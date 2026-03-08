import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version, x-api-key",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Auth: either Bearer token (web) or x-api-key (OpenClaw)
    let userId: string | null = null;
    const authHeader = req.headers.get("authorization");
    const apiKey = req.headers.get("x-api-key");

    if (authHeader) {
      const token = authHeader.replace("Bearer ", "");
      const { data: { user }, error } = await supabase.auth.getUser(token);
      if (error || !user) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      userId = user.id;
    } else if (apiKey) {
      // Hash the key and look it up
      const encoder = new TextEncoder();
      const data = encoder.encode(apiKey);
      const hashBuffer = await crypto.subtle.digest("SHA-256", data);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      const keyHash = hashArray.map(b => b.toString(16).padStart(2, "0")).join("");

      const { data: keyData } = await supabase
        .from("api_keys")
        .select("user_id")
        .eq("key_hash", keyHash)
        .maybeSingle();

      if (!keyData) {
        return new Response(JSON.stringify({ error: "Invalid API key" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      userId = keyData.user_id;

      // Update last_used_at
      await supabase
        .from("api_keys")
        .update({ last_used_at: new Date().toISOString() })
        .eq("key_hash", keyHash);
    } else {
      return new Response(JSON.stringify({ error: "No auth provided" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const url = new URL(req.url);
    const action = url.searchParams.get("action") || (req.method === "GET" ? "one_thing" : null);

    const body = req.method !== "GET" ? await req.json().catch(() => ({})) : {};
    const requestAction = body.action || action;

    switch (requestAction) {
      case "one_thing": {
        // The priority engine — returns the single most important task
        const now = new Date();
        const today = now.toISOString().split("T")[0];
        const threWeeksFromNow = new Date(now.getTime() + 21 * 86400000).toISOString();
        const endOfWeek = new Date(now.getTime() + (7 - now.getDay()) * 86400000).toISOString().split("T")[0];

        // Priority 1: Tasks due today or overdue
        const { data: overdue } = await supabase
          .from("tasks")
          .select("*, courses(name)")
          .eq("user_id", userId)
          .eq("status", "pending")
          .lte("due_date", new Date(now.getTime() + 86400000).toISOString())
          .order("due_date", { ascending: true })
          .limit(1);

        if (overdue && overdue.length > 0) {
          return json({ task: overdue[0], priority_level: 1, reason: "Due today or overdue" });
        }

        // Priority 2: Prep tasks for current week
        const { data: prepThisWeek } = await supabase
          .from("tasks")
          .select("*, courses(name)")
          .eq("user_id", userId)
          .eq("status", "pending")
          .in("task_type", ["prep_reading"])
          .lte("scheduled_for", endOfWeek)
          .gte("scheduled_for", today)
          .order("scheduled_for", { ascending: true })
          .limit(1);

        if (prepThisWeek && prepThisWeek.length > 0) {
          return json({ task: prepThisWeek[0], priority_level: 2, reason: "Prep task for this week" });
        }

        // Priority 3: New material < 24h (tasks from moodle_material source)
        const yesterday = new Date(now.getTime() - 86400000).toISOString();
        const { data: newMaterial } = await supabase
          .from("tasks")
          .select("*, courses(name)")
          .eq("user_id", userId)
          .eq("status", "pending")
          .eq("task_type", "moodle_material")
          .gte("created_at", yesterday)
          .order("created_at", { ascending: false })
          .limit(1);

        if (newMaterial && newMaterial.length > 0) {
          return json({ task: newMaterial[0], priority_level: 3, reason: "New material added in last 24h" });
        }

        // Priority 4: Exam prep when exams are within 3 weeks
        const { data: examPrep } = await supabase
          .from("tasks")
          .select("*, courses(name)")
          .eq("user_id", userId)
          .eq("status", "pending")
          .eq("task_type", "exam_prep")
          .lte("due_date", threWeeksFromNow)
          .order("due_date", { ascending: true })
          .limit(1);

        if (examPrep && examPrep.length > 0) {
          return json({ task: examPrep[0], priority_level: 4, reason: "Exam approaching within 3 weeks" });
        }

        // Priority 5: Any pending task (favoring courses with least completed tasks)
        const { data: anyTask } = await supabase
          .from("tasks")
          .select("*, courses(name)")
          .eq("user_id", userId)
          .eq("status", "pending")
          .order("created_at", { ascending: true })
          .limit(1);

        if (anyTask && anyTask.length > 0) {
          return json({ task: anyTask[0], priority_level: 5, reason: "Next available task" });
        }

        return json({ task: null, priority_level: 0, reason: "No pending tasks 🎉" });
      }

      case "list": {
        const status = body.status || "pending";
        const limit = body.limit || 20;
        const { data } = await supabase
          .from("tasks")
          .select("*, courses(name)")
          .eq("user_id", userId)
          .eq("status", status)
          .order("due_date", { ascending: true, nullsFirst: false })
          .limit(limit);

        return json({ tasks: data || [] });
      }

      case "create": {
        const { title, description, task_type, course_id, due_date, scheduled_for, week_number, source, source_file } = body;
        if (!title) {
          return json({ error: "title is required" }, 400);
        }
        const { data, error } = await supabase.from("tasks").insert({
          user_id: userId,
          title,
          description: description || null,
          task_type: task_type || "custom",
          course_id: course_id || null,
          due_date: due_date || null,
          scheduled_for: scheduled_for || null,
          week_number: week_number || null,
          source: source || "openclaw",
          source_file: source_file || null,
        }).select().single();

        if (error) return json({ error: error.message }, 500);
        return json({ task: data });
      }

      case "complete": {
        const { task_id } = body;
        if (!task_id) return json({ error: "task_id required" }, 400);

        const { data, error } = await supabase
          .from("tasks")
          .update({ status: "done", completed_at: new Date().toISOString() })
          .eq("id", task_id)
          .eq("user_id", userId)
          .select()
          .single();

        if (error) return json({ error: error.message }, 500);
        return json({ task: data });
      }

      case "status": {
        // Overview like studybrain_status.py
        const [pendingRes, doneRes, courseStats] = await Promise.all([
          supabase.from("tasks").select("id", { count: "exact", head: true }).eq("user_id", userId).eq("status", "pending"),
          supabase.from("tasks").select("id", { count: "exact", head: true }).eq("user_id", userId).eq("status", "done"),
          supabase.from("tasks").select("course_id, status, courses(name)").eq("user_id", userId),
        ]);

        // Upcoming deadlines (next 14 days)
        const { data: upcomingDeadlines } = await supabase
          .from("deadlines")
          .select("*, courses(name)")
          .eq("user_id", userId)
          .eq("is_completed", false)
          .gte("due_date", new Date().toISOString())
          .lte("due_date", new Date(Date.now() + 14 * 86400000).toISOString())
          .order("due_date", { ascending: true });

        return json({
          pending_tasks: pendingRes.count || 0,
          completed_tasks: doneRes.count || 0,
          upcoming_deadlines: upcomingDeadlines || [],
        });
      }

      default:
        return json({ error: `Unknown action: ${requestAction}` }, 400);
    }
  } catch (error) {
    console.error("Study tasks error:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers":
        "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version, x-api-key",
      "Content-Type": "application/json",
    },
  });
}
