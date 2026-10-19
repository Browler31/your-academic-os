import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";

const SYSTEM_PROMPT = `Du bist ein Schweizer Rechtsprofessor und Experte für juristische Textanalyse.

Analysiere den folgenden Text aus einer juristischen Vorlesung oder einem Skript. Extrahiere ALLE relevanten rechtlichen Elemente.

Für jede Rechtsnorm oder jedes Konzept, identifiziere:
- article: Gesetzesartikel (z.B. "Art. 41 Abs. 1 OR")
- tbm: Liste der Tatbestandsmerkmale (Elements/Requirements)
- rechtsfolge: Rechtsfolge (Legal consequence)
- definitionen: Schlüsselbegriffe und deren Definitionen
- importance: 1-5 Skala basierend auf Prüfungsrelevanz (5 = sehr wichtig)

Zusätzlich extrahiere:
- key_concepts: Wichtige juristische Konzepte und Prinzipien
- cases: Referenzierte Gerichtsentscheide (BGE, etc.)
- cross_references: Verweise auf andere Artikel oder Gesetze`;

const EXTRACTION_TOOL = {
  type: "function",
  function: {
    name: "extract_legal_elements",
    description: "Extract structured legal elements from a Swiss law document",
    parameters: {
      type: "object",
      properties: {
        norms: {
          type: "array",
          items: {
            type: "object",
            properties: {
              article: { type: "string" },
              tbm: { type: "array", items: { type: "string" } },
              rechtsfolge: { type: "string" },
              definitionen: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    term: { type: "string" },
                    definition: { type: "string" },
                  },
                  required: ["term", "definition"],
                },
              },
              importance: { type: "number" },
            },
            required: ["article", "tbm", "rechtsfolge", "importance"],
          },
        },
        key_concepts: {
          type: "array",
          items: {
            type: "object",
            properties: {
              concept: { type: "string" },
              explanation: { type: "string" },
              related_articles: { type: "array", items: { type: "string" } },
            },
            required: ["concept", "explanation"],
          },
        },
        cases: {
          type: "array",
          items: {
            type: "object",
            properties: {
              reference: { type: "string" },
              summary: { type: "string" },
              relevance: { type: "string" },
            },
            required: ["reference", "summary"],
          },
        },
        summary: { type: "string", description: "Brief summary of the document's legal content" },
        total_elements: { type: "number" },
      },
      required: ["norms", "key_concepts", "summary", "total_elements"],
    },
  },
};

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
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const { action } = body;

    if (action === "parse") {
      const { file_id } = body;
      if (!file_id) throw new Error("file_id required");

      // Get file record
      const { data: file, error: fileErr } = await supabase
        .from("files")
        .select("id, file_name, file_url, moodle_file_url, file_type, course_id")
        .eq("id", file_id)
        .eq("user_id", user.id)
        .single();

      if (fileErr || !file) throw new Error("File not found");

      // Mark as processing
      await supabase.from("files").update({ extraction_status: "processing" }).eq("id", file_id);

      // Download the PDF from Moodle
      const downloadUrl = file.file_url || file.moodle_file_url;
      if (!downloadUrl) throw new Error("No download URL for this file");

      console.log(`Downloading file: ${file.file_name} from ${downloadUrl.substring(0, 80)}...`);

      const pdfResp = await fetch(downloadUrl);
      if (!pdfResp.ok) throw new Error(`Failed to download file: ${pdfResp.status}`);

      const pdfBytes = await pdfResp.arrayBuffer();
      const uint8 = new Uint8Array(pdfBytes);
      let binary = "";
      const chunkSize = 8192;
      for (let i = 0; i < uint8.length; i += chunkSize) {
        binary += String.fromCharCode(...uint8.subarray(i, i + chunkSize));
      }
      const base64Pdf = btoa(binary);

      console.log(`Downloaded ${file.file_name}: ${pdfBytes.byteLength} bytes`);

      const apiKey = Deno.env.get("OPENAI_API_KEY");
      if (!apiKey) throw new Error("OPENAI_API_KEY not configured");

      // Send to Gemini with the PDF as base64 content
      const aiResp = await fetch(OPENAI_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: "google/gemini-2.5-pro",
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: `Analysiere dieses Dokument: "${file.file_name}". Extrahiere alle juristischen Elemente.`,
                },
                {
                  type: "image_url",
                  image_url: {
                    url: `data:application/pdf;base64,${base64Pdf}`,
                  },
                },
              ],
            },
          ],
          tools: [EXTRACTION_TOOL],
          tool_choice: { type: "function", function: { name: "extract_legal_elements" } },
          temperature: 0.2,
        }),
      });

      if (aiResp.status === 429) {
        await supabase.from("files").update({ extraction_status: "rate_limited" }).eq("id", file_id);
        throw new Error("Rate limit exceeded. Please try again in a moment.");
      }
      if (aiResp.status === 402) {
        await supabase.from("files").update({ extraction_status: "error" }).eq("id", file_id);
        throw new Error("Payment required. Please add credits.");
      }
      if (!aiResp.ok) {
        const errText = await aiResp.text();
        console.error("AI error:", aiResp.status, errText);
        await supabase.from("files").update({ extraction_status: "error" }).eq("id", file_id);
        throw new Error(`AI gateway error: ${aiResp.status}`);
      }

      const aiResult = await aiResp.json();
      const toolCall = aiResult.choices?.[0]?.message?.tool_calls?.[0];
      if (!toolCall) {
        await supabase.from("files").update({ extraction_status: "error" }).eq("id", file_id);
        throw new Error("AI did not return structured data");
      }

      const extracted = JSON.parse(toolCall.function.arguments);

      // Save to files table
      await supabase.from("files").update({
        extracted_content: extracted,
        extracted_at: new Date().toISOString(),
        extraction_status: "done",
      }).eq("id", file_id);

      console.log(`Parsed ${file.file_name}: ${extracted.total_elements} elements, ${extracted.norms?.length || 0} norms`);

      return new Response(JSON.stringify({
        file_id,
        file_name: file.file_name,
        total_elements: extracted.total_elements,
        norms_count: extracted.norms?.length || 0,
        concepts_count: extracted.key_concepts?.length || 0,
        cases_count: extracted.cases?.length || 0,
        summary: extracted.summary,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "parse_batch") {
      // Parse multiple files for a course
      const { course_id } = body;

      let query = supabase
        .from("files")
        .select("id, file_name, file_type")
        .eq("user_id", user.id)
        .is("extracted_content", null)
        .in("extraction_status", ["pending", "error"]);

      if (course_id) query = query.eq("course_id", course_id);

      const { data: files, error } = await query.limit(5); // Process 5 at a time
      if (error) throw error;

      // Filter to parseable types
      const parseable = (files || []).filter(f => {
        const name = f.file_name.toLowerCase();
        return name.endsWith(".pdf") || name.endsWith(".pptx") || name.endsWith(".docx");
      });

      return new Response(JSON.stringify({
        parseable_files: parseable.length,
        files: parseable.map(f => ({ id: f.id, name: f.file_name })),
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "Unknown action" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err: any) {
    console.error("parse-pdf error:", err);
    const status = err.message?.includes("Rate limit") ? 429 :
                   err.message?.includes("Payment") ? 402 : 500;
    return new Response(JSON.stringify({ error: err.message }), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
