import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";

const SYSTEM_PROMPT = `Du bist ein Schweizer Rechtsprofessor. Deine Aufgabe ist es, Lernnotizen in Anki-Flashcards im Cloze-Deletion-Format umzuwandeln.

## Regeln:

1. **Atomares Prinzip**: Jede Karte enthält NUR EINEN juristischen Fakt, eine Definition oder ein Tatbestandsmerkmal.
2. **Cloze-Format**: Verwende {{c1::versteckter Text}} für Lücken. Mehrere Lücken pro Karte sind erlaubt ({{c1::}}, {{c2::}}, {{c3::}}).
3. **Gesetzesartikel**: Wenn ein Artikel referenziert wird (z.B. Art. 41 OR), muss die Artikelnummer SICHTBAR bleiben. Die Tatbestandsmerkmale werden versteckt.
4. **Definitionen**: Bei Definitionen wird der Definitionsbegriff sichtbar gelassen, die Erklärung wird versteckt.
5. **Sprache**: Deutsch (Schweizer Rechtssprache).
6. **Qualität**: Nur prüfungsrelevante Inhalte. Keine organisatorischen Details.

## Beispiele:

Input: "Haftung nach Art. 41 OR setzt Schaden, Widerrechtlichkeit, Kausalzusammenhang und Verschulden voraus."
Output: "Art. 41 OR setzt {{c1::Schaden}}, {{c2::Widerrechtlichkeit}}, {{c3::Kausalzusammenhang}} und {{c4::Verschulden}} voraus."

Input: "Die Verjährungsfrist für vertragliche Ansprüche beträgt nach Art. 127 OR 10 Jahre."
Output: "Die Verjährungsfrist für vertragliche Ansprüche beträgt nach Art. 127 OR {{c1::10 Jahre}}."

Input: "Widerrechtlichkeit liegt vor bei Verstoss gegen eine Schutznorm oder Eingriff in ein absolutes Recht."
Output: "Widerrechtlichkeit liegt vor bei {{c1::Verstoss gegen eine Schutznorm}} oder {{c2::Eingriff in ein absolutes Recht}}."`;

const CARD_TOOL = {
  type: "function",
  function: {
    name: "create_flashcards",
    description: "Create Anki Cloze deletion flashcards from study notes",
    parameters: {
      type: "object",
      properties: {
        cards: {
          type: "array",
          items: {
            type: "object",
            properties: {
              cloze_text: { type: "string", description: "The full Cloze deletion text with {{c1::}} markers" },
              tags: { type: "array", items: { type: "string" }, description: "Tags like article numbers, topic areas" },
            },
            required: ["cloze_text", "tags"],
            additionalProperties: false,
          },
        },
      },
      required: ["cards"],
      additionalProperties: false,
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

    if (action === "generate") {
      const { note_id } = body;
      if (!note_id) throw new Error("note_id required");

      // Fetch the note
      const { data: note, error: noteErr } = await supabase
        .from("notes")
        .select("id, title, content, note_type, course_id, courses(name, short_name)")
        .eq("id", note_id)
        .eq("user_id", userId)
        .single();

      if (noteErr || !note) throw new Error("Note not found");
      if (!note.content || note.content.trim().length < 20) {
        throw new Error("Note content too short for flashcard generation");
      }

      const courseName = (note as any).courses?.name || "Unbekannt";
      const prompt = `Kurs: ${courseName}\nNotiz-Typ: ${note.note_type || "general"}\nTitel: ${note.title}\n\nInhalt:\n${note.content}`;

      const apiKey = Deno.env.get("OPENAI_API_KEY");
      if (!apiKey) throw new Error("OPENAI_API_KEY not configured");

      const aiResp = await fetch(OPENAI_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: "google/gemini-3-flash-preview",
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: prompt },
          ],
          tools: [CARD_TOOL],
          tool_choice: { type: "function", function: { name: "create_flashcards" } },
          temperature: 0.3,
        }),
      });

      if (aiResp.status === 429) throw new Error("Rate limit exceeded. Please try again in a moment.");
      if (aiResp.status === 402) throw new Error("Payment required. Please add credits.");
      if (!aiResp.ok) {
        const t = await aiResp.text();
        console.error("AI error:", aiResp.status, t);
        throw new Error("AI gateway error");
      }

      const aiResult = await aiResp.json();
      const toolCall = aiResult.choices?.[0]?.message?.tool_calls?.[0];
      if (!toolCall) throw new Error("AI did not return flashcards");

      const parsed = JSON.parse(toolCall.function.arguments);
      const cards = parsed.cards || [];

      // Insert flashcards
      let created = 0;
      for (const card of cards) {
        const { error } = await supabase.from("flashcards").insert({
          user_id: userId,
          note_id: note.id,
          course_id: note.course_id,
          cloze_text: card.cloze_text,
          front: card.cloze_text.replace(/\{\{c\d+::(.*?)\}\}/g, "[...]"),
          back: card.cloze_text.replace(/\{\{c\d+::(.*?)\}\}/g, "$1"),
          tags: card.tags || [],
          is_approved: false,
        });
        if (!error) created++;
        else console.error("Flashcard insert error:", error.message);
      }

      return new Response(JSON.stringify({ created, total: cards.length }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "export_csv") {
      // Export approved flashcards as Anki CSV
      const { course_id } = body;
      let query = supabase
        .from("flashcards")
        .select("cloze_text, tags")
        .eq("user_id", userId)
        .eq("is_approved", true);

      if (course_id) query = query.eq("course_id", course_id);

      const { data: cards, error } = await query;
      if (error) throw error;
      if (!cards || cards.length === 0) throw new Error("No approved flashcards to export");

      // Anki Cloze format: Text\tTags
      const lines = cards.map((c: any) => {
        const tags = (c.tags || []).join(" ");
        return `${c.cloze_text}\t${tags}`;
      });
      const csv = lines.join("\n");

      return new Response(csv, {
        headers: {
          ...corsHeaders,
          "Content-Type": "text/tab-separated-values",
          "Content-Disposition": "attachment; filename=anki_flashcards.txt",
        },
      });
    }

    return new Response(JSON.stringify({ error: "Unknown action. Use generate or export_csv" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err: any) {
    console.error("generate-anki-cards error:", err);
    const status = err.message?.includes("Rate limit") ? 429 :
                   err.message?.includes("Payment") ? 402 : 500;
    return new Response(JSON.stringify({ error: err.message }), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
