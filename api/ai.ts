import { createClient } from "@supabase/supabase-js";

export const maxDuration = 60;

const SUPABASE_URL =
  process.env.VITE_SUPABASE_URL ||
  process.env.SUPABASE_URL ||
  "https://rtbtbzjnjqbmtrmyigxc.supabase.co";

const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  "sb_publishable_8mP_0CQw-xG9gP19FSHNiw_UBH_Pxbb";

const DEFAULT_USER_ID = "59255661-ce8b-476c-8e00-408b55843c58";

const GERMAN_MONTHS: Record<string, number> = {
  januar: 1, jan: 1,
  februar: 2, feb: 2,
  märz: 3, maerz: 3, mrz: 3,
  april: 4, apr: 4,
  mai: 5,
  juni: 6, jun: 6,
  juli: 7, jul: 7,
  august: 8, aug: 8,
  september: 9, sept: 9, sep: 9,
  oktober: 10, okt: 10,
  november: 11, nov: 11,
  dezember: 12, dez: 12,
};

const DEADLINE_KEYWORDS =
  /(leistungsnachweis|usln|abgabe|einreichung|frist|deadline|prüfung|klausur|test|kurztest|zwischenprüfung|modulendprüfung|mep|fallbearbeitung|referat|präsentation|moot|probeprüfung|bis\s+spätestens|bis\s+zum|fällig|termin|obligatorisch)/i;

export interface ExtractedDeadlineItem {
  title: string;
  description: string;
  due_date: string;
  category: "usln" | "exam" | "submission" | "other";
  course_id?: string | null;
  source: string;
}

/**
 * Deterministic Swiss-German date & deadline parser that works on any text
 * (Moodle notes, pasted emails, syllabus text, WhatsApp messages, PDF strings).
 */
function extractDeadlinesFromText(
  text: string,
  defaultContext = "Termin",
  courseId: string | null = null,
  source = "scanner",
  requireKeyword = false
): ExtractedDeadlineItem[] {
  if (!text || text.trim().length < 5) return [];

  const items: ExtractedDeadlineItem[] = [];
  const seen = new Set<string>();
  const currentYear = new Date().getFullYear();

  // Split into lines / sentences so each date gets its surrounding sentence as context
  const lines = text
    .split(/[\n\r]+|(?<=[.!?])\s+/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l.length >= 5);

  const monthNamesPattern = Object.keys(GERMAN_MONTHS).join("|");

  for (const line of lines) {
    const hasSignal =
      !requireKeyword ||
      DEADLINE_KEYWORDS.test(line) ||
      DEADLINE_KEYWORDS.test(defaultContext);
    if (!hasSignal) continue;

    const classifyLine = (s: string): "usln" | "exam" | "submission" | "other" => {
      const combined = `${s} ${defaultContext}`.toLowerCase();
      if (/usln|untersemestrig|leistungsnachweis|zwischenprüfung|kurztest/i.test(combined)) return "usln";
      if (/modulendprüfung|mep|prüfung|klausur|examen/i.test(combined)) return "exam";
      if (/abgabe|einreichung|fallbearbeitung|hausarbeit|essay|referat|präsentation|frist|deadline/i.test(combined))
        return "submission";
      return "other";
    };

    const buildTitle = (lineStr: string, category: string, dateLabel: string): string => {
      // Clean date out of line to get a concise title
      let cleaned = lineStr
        .replace(/\b\d{1,2}\.\d{1,2}\.\d{2,4}\b/g, "")
        .replace(new RegExp(`\\b\\d{1,2}\\.\\s*(${monthNamesPattern})\\.?\\s*\\d{0,4}\\b`, "gi"), "")
        .replace(/\b\d{1,2}[:.]\d{2}\s*(Uhr)?\b/gi, "")
        .replace(/^[\s\-–—:•*.,]+|[\s\-–—:•*.,]+$/g, "")
        .trim();

      if (cleaned.length < 4 || cleaned.length > 90) {
        cleaned = defaultContext;
      }

      const prefix =
        category === "usln" && !/usln|leistungsnachweis/i.test(cleaned)
          ? "🎯 USLN: "
          : category === "exam" && !/prüfung|klausur|mep/i.test(cleaned)
          ? "🎓 Prüfung: "
          : "";

      return `${prefix}${cleaned} (${dateLabel})`.slice(0, 120);
    };

    // 1. Numeric DD.MM.YYYY or DD.MM.YY (or DD.MM. when followed by time/signal)
    const numRegex =
      /\b(\d{1,2})\.(\d{1,2})\.(?:(\d{2,4}))?(?:[\s,umUhr\-–]*(\d{1,2})[:.](\d{2}))?/g;
    let m: RegExpExecArray | null;
    while ((m = numRegex.exec(line)) !== null) {
      // Skip legal articles like "Art. 1.2" or section numbers like "1.1." if no year and no keyword
      if (!m[3] && !DEADLINE_KEYWORDS.test(line)) continue;

      const day = parseInt(m[1], 10);
      const month = parseInt(m[2], 10);
      let year = m[3] ? parseInt(m[3], 10) : currentYear;
      if (year < 100) year += 2000;
      const hour = m[4] ? parseInt(m[4], 10) : 23;
      const minute = m[5] ? parseInt(m[5], 10) : 59;

      if (month >= 1 && month <= 12 && day >= 1 && day <= 31 && year >= currentYear - 1 && year <= currentYear + 2) {
        const dt = new Date(Date.UTC(year, month - 1, day, Math.min(hour, 23), Math.min(minute, 59)));
        if (!isNaN(dt.getTime())) {
          const iso = dt.toISOString();
          const dateKey = `${iso.slice(0, 10)}-${courseId || "global"}`;
          if (!seen.has(dateKey + line.slice(0, 25))) {
            seen.add(dateKey + line.slice(0, 25));
            const cat = classifyLine(line);
            const dateLabel = `${day.toString().padStart(2, "0")}.${month.toString().padStart(2, "0")}.${year}`;
            items.push({
              title: buildTitle(line, cat, dateLabel),
              description: line.slice(0, 300),
              due_date: iso,
              category: cat,
              course_id: courseId,
              source,
            });
          }
        }
      }
    }

    // 2. Written German month: e.g. "14. Mai 2026" or "20. April"
    const wordRegex = new RegExp(
      `\\b(\\d{1,2})\\.\\s*(${monthNamesPattern})\\.?\\s*(\\d{4})?(?:[\\s,umUhr\\-–]*(\\d{1,2})[:.](\\d{2}))?`,
      "gi"
    );
    while ((m = wordRegex.exec(line)) !== null) {
      const day = parseInt(m[1], 10);
      const month = GERMAN_MONTHS[m[2].toLowerCase()];
      const year = m[3] ? parseInt(m[3], 10) : currentYear;
      const hour = m[4] ? parseInt(m[4], 10) : 23;
      const minute = m[5] ? parseInt(m[5], 10) : 59;

      if (month && day >= 1 && day <= 31 && year >= currentYear - 1 && year <= currentYear + 2) {
        const dt = new Date(Date.UTC(year, month - 1, day, Math.min(hour, 23), Math.min(minute, 59)));
        if (!isNaN(dt.getTime())) {
          const iso = dt.toISOString();
          const dateKey = `${iso.slice(0, 10)}-${courseId || "global"}`;
          if (!seen.has(dateKey + line.slice(0, 25))) {
            seen.add(dateKey + line.slice(0, 25));
            const cat = classifyLine(line);
            const dateLabel = `${day.toString().padStart(2, "0")}.${month.toString().padStart(2, "0")}.${year}`;
            items.push({
              title: buildTitle(line, cat, dateLabel),
              description: line.slice(0, 300),
              due_date: iso,
              category: cat,
              course_id: courseId,
              source,
            });
          }
        }
      }
    }

    // 3. ISO format YYYY-MM-DD
    const isoRegex = /\b(202\d)-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b/g;
    while ((m = isoRegex.exec(line)) !== null) {
      const year = parseInt(m[1], 10);
      const month = parseInt(m[2], 10);
      const day = parseInt(m[3], 10);
      const dt = new Date(Date.UTC(year, month - 1, day, 23, 59));
      if (!isNaN(dt.getTime())) {
        const iso = dt.toISOString();
        const dateKey = `${iso.slice(0, 10)}-${courseId || "global"}`;
        if (!seen.has(dateKey + line.slice(0, 25))) {
          seen.add(dateKey + line.slice(0, 25));
          const cat = classifyLine(line);
          const dateLabel = `${day.toString().padStart(2, "0")}.${month.toString().padStart(2, "0")}.${year}`;
          items.push({
            title: buildTitle(line, cat, dateLabel),
            description: line.slice(0, 300),
            due_date: iso,
            category: cat,
            course_id: courseId,
            source,
          });
        }
      }
    }
  }

  return items;
}

/**
 * Extracts Swiss legal norms (OR, ZGB, StGB, BV, SchKG, ZPO, StPO, VwVG, etc.) and BGE cases from text.
 */
function extractLegalNormsAndCases(text: string) {
  const normsMap = new Map<string, { article: string; importance: number; tbm: string[]; rechtsfolge: string }>();
  const casesMap = new Map<string, { reference: string; summary: string }>();

  const normRegex =
    /\b(Art\.?\s*\d+[a-z]?(?:\s*(?:Abs\.?\s*\d+|Ziff\.?\s*\d+|lit\.?\s*[a-z]|ff\.?))*)\s+(OR|ZGB|StGB|BV|ZPO|StPO|SchKG|VwVG|BGG|UWG|DSG|KVG|UVG|ArG|ATSG|IPRG|FusG)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = normRegex.exec(text)) !== null) {
    const art = `${m[1].replace(/\s+/g, " ").trim()} ${m[2].toUpperCase()}`;
    const existing = normsMap.get(art);
    if (existing) {
      existing.importance = Math.min(5, existing.importance + 1);
    } else {
      const start = Math.max(0, m.index - 60);
      const end = Math.min(text.length, m.index + 160);
      const snippet = text.slice(start, end).replace(/\s+/g, " ").trim();
      normsMap.set(art, {
        article: art,
        importance: 3,
        tbm: ["Tatbestandsmerkmal prüfen", m[2].toUpperCase()],
        rechtsfolge: snippet,
      });
    }
  }

  const bgeRegex = /\b(BGE\s+\d+\s+[IVX]+\s+\d+|BGer\s+\d[A-Z]_\d+\/\d{4})\b/gi;
  while ((m = bgeRegex.exec(text)) !== null) {
    const ref = m[1].replace(/\s+/g, " ").trim();
    if (!casesMap.has(ref)) {
      const start = Math.max(0, m.index - 40);
      const end = Math.min(text.length, m.index + 160);
      casesMap.set(ref, {
        reference: ref,
        summary: text.slice(start, end).replace(/\s+/g, " ").trim(),
      });
    }
  }

  return {
    norms: Array.from(normsMap.values()),
    cases: Array.from(casesMap.values()),
  };
}

/**
 * Optional Gemini 2.5 Flash helper if GEMINI_API_KEY is configured
 */
async function callGeminiJson(prompt: string, apiKey?: string, pdfBase64?: string): Promise<any | null> {
  const key = apiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!key) return null;

  try {
    const parts: any[] = [{ text: prompt }];
    if (pdfBase64) {
      parts.push({
        inline_data: {
          mime_type: "application/pdf",
          data: pdfBase64,
        },
      });
    }

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: {
            temperature: 0.1,
            responseMimeType: "application/json",
          },
        }),
      }
    );

    if (!res.ok) return null;
    const data = await res.json();
    const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawText) return null;
    return JSON.parse(rawText);
  } catch (e) {
    console.warn("Gemini call fallback to deterministic engine:", e);
    return null;
  }
}

/**
 * Attempts to extract readable text from a PDF buffer (printable ASCII/Latin1/UTF-8 strings)
 * so we can find dates/norms inside Moodle syllabus PDFs even without an external LLM key.
 */
function extractPrintableStringsFromPdfBuffer(buf: ArrayBuffer): string {
  try {
    const decoder = new TextDecoder("latin1");
    const raw = decoder.decode(buf);
    const matches: string[] = [];

    // 1. Text inside PDF parentheses (...)
    const parenRegex = /\(([^()]{3,200})\)/g;
    let m: RegExpExecArray | null;
    while ((m = parenRegex.exec(raw)) !== null) {
      const s = m[1]
        .replace(/\\n/g, " ")
        .replace(/\\r/g, " ")
        .replace(/\\[()\\]/g, "")
        .trim();
      if (/[a-zA-Z0-9]{2,}/.test(s) && !/^[0-9\s.]+$/.test(s)) {
        matches.push(s);
      }
    }

    return matches.join(" ").slice(0, 60000);
  } catch {
    return "";
  }
}

export default async function handler(req: any, res: any) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    const {
      action,
      user_id = DEFAULT_USER_ID,
      course_id,
      file_id,
      text,
      gemini_api_key,
      moodle_token,
      auto_save = true,
    } = body;

    switch (action) {
      // =========================================================================
      // 1. EXTRACT DEADLINES (Workspace Deep Scan OR External Text/Email Paste)
      // =========================================================================
      case "extract_deadlines": {
        const mode = body.mode || (text ? "extract_from_text" : "scan_workspace");
        const discovered: ExtractedDeadlineItem[] = [];
        let scannedNotes = 0;
        let scannedFiles = 0;

        if (mode === "extract_from_text" && text) {
          // A. Deterministic extraction (requireKeyword = false because user explicitly pasted deadline text)
          const detItems = extractDeadlinesFromText(
            text,
            body.context_title || "Importierter Termin",
            course_id || null,
            "text_import",
            false
          );
          discovered.push(...detItems);

          // B. Optional Gemini enrichment for complex natural language dates
          const geminiRes = await callGeminiJson(
            `Extrahiere alle Termine, Fristen, Prüfungen und untersemestrigen Leistungsnachweise (USLN) aus folgendem Schweizer Hochschultext (heutiges Jahr: ${new Date().getFullYear()}).
Gib ein JSON-Objekt zurück: {"deadlines": [{"title": "Kurzer prägnanter Titel (mit 🎯 USLN: falls Leistungsnachweis)", "description": "Details/Kontext", "due_date": "ISO-8601 Datum z.B. 2026-05-14T23:59:00.000Z", "category": "usln|exam|submission|other"}]}
Text:
${text.slice(0, 12000)}`,
            gemini_api_key
          );

          if (Array.isArray(geminiRes?.deadlines)) {
            for (const gd of geminiRes.deadlines) {
              if (gd.title && gd.due_date && !isNaN(new Date(gd.due_date).getTime())) {
                discovered.push({
                  title: gd.title,
                  description: gd.description || "",
                  due_date: new Date(gd.due_date).toISOString(),
                  category: gd.category || "other",
                  course_id: course_id || null,
                  source: "ai_import",
                });
              }
            }
          }
        } else {
          // Mode: scan_workspace -> scan all notes + syllabus/schedule files in Supabase
          let notesQuery = supabase.from("notes").select("id, title, content, course_id").eq("user_id", user_id);
          let filesQuery = supabase
            .from("files")
            .select("id, file_name, file_url, moodle_file_url, extracted_content, course_id")
            .eq("user_id", user_id);

          if (course_id && course_id !== "all") {
            notesQuery = notesQuery.eq("course_id", course_id);
            filesQuery = filesQuery.eq("course_id", course_id);
          }

          const [{ data: notes }, { data: files }] = await Promise.all([notesQuery, filesQuery]);

          for (const n of notes || []) {
            scannedNotes++;
            const found = extractDeadlinesFromText(
              `${n.title || ""}. ${n.content || ""}`,
              n.title || "Kursnotiz",
              n.course_id,
              "scanner_note",
              true
            );
            discovered.push(...found);
          }

          // Check files (especially syllabus/schedule files or already parsed files)
          const syllabusRegex =
            /(modulübersicht|semesterprogramm|programm|zeitplan|termin|merkblatt|leistungsnachweis|usln|leitfaden|syllabus|übersicht|info|organisation|einführung|vorlesung\s*1\b|01_)/i;

          let pdfFetchCount = 0;
          for (const f of files || []) {
            scannedFiles++;
            // Check filename itself for dates
            const nameDates = extractDeadlinesFromText(
              f.file_name,
              f.file_name,
              f.course_id,
              "scanner_file",
              true
            );
            discovered.push(...nameDates);

            // Check extracted_content if already parsed
            if (f.extracted_content) {
              const jsonText = JSON.stringify(f.extracted_content);
              const parsedDates = extractDeadlinesFromText(
                jsonText,
                f.file_name,
                f.course_id,
                "scanner_pdf",
                true
              );
              discovered.push(...parsedDates);
            }

            // If it's a high-priority syllabus/schedule PDF and we haven't fetched too many yet, inspect its raw content
            if (
              pdfFetchCount < 8 &&
              f.file_name?.toLowerCase().endsWith(".pdf") &&
              syllabusRegex.test(f.file_name) &&
              (f.file_url || f.moodle_file_url)
            ) {
              try {
                pdfFetchCount++;
                let downloadUrl = f.file_url;
                if (f.moodle_file_url && moodle_token) {
                  downloadUrl = `${f.moodle_file_url}${f.moodle_file_url.includes("?") ? "&" : "?"}token=${moodle_token}`;
                }
                if (downloadUrl) {
                  const pdfRes = await fetch(downloadUrl);
                  if (pdfRes.ok) {
                    const buf = await pdfRes.arrayBuffer();
                    const extractedStr = extractPrintableStringsFromPdfBuffer(buf);
                    if (extractedStr.length > 30) {
                      const pdfDates = extractDeadlinesFromText(
                        extractedStr,
                        f.file_name.replace(/\.pdf$/i, ""),
                        f.course_id,
                        "scanner_pdf",
                        true
                      );
                      discovered.push(...pdfDates);
                    }
                  }
                }
              } catch (e) {
                console.warn(`Failed to scan syllabus PDF ${f.file_name}:`, e);
              }
            }
          }
        }

        // Deduplicate discovered items by (date_day + course_id + normalized title)
        const uniqueDiscovered: ExtractedDeadlineItem[] = [];
        const uniqueKeys = new Set<string>();
        for (const item of discovered) {
          const dayKey = `${item.due_date.slice(0, 10)}::${item.course_id || "none"}::${item.title
            .toLowerCase()
            .slice(0, 30)}`;
          if (!uniqueKeys.has(dayKey)) {
            uniqueKeys.add(dayKey);
            uniqueDiscovered.push(item);
          }
        }

        // Save new deadlines into Supabase if auto_save is true
        let insertedCount = 0;
        const savedDeadlines: any[] = [];
        if (auto_save && uniqueDiscovered.length > 0) {
          const { data: existingDeadlines } = await supabase
            .from("deadlines")
            .select("id, title, due_date, course_id")
            .eq("user_id", user_id);

          const existingSet = new Set(
            (existingDeadlines || []).map(
              (d: any) =>
                `${new Date(d.due_date).toISOString().slice(0, 10)}::${d.course_id || "none"}`
            )
          );
          const existingTitles = new Set(
            (existingDeadlines || []).map((d: any) => (d.title || "").toLowerCase().trim())
          );

          for (const d of uniqueDiscovered) {
            const dayCourseKey = `${d.due_date.slice(0, 10)}::${d.course_id || "none"}`;
            const normTitle = d.title.toLowerCase().trim();
            if (!existingTitles.has(normTitle) && !existingSet.has(dayCourseKey)) {
              const { data: inserted, error: insErr } = await supabase
                .from("deadlines")
                .insert({
                  user_id,
                  course_id: d.course_id || null,
                  title: d.title,
                  description: d.description,
                  due_date: d.due_date,
                  source: d.source,
                  is_completed: false,
                })
                .select("*")
                .single();

              if (!insErr && inserted) {
                insertedCount++;
                savedDeadlines.push(inserted);
                existingTitles.add(normTitle);
              }
            }
          }
        }

        return res.status(200).json({
          success: true,
          discovered: uniqueDiscovered,
          inserted_count: insertedCount,
          saved_deadlines: savedDeadlines,
          scanned_notes: scannedNotes,
          scanned_files: scannedFiles,
        });
      }

      // =========================================================================
      // 2. COURSE BRIEFING ("Spielregeln des Moduls" & Executive Overview)
      // =========================================================================
      case "course_briefing": {
        if (!course_id) {
          return res.status(400).json({ error: "Missing course_id" });
        }

        const [courseRes, deadlinesRes, notesRes, filesRes] = await Promise.all([
          supabase.from("courses").select("*").eq("id", course_id).maybeSingle(),
          supabase
            .from("deadlines")
            .select("*")
            .eq("user_id", user_id)
            .eq("course_id", course_id)
            .order("due_date", { ascending: true }),
          supabase
            .from("notes")
            .select("*")
            .eq("user_id", user_id)
            .eq("course_id", course_id)
            .order("created_at", { ascending: false }),
          supabase
            .from("files")
            .select("*")
            .eq("user_id", user_id)
            .eq("course_id", course_id)
            .order("file_name", { ascending: true }),
        ]);

        const course = courseRes.data;
        const deadlines = deadlinesRes.data || [];
        const notes = notesRes.data || [];
        const files = filesRes.data || [];

        // Scan notes & filenames right now for any uncaptured dates
        const allCourseText = [
          ...notes.map((n: any) => `${n.title}: ${n.content}`),
          ...files.map((f: any) => f.file_name),
        ].join("\n");

        const newlyFoundDates = extractDeadlinesFromText(
          allCourseText,
          course?.short_name || course?.name || "Kurs",
          course_id,
          "course_briefing_scan",
          true
        );

        // Auto-insert any newly discovered deadlines for this course
        const existingTitles = new Set(deadlines.map((d: any) => (d.title || "").toLowerCase()));
        for (const nd of newlyFoundDates) {
          if (!existingTitles.has(nd.title.toLowerCase())) {
            const { data: ins } = await supabase
              .from("deadlines")
              .insert({
                user_id,
                course_id,
                title: nd.title,
                description: nd.description,
                due_date: nd.due_date,
                source: "scanner",
                is_completed: false,
              })
              .select("*")
              .single();
            if (ins) {
              deadlines.push(ins);
              existingTitles.add(nd.title.toLowerCase());
            }
          }
        }

        // Extract USLN mentions from notes/files even if no date was attached
        const uslnMentions: string[] = [];
        const examMentions: string[] = [];
        for (const n of notes) {
          const text = `${n.title} — ${n.content}`;
          if (/usln|untersemestrig|leistungsnachweis|zwischenprüfung|fallbearbeitung|bonus/i.test(text)) {
            uslnMentions.push(text.slice(0, 240));
          }
          if (/modulendprüfung|mep|prüfung|hilfsmittel|open\s*book|closed\s*book|klausur/i.test(text)) {
            examMentions.push(text.slice(0, 240));
          }
        }

        const syllabusFiles = files.filter((f: any) =>
          /(modulübersicht|semesterprogramm|programm|zeitplan|merkblatt|leistungsnachweis|usln|leitfaden|syllabus|übersicht|info)/i.test(
            f.file_name || ""
          )
        );

        const lernziele = notes
          .filter((n: any) => n.note_type === "lernziel" || /lernziel|kompetenz/i.test(n.title + " " + n.content))
          .slice(0, 8)
          .map((n: any) => ({ id: n.id, title: n.title, content: n.content }));

        const { norms, cases } = extractLegalNormsAndCases(allCourseText);

        return res.status(200).json({
          success: true,
          course,
          briefing: {
            usln_deadlines: deadlines.filter((d: any) =>
              /usln|leistungsnachweis|fallbearbeitung|zwischenprüfung|quiz|test/i.test(
                `${d.title} ${d.description || ""}`
              )
            ),
            all_deadlines: deadlines,
            usln_mentions: uslnMentions.slice(0, 5),
            exam_mentions: examMentions.slice(0, 5),
            syllabus_files: syllabusFiles,
            lernziele,
            key_norms: norms.slice(0, 12),
            key_cases: cases.slice(0, 8),
            stats: {
              total_files: files.length,
              total_notes: notes.length,
              open_deadlines: deadlines.filter((d: any) => !d.is_completed).length,
            },
          },
        });
      }

      // =========================================================================
      // 3. CLASSIFY NOTES (Replaces dead Supabase 'note-classifier' function)
      // =========================================================================
      case "classify_notes": {
        const { data: notes } = await supabase
          .from("notes")
          .select("id, title, content, note_type, course_id")
          .eq("user_id", user_id);

        let classified = 0;
        let deadlinesExtracted = 0;

        for (const n of notes || []) {
          const combined = `${n.title || ""} ${n.content || ""}`;

          // Also scan every note for hidden deadlines while classifying!
          const dates = extractDeadlinesFromText(combined, n.title || "Notiz", n.course_id, "note_classifier", true);
          for (const d of dates) {
            const { data: exists } = await supabase
              .from("deadlines")
              .select("id")
              .eq("user_id", user_id)
              .eq("title", d.title)
              .maybeSingle();
            if (!exists) {
              await supabase.from("deadlines").insert({
                user_id,
                course_id: n.course_id,
                title: d.title,
                description: d.description,
                due_date: d.due_date,
                source: "scanner_note",
              });
              deadlinesExtracted++;
            }
          }

          if (n.note_type && n.note_type !== "general") continue;

          let newType = "general";
          if (/lernziel|learning\s*objective|kompetenz|studierenden\s+können/i.test(combined)) {
            newType = "lernziel";
          } else if (/leistungsnachweis|usln|prüfung|abgabe|frist|termin|organisatorisch|merkblatt|hilfsmittel/i.test(combined)) {
            newType = "organizational";
          } else if (/übung|aufgabe|fall\s*\d|fallbearbeitung|frage|lösen|besprechung/i.test(combined)) {
            newType = "exercise";
          } else if (/lektüre|pflichtlektüre|lesen|kapitel|literatur|buch|seite\s*\d/i.test(combined)) {
            newType = "reading";
          } else if (/vorbereitung|vor\s+der\s+vorlesung|selbststudium|auftrag/i.test(combined)) {
            newType = "prep";
          } else if (/zusammenfassung|überblick|repetitorium|fazit/i.test(combined)) {
            newType = "summary";
          }

          if (newType !== "general") {
            await supabase.from("notes").update({ note_type: newType }).eq("id", n.id);
            classified++;
          }
        }

        return res.status(200).json({
          success: true,
          classified,
          total_processed: (notes || []).length,
          deadlines_extracted: deadlinesExtracted,
        });
      }

      // =========================================================================
      // 4. PARSE PDF / FILE (Replaces dead Supabase 'parse-pdf' function)
      // =========================================================================
      case "parse":
      case "parse_pdf": {
        if (!file_id) {
          return res.status(400).json({ error: "Missing file_id" });
        }

        const { data: file } = await supabase
          .from("files")
          .select("*, courses(name, short_name)")
          .eq("id", file_id)
          .maybeSingle();

        if (!file) {
          return res.status(404).json({ error: "File not found" });
        }

        await supabase.from("files").update({ extraction_status: "processing" }).eq("id", file_id);

        // Fetch related course notes as additional context
        const { data: courseNotes } = file.course_id
          ? await supabase.from("notes").select("title, content").eq("course_id", file.course_id)
          : { data: [] };

        let rawPdfText = "";
        let pdfBase64: string | undefined;

        const downloadUrl =
          file.moodle_file_url && moodle_token
            ? `${file.moodle_file_url}${file.moodle_file_url.includes("?") ? "&" : "?"}token=${moodle_token}`
            : file.file_url;

        if (downloadUrl) {
          try {
            const pdfRes = await fetch(downloadUrl);
            if (pdfRes.ok) {
              const buf = await pdfRes.arrayBuffer();
              rawPdfText = extractPrintableStringsFromPdfBuffer(buf);
              if (buf.byteLength < 8 * 1024 * 1024) {
                pdfBase64 = Buffer.from(buf).toString("base64");
              }
            }
          } catch (e) {
            console.warn("Could not download file binary:", e);
          }
        }

        const combinedContext = [
          file.file_name,
          rawPdfText,
          ...(courseNotes || []).map((n: any) => `${n.title}: ${n.content}`),
        ].join("\n");

        // Try Gemini multimodal if key is configured
        let extractedContent: any = null;
        if (gemini_api_key || process.env.GEMINI_API_KEY) {
          extractedContent = await callGeminiJson(
            `Analysiere dieses juristische Vorlesungsdokument ("${file.file_name}") aus dem Kurs "${
              file.courses?.name || "Wirtschaftsrecht"
            }".
Extrahiere:
1. "summary": Kurze Zusammenfassung (2-4 Sätze)
2. "norms": Array von Schweizer Rechtsnormen [{"article": "z.B. Art. 41 Abs. 1 OR", "importance": 1-5, "tbm": ["Tatbestandsmerkmal 1", "TBM 2"], "rechtsfolge": "Rechtsfolge", "definitionen": [{"term": "Begriff", "definition": "Erklärung"}]}]
3. "key_concepts": [{"concept": "Begriff", "explanation": "Erklärung"}]
4. "cases": [{"reference": "z.B. BGE 130 III 182", "summary": "Kernaussage"}]
5. "deadlines": [{"title": "Termin/USLN/Prüfung", "due_date": "ISO-8601 Datum", "description": "Kontext"}]`,
            gemini_api_key,
            pdfBase64
          );
        }

        // Deterministic fallback / enrichment
        const { norms, cases } = extractLegalNormsAndCases(combinedContext);
        const foundDeadlines = extractDeadlinesFromText(
          combinedContext,
          file.file_name.replace(/\.\w+$/, ""),
          file.course_id,
          "pdf_parser",
          true
        );

        if (!extractedContent) {
          extractedContent = {
            summary: `Automatische Analyse von "${file.file_name}" (${
              file.courses?.short_name || file.courses?.name || "ZHAW SML"
            }). ${norms.length} Rechtsnormen, ${cases.length} Entscheide und ${
              foundDeadlines.length
            } Termine erkannt.`,
            norms,
            key_concepts: (courseNotes || []).slice(0, 5).map((n: any) => ({
              concept: n.title,
              explanation: (n.content || "").slice(0, 180),
            })),
            cases,
            deadlines: foundDeadlines,
          };
        }

        // Save any discovered deadlines into `deadlines` table
        for (const dl of extractedContent.deadlines || foundDeadlines) {
          if (dl.title && dl.due_date && !isNaN(new Date(dl.due_date).getTime())) {
            const { data: exists } = await supabase
              .from("deadlines")
              .select("id")
              .eq("user_id", user_id)
              .eq("title", dl.title)
              .maybeSingle();
            if (!exists) {
              await supabase.from("deadlines").insert({
                user_id,
                course_id: file.course_id,
                title: dl.title,
                description: dl.description || `Extrahiert aus Datei: ${file.file_name}`,
                due_date: new Date(dl.due_date).toISOString(),
                source: "pdf_parser",
              });
            }
          }
        }

        await supabase
          .from("files")
          .update({
            extraction_status: "done",
            extracted_content: extractedContent,
            extracted_at: new Date().toISOString(),
          })
          .eq("id", file_id);

        return res.status(200).json({
          success: true,
          norms_count: extractedContent.norms?.length || 0,
          concepts_count: extractedContent.key_concepts?.length || 0,
          deadlines_count: (extractedContent.deadlines || foundDeadlines).length,
          extracted_content: extractedContent,
        });
      }

      // =========================================================================
      // 5. SMART STUDY PLANNER (Replaces dead 'study-planner' function)
      // =========================================================================
      case "plan_today":
      case "plan_week": {
        const isWeek = action === "plan_week";
        const todayStr = new Date().toISOString().slice(0, 10);

        const [{ data: deadlines }, { data: notes }, { data: existingTasks }] = await Promise.all([
          supabase
            .from("deadlines")
            .select("*, courses(name, short_name)")
            .eq("user_id", user_id)
            .eq("is_completed", false)
            .order("due_date", { ascending: true })
            .limit(10),
          supabase
            .from("notes")
            .select("*, courses(name, short_name)")
            .eq("user_id", user_id)
            .in("note_type", ["lernziel", "exercise", "prep", "reading"])
            .order("created_at", { ascending: false })
            .limit(15),
          supabase
            .from("tasks")
            .select("title")
            .eq("user_id", user_id)
            .in("status", ["pending", "in_progress"]),
        ]);

        const existingTitles = new Set((existingTasks || []).map((t: any) => (t.title || "").toLowerCase()));
        const toInsert: any[] = [];

        // 1. Create preparation tasks for upcoming deadlines / USLNs
        for (const dl of (deadlines || []).slice(0, isWeek ? 6 : 3)) {
          const taskTitle = `Vorbereitung: ${dl.title}`;
          if (!existingTitles.has(taskTitle.toLowerCase())) {
            toInsert.push({
              user_id,
              course_id: dl.course_id,
              deadline_id: dl.id,
              title: taskTitle,
              description: dl.description || `Frist am ${new Date(dl.due_date).toLocaleDateString("de-CH")}`,
              task_type: /usln|prüfung|klausur/i.test(dl.title) ? "exam_prep" : "exercises",
              status: "pending",
              priority_score: 90,
              estimated_minutes: 45,
              scheduled_for: todayStr,
              ai_reasoning: "Hohe Priorität wegen bevorstehender Frist / Leistungsnachweis.",
            });
            existingTitles.add(taskTitle.toLowerCase());
          }
        }

        // 2. Create tasks from Lernziele / Exercises
        for (const n of (notes || []).slice(0, isWeek ? 6 : 2)) {
          const taskTitle = `${n.note_type === "lernziel" ? "Lernziel prüfen" : "Übung bearbeiten"}: ${n.title}`;
          if (!existingTitles.has(taskTitle.toLowerCase())) {
            toInsert.push({
              user_id,
              course_id: n.course_id,
              title: taskTitle.slice(0, 110),
              description: (n.content || "").slice(0, 240),
              task_type: n.note_type === "exercise" ? "exercises" : "lecture_review",
              status: "pending",
              priority_score: 70,
              estimated_minutes: 30,
              scheduled_for: todayStr,
              ai_reasoning: "Aus aktuellem Moodle-Kursmaterial abgeleitet.",
            });
            existingTitles.add(taskTitle.toLowerCase());
          }
        }

        if (toInsert.length > 0) {
          await supabase.from("tasks").insert(toInsert);
        }

        return res.status(200).json({
          success: true,
          created: toInsert.length,
        });
      }

      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }
  } catch (err: any) {
    console.error("api/ai error:", err);
    return res.status(500).json({ error: err.message || "Internal server error" });
  }
}
