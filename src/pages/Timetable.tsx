import { useEffect, useState, useMemo } from "react";
import { DashboardLayout } from "@/components/DashboardLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { ChevronLeft, ChevronRight, RefreshCw, Loader2, Calendar } from "lucide-react";
import { format, startOfWeek, addDays, subDays, addWeeks, subWeeks, isSameDay } from "date-fns";
import { de } from "date-fns/locale";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

interface TimetableEntry {
  id: string;
  subject_name: string;
  subject_short: string;
  teacher_name: string | null;
  room_name: string | null;
  day_of_week: number;
  start_time: string;
  end_time: string;
  date: string;
  course_id: string | null;
}

const HOURS = Array.from({ length: 12 }, (_, i) => i + 7); // 07:00 - 18:00
const DAYS = ["Mo", "Di", "Mi", "Do", "Fr"];

const SUBJECT_COLORS: Record<string, string> = {};
const COLOR_PALETTE = [
  "bg-primary/15 border-primary/30 text-primary",
  "bg-accent/15 border-accent/30 text-accent",
  "bg-warning/15 border-warning/30 text-warning",
  "bg-destructive/15 border-destructive/30 text-destructive",
  "bg-success/15 border-success/30 text-success",
  "bg-primary/20 border-primary/40 text-primary",
  "bg-accent/20 border-accent/40 text-accent",
];

function getSubjectColor(subjectShort: string): string {
  if (!SUBJECT_COLORS[subjectShort]) {
    const idx = Object.keys(SUBJECT_COLORS).length % COLOR_PALETTE.length;
    SUBJECT_COLORS[subjectShort] = COLOR_PALETTE[idx];
  }
  return SUBJECT_COLORS[subjectShort];
}

function timeToMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

export default function Timetable() {
  const { user, session } = useAuth();
  const [entries, setEntries] = useState<TimetableEntry[]>([]);
  const [currentDate, setCurrentDate] = useState(new Date());
  const [syncing, setSyncing] = useState(false);
  const [loading, setLoading] = useState(true);

  const weekStart = useMemo(
    () => startOfWeek(currentDate, { weekStartsOn: 1 }),
    [currentDate]
  );

  const weekDates = useMemo(
    () => Array.from({ length: 5 }, (_, i) => addDays(weekStart, i)),
    [weekStart]
  );

  const fetchEntries = async () => {
    if (!user) return;
    setLoading(true);
    const from = format(weekDates[0], "yyyy-MM-dd");
    const to = format(weekDates[4], "yyyy-MM-dd");

    const { data, error } = await supabase
      .from("timetable_entries")
      .select("*")
      .eq("user_id", user.id)
      .gte("date", from)
      .lte("date", to)
      .order("start_time");

    if (!error && data) setEntries(data as TimetableEntry[]);
    setLoading(false);
  };

  useEffect(() => {
    fetchEntries();
  }, [user, weekStart]);

  const handleSync = async () => {
    setSyncing(true);
    try {
      const { data, error } = await supabase.functions.invoke("webuntis-sync", {
        body: { action: "sync_semester" },
      });
      if (error) throw error;
      toast.success(`Synced ${data.total_synced} timetable entries across ${data.weeks_processed} weeks!`);
      await fetchEntries();
    } catch (err: any) {
      toast.error(`Sync failed: ${err.message}`);
    } finally {
      setSyncing(false);
    }
  };

  const entriesByDay = useMemo(() => {
    const map: Record<string, TimetableEntry[]> = {};
    for (const e of entries) {
      const key = e.date;
      if (!map[key]) map[key] = [];
      map[key].push(e);
    }
    return map;
  }, [entries]);

  const startHour = 7;
  const hourHeight = 64; // px per hour

  return (
    <DashboardLayout>
      <div className="animate-fade-in">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Stundenplan</h1>
            <p className="mt-1 text-muted-foreground">Dein Wochenplan von WebUntis.</p>
          </div>
          <Button onClick={handleSync} disabled={syncing}>
            {syncing ? (
              <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Syncing...</>
            ) : (
              <><RefreshCw className="mr-2 h-4 w-4" /> Semester synchen</>
            )}
          </Button>
        </div>

        {/* Week navigation */}
        <div className="mt-6 flex items-center gap-3">
          <Button variant="outline" size="icon" onClick={() => setCurrentDate(subWeeks(currentDate, 1))}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button variant="outline" onClick={() => setCurrentDate(new Date())}>
            Heute
          </Button>
          <Button variant="outline" size="icon" onClick={() => setCurrentDate(addWeeks(currentDate, 1))}>
            <ChevronRight className="h-4 w-4" />
          </Button>
          <span className="text-sm font-medium text-muted-foreground">
            {format(weekDates[0], "d. MMM", { locale: de })} – {format(weekDates[4], "d. MMM yyyy", { locale: de })}
          </span>
        </div>

        {/* Calendar grid */}
        <Card className="mt-4 overflow-hidden">
          <CardContent className="p-0">
            <div className="grid grid-cols-[60px_repeat(5,1fr)]">
              {/* Header row */}
              <div className="border-b border-r bg-muted/30 p-2" />
              {weekDates.map((d, i) => (
                <div
                  key={i}
                  className={cn(
                    "border-b border-r p-2 text-center",
                    isSameDay(d, new Date()) && "bg-primary/5"
                  )}
                >
                  <div className="text-xs font-medium text-muted-foreground">{DAYS[i]}</div>
                  <div className={cn(
                    "text-sm font-bold",
                    isSameDay(d, new Date()) && "text-primary"
                  )}>
                    {format(d, "d")}
                  </div>
                </div>
              ))}

              {/* Time grid */}
              <div className="relative col-span-full grid grid-cols-[60px_repeat(5,1fr)]" style={{ height: HOURS.length * hourHeight }}>
                {/* Hour labels */}
                {HOURS.map((h) => (
                  <div
                    key={h}
                    className="absolute left-0 w-[60px] border-r text-right pr-2"
                    style={{ top: (h - startHour) * hourHeight }}
                  >
                    <span className="text-xs text-muted-foreground -translate-y-1/2 block">
                      {h.toString().padStart(2, "0")}:00
                    </span>
                  </div>
                ))}

                {/* Hour grid lines */}
                {HOURS.map((h) => (
                  <div
                    key={`line-${h}`}
                    className="absolute left-[60px] right-0 border-t border-border/50"
                    style={{ top: (h - startHour) * hourHeight }}
                  />
                ))}

                {/* Day columns */}
                {weekDates.map((d, dayIdx) => {
                  const dateStr = format(d, "yyyy-MM-dd");
                  const dayEntries = entriesByDay[dateStr] || [];

                  return (
                    <div
                      key={dayIdx}
                      className={cn(
                        "absolute border-r",
                        isSameDay(d, new Date()) && "bg-primary/[0.02]"
                      )}
                      style={{
                        left: `calc(60px + ${dayIdx} * (100% - 60px) / 5)`,
                        width: `calc((100% - 60px) / 5)`,
                        height: "100%",
                      }}
                    >
                      {dayEntries.map((entry) => {
                        const startMin = timeToMinutes(entry.start_time);
                        const endMin = timeToMinutes(entry.end_time);
                        const top = ((startMin - startHour * 60) / 60) * hourHeight;
                        const height = ((endMin - startMin) / 60) * hourHeight;
                        const colorClass = getSubjectColor(entry.subject_short);

                        return (
                          <div
                            key={entry.id}
                            className={cn(
                              "absolute left-1 right-1 rounded-md border px-2 py-1 overflow-hidden cursor-default transition-shadow hover:shadow-md",
                              colorClass
                            )}
                            style={{ top, height: Math.max(height, 24) }}
                          >
                            <p className="text-xs font-bold truncate">{entry.subject_short}</p>
                            {height > 40 && (
                              <p className="text-[10px] opacity-80 truncate">{entry.subject_name}</p>
                            )}
                            {height > 56 && entry.room_name && (
                              <p className="text-[10px] opacity-60 truncate">{entry.room_name}</p>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Legend */}
        {entries.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-2">
            {[...new Set(entries.map((e) => e.subject_short))].sort().map((s) => {
              const entry = entries.find((e) => e.subject_short === s);
              return (
                <Badge key={s} variant="outline" className={cn("text-xs", getSubjectColor(s))}>
                  {s} — {entry?.subject_name}
                </Badge>
              );
            })}
          </div>
        )}

        {!loading && entries.length === 0 && (
          <div className="mt-8 text-center text-muted-foreground">
            <Calendar className="mx-auto h-12 w-12 opacity-30" />
            <p className="mt-3 font-medium">Kein Stundenplan für diese Woche</p>
            <p className="text-sm">Klicke "Semester synchen" um deinen WebUntis-Stundenplan zu importieren.</p>
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
