export type DocRole =
  | "compass"
  | "old_exam"
  | "lecture"
  | "factsheet"
  | "exercise"
  | "solution"
  | "statute_lit";

export interface ClassifiedFile {
  id: string;
  file_name: string;
  clean_title: string;
  file_url: string | null;
  extraction_status: string | null;
  extracted_content: any | null;
  weekNumber: number | null;
  role: DocRole;
  roleLabel: string;
}

export interface CourseChapter {
  weekNumber: number;
  title: string;
  topicSubtitle: string;
  lectures: ClassifiedFile[];
  factsheets: ClassifiedFile[];
  exercises: ClassifiedFile[];
  solutions: ClassifiedFile[];
  allFiles: ClassifiedFile[];
}

export interface StructuredCourse {
  compassDocs: ClassifiedFile[];
  oldExams: ClassifiedFile[];
  referenceDocs: ClassifiedFile[];
  chapters: CourseChapter[];
}

export function normalizeZhawText(input: string): string {
  return (input || "").normalize("NFC");
}

export function detectWeekNumber(rawName: string): number | null {
  const name = normalizeZhawText(rawName);

  // 1. Explicit SW / UW / VL / Lektion / Woche / Semesterwoche
  const explicitMatch = name.match(
    /(?:^|[\s_.-])(?:SW|UW|VL|Lektion|Semesterwoche|Woche)\s*0*(\d{1,2})(?:[a-z])?(?=$|[\s_.-])/i
  );
  if (explicitMatch) {
    const num = parseInt(explicitMatch[1], 10);
    if (num >= 1 && num <= 16) return num;
  }

  // 2. OR AT II style: "OR AT II L 1.pdf" or "L 12.pdf"
  const lMatch = name.match(/(?:^|[\s_.-])L\s*0*(\d{1,2})(?=$|[\s_.-])/);
  if (lMatch) {
    const num = parseInt(lMatch[1], 10);
    if (num >= 1 && num <= 16) return num;
  }

  // 3. Strafrecht BT I style: "Ü1_Lösungsvorschläge.pdf", "Ü2_Tötungsdelikte..."
  const uebungMatch = name.match(/(?:^|[\s_.-])(?:Ü|Uebung|Übung)\s*0*(\d{1,2})(?=$|[\s_.-])/i);
  if (uebungMatch) {
    const num = parseInt(uebungMatch[1], 10);
    if (num >= 1 && num <= 16) return num;
  }

  return null;
}

export function classifyDocRole(rawName: string, weekNumber: number | null): {
  role: DocRole;
  roleLabel: string;
} {
  const name = normalizeZhawText(rawName).toLowerCase();

  // 1. Solutions / Musterlösungen / Lösungsskizzen (Highest priority inside weeks!)
  if (
    /(lösungsskizze|musterlösung|falllösung|lösungsvorschläge|lösungsvorschlag|loesung|lösungen)/i.test(
      name
    )
  ) {
    return { role: "solution", roleLabel: "Musterlösung / Gutachten" };
  }

  // 2. Old Exams / Alte MEP
  if (/(alte mep|muster-mep|mep-beilage|probeklausur|altprüfung|_mep\b)/i.test(name)) {
    return { role: "old_exam", roleLabel: "Alte MEP / Klausur" };
  }

  // 3. Compass / Organizational / USLN / Syllabus
  if (
    /(modulbeschreibung|modulübersicht|semesterprogramm|leistungsnachweis|usln|fallbearbeitung.*merkblatt|merkblatt|bearbeitungshinweise|leseliste|checkliste|einführungsveranstaltung|sachverhalt legal memorandum)/i.test(
      name
    )
  ) {
    return { role: "compass", roleLabel: "Modul-Kompass & USLN" };
  }

  // 4. Exercises / Fallskript / Übungsfälle
  if (/(übungsfälle|übungen|uebungen|fallskript|arbeitsblatt|ü\d+)/i.test(name)) {
    return { role: "exercise", roleLabel: "Übungsfälle / Sachverhalt" };
  }

  // 5. Factsheets / Repetitionsfragen / Grafiken
  if (/(factsheet|repetitionsfragen|grafik|inhaltsverzeichnis|check)/i.test(name)) {
    return { role: "factsheet", roleLabel: "Factsheet / Repetition" };
  }

  // 6. If it has a week number, default to Lecture / Vorlesungsfolien
  if (weekNumber !== null) {
    return { role: "lecture", roleLabel: "Vorlesungsfolien / Theorie" };
  }

  // 7. General Skript / BGE / Statute / Literature
  return { role: "statute_lit", roleLabel: "Skript, BGE & Gesetze" };
}

function extractCleanTopicFromFilename(rawName: string): string {
  let s = normalizeZhawText(rawName)
    .replace(/\.(pdf|docx?|pptx?|xlsx?|html)$/i, "")
    .replace(/_/g, " ")
    .replace(/\b(Fokusvorlesung|StaatsR II|StaatsR|OR AT II|GR|trav|online|korrekte Fassung|zimv|KURZ)\b/gi, "")
    .replace(/\b(SW|UW|VL|Lektion|Semesterwoche|Woche|L|Ü)\s*0*\d{1,2}[a-z]?\b/gi, "")
    .replace(/\b(Übungsfälle|Übungen|Musterlösung|Lösungsskizze|Lösungsvorschläge|Fallskript|Falllösungen|Factsheet|Repetitionsfragen|Präsentation|Arbeitsblatt|Inhaltsverzeichnis|Grafik|Notizen|Fall\s*\d+)\b/gi, "")
    .replace(/[-–—]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (s.length < 2) return "";
  return s;
}

export function structureCourseFiles(rawFiles: any[]): StructuredCourse {
  const validFiles = (rawFiles || []).filter(
    (f) => f.file_name && !/^index\.html$/i.test(f.file_name.trim())
  );

  const classified: ClassifiedFile[] = validFiles.map((f) => {
    const normName = normalizeZhawText(f.file_name || "Dokument");
    const weekNumber = detectWeekNumber(normName);
    const { role, roleLabel } = classifyDocRole(normName, weekNumber);

    return {
      id: f.id,
      file_name: normName,
      clean_title: normName.replace(/\.(pdf|docx?|pptx?)$/i, "").replace(/_/g, " "),
      file_url: f.file_url || null,
      extraction_status: f.extraction_status || null,
      extracted_content: f.extracted_content || null,
      weekNumber,
      role,
      roleLabel,
    };
  });

  const compassDocs: ClassifiedFile[] = [];
  const oldExams: ClassifiedFile[] = [];
  const referenceDocs: ClassifiedFile[] = [];
  const byWeek = new Map<number, ClassifiedFile[]>();

  for (const cf of classified) {
    if (cf.role === "compass") {
      compassDocs.push(cf);
    } else if (cf.role === "old_exam") {
      oldExams.push(cf);
    } else if (cf.weekNumber !== null) {
      const list = byWeek.get(cf.weekNumber) || [];
      list.push(cf);
      byWeek.set(cf.weekNumber, list);
    } else {
      referenceDocs.push(cf);
    }
  }

  const weekNumbers = Array.from(byWeek.keys()).sort((a, b) => a - b);
  const chapters: CourseChapter[] = weekNumbers.map((wn) => {
    const files = byWeek.get(wn) || [];
    const lectures = files.filter((f) => f.role === "lecture");
    const factsheets = files.filter((f) => f.role === "factsheet");
    const exercises = files.filter((f) => f.role === "exercise");
    const solutions = files.filter((f) => f.role === "solution");

    // Pick best topic subtitle from lecture or exercise filenames
    const topicCandidates = [...lectures, ...exercises, ...factsheets, ...solutions]
      .map((f) => extractCleanTopicFromFilename(f.file_name))
      .filter((t) => t.length >= 3);

    const topicSubtitle =
      topicCandidates[0] || `Semesterwoche ${wn} (${files.length} Unterlagen)`;

    return {
      weekNumber: wn,
      title: `SW ${wn}`,
      topicSubtitle,
      lectures,
      factsheets,
      exercises,
      solutions,
      allFiles: files,
    };
  });

  return {
    compassDocs,
    oldExams,
    referenceDocs,
    chapters,
  };
}
