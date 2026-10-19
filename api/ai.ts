import { createClient } from "@supabase/supabase-js";
import * as zlib from "zlib";

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
  /(leistungsnachweis|usln|abgabe|einreichung|einreichen|einsendung|einsenden|hochladen|upload|publikation|aufschaltung|frist|deadline|prüfung|klausur|test|kurztest|zwischenprüfung|modulendprüfung|mep|fallbearbeitung|referat|präsentation|moot|probeprüfung|per\s+e-?mail|@zhaw\.ch|bis\s+spätestens|bis\s+zum|\bbis\b|fällig|termin|obligatorisch)/i;

export interface ExtractedDeadlineItem {
  title: string;
  description: string;
  due_date: string;
  category: "usln" | "exam" | "submission" | "other";
  course_id?: string | null;
  source: string;
}

/**
 * Decodes PDF octal escapes (\344 -> ä, \366 -> ö, \374 -> ü, \253 -> «, etc.)
 * and unescapes parentheses inside PDF string literals.
 */
function decodePdfLiteral(s: string): string {
  const cp1252Map: Record<number, string> = {
    0x84: "„",
    0x93: "“",
    0x94: "”",
    0x96: "–",
    0x97: "—",
    0xa7: "§",
    0xab: "«",
    0xbb: "»",
  };
  return s
    .replace(/\\([0-7]{3})/g, (_, oct) => {
      const code = parseInt(oct, 8);
      return cp1252Map[code] || String.fromCharCode(code);
    })
    .replace(/\\n/g, " ")
    .replace(/\\r/g, " ")
    .replace(/\\t/g, " ")
    .replace(/\\\(/g, "(")
    .replace(/\\\)/g, ")")
    .replace(/\\\\/g, "\\");
}

/**
 * Decompresses PDF FlateDecode (zlib) streams and reconstructs text from TJ / Tj operators,
 * properly reassembling kerned word splits like [(O)-7.2 (kt)5.6 (o)-5.6 (b)-5.5 (er)]TJ -> "Oktober".
 */
export function extractTextFromPdfBuffer(buf: ArrayBuffer): string {
  try {
    const nodeBuf = Buffer.from(buf);
    const raw = nodeBuf.toString("latin1");
    const streamRegex = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
    const chunks: string[] = [];

    let m: RegExpExecArray | null;
    while ((m = streamRegex.exec(raw)) !== null) {
      const streamLatin1 = m[1];
      let decompressed = "";
      try {
        const inflated = zlib.inflateSync(Buffer.from(streamLatin1, "latin1"));
        decompressed = inflated.toString("latin1");
      } catch {
        try {
          const inflatedRaw = zlib.inflateRawSync(Buffer.from(streamLatin1, "latin1"));
          decompressed = inflatedRaw.toString("latin1");
        } catch {
          decompressed = streamLatin1;
        }
      }

      if (!decompressed || (!decompressed.includes("Tj") && !decompressed.includes("TJ"))) {
        continue;
      }

      const litRegex = /\((?:\\.|[^\\()])*\)/g;
      const parts: string[] = [];
      let lm: RegExpExecArray | null;
      while ((lm = litRegex.exec(decompressed)) !== null) {
        const inner = lm[0].slice(1, -1);
        parts.push(decodePdfLiteral(inner));
      }

      if (parts.length > 0) {
        const joined = parts
          .join("")
          .replace(/de-(?:DE|CH)/gi, " ")
          .replace(/\s+/g, " ")
          .trim();
        if (joined.length > 10) {
          chunks.push(joined);
        }
      }
    }

    return chunks.join("\n").slice(0, 80000);
  } catch (e) {
    console.warn("PDF decompression error:", e);
    return "";
  }
}

/**
 * Deterministic Swiss-German date & deadline parser that handles:
 * - Multi-line wrapped sentences ("per E-Mail an baes@zhaw.ch bis \r\nFr. 30. Oktober 2026 um 17.00 Uhr")
 * - Weekday abbreviations (Mo., Di., Mi., Do., Fr., Sa., So.)
 * - German written months (30. Oktober 2026) and numeric dates (04.11.2026)
 * - Times with dots or colons and optional parentheses ((17.00 Uhr) or um 17:00 Uhr)
 */
export function extractDeadlinesFromText(
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

  // 1. Normalize line breaks & strip Word PDF language tags (e.g. "de-DE21.10.2026")
  const normalized = text
    .replace(/\r\n/g, "\n")
    .replace(/de-(?:DE|CH)/gi, " ")
    .replace(/([a-zäöü])-\s*\n\s*([a-zäöü])/gi, "$1$2")
    .replace(/(?<!\n)\n(?!\n)/g, " ");

  // 2. Split into sentences without splitting after German ordinal numbers (1.-31.), weekdays (Fr.), or legal abbreviations (Art.)
  const lines = normalized
    .split(
      /\n{2,}|(?<!\b\d{1,2}\.)(?<!\b(?:Mo|Di|Mi|Do|Fr|Sa|So|Jan|Feb|Mär|Mrz|Apr|Jun|Jul|Aug|Sep|Sept|Okt|Nov|Dez|Art|Abs|Ziff|lit|Bst|Nr|S|vgl|bspw|z\.B|bzw|etc|ca|Prof|Dr|iur|LL\.M)\.)(?<=[.!?])\s+/i
    )
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l.length >= 5);

  const monthNamesPattern = Object.keys(GERMAN_MONTHS).join("|");

  for (const line of lines) {
    // Skip metadata/archive sentences like "Datum 29.04.2009" or "Anfang 2023 gegründete"
    if (/Version\s+\d|MSIP_Label/i.test(line)) continue;

    const hasSignal =
      !requireKeyword ||
      DEADLINE_KEYWORDS.test(line) ||
      DEADLINE_KEYWORDS.test(defaultContext);
    if (!hasSignal) continue;

    const classifyLine = (s: string): "usln" | "exam" | "submission" | "other" => {
      const combined = `${s} ${defaultContext}`.toLowerCase();
      if (
        /usln|untersemestrig|leistungsnachweis|fallbearbeitung|zwischenprüfung|kurztest|einsendung.*lösungen|baes@zhaw\.ch/i.test(
          combined
        )
      ) {
        return "usln";
      }
      if (/modulendprüfung|mep|prüfung|klausur|examen/i.test(combined)) return "exam";
      if (
        /abgabe|einreichung|hochladen|per\s+e-?mail|hausarbeit|essay|referat|präsentation|frist|deadline/i.test(
          combined
        )
      ) {
        return "submission";
      }
      return "other";
    };

    const buildTitle = (
      lineStr: string,
      category: string,
      dateLabel: string,
      matchIndex = 0,
      totalMatchesInLine = 1
    ): string => {
      const shortContext = defaultContext.split("—")[0].trim().slice(0, 45);
      // Special handling for table rows containing both "Publikation" and "Hochladen"
      if (
        totalMatchesInLine >= 2 &&
        /publikation/i.test(lineStr) &&
        /hochladen|abgabe|einreichung/i.test(lineStr)
      ) {
        if (matchIndex === 0) {
          return `📄 Publikation Fallbearbeitung (${dateLabel})`;
        } else {
          return `🎯 USLN Abgabe / Hochladen (${dateLabel})`;
        }
      }

      let cleaned = lineStr
        .replace(/\b(?:Mo|Di|Mi|Do|Fr|Sa|So)\.?\s*(?=\d{1,2}\.)/gi, "")
        .replace(/\b\d{1,2}\.\d{1,2}\.\d{2,4}\b/g, "")
        .replace(new RegExp(`\\b\\d{1,2}\\.\\s*(${monthNamesPattern})\\.?\\s*\\d{0,4}\\b`, "gi"), "")
        .replace(/\b(?:um\s+)?\d{1,2}[:.]\d{2}\s*(?:Uhr)?\.?/gi, "")
        .replace(/\b(?:bis\s+spätestens|bis\s+zum|bis|am|vom)\s*$/gi, "")
        .replace(/^\d+[)\].]\s*/, "")
        .replace(/^[\s\-–—:•*.,()]+|[\s\-–—:•*.,()]+$/g, "")
        .replace(/\s+/g, " ")
        .trim();

      if (cleaned.length < 4 || cleaned.length > 75) {
        cleaned = shortContext;
      }

      const prefix =
        category === "usln" && !/usln|leistungsnachweis/i.test(cleaned)
          ? "🎯 USLN: "
          : category === "exam" && !/prüfung|klausur|mep/i.test(cleaned)
          ? "🎓 Prüfung: "
          : "";

      return `${prefix}${cleaned} (${dateLabel})`;
    };

    // 1. Numeric DD.MM.YYYY or DD.MM.YY (with optional time HH:MM, HH.MM Uhr, or (17.00 Uhr))
    const numRegex =
      /\b(\d{1,2})\.(\d{1,2})\.(\d{2,4})(?:[\s,umUhr\-–(]*(\d{1,2})[:.](\d{2})\s*(?:Uhr)?\)?)?/gi;
    const numMatches = Array.from(line.matchAll(numRegex));
    numMatches.forEach((m, idx) => {
      const day = parseInt(m[1], 10);
      const month = parseInt(m[2], 10);
      let year = parseInt(m[3], 10);
      if (year < 100) year += 2000;
      const hour = m[4] ? parseInt(m[4], 10) : 23;
      const minute = m[5] ? parseInt(m[5], 10) : 59;

      if (month >= 1 && month <= 12 && day >= 1 && day <= 31 && year >= currentYear - 1 && year <= currentYear + 2) {
        const dt = new Date(Date.UTC(year, month - 1, day, Math.min(hour, 23), Math.min(minute, 59)));
        if (!isNaN(dt.getTime())) {
          const iso = dt.toISOString();
          const timeStr = m[4] ? `, ${hour.toString().padStart(2, "0")}:${minute.toString().padStart(2, "0")}` : "";
          const dateLabel = `${day.toString().padStart(2, "0")}.${month.toString().padStart(2, "0")}.${year}${timeStr}`;
          const seenKey = `${iso.slice(0, 16)}-${courseId || "global"}`;
          if (!seen.has(seenKey)) {
            seen.add(seenKey);
            const cat = classifyLine(line);
            items.push({
              title: buildTitle(line, cat, dateLabel, idx, numMatches.length),
              description: line.slice(0, 300),
              due_date: iso,
              category: cat,
              course_id: courseId,
              source,
            });
          }
        }
      }
    });

    // 2. Written German month: e.g. "Fr. 30. Oktober 2026 um 17.00 Uhr" or "2. Oktober 2026"
    const wordRegex = new RegExp(
      `\\b(\\d{1,2})\\.\\s*(${monthNamesPattern})\\.?\\s*(\\d{4})?(?:[\\s,umUhr\\-–(]*(\\d{1,2})[:.](\\d{2})\\s*(?:Uhr)?\\)?)?`,
      "gi"
    );
    const wordMatches = Array.from(line.matchAll(wordRegex));
    wordMatches.forEach((m, idx) => {
      const day = parseInt(m[1], 10);
      const month = GERMAN_MONTHS[m[2].toLowerCase()];
      const year = m[3] ? parseInt(m[3], 10) : currentYear;
      const hour = m[4] ? parseInt(m[4], 10) : 23;
      const minute = m[5] ? parseInt(m[5], 10) : 59;

      if (month && day >= 1 && day <= 31 && year >= currentYear - 1 && year <= currentYear + 2) {
        const dt = new Date(Date.UTC(year, month - 1, day, Math.min(hour, 23), Math.min(minute, 59)));
        if (!isNaN(dt.getTime())) {
          const iso = dt.toISOString();
          const timeStr = m[4] ? `, ${hour.toString().padStart(2, "0")}:${minute.toString().padStart(2, "0")}` : "";
          const dateLabel = `${day.toString().padStart(2, "0")}.${month.toString().padStart(2, "0")}.${year}${timeStr}`;
          const seenKey = `${iso.slice(0, 16)}-${courseId || "global"}`;
          if (!seen.has(seenKey)) {
            seen.add(seenKey);
            const cat = classifyLine(line);
            items.push({
              title: buildTitle(line, cat, dateLabel, idx, wordMatches.length),
              description: line.slice(0, 300),
              due_date: iso,
              category: cat,
              course_id: courseId,
              source,
            });
          }
        }
      }
    });
  }

  return items;
}

/**
 * Extracts Swiss legal norms (OR, ZGB, StGB, BV, SchKG, ZPO, StPO, VwVG, FusG, HRegV, EMRK, BGG) and BGE cases.
 */
export function extractLegalNormsAndCases(text: string) {
  const normsMap = new Map<string, { article: string; importance: number; tbm: string[]; rechtsfolge: string }>();
  const casesMap = new Map<string, { reference: string; summary: string }>();

  const normRegex =
    /\b(Art\.?\s*\d+[a-z]?(?:\s*(?:Abs\.?\s*\d+|Ziff\.?\s*\d+|lit\.?\s*[a-z]|ff\.?))*)\s+(OR|ZGB|StGB|BV|ZPO|StPO|SchKG|VwVG|BGG|UWG|DSG|KVG|UVG|ArG|ATSG|IPRG|FusG|HRegV|EMRK)\b/gi;
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
          const detItems = extractDeadlinesFromText(
            text,
            body.context_title || "Importierter Termin",
            course_id || null,
            "text_import",
            false
          );
          discovered.push(...detItems);

          const geminiRes = await callGeminiJson(
            `Extrahiere alle Termine, Fristen, Prüfungen und untersemestrigen Leistungsnachweise (USLN) aus folgendem Schweizer Hochschultext (heutiges Jahr: ${new Date().getFullYear()}).
Gib ein JSON-Objekt zurück: {"deadlines": [{"title": "Kurzer prägnanter Titel (mit 🎯 USLN: falls Leistungsnachweis)", "description": "Details/Kontext", "due_date": "ISO-8601 Datum z.B. 2026-10-30T17:00:00.000Z", "category": "usln|exam|submission|other"}]}
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
          // Mode: scan_workspace -> scan all notes + syllabus/USLN/Merkblatt PDFs in Supabase
          let notesQuery = supabase.from("notes").select("id, title, content, course_id").eq("user_id", user_id);
          let filesQuery = supabase
            .from("files")
            .select("id, file_name, file_url, moodle_file_url, extracted_content, course_id, courses(name, short_name)")
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

          const syllabusRegex =
            /(leistungsnachweis|usln|fallbearbeitung|merkblatt|modulübersicht|modulbeschreibung|semesterprogramm|semesterwochenprogramm|programm|zeitplan|termin|leitfaden|syllabus|übersicht|info|organisation|einführung)/i;

          // Prioritize newest semester (e.g. 2026-HS) and explicit USLN/Merkblatt files first
          const sortedFiles = [...(files || [])].sort((a: any, b: any) => {
            const aIsCurrent = /2026-HS/i.test(a.courses?.name || "") ? 1 : 0;
            const bIsCurrent = /2026-HS/i.test(b.courses?.name || "") ? 1 : 0;
            if (aIsCurrent !== bIsCurrent) return bIsCurrent - aIsCurrent;
            const aIsUsln = /leistungsnachweis|usln|fallbearbeitung|merkblatt/i.test(a.file_name || "") ? 1 : 0;
            const bIsUsln = /leistungsnachweis|usln|fallbearbeitung|merkblatt/i.test(b.file_name || "") ? 1 : 0;
            return bIsUsln - aIsUsln;
          });

          let pdfFetchCount = 0;
          for (const f of sortedFiles) {
            scannedFiles++;
            const courseLabel = f.courses?.name
              ? f.courses.name.replace(/\s*\(\d{4}-(FS|HS)\)/i, "")
              : f.file_name.replace(/\.pdf$/i, "");

            const nameDates = extractDeadlinesFromText(
              f.file_name,
              courseLabel,
              f.course_id,
              "scanner_file",
              true
            );
            discovered.push(...nameDates);

            // Download & decompress high-priority USLN / Merkblatt / Syllabus PDFs
            if (
              pdfFetchCount < 15 &&
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
                    const extractedStr = extractTextFromPdfBuffer(buf);
                    if (extractedStr.length > 30) {
                      const pdfDates = extractDeadlinesFromText(
                        extractedStr,
                        `${courseLabel} — ${f.file_name.replace(/\.pdf$/i, "")}`,
                        f.course_id,
                        "scanner_pdf",
                        true
                      );
                      discovered.push(...pdfDates);

                      // Also persist the decompressed summary & deadlines on the file row so we don't have to re-download
                      const { norms, cases } = extractLegalNormsAndCases(extractedStr);
                      await supabase
                        .from("files")
                        .update({
                          extraction_status: "done",
                          extracted_at: new Date().toISOString(),
                          extracted_content: {
                            summary: extractedStr.slice(0, 900),
                            full_text_preview: extractedStr.slice(0, 3500),
                            norms,
                            cases,
                            deadlines: pdfDates,
                          },
                        })
                        .eq("id", f.id);
                    }
                  }
                }
              } catch (e) {
                console.warn(`Failed to scan syllabus PDF ${f.file_name}:`, e);
              }
            } else if (f.extracted_content) {
              const jsonText =
                typeof f.extracted_content.full_text_preview === "string"
                  ? f.extracted_content.full_text_preview
                  : JSON.stringify(f.extracted_content);
              const parsedDates = extractDeadlinesFromText(
                jsonText,
                `${courseLabel} — ${f.file_name.replace(/\.pdf$/i, "")}`,
                f.course_id,
                "scanner_pdf",
                true
              );
              discovered.push(...parsedDates);
            }
          }
        }

        // Deduplicate discovered items by (date_hour_minute + course_id)
        const uniqueDiscovered: ExtractedDeadlineItem[] = [];
        const uniqueKeys = new Set<string>();
        for (const item of discovered) {
          const key = `${item.due_date.slice(0, 16)}::${item.course_id || "none"}`;
          if (!uniqueKeys.has(key)) {
            uniqueKeys.add(key);
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
                existingSet.add(dayCourseKey);
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
      // 2. COURSE BRIEFING ("Spielregeln des Moduls" & Auto-PDF Decompression)
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
        const courseCleanName = (course?.name || "Kurs").replace(/\s*\(\d{4}-(FS|HS)\)/i, "");

        const syllabusFiles = files.filter((f: any) =>
          /(leistungsnachweis|usln|fallbearbeitung|merkblatt|modulübersicht|modulbeschreibung|semesterprogramm|semesterwochenprogramm|programm|zeitplan|leitfaden|syllabus|übersicht|info)/i.test(
            f.file_name || ""
          )
        );

        // Automatically decompress any syllabus / USLN / Merkblatt PDF for this course if not yet decompressed
        const pdfTexts: string[] = [];
        for (const sf of syllabusFiles.slice(0, 5)) {
          if (sf.extracted_content?.full_text_preview) {
            pdfTexts.push(sf.extracted_content.full_text_preview);
          } else if (sf.file_name?.toLowerCase().endsWith(".pdf") && sf.file_url) {
            try {
              const pdfRes = await fetch(sf.file_url);
              if (pdfRes.ok) {
                const buf = await pdfRes.arrayBuffer();
                const txt = extractTextFromPdfBuffer(buf);
                if (txt.length > 30) {
                  pdfTexts.push(txt);
                  const pdfDates = extractDeadlinesFromText(
                    txt,
                    `${courseCleanName} — ${sf.file_name.replace(/\.pdf$/i, "")}`,
                    course_id,
                    "scanner_pdf",
                    true
                  );
                  const { norms, cases } = extractLegalNormsAndCases(txt);
                  await supabase
                    .from("files")
                    .update({
                      extraction_status: "done",
                      extracted_at: new Date().toISOString(),
                      extracted_content: {
                        summary: txt.slice(0, 900),
                        full_text_preview: txt.slice(0, 3500),
                        norms,
                        cases,
                        deadlines: pdfDates,
                      },
                    })
                    .eq("id", sf.id);
                }
              }
            } catch (e) {
              console.warn("Could not auto-decompress course syllabus PDF:", e);
            }
          }
        }

        const allCourseText = [
          ...pdfTexts,
          ...notes.map((n: any) => `${n.title}: ${n.content}`),
          ...files.map((f: any) => f.file_name),
        ].join("\n\n");

        const newlyFoundDates = extractDeadlinesFromText(
          allCourseText,
          courseCleanName,
          course_id,
          "course_briefing_scan",
          true
        );

        const existingDates = new Set(
          deadlines.map((d: any) => new Date(d.due_date).toISOString().slice(0, 10))
        );
        for (const nd of newlyFoundDates) {
          const dayKey = nd.due_date.slice(0, 10);
          if (!existingDates.has(dayKey)) {
            const { data: ins } = await supabase
              .from("deadlines")
              .insert({
                user_id,
                course_id,
                title: nd.title,
                description: nd.description,
                due_date: nd.due_date,
                source: "scanner_pdf",
                is_completed: false,
              })
              .select("*")
              .single();
            if (ins) {
              deadlines.push(ins);
              existingDates.add(dayKey);
            }
          }
        }

        // Extract USLN details, exam rules & literature from notes + PDF texts
        const uslnMentions: string[] = [];
        const examMentions: string[] = [];
        for (const srcText of [...pdfTexts, ...notes.map((n: any) => `${n.title} — ${n.content}`)]) {
          if (/usln|untersemestrig|leistungsnachweis|fallbearbeitung|bonuspunkte|pass.*fail/i.test(srcText)) {
            uslnMentions.push(srcText.slice(0, 600));
          }
          if (/modulendprüfung|mep|hilfsmittel|zugelassen|pflichtliteratur|erlasse/i.test(srcText)) {
            examMentions.push(srcText.slice(0, 450));
          }
        }

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
              /usln|leistungsnachweis|fallbearbeitung|zwischenprüfung|quiz|test|baes@zhaw/i.test(
                `${d.title} ${d.description || ""}`
              )
            ),
            all_deadlines: deadlines,
            usln_mentions: uslnMentions.slice(0, 4),
            exam_mentions: examMentions.slice(0, 4),
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
      // 3. CLASSIFY NOTES
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
      // 4. PARSE PDF / FILE
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
              rawPdfText = extractTextFromPdfBuffer(buf);
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

        const { norms, cases } = extractLegalNormsAndCases(combinedContext);
        const courseClean = (file.courses?.name || file.file_name).replace(/\s*\(\d{4}-(FS|HS)\)/i, "");
        const foundDeadlines = extractDeadlinesFromText(
          combinedContext,
          `${courseClean} — ${file.file_name.replace(/\.\w+$/, "")}`,
          file.course_id,
          "pdf_parser",
          true
        );

        if (!extractedContent) {
          extractedContent = {
            summary:
              rawPdfText.length > 40
                ? rawPdfText.slice(0, 700)
                : `Automatische Analyse von "${file.file_name}". ${norms.length} Rechtsnormen, ${cases.length} Entscheide und ${foundDeadlines.length} Termine erkannt.`,
            full_text_preview: rawPdfText.slice(0, 3500),
            norms,
            key_concepts: (courseNotes || []).slice(0, 5).map((n: any) => ({
              concept: n.title,
              explanation: (n.content || "").slice(0, 180),
            })),
            cases,
            deadlines: foundDeadlines,
          };
        }

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
      // 5. SMART STUDY PLANNER
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

      // =========================================================================
      // 6. CHAPTER DEEP NOTES (Swiss Law Definitionen, Prüfungsschema & Syllogismus)
      // =========================================================================
      case "chapter_deep_notes": {
        const weekNum = Number(body.week_number || 1);
        const courseName = String(body.course_name || "Rechtswissenschaft");
        const fileIds: string[] = Array.isArray(body.file_ids) ? body.file_ids : [];

        const { data: chapterFiles } = fileIds.length
          ? await supabase.from("files").select("*").in("id", fileIds)
          : await supabase
              .from("files")
              .select("*")
              .eq("user_id", user_id)
              .eq("course_id", course_id)
              .limit(12);

        const filesList = chapterFiles || [];
        // Prioritize solution sketches (Lösungsskizze/Musterlösung) and lecture slides
        const sortedChapterFiles = [...filesList].sort((a: any, b: any) => {
          const aSol = /(lösung|musterlösung|falllösung)/i.test(a.file_name || "") ? 2 : 0;
          const bSol = /(lösung|musterlösung|falllösung)/i.test(b.file_name || "") ? 2 : 0;
          return bSol - aSol;
        });

        const lectureTexts: string[] = [];
        const solutionTexts: string[] = [];
        const exerciseTexts: string[] = [];

        for (const f of sortedChapterFiles.slice(0, 6)) {
          let txt = f.extracted_content?.full_text_preview || "";
          if (!txt && f.file_name?.toLowerCase().endsWith(".pdf") && f.file_url) {
            try {
              const pdfRes = await fetch(f.file_url);
              if (pdfRes.ok) {
                const buf = await pdfRes.arrayBuffer();
                txt = extractTextFromPdfBuffer(buf);
                if (txt.length > 30) {
                  const { norms, cases } = extractLegalNormsAndCases(txt);
                  await supabase
                    .from("files")
                    .update({
                      extraction_status: "done",
                      extracted_at: new Date().toISOString(),
                      extracted_content: {
                        summary: txt.slice(0, 900),
                        full_text_preview: txt.slice(0, 5000),
                        norms,
                        cases,
                      },
                    })
                    .eq("id", f.id);
                }
              }
            } catch (e) {
              console.warn("Failed to decompress chapter PDF:", f.file_name, e);
            }
          }

          if (txt) {
            const fname = (f.file_name || "").toLowerCase();
            if (/(lösung|musterlösung|falllösung)/i.test(fname)) {
              solutionTexts.push(`=== MUSTERLÖSUNG (${f.file_name}) ===\n${txt}`);
            } else if (/(übung|fallskript|arbeitsblatt|sachverhalt)/i.test(fname)) {
              exerciseTexts.push(`=== ÜBUNGSFALL (${f.file_name}) ===\n${txt}`);
            } else {
              lectureTexts.push(`=== VORLESUNG (${f.file_name}) ===\n${txt}`);
            }
          }
        }

        const combinedChapterText = [...solutionTexts, ...lectureTexts, ...exerciseTexts].join("\n\n");
        const { norms, cases } = extractLegalNormsAndCases(combinedChapterText);

        // Build domain-specific Swiss Law Definitions (ungeschriebene Definitionen zum Auswendiglernen!)
        const courseLower = `${courseName} ${filesList.map((f: any) => f.file_name).join(" ")}`.toLowerCase();

        interface LegalDefinitionItem {
          term: string;
          definition: string;
          keywords: string[];
          norm_anchor: string;
          why_memorize: string;
        }

        const memorizeDefinitions: LegalDefinitionItem[] = [];
        let pruefungsschemaTitle = "Allgemeines Anspruchsprüfungsschema (Gutachtenstil)";
        let pruefungsschemaSteps: { step: string; detail: string }[] = [];
        let pitfalls: string[] = [];
        let sampleSyllogismus = {
          case_question: "Fraglich ist, ob der Anspruch / Tatbestand vorliegend erfüllt ist.",
          obersatz:
            "Zu prüfen ist, ob X gegen Y einen Anspruch auf Schadenersatz in Höhe von CHF ... gemäss Art. 41 Abs. 1 OR (bzw. Art. 97 Abs. 1 OR) hat.",
          definition_rechtssatz:
            "Voraussetzung ist zunächst das Vorliegen eines Schadens. Da das Gesetz den Schadensbegriff nicht definiert, gilt nach ständiger Rechtsprechung (Differenztheorie): Schaden ist eine unfreiwillige Vermögensminderung, die in einer Verminderung der Aktiven, einer Vermehrung der Passiven oder in entgangenem Gewinn besteht (BGE 132 III 359).",
          subsumtion:
            "Vorliegend musste X aufgrund des Vorfalls Heilungskosten von CHF ... bezahlen, wodurch sich seine Aktiven unfreiwillig verringert haben. Eine Vermögensdifferenz im Sinne der Differenztheorie liegt damit vor.",
          konklusion: "Folglich ist das Tatbestandsmerkmal des Schadens gemäss Art. 41 Abs. 1 OR erfüllt.",
        };

        if (/obligationenrecht|\bor\b|haftpflicht|schaden|vertrag/i.test(courseLower)) {
          memorizeDefinitions.push(
            {
              term: "Schaden (Differenztheorie)",
              definition:
                "Schaden ist eine unfreiwillige Vermögensminderung, die in einer Verminderung der Aktiven, einer Vermehrung der Passiven oder in entgangenem Gewinn besteht. Er entspricht der Differenz zwischen dem gegenwärtigen Vermögensstand und dem Stand, den das Vermögen ohne das schädigende Ereignis hätte (BGE 132 III 359).",
              keywords: [
                "unfreiwillige Vermögensminderung",
                "Verminderung der Aktiven",
                "Vermehrung der Passiven",
                "entgangener Gewinn",
                "Differenztheorie",
              ],
              norm_anchor: "Art. 41 Abs. 1 / Art. 97 Abs. 1 OR (nicht im Gesetz definiert!)",
              why_memorize:
                "Steht NICHT im OR! Muss in jeder Haftpflicht- und Vertragsverletzungs-Klausur exakt so im Rechtssatz vor der Subsumtion definiert werden.",
            },
            {
              term: "Natürlicher Kausalzusammenhang (Conditio sine qua non)",
              definition:
                "Ein Verhalten ist natürlich kausal für einen Schaden, wenn es nicht weggedacht werden kann, ohne dass auch der eingetretene Erfolg (Schaden) in seiner konkreten Gestalt entfiele.",
              keywords: ["nicht weggedacht", "Erfolg entfiele", "conditio sine qua non"],
              norm_anchor: "Art. 41 Abs. 1 / Art. 97 Abs. 1 OR",
              why_memorize:
                "Erste Stufe der Kausalitätsprüfung; wird in den ZHAW-Lösungsskizzen stets vor der Adäquanz kurz definiert.",
            },
            {
              term: "Adäquater Kausalzusammenhang",
              definition:
                "Ein Ereignis gilt als adäquat kausal, wenn es nach dem gewöhnlichen Lauf der Dinge und der allgemeinen Lebenserfahrung an sich geeignet ist, einen Erfolg von der Art des eingetretenen herbeizuführen, sodass der Eintritt dieses Erfolgs als durch die fragliche Tatsache wesentlich begünstigt erscheint (BGE 123 III 110).",
              keywords: [
                "gewöhnlicher Lauf der Dinge",
                "allgemeine Lebenserfahrung",
                "geeignet",
                "Erfolg von der Art des eingetretenen",
              ],
              norm_anchor: "Art. 41 Abs. 1 / Art. 97 Abs. 1 OR (Rechtsfrage)",
              why_memorize:
                "Klassische Bundesgerichtsformel – bringt in jeder OR-Klausur sichere Punkte, wenn die 4 Schlüsselwörter fallen.",
            },
            {
              term: "Widerrechtlichkeit (Objektive Widerrechtlichkeitstheorie)",
              definition:
                "Ein Verhalten ist widerrechtlich, wenn es gegen ein allgemeines gesetzliches Gebot oder Verbot verstösst, indem es entweder ein absolutes Rechtsgut direkt verletzt (Erfolgsunrecht, z.B. Körperintegrität, Eigentum) oder einen reinen Vermögensschaden durch Verstoss gegen eine einschlägige Schutznorm bewirkt (Verhaltensunrecht, BGE 119 II 127).",
              keywords: [
                "absolutes Rechtsgut",
                "Erfolgsunrecht",
                "reiner Vermögensschaden",
                "Schutznorm",
                "Verhaltensunrecht",
              ],
              norm_anchor: "Art. 41 Abs. 1 OR",
              why_memorize:
                "Zentral bei reinen Vermögensschäden: Ohne Verletzung eines absoluten Rechtsguts braucht es zwingend eine Schutznorm!",
            },
            {
              term: "Verschulden (Objektivierter Fahrlässigkeitsmassstab)",
              definition:
                "Verschulden ist die subjektive Vorwerfbarkeit eines widerrechtlichen Verhaltens. Es setzt subjektiv Urteilsfähigkeit (Art. 16 ZGB) und objektiv Vorsatz oder Fahrlässigkeit (Mangel an der unter den gegebenen Umständen geforderten Sorgfalt nach objektiviertem Massstab) voraus.",
              keywords: [
                "subjektive Vorwerfbarkeit",
                "Urteilsfähigkeit",
                "Vorsatz oder Fahrlässigkeit",
                "Sorgfaltspflichtwidrigkeit",
                "objektivierter Massstab",
              ],
              norm_anchor: "Art. 41 Abs. 1 / Art. 97 Abs. 1 OR i.V.m. Art. 16 ZGB",
              why_memorize:
                "Bei Art. 41 OR vom Geschädigten zu beweisen; bei Art. 97 Abs. 1 OR wird das Verschulden gesetzlich vermutet (Exkulpationsbeweis).",
            }
          );

          pruefungsschemaTitle =
            "Prüfungsschema: Vertraglicher (Art. 97 OR) & Ausservertraglicher Schadenersatz (Art. 41 OR)";
          pruefungsschemaSteps = [
            {
              step: "1. Schaden (Differenztheorie)",
              detail:
                "Definition hinschreiben (unfreiwillige Vermögensminderung: Aktiven ↓, Passiven ↑, entgangener Gewinn) + Schadensposten beziffern.",
            },
            {
              step: "2. Vertragsverletzung (Art. 97 OR) bzw. Widerrechtlichkeit (Art. 41 OR)",
              detail:
                "Bei Art. 97 OR: Nicht- oder Schlechterfüllung einer vertraglichen Pflicht. Bei Art. 41 OR: Erfolgsunrecht (absolutes Recht) vs. Verhaltensunrecht (Schutznorm bei reinem Vermögensschaden) + kein Rechtfertigungsgrund (Art. 20/52 OR).",
            },
            {
              step: "3. Natürlicher & Adäquater Kausalzusammenhang",
              detail:
                "Conditio sine qua non + Formel: «nach dem gewöhnlichen Lauf der Dinge und der allgemeinen Lebenserfahrung geeignet» + keine Unterbrechung durch grobes Dritt-/Selbstverschulden.",
            },
            {
              step: "4. Verschulden",
              detail:
                "Urteilsfähigkeit (Art. 16 ZGB) + Vorsatz/Fahrlässigkeit. Beachte Beweislast: Art. 97 Abs. 1 OR (Vermutung, «sofern er nicht beweist...») vs. Art. 41 Abs. 1 OR (Beweislast beim Kläger, Art. 8 ZGB).",
            },
            {
              step: "5. Schadenersatzbemessung & Reduktionsgründe (Art. 43/44 OR)",
              detail:
                "Berechnung des Ersatzumfangs, Selbstverschulden des Geschädigten (Art. 44 Abs. 1 OR), Vorteilsanrechnung.",
            },
          ];

          pitfalls = [
            "Urteilsstil-Falle: Niemals schreiben «X muss zahlen, weil ein Schaden vorliegt», sondern immer mit Obersatz starten («Zu prüfen ist, ob...») und erst die Definition von Schaden nennen!",
            "Reiner Vermögensschaden bei Art. 41 OR: Das Vermögen als solches ist KEIN absolutes Rechtsgut – es braucht zwingend eine Schutznorm (Verhaltensunrecht)!",
            "Beweislast bei Art. 97 Abs. 1 OR vs. Art. 41 Abs. 1 OR nicht verwechseln: Bei Art. 97 OR wird das Verschulden vermutet.",
          ];
        } else if (/gesellschaftsrecht|aktiengesellschaft|personengesellschaft|\bag\b|gmbh/i.test(courseLower)) {
          memorizeDefinitions.push(
            {
              term: "Gesellschaftsbegriff (Animus societatis)",
              definition:
                "Eine Gesellschaft ist die vertragsmässige Verbindung von zwei oder mehreren Personen zur Erreichung eines gemeinsamen Zwecks mit gemeinsamen Kräften oder Mitteln (Art. 530 Abs. 1 OR).",
              keywords: [
                "vertragsmässige Verbindung",
                "zwei oder mehrere Personen",
                "gemeinsamer Zweck",
                "gemeinsame Kräfte oder Mittel",
              ],
              norm_anchor: "Art. 530 Abs. 1 OR (Subsidiäre Grundform)",
              why_memorize:
                "Jede Abgrenzung (z.B. Darlehen vs. einfache Gesellschaft) prüft exakt diese 3 Begriffselemente im Gutachtenstil.",
            },
            {
              term: "Kaufmännisches Gewerbe (Abgrenzung Einfache Gesellschaft vs. Kollektivgesellschaft)",
              definition:
                "Ein kaufmännisches Gewerbe ist eine selbständige, auf dauernden Erwerb gerichtete wirtschaftliche Tätigkeit (Art. 552 Abs. 1 OR i.V.m. Art. 2 lit. a HRegV). Wird ein solches gemeinsam geführt, entsteht von Gesetzes wegen eine Kollektivgesellschaft.",
              keywords: [
                "selbständige",
                "auf dauernden Erwerb gerichtete",
                "wirtschaftliche Tätigkeit",
              ],
              norm_anchor: "Art. 530 vs. Art. 552 Abs. 1 OR",
              why_memorize:
                "Liegt ein kaufmännisches Gewerbe vor, entsteht die Kollektivgesellschaft auch ohne HR-Eintrag (deklaratorischer Eintrag)!",
            },
            {
              term: "Sorgfalts- & Treuepflicht / Business Judgment Rule (VR)",
              definition:
                "Geschäftsentscheide des Verwaltungsrats sind gerichtlich nur zurückhaltend zu überprüfen (Business Judgment Rule), sofern der Entscheid in einem einwandfreien, auf angemessener Information beruhenden Verfahren und frei von Interessenkonflikten zustande gekommen ist (BGE 139 III 24).",
              keywords: [
                "einwandfreies Verfahren",
                "angemessene Information",
                "frei von Interessenkonflikten",
                "Business Judgment Rule",
              ],
              norm_anchor: "Art. 717 Abs. 1 OR i.V.m. Art. 754 OR",
              why_memorize:
                "Steht NICHT im Gesetzestext von Art. 717 OR – zentrale BGE-Definition für jede VR-Verantwortlichkeitsprüfung!",
            },
            {
              term: "Mittelbarer vs. Unmittelbarer Schaden (Art. 754 OR)",
              definition:
                "Ein unmittelbarer (direkter) Schaden trifft das Vermögen des Aktionärs oder Gläubigers direkt; ein mittelbarer (indirekter / Reflex-)Schaden trifft primär das Gesellschaftsvermögen der AG und schmälert den Wert der Beteiligung des Aktionärs nur mittelbar.",
              keywords: [
                "Vermögen der Gesellschaft",
                "Reflexschaden",
                "direkt im Vermögen des Aktionärs",
              ],
              norm_anchor: "Art. 754 / Art. 756 OR",
              why_memorize:
                "Entscheidet in der Klausur über die Aktivlegitimation und das Klageziel (Leistung an die Gesellschaft vs. an den Kläger persönlich).",
            }
          );

          pruefungsschemaTitle =
            "Prüfungsschema Gesellschaftsrecht: Qualifikation, Vertretungsmacht & Organhaftung (Art. 754 OR)";
          pruefungsschemaSteps = [
            {
              step: "1. Gesellschaftsrechtliche Qualifikation / Rechtsform",
              detail:
                "Prüfung von Personenverbindung, gemeinsamem Zweck und gemeinsamen Mitteln (Art. 530 OR) bzw. Kapitalgesellschaft mit eigener Rechtspersönlichkeit (Art. 620 OR).",
            },
            {
              step: "2. Vertretung & Bindung der Gesellschaft (Art. 718 / 718a OR)",
              detail:
                "1. Organstellung / Zeichnungsberechtigung (HR-Eintrag) → 2. Handeln im Namen der Gesellschaft → 3. Umfang der Vertretungsmacht: Alle Rechtshandlungen, die der Gesellschaftszweck mit sich bringen kann (nicht durch Zweck ausgeschlossen, BGE 116 II 320) → 4. Gutgläubigkeit des Dritten (Art. 3 ZGB).",
            },
            {
              step: "3. Organverantwortlichkeit (Art. 754 OR)",
              detail:
                "1. Aktiv- & Passivlegitimation (Organbegriff: formell/materiell/faktisch) → 2. Schaden (unmittelbar vs. mittelbar/Reflexschaden) → 3. Pflichtwidrigkeit (Art. 717 OR / Business Judgment Rule) → 4. Natürliche & adäquate Kausalität → 5. Verschulden (jedes Verschulden genügt).",
            },
          ];

          sampleSyllogismus = {
            case_question:
              "Ist der von VR-Mitglied X abgeschlossene Vertrag für die A-AG verbindlich (Art. 718 / 718a OR)?",
            obersatz:
              "Fraglich ist, ob die A-AG durch den von ihrem Verwaltungsrat X abgeschlossenen Kaufvertrag gemäss Art. 718 Abs. 1 i.V.m. Art. 718a Abs. 1 OR wirksam verpflichtet wurde.",
            definition_rechtssatz:
              "Gemäss Art. 718a Abs. 1 OR können die zur Vertretung befugten Personen im Namen der Gesellschaft alle Rechtshandlungen vornehmen, die der Zweck der Gesellschaft mit sich bringen kann. Nach bundesgerichtlicher Rechtsprechung (BGE 116 II 320) umfasst dies alle Geschäfte, die durch den statutarischen Gesellschaftszweck nicht geradezu ausgeschlossen sind.",
            subsumtion:
              "Vorliegend ist X im Handelsregister mit Einzelunterschrift eingetragen und handelte im Namen der A-AG. Der Kauf des Lieferwagens ist durch den statutarischen Zweck (Handel mit Waren) nicht ausgeschlossen, sondern dient dessen Verwirklichung.",
            konklusion:
              "Folglich war X zur Vertretung befugt, sodass die A-AG aus dem Kaufvertrag wirksam berechtigt und verpflichtet wurde.",
          };

          pitfalls = [
            "Zweckgrenze bei Art. 718a Abs. 1 OR: Immer die Bundesgerichts-Definition nennen («nicht durch den Gesellschaftszweck geradezu ausgeschlossen», nicht eng auslegen!).",
            "Darlehen vs. Einfache Gesellschaft: Bei blosser Gewinnbeteiligung (partiarisches Darlehen) fehlt oft der gemeinsame Zweck / Verlusttragung (Animus societatis).",
            "Deklaratorischer vs. konstitutiver Handelsregistereintrag: Kollektivgesellschaft mit kaufmännischem Gewerbe entsteht bereits vor dem HR-Eintrag (Art. 552 OR), die AG erst mit dem HR-Eintrag (Art. 643 OR).",
          ];
        } else if (/strafrecht|tötung|körperverletzung|\bstgb\b|legal memorandum/i.test(courseLower)) {
          memorizeDefinitions.push(
            {
              term: "Vorsatz & Eventualvorsatz (Dolus eventualis, Art. 12 Abs. 2 StGB)",
              definition:
                "Eventualvorsätzlich handelt, wer die Verwirklichung eines Tatbestands zwar nicht mit Gewissheit voraussieht, aber ernsthaft für möglich hält (Wissenskomponente) und die Tatbestandsverwirklichung für den Fall ihres Eintritts in Kauf nimmt bzw. sich mit ihr abfindet (Willenskomponente, BGE 133 IV 9).",
              keywords: [
                "ernsthaft für möglich hält",
                "in Kauf nimmt",
                "sich mit ihr abfindet",
                "Wissens- und Willenskomponente",
              ],
              norm_anchor: "Art. 12 Abs. 2 Satz 2 StGB",
              why_memorize:
                "Wichtigste Abgrenzung zur bewussten Fahrlässigkeit («es werde schon gutgehen» = Vertrauen auf Nichteintritt).",
            },
            {
              term: "Skrupellosigkeit beim Mord (Art. 112 StGB)",
              definition:
                "Skrupellosigkeit liegt vor, wenn der Täter besonders verwerflich handelt, d.h. wenn seine Beweggründe (z.B. Habgier, Rache), der Zweck der Tat oder die Art der Ausführung (z.B. Heimtücke, Grausamkeit) in einer Gesamtwürdigung eine extreme Geringschätzung menschlichen Lebens und ein krasses Missverhältnis zwischen Tat und Anlass offenbaren (BGE 141 IV 61).",
              keywords: [
                "Gesamtwürdigung",
                "extreme Geringschätzung menschlichen Lebens",
                "krasses Missverhältnis",
                "Beweggründe, Zweck oder Art der Ausführung",
              ],
              norm_anchor: "Art. 112 StGB (Qualifikation zu Art. 111 StGB)",
              why_memorize:
                "Mord (Art. 112 StGB) nennt nur Beispiele («namentlich»); für die Subsumtion verlangt die Musterlösung zwingend die Gesamtwürdigungs-Definition!",
            },
            {
              term: "Entschuldbare heftige Gemütsbewegung (Totschlag, Art. 113 StGB)",
              definition:
                "Eine heftige Gemütsbewegung (Affekt) oder grosse seelische Belastung ist entschuldbar, wenn sie bei objektiver Betrachtung unter den gegebenen Umständen menschlich nachvollziehbar erscheint und den Täter nicht vorwiegend eigenes Verschulden am Entstehen der Konfliktsituation trifft.",
              keywords: [
                "Affekt",
                "objektiver Betrachtung",
                "menschlich nachvollziehbar",
                "kein überwiegendes Eigenverschulden",
              ],
              norm_anchor: "Art. 113 StGB (Privilegierung zu Art. 111 StGB)",
              why_memorize:
                "Nicht jeder Wutanfall ist Totschlag: Entscheidend ist die objektive Entschuldbarkeit des Affekts!",
            },
            {
              term: "Tätlichkeit vs. Einfache Körperverletzung (Art. 126 vs. Art. 123 StGB)",
              definition:
                "Eine Tätlichkeit (Art. 126 StGB) ist ein das allgemein übliche und gesellschaftlich geduldete Mass überschreitender physischer Eingriff in die körperliche Integrität, der noch keine Schädigung des Körpers oder der Gesundheit verursacht (z.B. Ohrfeige, Stossen). Eine einfache Körperverletzung (Art. 123 StGB) setzt dagegen eine pathologische Veränderung oder erhebliche Schmerzen mit einer gewissen Heilungsdauer voraus (BGE 134 IV 189).",
              keywords: [
                "gesellschaftlich geduldetes Mass überschreitend",
                "keine Schädigung des Körpers oder der Gesundheit",
                "pathologische Veränderung",
                "Heilungsdauer",
              ],
              norm_anchor: "Art. 123 vs. Art. 126 StGB",
              why_memorize:
                "Im Gesetz steht bei Art. 123 StGB nur «in anderer Weise an Körper oder Gesundheit schädigt» – die Untergrenze zu Art. 126 StGB muss auswendig definiert werden!",
            }
          );

          pruefungsschemaTitle =
            "Strafrechtliches Prüfungsschema (Vorsätzliches Begehungsdelikt im Gutachtenstil)";
          pruefungsschemaSteps = [
            {
              step: "I. Tatbestandsmässigkeit — 1. Objektiver Tatbestand",
              detail:
                "Tätertauglichkeit, Tatobjekt, Tathandlung, Taterfolg sowie natürlicher (conditio sine qua non) und adäquater Kausalzusammenhang / objektive Zurechnung.",
            },
            {
              step: "I. Tatbestandsmässigkeit — 2. Subjektiver Tatbestand",
              detail:
                "Wissen und Willen bezüglich aller objektiven Tatbestandsmerkmale (Art. 12 Abs. 2 StGB: direkter Vorsatz 1./2. Grades oder Eventualvorsatz) + allfällige besondere Absichten / Qualifikationsmerkmale (z.B. Skrupellosigkeit bei Art. 112 StGB).",
            },
            {
              step: "II. Rechtswidrigkeit",
              detail:
                "Grundsätzlich durch die Tatbestandsmässigkeit indiziert, sofern kein gesetzlicher oder aussergesetzlicher Rechtfertigungsgrund greift (z.B. Notwehr Art. 15 StGB, Notstand Art. 17 StGB, Einwilligung).",
            },
            {
              step: "III. Schuld",
              detail:
                "Schuldfähigkeit (Art. 19 StGB), Unrechtsbewusstsein (Art. 21 StGB) und Zumutbarkeit normgemässen Verhaltens (bzw. entschuldbarer Notstand Art. 18 StGB, Notwehrexzess Art. 16 Abs. 2 StGB).",
            },
          ];

          sampleSyllogismus = {
            case_question: "Strafbarkeit des X wegen vorsätzlicher Tötung / Mordes (Art. 111 / 112 StGB)",
            obersatz:
              "Zu prüfen ist, ob sich X durch die Messerstiche gegen Y der vorsätzlichen Tötung gemäss Art. 111 StGB (allenfalls qualifiziert als Mord gemäss Art. 112 StGB) schuldig gemacht hat.",
            definition_rechtssatz:
              "Nach Art. 111 StGB macht sich strafbar, wer vorsätzlich einen Menschen tötet. Qualifiziert nach Art. 112 StGB handelt, wer besonders skrupellos handelt, namentlich wenn Beweggründe, Zweck oder Art der Ausführung in einer Gesamtwürdigung eine extreme Geringschätzung menschlichen Lebens offenbaren (BGE 141 IV 61).",
            subsumtion:
              "Vorliegend ist Y, ein lebender Mensch, infolge der Messerstiche des X verstorben (Taterfolg und Kausalität). X wusste um die Tödlichkeit der Stiche in den Brustbereich und wollte den Tod herbeiführen (Art. 12 Abs. 2 StGB). Da er aus reiner Habgier und heimtückisch von hinten zustach, offenbart sein Handeln in einer Gesamtwürdigung eine extreme Geringschätzung menschlichen Lebens.",
            konklusion:
              "Folglich hat X den objektiven und subjektiven Tatbestand von Art. 112 StGB rechtswidrig und schuldhaft erfüllt und sich des Mordes gemäss Art. 112 StGB schuldig gemacht.",
          };

          pitfalls = [
            "Bei Tötungsdelikten (Art. 111–113 StGB): Immer zuerst den Grundtatbestand (Art. 111 StGB) prüfen oder sauber ankündigen, bevor Qualifikation (Art. 112) bzw. Privilegierung (Art. 113) subsumiert wird!",
            "Beim subjektiven Tatbestand nicht bloss schreiben «X handelte vorsätzlich», sondern explizit Wissens- UND Willenskomponente (Art. 12 Abs. 2 StGB) am Sachverhalt nachweisen.",
            "Rechtswidrigkeit und Schuld am Ende immer kurz feststellen, auch wenn keine Rechtfertigungs-/Schuldausschlussgründe ersichtlich sind.",
          ];
        } else if (/staatsrecht|grundrecht|verfassung|\bbv\b/i.test(courseLower)) {
          memorizeDefinitions.push(
            {
              term: "Schutzbereich & Grundrechtseingriff (Art. 36 BV)",
              definition:
                "Ein Grundrechtseingriff ist jede staatliche Massnahme (Rechtssatz, Realakt oder Verfügung), die eine durch den sachlichen und persönlichen Schutzbereich eines Grundrechts geschützte Tätigkeit oder Rechtsposition erschwert, beschränkt oder verunmöglicht.",
              keywords: [
                "staatliche Massnahme",
                "sachlicher und persönlicher Schutzbereich",
                "erschwert, beschränkt oder verunmöglicht",
              ],
              norm_anchor: "Art. 36 BV",
              why_memorize:
                "Jede Grundrechtsklausur beginnt zwingend mit der Eröffnung des sachlichen und persönlichen Schutzbereichs sowie dem Vorliegen eines Eingriffs.",
            },
            {
              term: "Verhältnismässigkeitsprinzip (Art. 36 Abs. 3 BV — 3 Teilgehalte)",
              definition:
                "Eine staatliche Massnahme ist verhältnismässig, wenn sie 1. zur Erreichung des im öffentlichen Interesse liegenden Ziels geeignet ist (Zwecktauglichkeit), 2. erforderlich ist, d.h. kein milderes, gleich geeignetes Mittel zur Verfügung steht, und 3. für den Betroffenen zumutbar ist, d.h. eine vernünftige Zweck-Mittel-Relation (Verhältnismässigkeit im engeren Sinn) wahrt.",
              keywords: [
                "Eignung (Zwecktauglichkeit)",
                "Erforderlichkeit (mildestes Mittel)",
                "Zumutbarkeit (Zweck-Mittel-Relation)",
              ],
              norm_anchor: "Art. 36 Abs. 3 BV (i.V.m. Art. 5 Abs. 2 BV)",
              why_memorize:
                "In den ZHAW-Musterlösungen zu Staatsrecht II werden über 50 % der Punkte bei der getrennten Subsumtion der 3 Teilgehalte (Eignung, Erforderlichkeit, Zumutbarkeit) vergeben!",
            },
            {
              term: "Allgemeines Rechtsgleichheitsgebot (Art. 8 Abs. 1 BV)",
              definition:
                "Ein Erlass oder Entscheid verletzt das Gebot der Rechtsgleichheit, wenn er rechtliche Unterscheidungen trifft, für die ein vernünftiger Grund in den zu regelnden Verhältnissen nicht ersichtlich ist, oder Unterscheidungen unterlässt, die sich aufgrund der Verhältnisse aufdrängen: Gleiches ist nach Massgabe seiner Gleichheit gleich, Ungleiches nach Massgabe seiner Ungleichheit ungleich zu behandeln (BGE 143 I 361).",
              keywords: [
                "Gleiches nach Massgabe seiner Gleichheit gleich",
                "Ungleiches nach Massgabe seiner Ungleichheit ungleich",
                "sachlicher / vernünftiger Grund",
              ],
              norm_anchor: "Art. 8 Abs. 1 BV",
              why_memorize:
                "Klassische Bundesgerichtsformel, die in jeder Prüfung zu Art. 8 BV wörtlich erwartet wird.",
            },
            {
              term: "Willkürverbot (Art. 9 BV)",
              definition:
                "Willkürlich ist ein staatlicher Akt nicht schon dann, wenn eine andere Lösung ebenfalls vertretbar oder sogar vorzuziehen wäre, sondern erst, wenn er offensichtlich unhaltbar ist, mit der tatsächlichen Situation in klarem Widerspruch steht, eine Norm oder einen unumstrittenen Rechtsgrundsatz krass verletzt oder in stossender Weise dem Gerechtigkeitsgedanken zuwiderläuft (BGE 144 I 113).",
              keywords: [
                "nicht schon wenn andere Lösung vertretbar",
                "offensichtlich unhaltbar",
                "Norm krass verletzt",
                "stossend gegen Gerechtigkeitsgedanken",
              ],
              norm_anchor: "Art. 9 BV",
              why_memorize:
                "Steht NICHT in Art. 9 BV – muss für jede Willkürprüfung auswendig reproduziert werden!",
            }
          );

          pruefungsschemaTitle =
            "Prüfungsschema: Einschränkung von Freiheitsrechten (Art. 36 BV im Gutachtenstil)";
          pruefungsschemaSteps = [
            {
              step: "1. Schutzbereich (Sachlich & Persönlich) und Grundrechtseingriff",
              detail:
                "Welches Grundrecht (z.B. Art. 10, 13, 16, 22, 27 BV / EMRK) ist sachlich betroffen? Ist der Beschwerdeführer persönlich Träger (natürliche/juristische Person, ggf. Schweizerbürgerrecht)? Liegt ein staatlicher Eingriff vor?",
            },
            {
              step: "2. Gesetzliche Grundlage (Art. 36 Abs. 1 BV)",
              detail:
                "Genügend bestimmt (Normdichte) und zuständiges Organ (Normstufe). Wichtig: Vorab prüfen, ob ein schwerer Eingriff vorliegt → dann ist zwingend ein Gesetz im formellen Sinn erforderlich (ausser Polizeinotstand)!",
            },
            {
              step: "3. Öffentliches Interesse / Schutz von Grundrechten Dritter (Art. 36 Abs. 2 BV)",
              detail:
                "Zulässige Motive (Polizeigüter: öffentliche Sicherheit, Ordnung, Gesundheit, Treu und Glauben; sozialpolitische/ökologische Interessen). Rein fiskalische Interessen reichen bei Wirtschaftsfreiheit nicht!",
            },
            {
              step: "4. Verhältnismässigkeit (Art. 36 Abs. 3 BV)",
              detail:
                "Zwingend in 3 Unterpunkten prüfen: a) Eignung (Zwecktauglichkeit), b) Erforderlichkeit (mildestes gleich geeignetes Mittel), c) Zumutbarkeit (Abwägung öffentliches Interesse vs. Schwere der Grundrechtsbetroffenheit).",
            },
            {
              step: "5. Unantastbarkeit des Kerngehalts (Art. 36 Abs. 4 BV)",
              detail:
                "Wird der absolut geschützte Kerngehalt verletzt? Wenn nein und alle Voraussetzungen von Art. 36 Abs. 1–3 BV erfüllt sind → Eingriff verfassungskonform.",
            },
          ];

          sampleSyllogismus = {
            case_question: "Verletzt das Demonstrationsverbot die Versammlungsfreiheit (Art. 22 BV)?",
            obersatz:
              "Fraglich ist, ob die Verweigerung der Bewilligung den X in seiner Versammlungsfreiheit gemäss Art. 22 BV unzulässig einschränkt (Art. 36 BV).",
            definition_rechtssatz:
              "Eine Grundrechtseinschränkung muss nach Art. 36 Abs. 3 BV verhältnismässig sein. Dies setzt voraus, dass die Massnahme zur Erreichung des öffentlichen Interesses geeignet, erforderlich (kein milderes, gleich geeignetes Mittel vorhanden) und für den Betroffenen zumutbar (vernünftige Zweck-Mittel-Relation) ist.",
            subsumtion:
              "Vorliegend ist das Totalverbot zwar geeignet, Krawalle zu verhindern. Es ist jedoch nicht erforderlich, da als milderes Mittel eine Auflagenbewilligung (angepasste Route und Ordnerdienst) ausgereicht hätte, um die öffentliche Sicherheit gleich wirksam zu schützen.",
            konklusion:
              "Folglich verstösst das Totalverbot gegen das Gebot der Erforderlichkeit (Art. 36 Abs. 3 BV) und verletzt Art. 22 BV.",
          };

          pitfalls = [
            "Schwere des Eingriffs immer BEI Art. 36 Abs. 1 BV (Gesetzliche Grundlage) qualifizieren, weil davon abhängt, ob ein formelles Gesetz nötig ist!",
            "Bei Art. 36 Abs. 3 BV niemals pauschal schreiben «Die Massnahme ist verhältnismässig», sondern immer a) Eignung, b) Erforderlichkeit, c) Zumutbarkeit einzeln definieren und subsumieren.",
            "Freiheitsrechte (Prüfung nach Art. 36 BV) strikt von Gleichheitsrechten/Willkür (Art. 8 / Art. 9 BV – eigenes Prüfungsschema ohne Art. 36 BV!) trennen.",
          ];
        } else {
          // Sachverhaltserstellung / Allgemeine Methodenlehre
          memorizeDefinitions.push(
            {
              term: "Juristischer Syllogismus (4-Schritt-Gutachtenstil)",
              definition:
                "Der juristische Syllogismus gliedert jede Teilprüfung zwingend in: 1. Obersatz (Hypothese im Konjunktiv: Wer will was von wem woraus? / Strafbarkeit?), 2. Voraussetzungen & Definition (Rechtssatz: Gesetzesnorm + Definition der unbestimmten Rechtsbegriffe), 3. Subsumtion (Untersatz: Konkreter Lebenssachverhalt wird unter jedes Merkmal der Definition gelegt), 4. Konklusion (Schlusssatz als Antwort auf den Obersatz).",
              keywords: ["Obersatz", "Voraussetzungen / Definition", "Subsumtion", "Konklusion"],
              norm_anchor: "Juristische Methodenlehre (ZHAW Standard)",
              why_memorize:
                "Grundstruktur für jedes Legal Memorandum und jede MEP – wer im Urteilsstil («weil/da») schreibt, verliert in jedem Modul Punkte.",
            },
            {
              term: "Untersuchungsmaxime vs. Verhandlungsmaxime (ZPO / VwVG)",
              definition:
                "Unter der Verhandlungsmaxime (Art. 55 Abs. 1 ZPO) haben die Parteien dem Gericht die Tatsachen darzulegen und die Beweismittel zu bezeichnen. Unter der Untersuchungsmaxime (Art. 12 VwVG / Art. 55 Abs. 2 ZPO) ermittelt die Behörde bzw. das Gericht den rechtserheblichen Sachverhalt von Amtes wegen, wobei die Parteien eine Mitwirkungspflicht (Art. 13 VwVG) treffen kann.",
              keywords: [
                "Tatsachen darlegen",
                "Beweismittel bezeichnen",
                "von Amtes wegen",
                "Mitwirkungspflicht",
              ],
              norm_anchor: "Art. 55 ZPO / Art. 12–13 VwVG",
              why_memorize:
                "Zentral für die Sachverhaltserstellung und die Frage, wer die Folgen der Beweislosigkeit (Art. 8 ZGB) bzw. Sachverhaltsabklärung trägt.",
            }
          );

          pruefungsschemaTitle =
            "Prüfungsschema: Sachverhaltserstellung, Beweiswürdigung & Rechtsmittelkontrolle";
          pruefungsschemaSteps = [
            {
              step: "1. Rechtserheblichkeit der Tatsachen bestimmen (Blickwinkel der Norm)",
              detail:
                "Welche Tatbestandsmerkmale verlangt die massgebliche Rechtsnorm? Nur Tatsachen, die für ein Tatbestandsmerkmal relevant sind, gehören in den erstellten Sachverhalt.",
            },
            {
              step: "2. Trennung von Tatfrage (Sachverhalt) und Rechtsfrage (Würdigung)",
              detail:
                "Im Sachverhalt dürfen keine vorweggenommenen rechtlichen Qualifikationen stehen (z.B. nicht «X kündigte missbräuchlich», sondern konkrete Tatsachen beschreiben).",
            },
            {
              step: "3. Beweismass & Beweislastverteilung (Art. 8 ZGB)",
              detail:
                "Vollbeweis (Überzeugung des Gerichts) vs. überwiegende Wahrscheinlichkeit vs. Glaubhaftmachen. Bleibt eine rechtserhebliche Tatsache unbewiesen, entscheidet die objektive Beweislast (Art. 8 ZGB).",
            },
          ];

          pitfalls = [
            "Rechtsbegriffe im Sachverhalt vorwegnehmen: Im Sachverhalt werden nur Tatsachen (Wer, Wann, Was) geschildert, die rechtliche Bewertung erfolgt erst in der Subsumtion!",
            "Urteilsstil («Da X..., hat er...») statt Gutachtenstil («Fraglich ist, ob... Voraussetzung ist... Vorliegend... Folglich...»).",
          ];
        }

        // Also extract explicit definitions directly from the decompressed ZHAW PDFs of this week!
        const defSentences = combinedChapterText
          .split(/(?<=[.!?])\s+/)
          .map((s) => s.replace(/\s+/g, " ").trim())
          .filter(
            (s) =>
              s.length >= 40 &&
              s.length <= 360 &&
              /(unter\s+[\wäöüÄÖÜß\s-]+\s+versteht\s+man|ist\s+definiert\s+als|bedeutet\s+im\s+sinne|liegt\s+vor,\s+wenn|definition:|begriff:|voraussetzung\s+ist,\s+dass)/i.test(
                s
              )
          );

        for (const ds of defSentences.slice(0, 4)) {
          memorizeDefinitions.push({
            term: `Aus Vorlesung / Lösungsskizze (SW ${weekNum})`,
            definition: ds,
            keywords: ds
              .split(/\s+/)
              .filter((w) => w.length > 6 && /^[A-ZÄÖÜ]/.test(w))
              .slice(0, 4),
            norm_anchor: `Moodle-Unterlagen SW ${weekNum}`,
            why_memorize: "Direkt aus deinen ZHAW-Unterlagen dieser Semesterwoche extrahiert.",
          });
        }

        // Extract authentic Solution Excerpts (Gutachten-Passagen) from the decompressed ZHAW Lösungsskizze
        const solutionExcerpts: string[] = [];
        for (const st of solutionTexts) {
          const cleanLines = st
            .replace(/^===.*===\n/, "")
            .split(/(?<=[.!?])\s+/)
            .map((s) => s.trim())
            .filter((s) => s.length > 45 && !/Seite\s+\d|ZHAW|School of Management/i.test(s));
          if (cleanLines.length > 0) {
            solutionExcerpts.push(cleanLines.slice(0, 8).join(" "));
          }
        }

        return res.status(200).json({
          success: true,
          deep_notes: {
            week_number: weekNum,
            course_name: courseName,
            has_official_solution: solutionTexts.length > 0,
            memorize_definitions: memorizeDefinitions,
            pruefungsschema: {
              title: pruefungsschemaTitle,
              steps: pruefungsschemaSteps,
            },
            syllogismus_guide: sampleSyllogismus,
            solution_excerpts: solutionExcerpts,
            pitfalls,
            norms: norms.slice(0, 12),
            cases: cases.slice(0, 8),
            lecture_preview:
              lectureTexts[0]?.replace(/^===.*===\n/, "").slice(0, 900) ||
              exerciseTexts[0]?.replace(/^===.*===\n/, "").slice(0, 900) ||
              "",
          },
        });
      }

      // =========================================================================
      // 7. CHAPTER TUTOR INTERACTION (Definition Drill, Gutachten-Trainer, Feynman, Brain Dump)
      // =========================================================================
      case "chapter_tutor_interaction": {
        const mode = String(body.mode || "gutachten_trainer");
        const userAnswer = String(body.user_answer || "").trim();
        const targetTerm = String(body.target_term || "");
        const targetDefinition = String(body.target_definition || "");
        const targetKeywords: string[] = Array.isArray(body.target_keywords) ? body.target_keywords : [];

        if (!userAnswer) {
          return res.status(400).json({ error: "Bitte gib zuerst deine Antwort oder Lösung ein." });
        }

        if (mode === "definition_drill") {
          const lowerAns = userAnswer.toLowerCase();
          const matchedKeywords: string[] = [];
          const missedKeywords: string[] = [];

          const checkList =
            targetKeywords.length > 0
              ? targetKeywords
              : targetDefinition
                  .split(/[\s,;().]+/)
                  .filter((w) => w.length >= 6 && /^[A-ZÄÖÜ]/.test(w))
                  .slice(0, 5);

          for (const kw of checkList) {
            const parts = kw
              .toLowerCase()
              .split(/\s+/)
              .filter((p) => p.length >= 4);
            const hit = parts.some((p) => lowerAns.includes(p.slice(0, Math.max(4, p.length - 2))));
            if (hit) {
              matchedKeywords.push(kw);
            } else {
              missedKeywords.push(kw);
            }
          }

          const score =
            checkList.length > 0
              ? Math.round((matchedKeywords.length / checkList.length) * 100)
              : 80;

          return res.status(200).json({
            success: true,
            evaluation: {
              mode: "definition_drill",
              score,
              verdict:
                score >= 80
                  ? "Exzellent! Diese Definition sitzt prüfungsreif für die MEP."
                  : score >= 50
                  ? "Gute Basis – aber für die volle Punktzahl in der Lösungsskizze fehlen noch Schlüsselbegriffe."
                  : "Noch unvollständig – präge dir die fehlenden Tatbestandselemente der Definition nochmals genau ein.",
              matched_keywords: matchedKeywords,
              missed_keywords: missedKeywords,
              official_definition: targetDefinition,
              term: targetTerm,
            },
          });
        }

        if (mode === "gutachten_trainer") {
          // Strictly evaluate Obersatz, Definition/Rechtssatz, Subsumtion, Konklusion & Urteilsstil traps
          const hasObersatz =
            /(fraglich\s+ist|zu\s+prüfen\s+ist|es\s+stellt\s+sich\s+die\s+frage|voraussetzung\s+dafür,\s+dass|könnte\s+einen\s+anspruch|könnte\s+sich.*strafbar)/i.test(
              userAnswer
            );
          const hasUrteilsstilTrap =
            /\b(da\s+er|weil\s+er|weil\s+vorliegend|somit\s+hat\s+er.*weil|ist\s+schuldig,\s+weil|hat\s+einen\s+anspruch,\s+da)\b/i.test(
              userAnswer
            );
          const hasDefinition =
            /(versteht\s+man|definiert|voraussetzung\s+ist|gemäss\s+art\.|nach\s+art\.|bedeutet|liegt\s+vor,\s+wenn|differenztheorie|unfreiwillige|gewöhnlichen\s+lauf|schutzbereich|verhältnismässig|skrupellos)/i.test(
              userAnswer
            );
          const hasSubsumtion =
            /(vorliegend|im\s+vorliegenden\s+fall|laut\s+sachverhalt|konkret|hier\s+hat|indem\s+er|dadurch,\s+dass)/i.test(
              userAnswer
            );
          const hasKonklusion =
            /(folglich|somit|demnach|im\s+ergebnis|damit\s+ist|zusammenfassend|ergo)/i.test(
              userAnswer
            );
          const citedNorms =
            userAnswer.match(/\bArt\.?\s*\d+[a-z]?(?:\s*Abs\.?\s*\d+)?(?:\s*(?:OR|ZGB|StGB|BV|ZPO|VwVG|BGG))?/gi) ||
            [];

          const stepsCheck = [
            {
              label: "1. Obersatz (Hypothese im Konjunktiv)",
              passed: hasObersatz,
              feedback: hasObersatz
                ? "✅ Sauberer Obersatz erkannt («Zu prüfen ist / Fraglich ist, ob...»)."
                : "⚠️ Obersatz fehlt! Starte zwingend mit: «Zu prüfen ist, ob X gegen Y einen Anspruch auf ... gemäss Art. ... hat» (bzw. «ob sich X gemäss Art. ... strafbar gemacht hat»).",
            },
            {
              label: "2. Voraussetzungen & Auswendig-Definition (Rechtssatz)",
              passed: hasDefinition,
              feedback: hasDefinition
                ? `✅ Rechtssatz / Definition erkannt (${citedNorms.length > 0 ? `Normen: ${citedNorms.join(", ")}` : "denke zusätzlich an das exakte Gesetzeszitat mit Abs./lit.!"}).`
                : "⚠️ Definition fehlt vor der Subsumtion! Nenne erst die gesetzlichen Tatbestandsmerkmale und definiere den Rechtsbegriff abstrakt, bevor du auf den Fall eingehst.",
            },
            {
              label: "3. Subsumtion am konkreten Sachverhalt (Untersatz)",
              passed: hasSubsumtion,
              feedback: hasSubsumtion
                ? "✅ Sachverhalts-Subsumtion («Vorliegend...») vorhanden."
                : "⚠️ Keine klare Subsumtion erkennbar! Verknüpfe jedes Merkmal deiner Definition mit dem Sachverhalt («Vorliegend hat X...»).",
            },
            {
              label: "4. Konklusion (Spiegelbild zum Obersatz)",
              passed: hasKonklusion,
              feedback: hasKonklusion
                ? "✅ Konklusion («Folglich / Somit...») sauber gezogen."
                : "⚠️ Konklusion fehlt! Schliesse den Syllogismus mit «Folglich / Somit ist das Tatbestandsmerkmal ... erfüllt» ab.",
            },
            {
              label: "5. Strikter Gutachtenstil (Kein Urteilsstil)",
              passed: !hasUrteilsstilTrap,
              feedback: !hasUrteilsstilTrap
                ? "✅ Kein Urteilsstil-Fehler («weil / da» vorweggenommen) entdeckt."
                : "❌ Achtung Urteilsstil-Falle! Du hast das Ergebnis mit «weil / da» vorweggenommen. Im Gutachtenstil steht das Ergebnis immer erst am Schluss nach «Folglich / Somit»!",
            },
          ];

          const passedCount = stepsCheck.filter((s) => s.passed).length;
          const score = Math.round((passedCount / stepsCheck.length) * 100);

          return res.status(200).json({
            success: true,
            evaluation: {
              mode: "gutachten_trainer",
              score,
              steps_check: stepsCheck,
              cited_norms: citedNorms,
              verdict:
                score === 100
                  ? "Perfekter ZHAW-Gutachtenstil! Alle 4 Syllogismus-Schritte sitzen."
                  : score >= 60
                  ? "Guter Aufbau – beachte die markierten Hinweise im Syllogismus-Check für volle Punkte."
                  : "Überarbeite deine Lösung nochmals strikt im 4-Schritt-Syllogismus (Obersatz → Definition → Subsumtion → Konklusion).",
            },
          });
        }

        // Default: Brain Dump / Feynman feedback
        const lowerAns = userAnswer.toLowerCase();
        const hitTerms = targetKeywords.filter((kw) =>
          kw
            .toLowerCase()
            .split(/\s+/)
            .filter((w) => w.length >= 4)
            .some((w) => lowerAns.includes(w.slice(0, Math.max(4, w.length - 2))))
        );
        const missedTerms = targetKeywords.filter((kw) => !hitTerms.includes(kw));

        return res.status(200).json({
          success: true,
          evaluation: {
            mode,
            score:
              targetKeywords.length > 0
                ? Math.round((hitTerms.length / targetKeywords.length) * 100)
                : 85,
            matched_keywords: hitTerms,
            missed_keywords: missedTerms,
            verdict:
              missedTerms.length === 0
                ? "Stark! Du hast alle Kernbegriffe und Definitionselemente dieser Semesterwoche aktiv abgerufen."
                : `Du hast ${hitTerms.length} Konzepte getroffen. Wiederhole gezielt die ${missedTerms.length} noch fehlenden Begriffe/Normen.`,
          },
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
