import { createClient } from "@supabase/supabase-js";

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

/**
 * Parses semester code like "2026-FS" or "2025-HS" from course full/short name.
 * Format: w.BA.XX.nameofcourse-RE.Year.Semester
 */
function extractSemester(name: string, shortName?: string | null): string {
  const text = `${shortName || ""} ${name || ""}`;
  const match = text.match(/(\d{4})-(FS|HS)/i) || text.match(/(FS|HS)[-\s]*(\d{4})/i);
  if (match) {
    if (match[1].length === 4) {
      return `${match[1]}-${match[2].toUpperCase()}`; // e.g. "2026-FS"
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

async function syncSingleCourse(
  supabase: any,
  user_id: string,
  moodle_base_url: string,
  moodle_token: string,
  moodle_course_id: number,
  courseDbId: string | null
) {
  let totalFiles = 0;
  let totalNotes = 0;

  try {
    const contents = await moodleApi(moodle_base_url, moodle_token, "core_course_get_contents", {
      courseid: String(moodle_course_id),
    });

    for (const section of contents) {
      // Notes from section descriptions (Lernziele / Vorbereitung)
      if (section.summary && section.summary.trim().length > 20) {
        const plainText = section.summary.replace(/<[^>]*>/g, "").trim();
        const isLernziel = /lernziel|learning\s*objective|kompetenz/i.test(plainText);
        const { data: exists } = await supabase
          .from("notes")
          .select("id")
          .eq("user_id", user_id)
          .eq("title", section.name || "Section")
          .eq("source", "moodle")
          .maybeSingle();

        if (!exists) {
          await supabase.from("notes").insert({
            user_id: user_id,
            course_id: courseDbId,
            title: section.name || "Section",
            content: plainText,
            note_type: isLernziel ? "lernziel" : "general",
            source: "moodle",
          });
          totalNotes++;
        }
      }

      for (const mod of section.modules || []) {
        // Notes from module descriptions
        const modDesc = (mod.description || "").replace(/<[^>]*>/g, "").trim();
        if (modDesc.length >= 30) {
          const modTitle = `${section.name || "Section"} — ${mod.name || "Module"}`;
          const { data: exists } = await supabase
            .from("notes")
            .select("id")
            .eq("user_id", user_id)
            .eq("title", modTitle)
            .eq("source", "moodle")
            .maybeSingle();

          if (!exists) {
            const isExercise = /aufgabe|übung|exercise|fragen|beantworten/i.test(modDesc);
            const isLernziel = /lernziel|kompetenz|learning\s*objective/i.test(modDesc);
            const isReading = /lektüre|lesen|read|kapitel|chapter|textbuch/i.test(modDesc);
            await supabase.from("notes").insert({
              user_id: user_id,
              course_id: courseDbId,
              title: modTitle,
              content: modDesc,
              note_type: isLernziel ? "lernziel" : isExercise ? "exercise" : isReading ? "reading" : "general",
              source: "moodle",
            });
            totalNotes++;
          }
        }

        // Files from modules
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

          const { data: exists } = await supabase
            .from("files")
            .select("id")
            .eq("user_id", user_id)
            .eq("file_name", fname)
            .eq(courseDbId ? "course_id" : "user_id", courseDbId || user_id)
            .maybeSingle();

          if (!exists) {
            const furl = file.fileurl || null;
            const { error: insertErr } = await supabase.from("files").insert({
              user_id: user_id,
              course_id: courseDbId,
              file_name: fname,
              file_type: file.mimetype || file.type || null,
              file_size: file.filesize || null,
              moodle_file_url: furl,
              file_url: furl ? `${furl}${furl.includes("?") ? "&" : "?"}token=${moodle_token}` : null,
            });
            if (!insertErr) totalFiles++;
          }
        }
      }
    }
  } catch (err: any) {
    console.error(`Error syncing course ${moodle_course_id}:`, err.message);
  }

  return { files: totalFiles, notes: totalNotes };
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
      moodle_token,
      moodle_base_url = "https://moodle.zhaw.ch",
      user_id = DEFAULT_USER_ID,
    } = body;

    if (!moodle_token) {
      return res.status(400).json({ error: "Missing moodle_token" });
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
        const userId = siteInfo.userid;
        result = await moodleApi(moodle_base_url, moodle_token, "core_enrol_get_users_courses", {
          userid: String(userId),
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

      case "sync_all": {
        // Background-safe server-side sync with semester filtering
        const { semester_filter = "all", sync_files = true } = body;
        const siteInfo = await moodleApi(moodle_base_url, moodle_token, "core_webservice_get_site_info");
        const allCourses = await moodleApi(moodle_base_url, moodle_token, "core_enrol_get_users_courses", {
          userid: String(siteInfo.userid),
        });

        // Filter out irrelevant meta courses
        const IGNORED_COURSES = ["modulendprüfungen bsc", "law board"];
        let courses = allCourses.filter((c: any) => {
          const name = (c.fullname || "").toLowerCase();
          return !IGNORED_COURSES.some((ignored) => name.includes(ignored));
        });

        // Apply semester filter
        if (semester_filter && semester_filter !== "all") {
          courses = courses.filter((c: any) => courseMatchesSemester(c, semester_filter));
        }

        let totalDeadlines = 0;
        const dbCourseMap: Record<number, string> = {};

        // 1. Upsert filtered courses
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
                user_id: user_id,
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
                    user_id: user_id,
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

        // 3. Deadlines from Moodle Calendar events (e.g. USLN, exams, project deadlines)
        try {
          const calData = await moodleApi(moodle_base_url, moodle_token, "core_calendar_get_calendar_events", {
            "events[timestart]": String(Math.floor(Date.now() / 1000) - 7 * 86400),
            "events[timeend]": String(Math.floor(Date.now() / 1000) + 180 * 86400),
          });
          for (const ev of calData.events || []) {
            if (ev.timestart && ev.name) {
              const courseDbId = ev.courseid ? dbCourseMap[ev.courseid] : null;
              const { data: exists } = await supabase
                .from("deadlines")
                .select("id")
                .eq("user_id", user_id)
                .eq("title", ev.name)
                .eq("due_date", new Date(ev.timestart * 1000).toISOString())
                .maybeSingle();

              if (!exists) {
                await supabase.from("deadlines").insert({
                  user_id: user_id,
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

        // 4. Server-Side Course Content & Files Sync (Chunked Concurrency)
        let totalFiles = 0;
        let totalNotes = 0;
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
                  dbCourseMap[c.id] || null
                )
              )
            );
            for (const r of results) {
              totalFiles += r.files;
              totalNotes += r.notes;
            }
          }
        }

        // 5. Update profile last synced timestamp
        await supabase.from("profiles").upsert(
          {
            user_id,
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
          message: `Synchronisation abgeschlossen: ${courses.length} Kurse, ${totalFiles} neue Dateien, ${totalNotes} neue Notizen, ${totalDeadlines} Termine.`,
        };
        break;
      }

      case "sync_course": {
        const { moodle_course_id, course_db_id } = body;
        if (!moodle_course_id) throw new Error("moodle_course_id required");
        result = await syncSingleCourse(
          supabase,
          user_id,
          moodle_base_url,
          moodle_token,
          moodle_course_id,
          course_db_id || null
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
