import { createClient } from "@supabase/supabase-js";

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

interface WebUntisElement {
  type: number;
  id: number;
  name: string;
  longName?: string;
}

interface WebUntisPeriod {
  id: number;
  lessonId: number;
  date: number;
  startTime: number;
  endTime: number;
  elements: { type: number; id: number }[];
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
  const dow = d.getDay();
  return dow === 0 ? 7 : dow;
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
      action = "fetch_week",
      date,
      school = "zhaw-sml-l",
      entity_id = 17213,
      user_id = DEFAULT_USER_ID,
    } = body;

    const targetDate = date || new Date().toISOString().split("T")[0];
    const url = `https://${school}.webuntis.com/WebUntis/api/public/timetable/weekly/data?elementType=1&elementId=${entity_id}&date=${targetDate}&formatId=1`;

    const resp = await fetch(url);
    if (!resp.ok) {
      throw new Error(`WebUntis API error: ${resp.status} ${resp.statusText}`);
    }

    const data = await resp.json();
    const result = data?.data?.result;
    if (!result) throw new Error("Invalid WebUntis response");

    const elementsArray: WebUntisElement[] = result.data?.elements || [];
    const elementsMap = new Map<number, WebUntisElement>();
    for (const el of elementsArray) {
      elementsMap.set(el.type * 100000 + el.id, el);
    }

    const elementPeriods = result.data?.elementPeriods || {};
    const allPeriods: WebUntisPeriod[] = Object.values(elementPeriods).flat() as WebUntisPeriod[];

    // Fetch existing courses for matching
    const { data: courses } = await supabase
      .from("courses")
      .select("id, name, short_name")
      .eq("user_id", user_id);

    let inserted = 0;
    for (const p of allPeriods) {
      const subjectEl = p.elements?.find((e) => e.type === 3);
      const teacherEl = p.elements?.find((e) => e.type === 2);
      const roomEl = p.elements?.find((e) => e.type === 4);

      const dStr = parseDate(p.date);
      const subject = subjectEl ? elementsMap.get(3 * 100000 + subjectEl.id) : null;
      const teacher = teacherEl ? elementsMap.get(2 * 100000 + teacherEl.id) : null;
      const room = roomEl ? elementsMap.get(4 * 100000 + roomEl.id) : null;

      if (!subject) continue;

      const subjectName = subject.longName || subject.name;
      const subjectShort = subject.name;

      // Match course
      const matched = (courses || []).find((c: any) => {
        const cName = (c.name || "").toLowerCase();
        const cShort = (c.short_name || "").toLowerCase();
        const sName = subjectName.toLowerCase();
        const sShort = subjectShort.toLowerCase();
        return cShort.includes(sShort) || cName.includes(sName) || sName.includes(cName);
      });

      const entry = {
        user_id,
        course_id: matched?.id || null,
        subject_name: subjectName,
        subject_short: subjectShort,
        teacher_name: teacher ? teacher.longName || teacher.name : null,
        room_name: room ? room.name : null,
        day_of_week: dayOfWeek(dStr),
        start_time: padTime(p.startTime),
        end_time: padTime(p.endTime),
        date: dStr,
        webuntis_lesson_id: p.lessonId,
      };

      const { error } = await supabase.from("timetable_entries").upsert(entry, {
        onConflict: "user_id,date,start_time,subject_short",
      });

      if (!error) inserted++;
    }

    return res.status(200).json({ success: true, inserted, total_periods: allPeriods.length });
  } catch (err: any) {
    console.error("webuntis-sync error:", err);
    return res.status(500).json({ error: err.message || "Internal server error" });
  }
}
