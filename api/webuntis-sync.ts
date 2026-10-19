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

interface ParsedPeriod {
  date: string;
  startTime: string;
  endTime: string;
  lessonId: number;
  subjectId: number;
  teacherId: number | null;
  roomId: number | null;
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

function mergePeriods(periods: ParsedPeriod[]): ParsedPeriod[] {
  const sorted = [...periods].sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    if (a.startTime !== b.startTime) return a.startTime.localeCompare(b.startTime);
    return a.lessonId - b.lessonId;
  });

  const merged: ParsedPeriod[] = [];
  for (const p of sorted) {
    const last = merged[merged.length - 1];
    if (
      last &&
      last.lessonId === p.lessonId &&
      last.date === p.date &&
      last.endTime === p.startTime
    ) {
      last.endTime = p.endTime;
    } else {
      merged.push({ ...p });
    }
  }

  const seen = new Set<string>();
  return merged.filter((p) => {
    const key = `${p.date}-${p.startTime}-${p.subjectId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function resolveClassEntityId(
  school: string,
  className: string,
  fallbackId: number,
  probeDate: string
): Promise<number> {
  try {
    const url = `https://${school}.webuntis.com/WebUntis/api/public/timetable/weekly/pageconfig?type=1&date=${probeDate}&formatId=2`;
    const resp = await fetch(url);
    if (!resp.ok) return fallbackId;
    const json = await resp.json();
    const elements: WebUntisElement[] = json?.data?.elements || [];
    if (!elements.length) return fallbackId;

    const target = className.toLowerCase();
    const exact = elements.find(
      (e) =>
        (e.name || "").toLowerCase() === target ||
        (e.longName || "").toLowerCase() === target
    );
    if (exact) return exact.id;

    const partial = elements.find(
      (e) =>
        (e.name || "").toLowerCase().includes(target) ||
        (e.longName || "").toLowerCase().includes(target)
    );
    return partial ? partial.id : fallbackId;
  } catch {
    return fallbackId;
  }
}

async function fetchAndStoreSingleWeek(
  supabase: any,
  userId: string,
  school: string,
  entityId: number,
  dateStr: string,
  courses: any[]
): Promise<{ inserted: number; total_periods: number; locked: boolean; dates?: string[] }> {
  const url = `https://${school}.webuntis.com/WebUntis/api/public/timetable/weekly/data?elementType=1&elementId=${entityId}&date=${dateStr}&formatId=1`;
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`WebUntis HTTP ${resp.status}`);
  }

  const data = await resp.json();
  const errKey = data?.data?.error?.data?.messageKey;
  if (errKey === "ERR_TTVIEW_NOTALLOWED_ONDATE" || data?.data?.error) {
    return { inserted: 0, total_periods: 0, locked: true };
  }

  const result = data?.data?.result;
  if (!result) {
    return { inserted: 0, total_periods: 0, locked: true };
  }

  const elementsArray: WebUntisElement[] = result.data?.elements || [];
  const elementsMap = new Map<number, WebUntisElement>();
  for (const el of elementsArray) {
    elementsMap.set(el.type * 100000 + el.id, el);
  }

  const elementPeriods = result.data?.elementPeriods || {};
  const allPeriods: WebUntisPeriod[] = Object.values(elementPeriods).flat() as WebUntisPeriod[];

  const rawParsed: ParsedPeriod[] = allPeriods.map((p) => {
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

  const merged = mergePeriods(rawParsed);
  let inserted = 0;
  const touchedDates = new Set<string>();

  for (const p of merged) {
    const subject = elementsMap.get(3 * 100000 + p.subjectId);
    const teacher = p.teacherId ? elementsMap.get(2 * 100000 + p.teacherId) : null;
    const room = p.roomId ? elementsMap.get(4 * 100000 + p.roomId) : null;

    if (!subject) continue;

    const subjectName = subject.longName || subject.name;
    const subjectShort = subject.name;

    const matched = (courses || []).find((c: any) => {
      const cName = (c.name || "").toLowerCase();
      const cShort = (c.short_name || "").toLowerCase();
      const sName = subjectName.toLowerCase();
      const sShort = subjectShort.toLowerCase();
      return (
        (sShort.length >= 2 && cShort.includes(sShort)) ||
        (sName.length > 3 && cName.includes(sName)) ||
        (cName.length > 3 && sName.includes(cName))
      );
    });

    const entry = {
      user_id: userId,
      course_id: matched?.id || null,
      subject_name: subjectName,
      subject_short: subjectShort,
      teacher_name: teacher ? teacher.longName || teacher.name : null,
      room_name: room ? room.name : null,
      day_of_week: dayOfWeek(p.date),
      start_time: p.startTime,
      end_time: p.endTime,
      date: p.date,
      webuntis_lesson_id: p.lessonId,
    };

    const { error } = await supabase.from("timetable_entries").upsert(entry, {
      onConflict: "user_id,date,start_time,subject_short",
    });

    if (!error) {
      inserted++;
      touchedDates.add(p.date);
    }
  }

  return {
    inserted,
    total_periods: merged.length,
    locked: false,
    dates: Array.from(touchedDates).sort(),
  };
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
      class_name = "W.BA.RE.25HS.VZa",
      user_id = DEFAULT_USER_ID,
    } = body;

    if (action === "list_classes") {
      const probeDates = [date, "2026-03-16", "2025-10-20"].filter(Boolean) as string[];
      for (const pd of probeDates) {
        const url = `https://${school}.webuntis.com/WebUntis/api/public/timetable/weekly/pageconfig?type=1&date=${pd}&formatId=2`;
        const resp = await fetch(url);
        if (!resp.ok) continue;
        const json = await resp.json();
        const elements: WebUntisElement[] = json?.data?.elements || [];
        const lawClasses = elements.filter((e) =>
          /\b(RE|WR)\b|\.(RE|WR)\./i.test(`${e.name} ${e.longName || ""}`)
        );
        if (lawClasses.length > 0) {
          return res.status(200).json({
            success: true,
            probe_date: pd,
            classes: lawClasses.map((e) => ({
              id: e.id,
              name: e.name,
              longName: e.longName || e.name,
            })),
          });
        }
      }
      return res.status(200).json({ success: true, classes: [] });
    }

    const { data: courses } = await supabase
      .from("courses")
      .select("id, name, short_name")
      .eq("user_id", user_id);

    if (action === "sync_semester") {
      // Probe both current view week and all active semester weeks
      const candidateWeeks: string[] = [];
      if (date) candidateWeeks.push(date);

      // Generate weekly Mondays for 2026-FS (Feb 16 - May 24) and 2026-HS (Sep 14 - Dec 18)
      const ranges = [
        ["2026-09-14", "2026-12-18"],
        ["2026-02-16", "2026-05-22"],
      ];
      for (const [startStr, endStr] of ranges) {
        const cur = new Date(startStr + "T12:00:00Z");
        const end = new Date(endStr + "T12:00:00Z");
        while (cur <= end) {
          const dStr = cur.toISOString().split("T")[0];
          if (!candidateWeeks.includes(dStr)) candidateWeeks.push(dStr);
          cur.setUTCDate(cur.getUTCDate() + 7);
        }
      }

      // Resolve class ID on an unlocked probe date
      const resolvedId = await resolveClassEntityId(
        school,
        class_name,
        Number(entity_id) || 17213,
        date || "2026-03-16"
      );

      let totalInserted = 0;
      let unlockedWeeks = 0;
      let lockedWeeks = 0;
      const syncedDates: string[] = [];

      // Sync weeks in parallel batches of 5 for fast execution inside Vercel serverless timeout
      const batchSize = 5;
      for (let i = 0; i < candidateWeeks.length; i += batchSize) {
        const batch = candidateWeeks.slice(i, i + batchSize);
        const results = await Promise.all(
          batch.map((wDate) =>
            fetchAndStoreSingleWeek(supabase, user_id, school, resolvedId, wDate, courses || []).catch(
              () => ({ inserted: 0, total_periods: 0, locked: true, dates: [] })
            )
          )
        );
        for (const r of results) {
          if (r.locked) {
            lockedWeeks++;
          } else {
            unlockedWeeks++;
            totalInserted += r.inserted;
            if (r.dates) syncedDates.push(...r.dates);
          }
        }
      }

      const sortedDates = Array.from(new Set(syncedDates)).sort();
      return res.status(200).json({
        success: true,
        inserted: totalInserted,
        total_synced: totalInserted,
        unlocked_weeks: unlockedWeeks,
        locked_weeks: lockedWeeks,
        class_name,
        entity_id: resolvedId,
        latest_date: sortedDates[sortedDates.length - 1] || null,
        earliest_date: sortedDates[0] || null,
      });
    }

    // Default: fetch_week for a specific date
    const targetDate = date || new Date().toISOString().split("T")[0];
    const resolvedId = await resolveClassEntityId(
      school,
      class_name,
      Number(entity_id) || 17213,
      targetDate
    );
    const weekRes = await fetchAndStoreSingleWeek(
      supabase,
      user_id,
      school,
      resolvedId,
      targetDate,
      courses || []
    );

    return res.status(200).json({
      success: true,
      inserted: weekRes.inserted,
      total_periods: weekRes.total_periods,
      locked: weekRes.locked,
      class_name,
      entity_id: resolvedId,
    });
  } catch (err: any) {
    console.error("webuntis-sync error:", err);
    return res.status(500).json({ error: err.message || "Internal server error" });
  }
}
