import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const LOVABLE_AI_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );

    const token = authHeader.replace("Bearer ", "");
    const { data: claimsData, error: claimsError } = await supabase.auth.getClaims(token);
    if (claimsError || !claimsData?.claims) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const userId = claimsData.claims.sub as string;

    const body = await req.json();
    const { action } = body;

    if (action === "plan_week") {
      const result = await planWeek(supabase, userId, body.target_date);
      return new Response(JSON.stringify(result), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "plan_today") {
      const result = await planToday(supabase, userId);
      return new Response(JSON.stringify(result), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "Unknown action. Use plan_week or plan_today" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err: any) {
    console.error("study-planner error:", err);
    const status = err.message?.includes("Rate limit") ? 429 : 
                   err.message?.includes("Payment") ? 402 : 500;
    return new Response(JSON.stringify({ error: err.message }), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

async function gatherContext(supabase: any, userId: string) {
  const today = new Date().toISOString().split("T")[0];
  const nextWeek = new Date(Date.now() + 14 * 86400000).toISOString().split("T")[0];

  const [coursesRes, notesRes, deadlinesRes, timetableRes, existingTasksRes, parsedFilesRes] = await Promise.all([
    supabase.from("courses").select("id, name, short_name").eq("user_id", userId),
    supabase.from("notes").select("id, title, content, note_type, course_id").eq("user_id", userId).order("created_at"),
    supabase.from("deadlines").select("id, title, description, due_date, course_id, is_completed")
      .eq("user_id", userId).eq("is_completed", false).gte("due_date", today).order("due_date"),
    supabase.from("timetable_entries").select("subject_name, subject_short, day_of_week, start_time, end_time, date, course_id")
      .eq("user_id", userId).gte("date", today).lte("date", nextWeek).order("date").order("start_time"),
    supabase.from("tasks").select("id, title, status, task_type, course_id, scheduled_for, due_date")
      .eq("user_id", userId).in("status", ["pending", "in_progress"]),
    supabase.from("files").select("id, file_name, course_id, extracted_content")
      .eq("user_id", userId).eq("extraction_status", "done").not("extracted_content", "is", null),
  ]);

  return {
    courses: coursesRes.data || [],
    notes: notesRes.data || [],
    deadlines: deadlinesRes.data || [],
    timetable: timetableRes.data || [],
    existingTasks: existingTasksRes.data || [],
    parsedFiles: parsedFilesRes.data || [],
  };
}

function buildCourseMap(courses: any[]) {
  const map: Record<string, string> = {};
  for (const c of courses) {
    map[c.id] = c.name;
  }
  return map;
}

async function callAI(prompt: string, systemPrompt: string, tools?: any[], toolChoice?: any) {
  const apiKey = Deno.env.get("LOVABLE_API_KEY");
  if (!apiKey) throw new Error("LOVABLE_API_KEY not configured");

  const body: any = {
    model: "google/gemini-2.5-flash",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: prompt },
    ],
    temperature: 0.2,
  };

  if (tools) {
    body.tools = tools;
    body.tool_choice = toolChoice;
  }

  const resp = await fetch(LOVABLE_AI_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (resp.status === 429) throw new Error("Rate limit exceeded. Please try again in a moment.");
  if (resp.status === 402) throw new Error("Payment required. Please add credits.");
  if (!resp.ok) {
    const t = await resp.text();
    console.error("AI error:", resp.status, t);
    throw new Error("AI gateway error");
  }

  return await resp.json();
}

const SYSTEM_PROMPT = `You are an AI study planner for a Swiss law student at ZHAW with ADHD.
Your job is to create a concrete, actionable study plan that removes all organizational overhead.

Key principles:
- Tasks should be 25-45 minutes (Pomodoro-friendly for ADHD)
- Preparation tasks (Vorbereitungsaufgaben) MUST be scheduled the day BEFORE the lecture
- Review tasks should be scheduled 1-2 days AFTER the lecture
- Exercise tasks should be scheduled with enough time before the deadline
- Exam prep should ramp up as exam dates approach
- Be specific: "Read Chapter 3 of FER" not "Study Family Law"
- Extract concrete tasks from note content (Aufgaben, Fragen, Lernziele)
- Consider the student's timetable to avoid scheduling during lectures
- Each task needs: title, type, course_id, scheduled_for date, estimated_minutes, priority_score (1-100)

Task types available: prep_reading, lecture_review, exercises, exam_prep, custom
Priority scoring: higher = more urgent. Consider deadline proximity, exam weight, and spaced repetition.`;

const TASK_TOOL = {
  type: "function",
  function: {
    name: "create_study_tasks",
    description: "Create a set of study tasks for the student",
    parameters: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string", description: "Specific, actionable task title in German" },
              description: { type: "string", description: "Brief description of what to do" },
              task_type: { type: "string", enum: ["prep_reading", "lecture_review", "exercises", "exam_prep", "custom"] },
              course_id: { type: "string", description: "UUID of the course this belongs to, or null" },
              scheduled_for: { type: "string", description: "YYYY-MM-DD date when this should be done" },
              due_date: { type: "string", description: "YYYY-MM-DD deadline if applicable" },
              estimated_minutes: { type: "number", description: "Estimated time in minutes (25-45 ideal)" },
              priority_score: { type: "number", description: "1-100, higher = more urgent" },
            },
            required: ["title", "task_type", "scheduled_for", "estimated_minutes", "priority_score"],
            additionalProperties: false,
          },
        },
        reasoning: { type: "string", description: "Brief explanation of your planning decisions" },
      },
      required: ["tasks", "reasoning"],
      additionalProperties: false,
    },
  },
};

async function planWeek(supabase: any, userId: string, targetDate?: string) {
  const ctx = await gatherContext(supabase, userId);
  const courseMap = buildCourseMap(ctx.courses);

  const prompt = buildPrompt(ctx, courseMap, "week", targetDate);
  const aiResult = await callAI(prompt, SYSTEM_PROMPT, [TASK_TOOL], { type: "function", function: { name: "create_study_tasks" } });

  const toolCall = aiResult.choices?.[0]?.message?.tool_calls?.[0];
  if (!toolCall) throw new Error("AI did not return structured tasks");

  const parsed = JSON.parse(toolCall.function.arguments);
  const tasks = parsed.tasks || [];

  // Insert tasks
  let created = 0;
  for (const task of tasks) {
    // Validate course_id exists
    const validCourseId = task.course_id && ctx.courses.some((c: any) => c.id === task.course_id) ? task.course_id : null;

    const { error } = await supabase.from("tasks").insert({
      user_id: userId,
      title: task.title,
      description: task.description || null,
      task_type: task.task_type,
      course_id: validCourseId,
      scheduled_for: task.scheduled_for,
      due_date: task.due_date ? new Date(task.due_date).toISOString() : null,
      estimated_minutes: task.estimated_minutes,
      priority_score: task.priority_score,
      source: "ai_planner",
      status: "pending",
    });

    if (!error) created++;
    else console.error("Task insert error:", error.message);
  }

  return {
    created,
    total_planned: tasks.length,
    reasoning: parsed.reasoning,
  };
}

async function planToday(supabase: any, userId: string) {
  const ctx = await gatherContext(supabase, userId);
  const courseMap = buildCourseMap(ctx.courses);

  const prompt = buildPrompt(ctx, courseMap, "today");
  const aiResult = await callAI(prompt, SYSTEM_PROMPT, [TASK_TOOL], { type: "function", function: { name: "create_study_tasks" } });

  const toolCall = aiResult.choices?.[0]?.message?.tool_calls?.[0];
  if (!toolCall) throw new Error("AI did not return structured tasks");

  const parsed = JSON.parse(toolCall.function.arguments);
  const tasks = parsed.tasks || [];

  let created = 0;
  const today = new Date().toISOString().split("T")[0];

  for (const task of tasks) {
    const validCourseId = task.course_id && ctx.courses.some((c: any) => c.id === task.course_id) ? task.course_id : null;

    const { error } = await supabase.from("tasks").insert({
      user_id: userId,
      title: task.title,
      description: task.description || null,
      task_type: task.task_type,
      course_id: validCourseId,
      scheduled_for: today,
      due_date: task.due_date ? new Date(task.due_date).toISOString() : null,
      estimated_minutes: task.estimated_minutes,
      priority_score: task.priority_score,
      source: "ai_planner",
      status: "pending",
    });

    if (!error) created++;
  }

  return { created, total_planned: tasks.length, reasoning: parsed.reasoning };
}

function buildPrompt(ctx: any, courseMap: Record<string, string>, scope: "week" | "today", targetDate?: string) {
  const today = new Date().toISOString().split("T")[0];
  const dayOfWeek = new Date().toLocaleDateString("de-CH", { weekday: "long" });

  let prompt = `Today is ${today} (${dayOfWeek}). Plan ${scope === "today" ? "TODAY's study tasks" : "the upcoming week's study tasks"}.\n\n`;

  // Courses
  prompt += `## Courses (with IDs for linking):\n`;
  for (const c of ctx.courses) {
    prompt += `- ${c.name} (id: ${c.id}, short: ${c.short_name || "n/a"})\n`;
  }

  // Timetable
  prompt += `\n## Upcoming lectures:\n`;
  if (ctx.timetable.length === 0) {
    prompt += "No timetable data available.\n";
  } else {
    for (const t of ctx.timetable) {
      const courseName = t.course_id ? courseMap[t.course_id] || t.subject_name : t.subject_name;
      prompt += `- ${t.date} ${t.start_time?.slice(0,5)}-${t.end_time?.slice(0,5)}: ${courseName} (${t.subject_short})\n`;
    }
  }

  // Deadlines
  prompt += `\n## Open deadlines:\n`;
  if (ctx.deadlines.length === 0) {
    prompt += "No open deadlines.\n";
  } else {
    for (const d of ctx.deadlines) {
      const courseName = d.course_id ? courseMap[d.course_id] || "Unknown" : "No course";
      prompt += `- ${d.due_date?.split("T")[0]}: "${d.title}" (${courseName})${d.description ? ` — ${d.description.slice(0, 100)}` : ""}\n`;
    }
  }

  // Notes (content for task extraction)
  prompt += `\n## Course notes (extract concrete tasks from these!):\n`;
  const notesByCourse: Record<string, any[]> = {};
  for (const n of ctx.notes) {
    const key = n.course_id || "none";
    if (!notesByCourse[key]) notesByCourse[key] = [];
    notesByCourse[key].push(n);
  }

  for (const [courseId, notes] of Object.entries(notesByCourse)) {
    const courseName = courseId !== "none" ? courseMap[courseId] || "Unknown" : "No course";
    prompt += `\n### ${courseName}:\n`;
    for (const n of notes as any[]) {
      // Include title (which often has dates) and content preview
      const contentPreview = (n.content || "").slice(0, 400);
      prompt += `[${n.note_type || "general"}] "${n.title}": ${contentPreview}\n---\n`;
    }
  }

  // Existing tasks (avoid duplicates)
  prompt += `\n## Already existing tasks (DON'T duplicate these):\n`;
  if (ctx.existingTasks.length === 0) {
    prompt += "No existing tasks.\n";
  } else {
    for (const t of ctx.existingTasks) {
      prompt += `- [${t.status}] "${t.title}" (type: ${t.task_type}, scheduled: ${t.scheduled_for || "unscheduled"})\n`;
    }
  }

  // Parsed legal content from PDFs
  prompt += `\n## Extracted legal content from parsed PDFs (use for targeted study tasks!):\n`;
  if (ctx.parsedFiles && ctx.parsedFiles.length > 0) {
    const byCourseParsed: Record<string, any[]> = {};
    for (const f of ctx.parsedFiles) {
      const key = f.course_id || "none";
      if (!byCourseParsed[key]) byCourseParsed[key] = [];
      byCourseParsed[key].push(f);
    }

    for (const [courseId, files] of Object.entries(byCourseParsed)) {
      const courseName = courseId !== "none" ? courseMap[courseId] || "Unknown" : "No course";
      prompt += `\n### ${courseName} (parsed PDFs):\n`;
      for (const f of files as any[]) {
        const ext = f.extracted_content;
        if (!ext) continue;
        prompt += `File: "${f.file_name}"\n`;
        if (ext.summary) prompt += `Summary: ${ext.summary}\n`;
        if (ext.norms?.length > 0) {
          prompt += `Norms: ${ext.norms.slice(0, 8).map((n: any) =>
            `${n.article} (TBM: ${(n.tbm || []).join(", ")}, importance: ${n.importance}/5)`
          ).join("; ")}\n`;
        }
        if (ext.key_concepts?.length > 0) {
          prompt += `Concepts: ${ext.key_concepts.slice(0, 5).map((c: any) => c.concept).join(", ")}\n`;
        }
        prompt += `---\n`;
      }
    }
  } else {
    prompt += "No parsed PDFs yet.\n";
  }

  prompt += `\n## Instructions:\n- Create ${scope === "today" ? "3-6 tasks for today" : "15-25 tasks for the next 7 days"}\n- Vorbereitungsaufgaben from notes should be scheduled the day BEFORE the corresponding lecture\n- After each lecture day, schedule a 25-min review task\n- Extract specific questions/exercises from note content as individual tasks\n- Use the exact course IDs from the list above\n- Set scheduled_for to specific dates (YYYY-MM-DD format)\n- Priority: deadline proximity → exam prep → prep_reading → lecture_review → exercises`;

  return prompt;
}
