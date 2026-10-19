import { useEffect, useState, useMemo } from "react";
import { DashboardLayout } from "@/components/DashboardLayout";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { toast } from "sonner";
import {
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  MapPin,
  User,
  Clock,
  Loader2,
  CalendarCheck,
  Info,
} from "lucide-react";
import { format, startOfWeek, addDays, addWeeks, subWeeks, isToday } from "date-fns";
import { de } from "date-fns/locale";

interface TimetableEntry {
  id: string;
  subject_name: string;
  subject_short: string | null;
  teacher_name: string | null;
  room_name: string | null;
  day_of_week: number;
  start_time: string;
  end_time: string;
  date: string;
  course_id: string | null;
}

const DAY_LABELS = ["Mo", "Di", "Mi", "Do", "Fr"];
const DAY_FULL = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag"];

const ZHAW_LAW_CLASSES = [
  { label: "RE25a (Vollzeit a · W.BA.RE.25HS.VZa)", value: "W.BA.RE.25HS.VZa", id: 17213 },
  { label: "RE25b (Vollzeit b · W.BA.RE.25HS.VZb)", value: "W.BA.RE.25HS.VZb", id: 17216 },
  { label: "RE25TZa (Teilzeit a · W.BA.RE.25HS.TZa)", value: "W.BA.RE.25HS.TZa", id: 17222 },
  { label: "RE25TZb (Teilzeit b · W.BA.RE.25HS.TZb)", value: "W.BA.RE.25HS.TZb", id: 17225 },
  { label: "RE24a (Vollzeit a · W.BA.RE.24HS.VZa)", value: "W.BA.RE.24HS.VZa", id: 17198 },
  { label: "WR25a (Wirtschaftsrecht VZa)", value: "W.BA.WR.25HS.VZa", id: 17324 },
];

const SUBJECT_COLORS: Record<string, string> = {
  default: "bg-primary/15 border-primary/30 text-foreground",
};

const PALETTE = [
  "bg-sky-500/15 border-sky-500/40 text-sky-950 dark:text-sky-100",
  "bg-amber-500/15 border-amber-500/40 text-amber-950 dark:text-amber-100",
  "bg-emerald-500/15 border-emerald-500/40 text-emerald-950 dark:text-emerald-100",
  "bg-violet-500/15 border-violet-500/40 text-violet-950 dark:text-violet-100",
  "bg-rose-500/15 border-rose-500/40 text-rose-950 dark:text-rose-100",
  "bg-cyan-500/15 border-cyan-500/40 text-cyan-950 dark:text-cyan-100",
  "bg-orange-500/15 border-orange-500/40 text-orange-950 dark:text-orange-100",
  "bg-indigo-500/15 border-indigo-500/40 text-indigo-950 dark:text-indigo-100",
];

function getSubjectColor(short: string | null, colorMap: Map<string, string>): string {
  const key = short || "unknown";
  if (!colorMap.has(key)) {
    colorMap.set(key, PALETTE[colorMap.size % PALETTE.length]);
  }
  return colorMap.get(key) || SUBJECT_COLORS.default;
}

function formatTimeShort(t: string): string {
  return t.slice(0, 5);
}

function timeToMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

export default function Timetable() {
  const { user } = useAuth();
  const [currentDate, setCurrentDate] = useState(() => new Date());
  const [entries, setEntries] = useState<TimetableEntry[]>([]);
  const [latestAvailableDate, setLatestAvailableDate] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [selectedClass, setSelectedClass] = useState<string>(
    () => localStorage.getItem("zhaw_webuntis_class") || "W.BA.RE.25HS.VZa"
  );
  const [weekLockedOnWebUntis, setWeekLockedOnWebUntis] = useState(false);

  const colorMap = useMemo(() => new Map<string, string>(), []);
  const weekStart = useMemo(() => startOfWeek(currentDate, { weekStartsOn: 1 }), [currentDate]);
  const weekDays = useMemo(
    () => Array.from({ length: 5 }, (_, i) => addDays(weekStart, i)),
    [weekStart]
  );

  const fetchEntries = async () => {
    if (!user) return;
    setLoading(true);
    const from = format(weekDays[0], "yyyy-MM-dd");
    const to = format(weekDays[4], "yyyy-MM-dd");

    const [weekRes, latestRes] = await Promise.all([
      supabase
        .from("timetable_entries")
        .select("*")
        .eq("user_id", user.id)
        .gte("date", from)
        .lte("date", to)
        .order("start_time"),
      supabase
        .from("timetable_entries")
        .select("date")
        .eq("user_id", user.id)
        .order("date", { ascending: false })
        .limit(1),
    ]);

    if (!weekRes.error && weekRes.data) {
      setEntries(weekRes.data as TimetableEntry[]);
    }
    if (latestRes.data?.[0]?.date) {
      setLatestAvailableDate(latestRes.data[0].date);
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchEntries();
  }, [user, weekStart]);

  const handleSyncWeek = async (targetDateStr?: string) => {
    setSyncing(true);
    try {
      const classObj =
        ZHAW_LAW_CLASSES.find((c) => c.value === selectedClass) || ZHAW_LAW_CLASSES[0];
      const dateStr = targetDateStr || format(weekStart, "yyyy-MM-dd");

      const res = await fetch("/api/webuntis-sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "fetch_week",
          date: dateStr,
          class_name: classObj.value,
          entity_id: classObj.id,
          user_id: user?.id || "59255661-ce8b-476c-8e00-408b55843c58",
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "WebUntis Fehler");

      setWeekLockedOnWebUntis(!!data.locked);
      if (data.locked) {
        toast.info(
          "Diese Woche ist auf ZHAW WebUntis noch nicht öffentlich freigeschaltet. Synchronisiere alle verfügbaren Semesterwochen..."
        );
        await handleSyncSemester();
      } else {
        toast.success(`${data.inserted ?? 0} Lektionen für diese Woche synchronisiert!`);
        await fetchEntries();
      }
    } catch (err: any) {
      toast.error(`Stundenplan-Sync fehlgeschlagen: ${err.message}`);
    } finally {
      setSyncing(false);
    }
  };

  const handleSyncSemester = async () => {
    setSyncing(true);
    try {
      const classObj =
        ZHAW_LAW_CLASSES.find((c) => c.value === selectedClass) || ZHAW_LAW_CLASSES[0];
      const res = await fetch("/api/webuntis-sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "sync_semester",
          date: format(weekStart, "yyyy-MM-dd"),
          class_name: classObj.value,
          entity_id: classObj.id,
          user_id: user?.id || "59255661-ce8b-476c-8e00-408b55843c58",
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "WebUntis Sync Fehler");

      toast.success(
        `${data.inserted ?? 0} Vorlesungsblöcke aus ${data.unlocked_weeks ?? 0} freigeschalteten ZHAW-Wochen synchronisiert!`
      );
      await fetchEntries();

      // If current week has no entries and we know a latest available date, offer or jump
      if (entries.length === 0 && data.latest_date) {
        setLatestAvailableDate(data.latest_date);
      }
    } catch (err: any) {
      toast.error(`Sync fehlgeschlagen: ${err.message}`);
    } finally {
      setSyncing(false);
    }
  };

  const handleClassChange = (val: string) => {
    setSelectedClass(val);
    localStorage.setItem("zhaw_webuntis_class", val);
  };

  const entriesByDay = useMemo(() => {
    const map: Record<string, TimetableEntry[]> = {};
    for (const e of entries) {
      if (!map[e.date]) map[e.date] = [];
      map[e.date].push(e);
    }
    return map;
  }, [entries]);

  const startHour = 7;
  const hourHeight = 64;

  return (
    <DashboardLayout>
      <div className="animate-fade-in space-y-5">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Stundenplan (ZHAW WebUntis)</h1>
            <p className="mt-1 text-muted-foreground">
              Direkte Kopplung mit <span className="font-mono text-xs">zhaw-sml-l.webuntis.com</span> · Automatische Doppellektionen-Zusammenführung.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={selectedClass}
              onChange={(e) => handleClassChange(e.target.value)}
              className="h-9 rounded-md border border-input bg-background px-3 text-xs font-medium shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
            >
              {ZHAW_LAW_CLASSES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
            <Button variant="outline" size="sm" onClick={() => handleSyncWeek()} disabled={syncing}>
              {syncing ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              )}
              Woche synchen
            </Button>
            <Button size="sm" onClick={handleSyncSemester} disabled={syncing}>
              {syncing ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Synchronisiere...
                </>
              ) : (
                <>
                  <RefreshCw className="mr-2 h-4 w-4" /> Ganzes Semester synchen
                </>
              )}
            </Button>
          </div>
        </div>

        {/* Week Navigation */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="icon"
              onClick={() => setCurrentDate((d) => subWeeks(d, 1))}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button variant="outline" size="sm" onClick={() => setCurrentDate(new Date())}>
              Heute
            </Button>
            <Button
              variant="outline"
              size="icon"
              onClick={() => setCurrentDate((d) => addWeeks(d, 1))}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
            {latestAvailableDate && entries.length === 0 && (
              <Button
                variant="secondary"
                size="sm"
                className="gap-1.5 text-xs"
                onClick={() => setCurrentDate(new Date(latestAvailableDate + "T12:00:00"))}
              >
                <CalendarCheck className="h-3.5 w-3.5 text-primary" />
                Zur letzten freigeschalteten Vorlesungswoche ({format(new Date(latestAvailableDate + "T12:00:00"), "dd.MM.yyyy")})
              </Button>
            )}
          </div>
          <span className="text-sm font-medium text-muted-foreground">
            {format(weekDays[0], "d. MMMM", { locale: de })} –{" "}
            {format(weekDays[4], "d. MMMM yyyy", { locale: de })}
          </span>
        </div>

        {/* Helpful Info Banner if current week has no WebUntis entries */}
        {!loading && entries.length === 0 && (
          <Card className="p-5 border-primary/30 bg-primary/5">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div className="flex items-start gap-3">
                <Info className="h-5 w-5 text-primary shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <h3 className="text-sm font-semibold">
                    Keine Lektionen für die Woche vom {format(weekDays[0], "dd.MM.yyyy")} in WebUntis gefunden
                  </h3>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    {weekLockedOnWebUntis
                      ? "ZHAW WebUntis hat dieses Datum im öffentlichen Stundenplan noch nicht freigeschaltet (ERR_TTVIEW_NOTALLOWED_ONDATE)."
                      : "Klicke auf „Ganzes Semester synchen“, um alle von der ZHAW auf WebUntis freigeschalteten Vorlesungswochen automatisch abzurufen."}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {latestAvailableDate && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setCurrentDate(new Date(latestAvailableDate + "T12:00:00"))}
                  >
                    Woche vom {format(new Date(latestAvailableDate + "T12:00:00"), "dd.MM.yyyy")} öffnen
                  </Button>
                )}
                <Button size="sm" onClick={handleSyncSemester} disabled={syncing}>
                  Jetzt Semester laden
                </Button>
              </div>
            </div>
          </Card>
        )}

        {/* Desktop Grid */}
        <div className="hidden lg:block">
          <div className="grid grid-cols-[60px_repeat(5,1fr)] border rounded-xl overflow-hidden bg-card">
            <div className="border-b bg-muted/50 p-3" />
            {weekDays.map((day, i) => {
              const dateStr = format(day, "yyyy-MM-dd");
              const dayEntries = entriesByDay[dateStr] || [];
              const today = isToday(day);
              return (
                <div
                  key={i}
                  className={`border-b border-l p-3 text-center transition-colors ${
                    today ? "bg-primary/5" : "bg-muted/50"
                  }`}
                >
                  <div className="text-xs font-medium text-muted-foreground uppercase">
                    {DAY_LABELS[i]}
                  </div>
                  <div
                    className={`mt-0.5 text-lg font-bold ${
                      today ? "text-primary" : "text-foreground"
                    }`}
                  >
                    {format(day, "d")}
                  </div>
                  {dayEntries.length > 0 && (
                    <Badge variant="secondary" className="mt-1 text-[10px]">
                      {dayEntries.length} Lektionen
                    </Badge>
                  )}
                </div>
              );
            })}

            <div
              className="relative"
              style={{ height: `${(21 - startHour) * hourHeight}px` }}
            >
              {Array.from({ length: 21 - startHour }, (_, i) => (
                <div
                  key={i}
                  className="absolute w-full border-t text-[11px] text-muted-foreground pr-2 text-right font-mono"
                  style={{ top: `${i * hourHeight}px`, height: `${hourHeight}px` }}
                >
                  <span className="-top-2 relative">
                    {(startHour + i).toString().padStart(2, "0")}:00
                  </span>
                </div>
              ))}
            </div>

            {weekDays.map((day, dayIdx) => {
              const dateStr = format(day, "yyyy-MM-dd");
              const dayEntries = entriesByDay[dateStr] || [];
              const today = isToday(day);

              return (
                <div
                  key={dayIdx}
                  className={`relative border-l ${today ? "bg-primary/[0.02]" : ""}`}
                  style={{ height: `${(21 - startHour) * hourHeight}px` }}
                >
                  {Array.from({ length: 21 - startHour }, (_, i) => (
                    <div
                      key={i}
                      className="absolute w-full border-t border-dashed border-border/50"
                      style={{ top: `${i * hourHeight}px` }}
                    />
                  ))}

                  {dayEntries.map((entry) => {
                    const startMin = timeToMinutes(entry.start_time) - startHour * 60;
                    const endMin = timeToMinutes(entry.end_time) - startHour * 60;
                    const top = (startMin / 60) * hourHeight;
                    const height = Math.max(((endMin - startMin) / 60) * hourHeight, 28);
                    const colorClass = getSubjectColor(entry.subject_short, colorMap);

                    return (
                      <div
                        key={entry.id}
                        className={`absolute inset-x-1 rounded-lg border p-2 overflow-hidden transition-shadow hover:shadow-md ${colorClass}`}
                        style={{ top: `${top}px`, height: `${height}px` }}
                      >
                        <div className="flex flex-col h-full justify-between">
                          <div>
                            <div className="font-semibold text-xs leading-tight truncate">
                              {entry.subject_name}
                            </div>
                            {height > 45 && entry.subject_short && (
                              <div className="text-[10px] opacity-70 font-mono truncate mt-0.5">
                                {entry.subject_short}
                              </div>
                            )}
                          </div>
                          {height > 55 && (
                            <div className="flex items-center gap-2 text-[10px] opacity-80 flex-wrap">
                              <span className="flex items-center gap-0.5 font-mono">
                                <Clock className="h-2.5 w-2.5" />
                                {formatTimeShort(entry.start_time)}–
                                {formatTimeShort(entry.end_time)}
                              </span>
                              {entry.room_name && (
                                <span className="flex items-center gap-0.5">
                                  <MapPin className="h-2.5 w-2.5" />
                                  {entry.room_name}
                                </span>
                              )}
                              {entry.teacher_name && (
                                <span className="flex items-center gap-0.5">
                                  <User className="h-2.5 w-2.5" />
                                  {entry.teacher_name}
                                </span>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>

        {/* Mobile List View */}
        <div className="lg:hidden space-y-4">
          {weekDays.map((day, i) => {
            const dateStr = format(day, "yyyy-MM-dd");
            const dayEntries = entriesByDay[dateStr] || [];
            const today = isToday(day);

            return (
              <Card key={i} className={`p-4 ${today ? "ring-2 ring-primary" : ""}`}>
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <span
                      className={`font-bold text-sm ${
                        today ? "text-primary" : "text-foreground"
                      }`}
                    >
                      {DAY_FULL[i]}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {format(day, "d. MMM", { locale: de })}
                    </span>
                  </div>
                  {today && <Badge variant="default" className="text-[10px]">Heute</Badge>}
                </div>

                {dayEntries.length === 0 ? (
                  <p className="text-xs text-muted-foreground italic">Keine Lektionen</p>
                ) : (
                  <div className="space-y-2">
                    {dayEntries.map((entry) => {
                      const colorClass = getSubjectColor(entry.subject_short, colorMap);
                      return (
                        <div key={entry.id} className={`rounded-lg border p-3 ${colorClass}`}>
                          <div className="font-semibold text-sm">{entry.subject_name}</div>
                          <div className="mt-1 flex items-center gap-3 text-xs opacity-80 flex-wrap">
                            <span className="flex items-center gap-1 font-mono">
                              <Clock className="h-3 w-3" />
                              {formatTimeShort(entry.start_time)} –{" "}
                              {formatTimeShort(entry.end_time)}
                            </span>
                            {entry.room_name && (
                              <span className="flex items-center gap-1">
                                <MapPin className="h-3 w-3" />
                                {entry.room_name}
                              </span>
                            )}
                            {entry.teacher_name && (
                              <span className="flex items-center gap-1">
                                <User className="h-3 w-3" />
                                {entry.teacher_name}
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      </div>
    </DashboardLayout>
  );
}
