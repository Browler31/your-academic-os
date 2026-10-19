import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";

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

    if (action === "classify_notes") {
      const result = await classifyNotes(supabase, userId);
      return new Response(JSON.stringify(result), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "Unknown action" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err: any) {
    console.error("note-classifier error:", err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

async function classifyNotes(supabase: any, userId: string) {
  // Fetch all "general" notes
  const { data: notes, error } = await supabase
    .from("notes")
    .select("id, title, content, course_id")
    .eq("user_id", userId)
    .eq("note_type", "general")
    .order("created_at");

  if (error) throw new Error(`Failed to fetch notes: ${error.message}`);
  if (!notes || notes.length === 0) return { classified: 0, message: "No general notes to classify" };

  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) throw new Error("OPENAI_API_KEY not configured");

  // Process in batches of 10
  const batchSize = 10;
  let classified = 0;
  const results: { id: string; title: string; old_type: string; new_type: string }[] = [];

  for (let i = 0; i < notes.length; i += batchSize) {
    const batch = notes.slice(i, i + batchSize);

    const noteSummaries = batch.map((n: any, idx: number) => {
      const contentPreview = (n.content || "").slice(0, 500);
      return `[${idx}] Title: "${n.title}"\nContent preview: ${contentPreview}`;
    }).join("\n\n---\n\n");

    const prompt = `You are classifying university course notes from a Swiss law school (ZHAW). 
Classify each note into exactly ONE of these types:
- "exercise" — contains practice questions, Aufgaben, Übungen, case studies
- "reading" — reading assignments, Pflichtlektüre, textbook references
- "lernziel" — learning objectives, Lernziele, competencies, what students should know
- "organizational" — course structure, Organisatorisches, schedule info, grading criteria, workload
- "summary" — lecture summaries, Zusammenfassungen, key concepts
- "general" — if truly none of the above fit

Respond ONLY with a JSON array of objects: [{"index": 0, "type": "exercise"}, ...]
No explanation, just the JSON array.

Notes to classify:

${noteSummaries}`;

    try {
      const aiResp = await fetch(OPENAI_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: "google/gemini-2.5-flash",
          messages: [{ role: "user", content: prompt }],
          temperature: 0.1,
        }),
      });

      if (!aiResp.ok) {
        console.error("AI API error:", aiResp.status, await aiResp.text());
        continue;
      }

      const aiData = await aiResp.json();
      const content = aiData.choices?.[0]?.message?.content || "";

      // Extract JSON from response
      const jsonMatch = content.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        console.error("No JSON array in AI response:", content);
        continue;
      }

      const classifications = JSON.parse(jsonMatch[0]) as { index: number; type: string }[];
      const validTypes = ["exercise", "reading", "lernziel", "organizational", "summary", "general"];

      for (const c of classifications) {
        if (c.index >= 0 && c.index < batch.length && validTypes.includes(c.type) && c.type !== "general") {
          const note = batch[c.index];
          const { error: updateError } = await supabase
            .from("notes")
            .update({ note_type: c.type })
            .eq("id", note.id);

          if (!updateError) {
            classified++;
            results.push({ id: note.id, title: note.title, old_type: "general", new_type: c.type });
          }
        }
      }
    } catch (err: any) {
      console.error(`Batch ${i} classification failed:`, err.message);
    }
  }

  return {
    classified,
    total_processed: notes.length,
    unchanged: notes.length - classified,
    results,
  };
}
