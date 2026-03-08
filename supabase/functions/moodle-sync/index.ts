import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

interface MoodleResponse {
  errorcode?: string;
  message?: string;
  exception?: string;
}

async function moodleApi(baseUrl: string, token: string, func: string, params: Record<string, string> = {}) {
  const url = new URL(`${baseUrl}/webservice/rest/server.php`);
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing authorization" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Verify user
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const { action, moodle_token, moodle_base_url = "https://moodle.zhaw.ch" } = body;

    if (!moodle_token) {
      return new Response(JSON.stringify({ error: "Missing moodle_token" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let result: unknown;

    switch (action) {
      case "verify": {
        result = await moodleApi(moodle_base_url, moodle_token, "core_webservice_get_site_info");
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
          return new Response(JSON.stringify({ error: "Missing course_id" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
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
          "events[timeend]": String(Math.floor(Date.now() / 1000) + 90 * 86400),
        });
        break;
      }

      case "sync_all": {
        // 1. Get courses
        const siteInfo = await moodleApi(moodle_base_url, moodle_token, "core_webservice_get_site_info");
        const courses = await moodleApi(moodle_base_url, moodle_token, "core_enrol_get_users_courses", {
          userid: String(siteInfo.userid),
        });

        // 2. Upsert courses
        for (const course of courses) {
          const { data: existing } = await supabase
            .from("courses")
            .select("id")
            .eq("user_id", user.id)
            .eq("moodle_course_id", course.id)
            .maybeSingle();

          if (existing) {
            await supabase
              .from("courses")
              .update({ name: course.fullname, short_name: course.shortname, last_synced_at: new Date().toISOString() })
              .eq("id", existing.id);
          } else {
            await supabase
              .from("courses")
              .insert({
                user_id: user.id,
                moodle_course_id: course.id,
                name: course.fullname,
                short_name: course.shortname,
                is_synced: true,
                last_synced_at: new Date().toISOString(),
              });
          }
        }

        // 3. Get assignments and create deadlines
        const assignData = await moodleApi(moodle_base_url, moodle_token, "mod_assign_get_assignments");
        const assignCourses = assignData.courses || [];

        for (const ac of assignCourses) {
          const { data: dbCourse } = await supabase
            .from("courses")
            .select("id")
            .eq("user_id", user.id)
            .eq("moodle_course_id", ac.id)
            .maybeSingle();

          for (const assign of ac.assignments || []) {
            if (assign.duedate && assign.duedate > 0) {
              const { data: existingDeadline } = await supabase
                .from("deadlines")
                .select("id")
                .eq("user_id", user.id)
                .eq("moodle_assignment_id", assign.id)
                .maybeSingle();

              if (!existingDeadline) {
                await supabase.from("deadlines").insert({
                  user_id: user.id,
                  course_id: dbCourse?.id || null,
                  title: assign.name,
                  description: assign.intro?.replace(/<[^>]*>/g, "") || null,
                  due_date: new Date(assign.duedate * 1000).toISOString(),
                  source: "moodle",
                  moodle_assignment_id: assign.id,
                });
              }
            }
          }
        }

        // 4. Get course contents for notes and files
        let totalFiles = 0;
        const fileErrors: string[] = [];
        
        for (const course of courses) {
          const { data: dbCourse } = await supabase
            .from("courses")
            .select("id")
            .eq("user_id", user.id)
            .eq("moodle_course_id", course.id)
            .maybeSingle();

          const courseDbId = dbCourse?.id || null;
          console.log(`Processing course: ${course.fullname} (moodle_id=${course.id}, db_id=${courseDbId})`);

          try {
            const contents = await moodleApi(moodle_base_url, moodle_token, "core_course_get_contents", {
              courseid: String(course.id),
            });

            console.log(`Course ${course.shortname}: ${contents.length} sections found`);

            for (const section of contents) {
              // 4a. Section summaries → notes
              if (section.summary && section.summary.trim().length > 20) {
                const plainText = section.summary.replace(/<[^>]*>/g, "").trim();
                const isLernziel = /lernziel|learning\s*objective|kompetenz/i.test(plainText);
                
                const { data: existingNote } = await supabase
                  .from("notes")
                  .select("id")
                  .eq("user_id", user.id)
                  .eq("title", section.name || "Section")
                  .eq("source", "moodle")
                  .maybeSingle();

                if (!existingNote) {
                  await supabase.from("notes").insert({
                    user_id: user.id,
                    course_id: courseDbId,
                    title: section.name || "Section",
                    content: plainText,
                    note_type: isLernziel ? "lernziel" : "general",
                    source: "moodle",
                  });
                }
              }

              // 4b. Module-level content
              for (const mod of section.modules || []) {
                const modDesc = (mod.description || "").replace(/<[^>]*>/g, "").trim();
                if (modDesc.length >= 30) {
                  const modTitle = `${section.name || "Section"} — ${mod.name || "Module"}`;

                  const { data: existingModNote } = await supabase
                    .from("notes")
                    .select("id")
                    .eq("user_id", user.id)
                    .eq("title", modTitle)
                    .eq("source", "moodle")
                    .maybeSingle();

                  if (!existingModNote) {
                    const isExercise = /aufgabe|übung|exercise|fragen|beantworten/i.test(modDesc);
                    const isLernziel = /lernziel|kompetenz|learning\s*objective/i.test(modDesc);
                    const isReading = /lektüre|lesen|read|kapitel|chapter|textbuch/i.test(modDesc);

                    await supabase.from("notes").insert({
                      user_id: user.id,
                      course_id: courseDbId,
                      title: modTitle,
                      content: modDesc,
                      note_type: isLernziel ? "lernziel" : isExercise ? "exercise" : isReading ? "reading" : "general",
                      source: "moodle",
                    });
                  }
                }

                // 4c. Extract ALL files from every possible location in the module
                const allFiles: any[] = [];
                
                // mod.contents — primary file list (resource, folder, etc.)
                if (Array.isArray(mod.contents)) {
                  for (const f of mod.contents) {
                    if (f.type === "file" || f.type === "content") allFiles.push(f);
                  }
                }
                // mod.introfiles — intro attachments on activities
                if (Array.isArray(mod.introfiles)) {
                  for (const f of mod.introfiles) allFiles.push({ ...f, type: "file" });
                }
                // mod.contentfiles — content attachments
                if (Array.isArray(mod.contentfiles)) {
                  for (const f of mod.contentfiles) allFiles.push({ ...f, type: "file" });
                }

                for (const file of allFiles) {
                  const fname = file.filename || file.name;
                  if (!fname || fname === ".") continue;

                  const { data: existingFile } = await supabase
                    .from("files")
                    .select("id")
                    .eq("user_id", user.id)
                    .eq("file_name", fname)
                    .eq(courseDbId ? "course_id" : "user_id", courseDbId || user.id)
                    .maybeSingle();

                  if (!existingFile) {
                    const furl = file.fileurl || null;
                    const { error: insertErr } = await supabase.from("files").insert({
                      user_id: user.id,
                      course_id: courseDbId,
                      file_name: fname,
                      file_type: file.mimetype || file.type || null,
                      file_size: file.filesize || null,
                      moodle_file_url: furl,
                      file_url: furl ? `${furl}${furl.includes("?") ? "&" : "?"}token=${moodle_token}` : null,
                    });
                    if (insertErr) {
                      console.error(`File insert error for ${fname}:`, insertErr.message);
                    } else {
                      totalFiles++;
                    }
                  }
                }
              }
            }
          } catch (err: any) {
            const msg = `Course ${course.shortname} (${course.id}): ${err.message}`;
            console.error("Content fetch error:", msg);
            fileErrors.push(msg);
          }
        }

        console.log(`Sync complete: ${courses.length} courses, ${totalFiles} new files, ${fileErrors.length} errors`);
        result = { 
          synced_courses: courses.length, 
          synced_files: totalFiles, 
          errors: fileErrors.length > 0 ? fileErrors : undefined,
          message: "Sync complete" 
        };
        break;
      }

      case "get_course_files": {
        // Get all files for a specific course via core_course_get_contents
        const { moodle_course_id } = body;
        if (!moodle_course_id) {
          return new Response(JSON.stringify({ error: "Missing moodle_course_id" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        const contents = await moodleApi(moodle_base_url, moodle_token, "core_course_get_contents", {
          courseid: String(moodle_course_id),
        });

        const files: any[] = [];
        for (const section of contents) {
          for (const mod of section.modules || []) {
            for (const file of mod.contents || []) {
              if (file.type === "file") {
                files.push({
                  filename: file.filename,
                  fileurl: file.fileurl,
                  filesize: file.filesize,
                  mimetype: file.mimetype,
                  section: section.name,
                  module: mod.name,
                  timemodified: file.timemodified,
                });
              }
            }
          }
        }
        result = { files, total: files.length };
        break;
      }

      default:
        return new Response(JSON.stringify({ error: `Unknown action: ${action}` }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
    }

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Moodle sync error:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
