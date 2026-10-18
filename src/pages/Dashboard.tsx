import { useEffect, useState, useCallback, useRef } from "react";
import { DashboardLayout } from "@/components/DashboardLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import {
  BookOpen,
  Clock,
  CalendarDays,
  Play,
  Pause,
  SkipForward,
  Check,
  Loader2,
  Target,
  Flame,
  ChevronRight,
  Sparkles,
  AlertTriangle,
  ArrowRight,
} from "lucide-react";
import { format, isToday, isPast, differenceInCalendarDays } from "date-fns";
import { de } from "date-fns/locale";
import { cleanCourseName } from "@/lib/semester";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { useNavigate } from "react-router-dom";

export default function Dashboard() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [courses, setCourses] = useState<any[]>([]);
  const [upcomingDeadlines, setUpcomingDeadlines] = useState<any[]>([]);
  const [todayLessons, setTodayLessons] = useState<any[]>([]);
  const [todayTasks, setTodayTasks] = useState<any[]>([]);
  const [currentTask, setCurrentTask] = useState<any | null>(null);

  // Quick-Capture bar (paste email / text and press Enter)
  const [quickInput, setQuickInput] = useState("");
  const [capturing, setCapturing] = useState(false);

  // Pomodoro timer
  const [timerActive, setTimerActive] = useState(false);
  const [timerSeconds, setTimerSeconds] = useState(25 * 60);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchAll = useCallback(async () => {
    if (!user) return;
    const today = format(new Date(), "yyyy-MM-dd");

    const [coursesRes, upcomingRes, todayLessonsRes, todayTasksRes] = await Promise.all([
      supabase.from("courses").select("*").eq("user_id", user.id),
      supabase
        .from("deadlines")
        .select("*, courses(id, name, short_name)")
        .eq("user_id", user.id)
        .eq("is_completed", false)
        .order("due_date", { ascending: true })
        .limit(8),
      supabase
        .from("timetable_entries")
        .select("*")
        .eq("user_id", user.id)
        .eq("date", today)
        .order("start_time"),
      supabase
        .from("tasks")
        .select("*, courses(name, short_name)")
        .eq("user_id", user.id)
        .in("status", ["pending", "in_progress"])
        .order("priority_score", { ascending: false })
        .limit(6),
    ]);

    setCourses(coursesRes.data || []);
    setUpcomingDeadlines(upcomingRes.data || []);
    setTodayLessons(todayLessonsRes.data || []);

    const tasks = todayTasksRes.data || [];
    setTodayTasks(tasks);
    if (!currentTask && tasks.length > 0) {
      setCurrentTask(tasks[0]);
    }
  }, [user, currentTask]);

  useEffect(() => {
    fetchAll();
    const onSynced = () => fetchAll();
    window.addEventListener("study-os-synced", onSynced);
    return () => window.removeEventListener("study-os-synced", onSynced);
  }, [fetchAll]);

  // Pomodoro timer logic
  useEffect(() => {
    if (timerActive && timerSeconds > 0) {
      timerRef.current = setInterval(() => {
        setTimerSeconds((prev) => {
          if (prev <= 1) {
            setTimerActive(false);
            toast.success("⏰ Fokus-Block fertig! Zeit für eine kurze Pause.");
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [timerActive, timerSeconds]);

  const handleQuickCapture = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !quickInput.trim()) return;
    setCapturing(true);
    try {
      // Auto-detect course from text if mentioned
      const lower = quickInput.toLowerCase();
      const matchedCourse = courses.find((c) => {
        const cnName = cleanCourseName(c.name, c.short_name).toLowerCase();
        return (
          lower.includes(cnName) ||
          (cnName.includes("gesellschaftsrecht") && lower.includes("gesellschaftsrecht")) ||
          (cnName.includes("obligationenrecht") && (lower.includes("obligationenrecht") || lower.includes("or at"))) ||
          (cnName.includes("staatsrecht") && lower.includes("staatsrecht")) ||
          (cnName.includes("strafrecht") && lower.includes("strafrecht"))
        );
      });

      const res = await fetch("/api/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "extract_deadlines",
          mode: "extract_from_text",
          user_id: user.id,
          course_id: matchedCourse?.id || null,
          context_title: matchedCourse
            ? cleanCourseName(matchedCourse.name, matchedCourse.short_name)
            : "Schnell-Eintrag",
          text: quickInput,
          auto_save: true,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Fehler");

      if ((data.discovered?.length || 0) > 0) {
        toast.success(
          `✅ ${data.discovered.length} Termin(e) automatisch erkannt und gespeichert!`
        );
        setQuickInput("");
        await fetchAll();
      } else {
        toast.info(
          "Kein Datum im Text gefunden — bitte ein Datum wie '30. Oktober 2026' oder '04.11.2026' mit angeben."
        );
      }
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setCapturing(false);
    }
  };

  const completeDeadline = async (id: string, title: string) => {
    await supabase.from("deadlines").update({ is_completed: true }).eq("id", id);
    toast.success(`✅ "${title}" erledigt!`);
    await fetchAll();
  };

  const startTimer = async () => {
    if (!currentTask || !user) return;
    setTimerActive(true);
    setTimerSeconds((currentTask.estimated_minutes || 25) * 60);

    const { data } = await supabase
      .from("study_sessions")
      .insert({
        user_id: user.id,
        task_id: currentTask.id,
        course_id: currentTask.course_id,
        started_at: new Date().toISOString(),
        session_type: "pomodoro",
      })
      .select("id")
      .single();

    if (data) setSessionId(data.id);
    await supabase.from("tasks").update({ status: "in_progress" }).eq("id", currentTask.id);
  };

  const pauseTimer = () => setTimerActive(false);

  const completeTask = async () => {
    if (!currentTask || !user) return;
    setTimerActive(false);

    if (sessionId) {
      const elapsed = (currentTask.estimated_minutes || 25) * 60 - timerSeconds;
      await supabase
        .from("study_sessions")
        .update({
          ended_at: new Date().toISOString(),
          duration_minutes: Math.round(elapsed / 60),
        })
        .eq("id", sessionId);
    }

    await supabase
      .from("tasks")
      .update({
        status: "done",
        completed_at: new Date().toISOString(),
      })
      .eq("id", currentTask.id);

    toast.success(`✅ "${currentTask.title}" erledigt!`);

    const remaining = todayTasks.filter((t) => t.id !== currentTask.id);
    setTodayTasks(remaining);
    setCurrentTask(remaining.length > 0 ? remaining[0] : null);
    setTimerSeconds(remaining.length > 0 ? (remaining[0].estimated_minutes || 25) * 60 : 25 * 60);
    setSessionId(null);

    await fetchAll();
  };

  const skipTask = async () => {
    if (!currentTask) return;
    await supabase.from("tasks").update({ status: "skipped" }).eq("id", currentTask.id);
    const remaining = todayTasks.filter((t) => t.id !== currentTask.id);
    setTodayTasks(remaining);
    setCurrentTask(remaining.length > 0 ? remaining[0] : null);
    setTimerActive(false);
    setTimerSeconds(remaining.length > 0 ? (remaining[0].estimated_minutes || 25) * 60 : 25 * 60);
  };

  const timerMinutes = Math.floor(timerSeconds / 60);
  const timerSecs = timerSeconds % 60;

  const taskTypeLabels: Record<string, string> = {
    prep_reading: "📖 Vorbereitung",
    lecture_review: "📝 Nachbereitung",
    exercises: "✏️ Übung",
    exam_prep: "🎯 USLN / Prüfung",
    custom: "📋 Aufgabe",
    moodle_material: "📂 Moodle",
    meta_skills: "🧠 Metakompetenz",
  };

  return (
    <DashboardLayout>
      <div className="animate-fade-in space-y-6">
        {/* Top Greeting + Quick-Capture Input */}
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Heute & Fokus</h1>
            <p className="mt-1 text-muted-foreground">
              {format(new Date(), "EEEE, d. MMMM yyyy", { locale: de })} · Automatisch synchronisiert
            </p>
          </div>

          {/* 1-Line Quick Capture for external emails/dates */}
          <form onSubmit={handleQuickCapture} className="flex w-full max-w-md items-center gap-2">
            <Input
              placeholder="E-Mail-Text oder Frist hier einfügen (z.B. 'Abgabe bis Fr. 30. Okt. 2026')..."
              value={quickInput}
              onChange={(e) => setQuickInput(e.target.value)}
              className="text-xs h-9"
            />
            <Button type="submit" size="sm" disabled={capturing || !quickInput.trim()} className="shrink-0">
              {capturing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5 mr-1" />}
              Merken
            </Button>
          </form>
        </div>

        {/* =====================================================================
            SECTION 1: USLN & FRISTEN RADAR (Most Critical Information First)
           ===================================================================== */}
        <Card className="border-warning/30 bg-gradient-to-br from-warning/5 via-background to-background">
          <CardHeader className="pb-3 flex flex-row items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2">
              <Clock className="h-4 w-4 text-warning" />
              Anstehende Leistungsnachweise (USLN) & Fristen
            </CardTitle>
            <Button
              variant="ghost"
              size="sm"
              className="text-xs h-7 gap-1"
              onClick={() => navigate("/tasks")}
            >
              Alle anzeigen <ArrowRight className="h-3 w-3" />
            </Button>
          </CardHeader>
          <CardContent>
            {upcomingDeadlines.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Aktuell keine offenen Fristen. Der Autopilot prüft laufend deine Moodle-Kurse & PDFs.
              </p>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                {upcomingDeadlines.slice(0, 6).map((d) => {
                  const dueDate = new Date(d.due_date);
                  const daysLeft = differenceInCalendarDays(dueDate, new Date());
                  const isOverdue = isPast(dueDate) && !isToday(dueDate);
                  const isUsln = /usln|leistungsnachweis|fallbearbeitung|baes@zhaw/i.test(
                    `${d.title} ${d.description || ""}`
                  );

                  return (
                    <div
                      key={d.id}
                      className={cn(
                        "flex items-start justify-between gap-3 rounded-lg border bg-card p-3.5 transition-all",
                        isUsln && "border-warning/40",
                        isOverdue && "border-destructive/40 bg-destructive/5"
                      )}
                    >
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          {d.courses && (
                            <Badge
                              variant="secondary"
                              className="text-[10px] cursor-pointer hover:bg-primary/10"
                              onClick={() => navigate("/courses")}
                            >
                              {cleanCourseName(d.courses.name, d.courses.short_name)}
                            </Badge>
                          )}
                          {isUsln && (
                            <Badge
                              variant="outline"
                              className="text-[10px] bg-warning/15 text-warning border-warning/30 font-semibold"
                            >
                              🎯 USLN
                            </Badge>
                          )}
                        </div>
                        <p className="font-semibold text-sm leading-snug">{d.title}</p>
                        {d.description && (
                          <p className="text-xs text-muted-foreground line-clamp-2">
                            {d.description}
                          </p>
                        )}
                        <div className="flex items-center gap-2 pt-1">
                          <span
                            className={cn(
                              "text-xs font-mono font-medium",
                              isOverdue
                                ? "text-destructive"
                                : daysLeft <= 7
                                ? "text-warning"
                                : "text-muted-foreground"
                            )}
                          >
                            {format(dueDate, "EEE, dd. MMM yyyy · HH:mm", { locale: de })} Uhr
                          </span>
                          <Badge variant="outline" className="text-[10px]">
                            {isOverdue
                              ? `Vor ${Math.abs(daysLeft)} Tagen`
                              : daysLeft === 0
                              ? "Heute!"
                              : `In ${daysLeft} Tagen`}
                          </Badge>
                        </div>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 shrink-0 text-muted-foreground hover:text-success"
                        onClick={() => completeDeadline(d.id, d.title)}
                        title="Als erledigt markieren"
                      >
                        <Check className="h-4 w-4" />
                      </Button>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        {/* =====================================================================
            SECTION 2: TODAY'S FOCUS TIMER & TODAY'S LECTURES
           ===================================================================== */}
        <div className="grid gap-6 lg:grid-cols-3">
          {/* Focus Card (2 columns wide) */}
          <Card
            className={cn(
              "lg:col-span-2 overflow-hidden transition-all",
              currentTask
                ? "border-primary/30 bg-gradient-to-br from-primary/5 to-accent/5"
                : "border-muted"
            )}
          >
            <CardContent className="p-6">
              {currentTask ? (
                <div className="flex flex-col items-center text-center">
                  <Badge className="mb-2 bg-primary/10 text-primary border-primary/20">
                    {taskTypeLabels[currentTask.task_type] || currentTask.task_type}
                  </Badge>
                  <h2 className="text-xl font-bold tracking-tight">{currentTask.title}</h2>
                  {currentTask.description && (
                    <p className="mt-1.5 text-xs text-muted-foreground max-w-lg line-clamp-2">
                      {currentTask.description}
                    </p>
                  )}
                  {currentTask.courses && (
                    <p className="mt-1 text-xs font-medium text-primary">
                      {cleanCourseName(currentTask.courses.name, currentTask.courses.short_name)}
                    </p>
                  )}

                  <div className="mt-5 flex items-center gap-6">
                    <div
                      className={cn(
                        "text-4xl font-mono font-bold tabular-nums",
                        timerActive ? "text-primary" : "text-foreground"
                      )}
                    >
                      {timerMinutes.toString().padStart(2, "0")}:
                      {timerSecs.toString().padStart(2, "0")}
                    </div>
                  </div>

                  <div className="mt-4 flex items-center gap-2.5">
                    {!timerActive ? (
                      <Button onClick={startTimer} size="sm" className="gap-1.5">
                        <Play className="h-3.5 w-3.5" /> Fokus starten
                      </Button>
                    ) : (
                      <Button onClick={pauseTimer} variant="outline" size="sm" className="gap-1.5">
                        <Pause className="h-3.5 w-3.5" /> Pause
                      </Button>
                    )}
                    <Button
                      onClick={completeTask}
                      variant="outline"
                      size="sm"
                      className="gap-1.5 text-success border-success/30 hover:bg-success/10"
                    >
                      <Check className="h-3.5 w-3.5" /> Erledigt
                    </Button>
                    <Button
                      onClick={skipTask}
                      variant="ghost"
                      size="sm"
                      className="gap-1.5 text-muted-foreground"
                    >
                      <SkipForward className="h-3.5 w-3.5" /> Nächste
                    </Button>
                  </div>

                  {/* Queue preview */}
                  {todayTasks.length > 1 && (
                    <div className="mt-5 w-full border-t pt-3 text-left space-y-1.5">
                      <p className="text-[11px] font-semibold uppercase text-muted-foreground flex items-center gap-1.5">
                        <Flame className="h-3.5 w-3.5 text-warning" /> Weitere Aufgaben ({todayTasks.length})
                      </p>
                      {todayTasks.slice(0, 3).map((t) => (
                        <div
                          key={t.id}
                          onClick={() => {
                            setCurrentTask(t);
                            setTimerActive(false);
                            setTimerSeconds((t.estimated_minutes || 25) * 60);
                          }}
                          className={cn(
                            "flex items-center justify-between rounded border px-3 py-1.5 text-xs cursor-pointer",
                            currentTask?.id === t.id
                              ? "border-primary/40 bg-primary/5 font-medium"
                              : "hover:bg-muted/50"
                          )}
                        >
                          <span className="truncate">{t.title}</span>
                          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex flex-col items-center text-center py-6">
                  <Target className="h-10 w-10 text-muted-foreground/30" />
                  <h2 className="mt-3 text-lg font-semibold">Alles erledigt für heute!</h2>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Der Autopilot plant neue Aufgaben automatisch anhand deiner Fristen & Vorlesungen.
                  </p>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Today's WebUntis Schedule + Module Shortcut */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center justify-between">
                <span className="flex items-center gap-2">
                  <CalendarDays className="h-4 w-4 text-primary" />
                  Vorlesungen heute
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs h-7 px-2"
                  onClick={() => navigate("/timetable")}
                >
                  Stundenplan
                </Button>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {todayLessons.length === 0 ? (
                <div className="py-6 text-center space-y-2">
                  <p className="text-sm text-muted-foreground">Heute keine Vorlesungen im Stundenplan.</p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5"
                    onClick={() => navigate("/courses")}
                  >
                    <BookOpen className="h-3.5 w-3.5" /> Zu meinen Modulen
                  </Button>
                </div>
              ) : (
                <div className="space-y-2">
                  {todayLessons.map((l: any) => (
                    <div key={l.id} className="flex items-center gap-3 rounded-lg border p-2.5">
                      <div className="text-xs font-mono text-muted-foreground w-20 shrink-0">
                        {l.start_time?.slice(0, 5)}–{l.end_time?.slice(0, 5)}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-xs truncate">{l.subject_name}</p>
                        {l.room_name && (
                          <p className="text-[11px] text-muted-foreground">{l.room_name}</p>
                        )}
                      </div>
                      <Badge variant="outline" className="text-[10px] shrink-0">
                        {l.subject_short}
                      </Badge>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </DashboardLayout>
  );
}
