import { createClient } from "@supabase/supabase-js";
import {
  extractTextFromPdfBuffer,
  extractDeadlinesFromText,
  extractLegalNormsAndCases,
} from "./ai";

export const maxDuration = 60; // Allow up to 60 seconds on Vercel

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

async function moodleApi(baseUrl: string, token: string, func: string, params: Record<string, string> = {}) {
  const url = new URL(`${baseUrl.replace(/\/+$/, "")}/webservice/rest/server.php`);
  url.searchParams.set("wstoken", token);
  url.searchParams.set("wsfunction", func);
  url.searchParams.set("moodlewsrestformat", "json");
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  const res = await fetch(url.toString());
  const data = await res.json();
  if (data?.exception) {
    throw new Error(`Moodle error: ${data.message} (${data.errorcode})`);
  }
  return data;
}

const DEADLINE_SIGNAL_REGEX =
  /(leistungsnachweis|usln|abgabe|einreichung|einsendung|hochladen|frist|deadline|prüfung|klausur|test|kurztest|zwischenprüfung|fallbearbeitung|referat|präsentation|moot|bis\s+spätestens|bis\s+zum|\bbis\b|fällig)/i;

const SYLLABUS_PDF_REGEX =
  /(leistungsnachweis|usln|fallbearbeitung|merkblatt|modulübersicht|modulbeschreibung|semesterprogramm|semesterwochenprogramm|programm|zeitplan|termin|leitfaden|syllabus|übersicht)/i;

function extractSemester(name: string, shortName?: string | null): string {
  const text = `${shortName || ""} ${name || ""}`;
  const match = text.match(/(\d{4})[.-](FS|HS)/i) || text.match(/(FS|HS)[-\s.]*(\d{4})/i);
  if (match) {
    if (match[1].length === 4) {
      return `${match[1]}-${match[2].toUpperCase()}`;
    } else {
      return `${match[2]}-${match[1].toUpperCase()}`;
    }
  }
  return "other";
}

function courseMatchesSemester(course: any, filter?: string): boolean {
  if (!filter || filter === "all") return true;
  const sem = extractSemester(course.fullname, course.shortname);
  if (filter === "other") return sem === "other";

  const norm = filter.replace(/\s+/g, "-").toUpperCase();
  const reversed = norm.includes("-FS")
    ? `FS-${norm.split("-")[0]}`
    : norm.includes("-HS")
    ? `HS-${norm.split("-")[0]}`
    : norm;

  return sem.toUpperCase() === norm || sem.toUpperCase() === reversed;
}

function classifyNoteType(text: string): string {
  if (/lernziel|learning\s*objective|kompetenz|studierenden\s+können/i.test(text)) return "lernziel";
  if (/leistungsnachweis|usln|prüfung|abgabe|frist|termin|organisatorisch|merkblatt|hilfsmittel/i.test(text))
    return "organizational";
  if (/übung|aufgabe|fall\s*\d|fallbearbeitung|frage|lösen|besprechung/i.test(text)) return "exercise";
  if (/lektüre|pflichtlektüre|lesen|kapitel|literatur|buch|seite\s*\d/i.test(text)) return "reading";
  if (/vorbereitung|vor\s+der\s+vorlesung|selbststudium|auftrag/i.test(text)) return "prep";
  if (/zusammenfassung|überblick|repetitorium|fazit/i.test(text)) return "summary";
  return "general";
}

async function resolveMoodleToken(supabase: any, user_id: string, providedToken?: string): Promise<string | null> {
  if (providedToken && providedToken.trim().length > 5) {
    return providedToken.trim();
  }
  const { data: profile } = await supabase
    .from("profiles")
    .select("moodle_token")
    .eq("user_id", user_id)
    .maybeSingle();
  if (profile?.moodle_token) {
    return profile.moodle_token;
  }
  // Fallback: extract token from existing synced file_url in `files`
  const { data: sampleFile } = await supabase
    .from("files")
    .select("file_url")
    .eq("user_id", user_id)
    .not("file_url", "is", null)
    .limit(1)
    .maybeSingle();
  if (sampleFile?.file_url) {
    const m = sampleFile.file_url.match(/[?&]token=([a-f0-9]{16,64})/i);
    if (m) return m[1];
  }
  return null;
}

async function syncSingleCourse(
  supabase: any,
  user_id: string,
  moodle_base_url: string,
  moodle_token: string,
  moodle_course_id: number,
  courseDbId: string | null,
  courseDisplayName = "Kurs"
) {
  let totalFiles = 0;
  let totalNotes = 0;
  let totalDeadlines = 0;
  const cleanCourse = courseDisplayName.replace(/\s*\(\d{4}-(FS|HS)\)/i, "");

  try {
    const contents = await moodleApi(moodle_base_url, moodle_token, "core_course_get_contents", {
      courseid: String(moodle_course_id),
    });

    for (const section of contents) {
      if (section.summary && section.summary.trim().length > 15) {
        const plainText = section.summary.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
        const noteType = classifyNoteType(`${section.name || ""} ${plainText}`);
        const { data: exists } = await supabase
          .from("notes")
          .select("id")
          .eq("user_id", user_id)
          .eq("title", section.name || "Section")
          .eq("source", "moodle")
          .maybeSingle();

        if (!exists && plainText.length > 20) {
          await supabase.from("notes").insert({
            user_id,
            course_id: courseDbId,
            title: section.name || "Section",
            content: plainText,
            note_type: noteType,
            source: "moodle",
          });
          totalNotes++;
        }

        const inlineDates = extractDeadlinesFromText(
          plainText,
          `${cleanCourse} — ${section.name || "Abschnitt"}`,
          courseDbId,
          "moodle_text",
          true
        );
        for (const d of inlineDates) {
          const { data: dlExists } = await supabase
            .from("deadlines")
            .select("id")
            .eq("user_id", user_id)
            .eq("title", d.title)
            .maybeSingle();
          if (!dlExists) {
            await supabase.from("deadlines").insert({
              user_id,
              course_id: courseDbId,
              title: d.title,
              description: d.description,
              due_date: d.due_date,
              source: "moodle_text",
            });
            totalDeadlines++;
          }
        }
      }

      for (const mod of section.modules || []) {
        // 1. Check Moodle 4.x module dates array
        if (Array.isArray(mod.dates)) {
          for (const dtObj of mod.dates) {
            const label = (dtObj.label || "").toLowerCase();
            const isClosingOrDue =
              label.includes("due") ||
              label.includes("fällig") ||
              label.includes("close") ||
              label.includes("schliesst") ||
              label.includes("schließt") ||
              label.includes("ende") ||
              label.includes("abgabe") ||
              DEADLINE_SIGNAL_REGEX.test(mod.name || "");

            if (dtObj.timestamp && dtObj.timestamp > 0 && isClosingOrDue) {
              const dueIso = new Date(dtObj.timestamp * 1000).toISOString();
              const title = mod.name || `${section.name} Termin`;
              const { data: dlExists } = await supabase
                .from("deadlines")
                .select("id")
                .eq("user_id", user_id)
                .eq("title", title)
                .maybeSingle();

              if (!dlExists) {
                await supabase.from("deadlines").insert({
                  user_id,
                  course_id: courseDbId,
                  title,
                  description: `${dtObj.label || "Termin"} (${mod.modplural || mod.modname || "Moodle"})`,
                  due_date: dueIso,
                  source: `moodle_${mod.modname || "module"}`,
                  moodle_assignment_id: mod.id,
                });
                totalDeadlines++;
              }
            }
          }
        }

        // 2. Notes & inline deadlines from module descriptions
        const modDesc = (mod.description || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
        const modTitle = `${section.name || "Section"} — ${mod.name || "Module"}`;

        if (modDesc.length >= 25) {
          const { data: exists } = await supabase
            .from("notes")
            .select("id")
            .eq("user_id", user_id)
            .eq("title", modTitle)
            .eq("source", "moodle")
            .maybeSingle();

          if (!exists) {
            await supabase.from("notes").insert({
              user_id,
              course_id: courseDbId,
              title: modTitle,
              content: modDesc,
              note_type: classifyNoteType(`${modTitle} ${modDesc}`),
              source: "moodle",
            });
            totalNotes++;
          }
        }

        const combinedModText = `${mod.name || ""}. ${modDesc}`;
        const modInlineDates = extractDeadlinesFromText(
          combinedModText,
          `${cleanCourse} — ${mod.name || section.name || "Modul"}`,
          courseDbId,
          "moodle_text",
          true
        );
        for (const d of modInlineDates) {
          const { data: dlExists } = await supabase
            .from("deadlines")
            .select("id")
            .eq("user_id", user_id)
            .eq("title", d.title)
            .maybeSingle();
          if (!dlExists) {
            await supabase.from("deadlines").insert({
              user_id,
              course_id: courseDbId,
              title: d.title,
              description: d.description,
              due_date: d.due_date,
              source: "moodle_text",
            });
            totalDeadlines++;
          }
        }

        // 3. Files from modules (+ automatic zlib PDF extraction for USLN/Merkblatt/Syllabus PDFs)
        const allFiles: any[] = [];
        if (Array.isArray(mod.contents)) {
          for (const f of mod.contents) {
            if (f.type === "file" || f.type === "content") allFiles.push(f);
          }
        }
        if (Array.isArray(mod.introfiles)) {
          for (const f of mod.introfiles) allFiles.push({ ...f, type: "file" });
        }
        if (Array.isArray(mod.contentfiles)) {
          for (const f of mod.contentfiles) allFiles.push({ ...f, type: "file" });
        }

        for (const file of allFiles) {
          const fname = file.filename || file.name;
          if (!fname || fname === ".") continue;

          const furl = file.fileurl || null;
          const tokenizedUrl = furl
            ? `${furl}${furl.includes("?") ? "&" : "?"}token=${moodle_token}`
            : null;

          const { data: existingFile } = await supabase
            .from("files")
            .select("id, extracted_content")
            .eq("user_id", user_id)
            .eq("file_name", fname)
            .eq(courseDbId ? "course_id" : "user_id", courseDbId || user_id)
            .maybeSingle();

          let fileDbId = existingFile?.id;
          if (!existingFile) {
            const { data: insertedFile, error: insertErr } = await supabase
              .from("files")
              .insert({
                user_id,
                course_id: courseDbId,
                file_name: fname,
                file_type: file.mimetype || file.type || null,
                file_size: file.filesize || null,
                moodle_file_url: furl,
                file_url: tokenizedUrl,
              })
              .select("id")
              .single();
            if (!insertErr && insertedFile) {
              fileDbId = insertedFile.id;
              totalFiles++;
            }
          }

          // Automatically decompress & extract deadlines from syllabus/USLN/Merkblatt PDFs
          const needsPdfDeepScan =
            fname.toLowerCase().endsWith(".pdf") &&
            SYLLABUS_PDF_REGEX.test(fname) &&
            tokenizedUrl &&
            (!existingFile?.extracted_content?.full_text_preview);

          if (needsPdfDeepScan && fileDbId) {
            try {
              const pdfRes = await fetch(tokenizedUrl);
              if (pdfRes.ok) {
                const buf = await pdfRes.arrayBuffer();
                const pdfText = extractTextFromPdfBuffer(buf);
                if (pdfText.length > 30) {
                  const pdfDeadlines = extractDeadlinesFromText(
                    pdfText,
                    `${cleanCourse} — ${fname.replace(/\.pdf$/i, "")}`,
                    courseDbId,
                    "scanner_pdf",
                    true
                  );
                  const { norms, cases } = extractLegalNormsAndCases(pdfText);

                  await supabase
                    .from("files")
                    .update({
                      extraction_status: "done",
                      extracted_at: new Date().toISOString(),
                      extracted_content: {
                        summary: pdfText.slice(0, 900),
                        full_text_preview: pdfText.slice(0, 3500),
                        norms,
                        cases,
                        deadlines: pdfDeadlines,
                      },
                    })
                    .eq("id", fileDbId);

                  for (const pd of pdfDeadlines) {
                    const { data: dlExists } = await supabase
                      .from("deadlines")
                      .select("id")
                      .eq("user_id", user_id)
                      .eq("course_id", courseDbId)
                      .gte("due_date", `${pd.due_date.slice(0, 10)}T00:00:00.000Z`)
                      .lte("due_date", `${pd.due_date.slice(0, 10)}T23:59:59.999Z`)
                      .maybeSingle();

                    if (!dlExists) {
                      await supabase.from("deadlines").insert({
                        user_id,
                        course_id: courseDbId,
                        title: pd.title,
                        description: pd.description,
                        due_date: pd.due_date,
                        source: "scanner_pdf",
                        is_completed: false,
                      });
                      totalDeadlines++;
                    }
                  }
                }
              }
            } catch (e) {
              console.warn(`Auto PDF scan failed for ${fname}:`, e);
            }
          }
        }
      }
    }
  } catch (err: any) {
    console.error(`Error syncing course ${moodle_course_id}:`, err.message);
  }

  return { files: totalFiles, notes: totalNotes, deadlines: totalDeadlines };
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
    const body =
      req.method === "GET"
        ? { action: "autopilot_sync" }
        : typeof req.body === "string"
        ? JSON.parse(req.body)
        : req.body || {};

    const {
      action = "autopilot_sync",
      moodle_base_url = "https://moodle.zhaw.ch",
      user_id = DEFAULT_USER_ID,
    } = body;

    const moodle_token = await resolveMoodleToken(supabase, user_id, body.moodle_token);

    if (!moodle_token) {
      return res.status(400).json({ error: "Missing moodle_token" });
    }

    // Persist token on profile so daily background syncs always have it
    if (body.moodle_token) {
      await supabase
        .from("profiles")
        .upsert({ user_id, moodle_token }, { onConflict: "user_id" });
    }

    let result: unknown;

    switch (action) {
      case "verify": {
        result = await moodleApi(moodle_base_url, moodle_token, "core_webservice_get_site_info");
        break;
      }

      case "get_available_semesters": {
        const siteInfo = await moodleApi(moodle_base_url, moodle_token, "core_webservice_get_site_info");
        const allCourses = await moodleApi(moodle_base_url, moodle_token, "core_enrol_get_users_courses", {
          userid: String(siteInfo.userid),
        });
        const semesters = new Set<string>();
        for (const c of allCourses) {
          const sem = extractSemester(c.fullname, c.shortname);
          if (sem && sem !== "other") semesters.add(sem);
        }
        result = {
          semesters: Array.from(semesters).sort().reverse(),
        };
        break;
      }

      case "get_courses": {
        const siteInfo = await moodleApi(moodle_base_url, moodle_token, "core_webservice_get_site_info");
        result = await moodleApi(moodle_base_url, moodle_token, "core_enrol_get_users_courses", {
          userid: String(siteInfo.userid),
        });
        break;
      }

      case "get_course_contents": {
        const { course_id } = body;
        if (!course_id) {
          return res.status(400).json({ error: "Missing course_id" });
        }
        result = await moodleApi(moodle_base_url, moodle_token, "core_course_get_contents", {
          courseid: String(course_id),
        });
        break;
      }

      case "get_assignments": {
        const assignData = await moodleApi(moodle_base_url, moodle_token, "mod_assign_get_assignments");
        result = assignData.courses || [];
        break;
      }

      case "get_calendar_events": {
        result = await moodleApi(moodle_base_url, moodle_token, "core_calendar_get_calendar_events", {
          "events[timestart]": String(Math.floor(Date.now() / 1000)),
          "events[timeend]": String(Math.floor(Date.now() / 1000) + 180 * 86400),
        });
        break;
      }

      case "autopilot_sync":
      case "sync_all": {
        const siteInfo = await moodleApi(moodle_base_url, moodle_token, "core_webservice_get_site_info");
        const allCourses = await moodleApi(moodle_base_url, moodle_token, "core_enrol_get_users_courses", {
          userid: String(siteInfo.userid),
        });

        const IGNORED_COURSES = ["modulendprüfungen bsc", "law board"];
        let courses = allCourses.filter((c: any) => {
          const name = (c.fullname || "").toLowerCase();
          return !IGNORED_COURSES.some((ignored) => name.includes(ignored));
        });

        // Default autopilot to newest semester (e.g. "2026-HS") unless specified
        let semester_filter = body.semester_filter;
        if (!semester_filter) {
          const detectedSemesters = new Set<string>();
          for (const c of courses) {
            const s = extractSemester(c.fullname, c.shortname);
            if (s !== "other") detectedSemesters.add(s);
          }
          const sortedSem = Array.from(detectedSemesters).sort().reverse();
          semester_filter = sortedSem[0] || "all";
        }

        if (semester_filter && semester_filter !== "all") {
          courses = courses.filter((c: any) => courseMatchesSemester(c, semester_filter));
        }

        let totalDeadlines = 0;
        const dbCourseMap: Record<number, string> = {};

        // 1. Upsert courses
        for (const course of courses) {
          const { data: existing } = await supabase
            .from("courses")
            .select("id")
            .eq("user_id", user_id)
            .eq("moodle_course_id", course.id)
            .maybeSingle();

          let courseId = existing?.id;
          if (existing) {
            await supabase
              .from("courses")
              .update({
                name: course.fullname,
                short_name: course.shortname,
                last_synced_at: new Date().toISOString(),
              })
              .eq("id", existing.id);
          } else {
            const { data: inserted } = await supabase
              .from("courses")
              .insert({
                user_id,
                moodle_course_id: course.id,
                name: course.fullname,
                short_name: course.shortname,
                is_synced: true,
                last_synced_at: new Date().toISOString(),
              })
              .select("id")
              .single();
            courseId = inserted?.id;
          }

          if (courseId) {
            dbCourseMap[course.id] = courseId;
          }
        }

        // 2. Deadlines from assignments
        try {
          const assignData = await moodleApi(moodle_base_url, moodle_token, "mod_assign_get_assignments");
          for (const ac of assignData.courses || []) {
            const courseDbId = dbCourseMap[ac.id];
            if (semester_filter !== "all" && !courseDbId) continue;
            for (const assign of ac.assignments || []) {
              if (assign.duedate && assign.duedate > 0) {
                const { data: exists } = await supabase
                  .from("deadlines")
                  .select("id")
                  .eq("user_id", user_id)
                  .eq("moodle_assignment_id", assign.id)
                  .maybeSingle();

                if (!exists) {
                  await supabase.from("deadlines").insert({
                    user_id,
                    course_id: courseDbId || null,
                    title: assign.name,
                    description: assign.intro?.replace(/<[^>]*>/g, "") || null,
                    due_date: new Date(assign.duedate * 1000).toISOString(),
                    source: "moodle",
                    moodle_assignment_id: assign.id,
                  });
                  totalDeadlines++;
                }
              }
            }
          }
        } catch (e) {
          console.warn("Could not fetch assignments:", e);
        }

        // 3. Deadlines from Moodle Quizzes
        try {
          const quizData = await moodleApi(moodle_base_url, moodle_token, "mod_quiz_get_quizzes_by_courses");
          for (const quiz of quizData.quizzes || []) {
            const courseDbId = dbCourseMap[quiz.course];
            if (semester_filter !== "all" && !courseDbId) continue;
            const dueTimestamp = quiz.timeclose && quiz.timeclose > 0 ? quiz.timeclose : quiz.timeopen;
            if (dueTimestamp && dueTimestamp > 0) {
              const dueIso = new Date(dueTimestamp * 1000).toISOString();
              const title = quiz.name || "Moodle Quiz / Test";
              const { data: exists } = await supabase
                .from("deadlines")
                .select("id")
                .eq("user_id", user_id)
                .eq("title", title)
                .maybeSingle();

              if (!exists) {
                await supabase.from("deadlines").insert({
                  user_id,
                  course_id: courseDbId || null,
                  title,
                  description: quiz.intro ? quiz.intro.replace(/<[^>]*>/g, "").trim() : "Moodle Test / Quiz",
                  due_date: dueIso,
                  source: "moodle_quiz",
                  moodle_assignment_id: quiz.id,
                });
                totalDeadlines++;
              }
            }
          }
        } catch (e) {
          console.warn("Could not fetch quizzes:", e);
        }

        // 4. Deadlines from Moodle Calendar events
        try {
          const calData = await moodleApi(moodle_base_url, moodle_token, "core_calendar_get_calendar_events", {
            "events[timestart]": String(Math.floor(Date.now() / 1000) - 14 * 86400),
            "events[timeend]": String(Math.floor(Date.now() / 1000) + 210 * 86400),
          });
          for (const ev of calData.events || []) {
            if (ev.timestart && ev.name) {
              const courseDbId = ev.courseid ? dbCourseMap[ev.courseid] : null;
              if (semester_filter !== "all" && ev.courseid && !courseDbId) continue;
              const { data: exists } = await supabase
                .from("deadlines")
                .select("id")
                .eq("user_id", user_id)
                .eq("title", ev.name)
                .eq("due_date", new Date(ev.timestart * 1000).toISOString())
                .maybeSingle();

              if (!exists) {
                await supabase.from("deadlines").insert({
                  user_id,
                  course_id: courseDbId || null,
                  title: ev.name,
                  description: ev.description?.replace(/<[^>]*>/g, "") || null,
                  due_date: new Date(ev.timestart * 1000).toISOString(),
                  source: "moodle_calendar",
                  moodle_assignment_id: ev.id,
                });
                totalDeadlines++;
              }
            }
          }
        } catch (e) {
          console.warn("Could not fetch calendar events:", e);
        }

        // 5. Server-Side Course Content, Files & Automatic PDF Decompression
        let totalFiles = 0;
        let totalNotes = 0;
        const sync_files = body.sync_files !== false;
        if (sync_files && courses.length > 0) {
          const CHUNK_SIZE = 3;
          for (let i = 0; i < courses.length; i += CHUNK_SIZE) {
            const chunk = courses.slice(i, i + CHUNK_SIZE);
            const results = await Promise.all(
              chunk.map((c: any) =>
                syncSingleCourse(
                  supabase,
                  user_id,
                  moodle_base_url,
                  moodle_token,
                  c.id,
                  dbCourseMap[c.id] || null,
                  c.fullname || "Kurs"
                )
              )
            );
            for (const r of results) {
              totalFiles += r.files;
              totalNotes += r.notes;
              totalDeadlines += r.deadlines;
            }
          }
        }

        // 6. Update profile last synced timestamp
        await supabase.from("profiles").upsert(
          {
            user_id,
            moodle_token,
            moodle_verified_at: new Date().toISOString(),
          },
          { onConflict: "user_id" }
        );

        result = {
          success: true,
          synced_courses: courses.length,
          total_files: totalFiles,
          total_notes: totalNotes,
          total_deadlines: totalDeadlines,
          semester: semester_filter,
          synced_at: new Date().toISOString(),
          message: `Autopilot Sync abgeschlossen (${semester_filter}): ${courses.length} Kurse, ${totalFiles} neue Dateien, ${totalDeadlines} neue Termine.`,
        };
        break;
      }

      case "sync_course": {
        const { moodle_course_id, course_db_id, course_name } = body;
        if (!moodle_course_id) throw new Error("moodle_course_id required");
        result = await syncSingleCourse(
          supabase,
          user_id,
          moodle_base_url,
          moodle_token,
          moodle_course_id,
          course_db_id || null,
          course_name || "Kurs"
        );
        break;
      }

      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }

    return res.status(200).json(result);
  } catch (err: any) {
    console.error("moodle-sync error:", err);
    return res.status(500).json({ error: err.message || "Internal server error" });
  }
}
