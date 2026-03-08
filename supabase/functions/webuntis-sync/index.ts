import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

interface WebUntisElement {
  type: number; // 1=class, 2=teacher, 3=room, 4=subject
  id: number;
  name: string;
  longName?: string;
}

interface WebUntisPeriod {
  id: number;
  lessonId: number;
  date: number; // e.g. 20260311
  startTime: number; // e.g. 1600
  endTime: number; // e.g. 1645
  elements: { type: number; id: number }[];
  cellState?: string;
}

function padTime(t: number): string {
  const s = t.toString().padStart(4, "0");
  return `${s.slice(0, 2)}:${s.slice(2)}:00`;
}

function parseDate(d: number): string {
  const s = d.toString();
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

function dayOfWeek(dateStr: string): number {
  const d = new Date(dateStr + "T12:00:00");
  const dow = d.getDay(); // 0=Sun
  return dow === 0 ? 7 : dow; // 1=Mon..7=Sun
}

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
    const { action, date, school, entity_id } = body;

    // Get WebUntis config from profile or use provided/defaults
    const { data: profile } = await supabase
      .from("profiles")
      .select("webuntis_school, webuntis_entity_id")
      .eq("user_id", userId)
      .single();

    const webuntisSchool = school || profile?.webuntis_school || "zhaw-sml-l";
    const webuntisEntityId = entity_id || profile?.webuntis_entity_id || 17213;

    if (action === "fetch_week") {
      const targetDate = date || new Date().toISOString().split("T")[0];
      const result = await fetchAndStoreWeek(supabase, userId, webuntisSchool, webuntisEntityId, targetDate);
      return new Response(JSON.stringify(result), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "sync_semester") {
      // Sync from Feb 16 to July 10 for FS 2026
      const startDate = body.start_date || "2026-02-16";
      const endDate = body.end_date || "2026-07-10";
      const result = await syncDateRange(supabase, userId, webuntisSchool, webuntisEntityId, startDate, endDate);
      return new Response(JSON.stringify(result), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "Unknown action. Use fetch_week or sync_semester" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err: any) {
    console.error("webuntis-sync error:", err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

async function fetchWebUntisWeek(school: string, entityId: number, date: string) {
  const url = `https://${school}.webuntis.com/WebUntis/api/public/timetable/weekly/data?elementType=1&elementId=${entityId}&date=${date}&formatId=1`;
  console.log("Fetching WebUntis:", url);
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`WebUntis API error: ${resp.status} ${resp.statusText}`);
  }
  return await resp.json();
}

function parseWebUntisResponse(data: any): {
  periods: { date: string; startTime: string; endTime: string; lessonId: number; subjectId: number; teacherId: number | null; roomId: number | null }[];
  elements: Map<number, WebUntisElement>;
} {
  const result = data?.data?.result;
  if (!result) throw new Error("Invalid WebUntis response structure");

  const elementsArray: WebUntisElement[] = result.data?.elements || [];
  const elementsMap = new Map<number, WebUntisElement>();
  for (const el of elementsArray) {
    // Use composite key: type*100000 + id to avoid collisions between types
    elementsMap.set(el.type * 100000 + el.id, el);
  }

  const elementPeriods = result.data?.elementPeriods || {};
  const allPeriods: WebUntisPeriod[] = Object.values(elementPeriods).flat() as WebUntisPeriod[];

  const parsed = allPeriods.map((p) => {
    // WebUntis ZHAW: type 3 = subject, type 4 = room (not the usual convention)
    const subjectEl = p.elements?.find((e) => e.type === 3);
    const teacherEl = p.elements?.find((e) => e.type === 2);
    const roomEl = p.elements?.find((e) => e.type === 4);

    return {
      date: parseDate(p.date),
      startTime: padTime(p.startTime),
      endTime: padTime(p.endTime),
      lessonId: p.lessonId,
      subjectId: subjectEl?.id || 0,
      teacherId: teacherEl?.id || null,
      roomId: roomEl?.id || null,
    };
  });

  return { periods: parsed, elements: elementsMap };
}

function mergePeriods(periods: typeof parseWebUntisResponse extends (...args: any) => infer R ? R extends { periods: infer P } ? P : never : never) {
  // Sort by date, startTime, lessonId
  const sorted = [...periods].sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    if (a.startTime !== b.startTime) return a.startTime.localeCompare(b.startTime);
    return a.lessonId - b.lessonId;
  });

  // Merge consecutive periods with same lessonId + date
  const merged: typeof sorted = [];
  for (const p of sorted) {
    const last = merged[merged.length - 1];
    if (last && last.lessonId === p.lessonId && last.date === p.date && last.endTime === p.startTime) {
      last.endTime = p.endTime;
    } else {
      merged.push({ ...p });
    }
  }

  // Deduplicate by date+startTime+subjectId
  const seen = new Set<string>();
  return merged.filter((p) => {
    const key = `${p.date}-${p.startTime}-${p.subjectId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function fetchAndStoreWeek(supabase: any, userId: string, school: string, entityId: number, date: string) {
  const raw = await fetchWebUntisWeek(school, entityId, date);
  const { periods, elements } = parseWebUntisResponse(raw);
  const merged = mergePeriods(periods);

  // Get user's courses for matching
  const { data: courses } = await supabase.from("courses").select("id, name, short_name").eq("user_id", userId);

  const entries = merged.map((p) => {
    // Match swapped types: subject=3, room=4
    const subjectEl = elements.get(3 * 100000 + p.subjectId);
    const teacherEl = p.teacherId ? elements.get(2 * 100000 + p.teacherId) : null;
    const roomEl = p.roomId ? elements.get(4 * 100000 + p.roomId) : null;

    const subjectShort = subjectEl?.name || "???";
    const subjectName = subjectEl?.longName || subjectEl?.name || "Unknown";

    // Match to course
    const matchedCourse = courses?.find((c: any) => {
      const sn = (c.short_name || "").toUpperCase();
      const shortUpper = subjectShort.toUpperCase();
      // Match: short_name contains the subject abbreviation
      // e.g. "w.BA.XX.1FER-RE.XX.2026-FS" contains "FER"
      if (shortUpper.length >= 2 && sn.includes(shortUpper)) return true;
      // Also try matching by course name containing the long name
      if (subjectName.length > 3 && c.name.toLowerCase().includes(subjectName.toLowerCase())) return true;
      return false;
    });

    return {
      user_id: userId,
      course_id: matchedCourse?.id || null,
      subject_name: subjectName,
      subject_short: subjectShort,
      teacher_name: teacherEl?.longName || teacherEl?.name || null,
      room_name: roomEl?.name || null,
      day_of_week: dayOfWeek(p.date),
      start_time: p.startTime,
      end_time: p.endTime,
      date: p.date,
      webuntis_lesson_id: p.lessonId,
    };
  });

  if (entries.length === 0) {
    return { synced: 0, week_of: date };
  }

  // Delete existing entries for this date range, then insert
  const dates = [...new Set(entries.map((e) => e.date))];
  const minDate = dates.sort()[0];
  const maxDate = dates.sort().reverse()[0];

  await supabase
    .from("timetable_entries")
    .delete()
    .eq("user_id", userId)
    .gte("date", minDate)
    .lte("date", maxDate);

  const { error } = await supabase.from("timetable_entries").insert(entries);
  if (error) throw new Error(`Insert failed: ${error.message}`);

  return { synced: entries.length, week_of: date, dates: { from: minDate, to: maxDate } };
}

async function syncDateRange(supabase: any, userId: string, school: string, entityId: number, startDate: string, endDate: string) {
  let current = new Date(startDate);
  const end = new Date(endDate);
  let totalSynced = 0;
  let weeksProcessed = 0;

  while (current <= end) {
    const dateStr = current.toISOString().split("T")[0];
    try {
      const result = await fetchAndStoreWeek(supabase, userId, school, entityId, dateStr);
      totalSynced += result.synced;
      weeksProcessed++;
    } catch (err: any) {
      console.error(`Failed to sync week of ${dateStr}:`, err.message);
    }
    // Move to next week
    current.setDate(current.getDate() + 7);
  }

  return { total_synced: totalSynced, weeks_processed: weeksProcessed, range: { from: startDate, to: endDate } };
}
