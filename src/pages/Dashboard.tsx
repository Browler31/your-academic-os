import { useEffect, useState, useCallback, useRef } from "react";
import { DashboardLayout } from "@/components/DashboardLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import {
  BookOpen, Clock, FileText, Zap, CalendarDays, Play, Pause,
  SkipForward, Check, Sparkles, Loader2, Target, Flame,
  ChevronRight,
} from "lucide-react";
import { format, isToday, isPast } from "date-fns";
import { de } from "date-fns/locale";
import { cleanCourseName, parseSemester } from "@/lib/semester";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

export default function Dashboard() {
  const { user } = useAuth();
  const [stats, setStats] = useState({ courses: 0, deadlines: 0, notes: 0, tasks: 0 });
  const [upcomingDeadlines, setUpcomingDeadlines] = useState<any[]>([]);
  const [todayLessons, setTodayLessons] = useState<any[]>([]);
  const [todayTasks, setTodayTasks] = useState<any[]>([]);
  const [currentTask, setCurrentTask] = useState<any | null>(null);
  const [planning, setPlanning] = useState(false);
  const [planningToday, setPlanningToday] = useState(false);

  // Pomodoro timer
  const [timerActive, setTimerActive] = useState(false);
  const [timerSeconds, setTimerSeconds] = useState(25 * 60);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchAll = useCallback(async () => {
    if (!user) return;
    const today = format(new Date(), "yyyy-MM-dd");

    const [coursesRes, deadlinesRes, notesRes, tasksCountRes, upcomingRes, todayLessonsRes, todayTasksRes] =
      await Promise.all([
        supabase.from("courses").select("id", { count: "exact", head: true }).eq("user_id", user.id),
        supabase.from("deadlines").select("id", { count: "exact", head: true }).eq("user_id", user.id).eq("is_completed", false),
        supabase.from("notes").select("id", { count: "exact", head: true }).eq("user_id", user.id),
        supabase.from("tasks").select("id", { count: "exact", head: true }).eq("user_id", user.id).eq("status", "pending"),
        supabase.from("deadlines").select("*, courses(name, short_name)")
          .eq("user_id", user.id).eq("is_completed", false)
          .gte("due_date", new Date().toISOString())
          .order("due_date", { ascending: true }).limit(5),
        supabase.from("timetable_entries").select("*")
          .eq("user_id", user.id).eq("date", today).order("start_time"),
        supabase.from("tasks").select("*, courses(name, short_name)")
          .eq("user_id", user.id).eq("scheduled_for", today)
          .in("status", ["pending", "in_progress"])
          .order("priority_score", { ascending: false }),
      ]);

    setStats({
      courses: coursesRes.count || 0,
      deadlines: deadlinesRes.count || 0,
      notes: notesRes.count || 0,
      tasks: tasksCountRes.count || 0,
    });
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
  }, [fetchAll]);

  // Pomodoro timer logic
  useEffect(() => {
    if (timerActive && timerSeconds > 0) {
      timerRef.current = setInterval(() => {
        setTimerSeconds((prev) => {
          if (prev <= 1) {
            setTimerActive(false);
            toast.success("⏰ Pomodoro fertig! Zeit für eine Pause.");
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

  const startTimer = async () => {
    if (!currentTask || !user) return;
    setTimerActive(true);
    setTimerSeconds((currentTask.estimated_minutes || 25) * 60);

    // Create study session
    const { data } = await supabase.from("study_sessions").insert({
      user_id: user.id,
      task_id: currentTask.id,
      course_id: currentTask.course_id,
      started_at: new Date().toISOString(),
      session_type: "pomodoro",
    }).select("id").single();

    if (data) setSessionId(data.id);

    // Mark task as in_progress
    await supabase.from("tasks").update({ status: "in_progress" }).eq("id", currentTask.id);
  };

  const pauseTimer = () => setTimerActive(false);

  const completeTask = async () => {
    if (!currentTask || !user) return;
    setTimerActive(false);

    // End study session
    if (sessionId) {
      const elapsed = ((currentTask.estimated_minutes || 25) * 60 - timerSeconds);
      await supabase.from("study_sessions").update({
        ended_at: new Date().toISOString(),
        duration_minutes: Math.round(elapsed / 60),
      }).eq("id", sessionId);
    }

    // Mark task done
    await supabase.from("tasks").update({
      status: "done",
      completed_at: new Date().toISOString(),
    }).eq("id", currentTask.id);

    toast.success(`✅ "${currentTask.title}" erledigt!`);

    // Move to next task
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

  const handlePlanWeek = async () => {
    if (!user) return;
    setPlanning(true);
    try {
      const res = await fetch("/api/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "plan_week", user_id: user.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Planung fehlgeschlagen");
      toast.success(`${data.created} Tasks für die Woche erstellt!`);
      await fetchAll();
    } catch (err: any) {
      toast.error(`Planung fehlgeschlagen: ${err.message}`);
    } finally {
      setPlanning(false);
    }
  };

  const handlePlanToday = async () => {
    if (!user) return;
    setPlanningToday(true);
    try {
      const res = await fetch("/api/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "plan_today", user_id: user.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Planung fehlgeschlagen");
      toast.success(`${data.created} Tasks für heute erstellt!`);
      await fetchAll();
    } catch (err: any) {
      toast.error(`Planung fehlgeschlagen: ${err.message}`);
    } finally {
      setPlanningToday(false);
    }
  };

  const timerMinutes = Math.floor(timerSeconds / 60);
  const timerSecs = timerSeconds % 60;
  const completedToday = todayTasks.filter((t) => t.status === "done").length;
  const totalToday = todayTasks.length + completedToday;

  const taskTypeLabels: Record<string, string> = {
    prep_reading: "📖 Vorbereitung",
    lecture_review: "📝 Nachbereitung",
    exercises: "✏️ Übung",
    exam_prep: "🎯 Prüfungsvorbereitung",
    custom: "📋 Aufgabe",
    moodle_material: "📂 Moodle",
    meta_skills: "🧠 Metakompetenz",
  };

  return (
    <DashboardLayout>
      <div className="animate-fade-in">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Study Autopilot</h1>
            <p className="mt-1 text-muted-foreground">
              {format(new Date(), "EEEE, d. MMMM yyyy", { locale: de })}
            </p>
          </div>
          <div className="flex gap-2">
            <Button onClick={handlePlanToday} disabled={planningToday} variant="outline" size="sm">
              {planningToday ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Zap className="mr-2 h-4 w-4" />}
              Heute planen
            </Button>
            <Button onClick={handlePlanWeek} disabled={planning} size="sm">
              {planning ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Sparkles className="mr-2 h-4 w-4" />}
              Woche planen
            </Button>
          </div>
        </div>

        {/* DO THIS NOW - Hero Card */}
        <Card className={cn(
          "mt-6 overflow-hidden transition-all",
          currentTask ? "border-primary/30 bg-gradient-to-br from-primary/5 to-accent/5" : "border-muted"
        )}>
          <CardContent className="p-8">
            {currentTask ? (
              <div className="flex flex-col items-center text-center">
                <Badge className="mb-3 bg-primary/10 text-primary border-primary/20">
                  {taskTypeLabels[currentTask.task_type] || currentTask.task_type}
                </Badge>
                <h2 className="text-2xl font-bold tracking-tight">{currentTask.title}</h2>
                {currentTask.description && (
                  <p className="mt-2 text-sm text-muted-foreground max-w-lg">{currentTask.description}</p>
                )}
                {currentTask.courses && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {cleanCourseName(currentTask.courses.name, currentTask.courses.short_name)}
                  </p>
                )}

                {/* Timer */}
                <div className="mt-6 flex items-center gap-6">
                  <div className={cn(
                    "text-5xl font-mono font-bold tabular-nums",
                    timerActive ? "text-primary" : "text-foreground"
                  )}>
                    {timerMinutes.toString().padStart(2, "0")}:{timerSecs.toString().padStart(2, "0")}
                  </div>
                </div>

                <div className="mt-4 flex items-center gap-3">
                  {!timerActive ? (
                    <Button onClick={startTimer} size="lg" className="gap-2">
                      <Play className="h-4 w-4" /> Start
                    </Button>
                  ) : (
                    <Button onClick={pauseTimer} variant="outline" size="lg" className="gap-2">
                      <Pause className="h-4 w-4" /> Pause
                    </Button>
                  )}
                  <Button onClick={completeTask} variant="outline" size="lg" className="gap-2 text-success border-success/30 hover:bg-success/10">
                    <Check className="h-4 w-4" /> Erledigt
                  </Button>
                  <Button onClick={skipTask} variant="ghost" size="lg" className="gap-2 text-muted-foreground">
                    <SkipForward className="h-4 w-4" /> Überspringen
                  </Button>
                </div>

                {currentTask.estimated_minutes && (
                  <p className="mt-3 text-xs text-muted-foreground">
                    ~{currentTask.estimated_minutes} Min geschätzt
                  </p>
                )}
              </div>
            ) : (
              <div className="flex flex-col items-center text-center py-4">
                <Target className="h-12 w-12 text-muted-foreground/30" />
                <h2 className="mt-4 text-xl font-semibold">Keine Tasks für heute</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Klicke "Heute planen" oder "Woche planen" damit der AI Planner deine Aufgaben erstellt.
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Today's progress + queue */}
        {todayTasks.length > 0 && (
          <Card className="mt-4">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm flex items-center justify-between">
                <span className="flex items-center gap-2">
                  <Flame className="h-4 w-4 text-warning" />
                  Heute noch {todayTasks.length} Tasks
                </span>
                <span className="text-xs text-muted-foreground font-normal">
                  ~{todayTasks.reduce((sum, t) => sum + (t.estimated_minutes || 25), 0)} Min
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-1.5">
              {todayTasks.map((task, idx) => (
                <div
                  key={task.id}
                  onClick={() => {
                    setCurrentTask(task);
                    setTimerActive(false);
                    setTimerSeconds((task.estimated_minutes || 25) * 60);
                  }}
                  className={cn(
                    "flex items-center gap-3 rounded-lg border p-3 cursor-pointer transition-colors",
                    currentTask?.id === task.id
                      ? "border-primary/30 bg-primary/5"
                      : "hover:bg-muted/50"
                  )}
                >
                  <div className={cn(
                    "flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold shrink-0",
                    currentTask?.id === task.id
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-muted-foreground"
                  )}>
                    {idx + 1}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{task.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {taskTypeLabels[task.task_type] || task.task_type}
                      {task.estimated_minutes && ` · ${task.estimated_minutes} Min`}
                    </p>
                  </div>
                  <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                </div>
              ))}
            </CardContent>
          </Card>
        )}

        <div className="mt-6 grid gap-6 lg:grid-cols-2">
          {/* Today's schedule */}
          {todayLessons.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-lg flex items-center gap-2">
                  <CalendarDays className="h-4 w-4" />
                  Vorlesungen heute
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {todayLessons.map((l: any) => (
                    <div key={l.id} className="flex items-center gap-3 rounded-lg border p-3">
                      <div className="text-xs font-mono text-muted-foreground w-24 shrink-0">
                        {l.start_time?.slice(0, 5)} – {l.end_time?.slice(0, 5)}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-sm truncate">{l.subject_name}</p>
                        {l.room_name && (
                          <p className="text-xs text-muted-foreground">{l.room_name}</p>
                        )}
                      </div>
                      <Badge variant="outline" className="text-xs shrink-0">{l.subject_short}</Badge>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Upcoming deadlines */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <Clock className="h-4 w-4" />
                Nächste Deadlines
              </CardTitle>
            </CardHeader>
            <CardContent>
              {upcomingDeadlines.length === 0 ? (
                <p className="text-sm text-muted-foreground">Keine offenen Deadlines. 🎉</p>
              ) : (
                <div className="space-y-3">
                  {upcomingDeadlines.map((d) => {
                    const isOverdue = isPast(new Date(d.due_date));
                    const isDueToday = isToday(new Date(d.due_date));
                    return (
                      <div key={d.id} className={cn(
                        "flex items-center justify-between rounded-lg border p-3",
                        isOverdue && "border-destructive/30 bg-destructive/5",
                        isDueToday && !isOverdue && "border-warning/30 bg-warning/5"
                      )}>
                        <div>
                          <p className="font-medium text-sm">{d.title}</p>
                          <p className="text-xs text-muted-foreground">
                            {d.courses ? cleanCourseName(d.courses.name, d.courses.short_name) : "Kein Kurs"}
                          </p>
                        </div>
                        <span className={cn(
                          "text-xs font-mono",
                          isOverdue ? "text-destructive font-semibold" :
                          isDueToday ? "text-warning font-semibold" :
                          "text-muted-foreground"
                        )}>
                          {format(new Date(d.due_date), "dd. MMM")}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Quick stats */}
        <div className="mt-6 grid gap-4 sm:grid-cols-4">
          {[
            { label: "Kurse", value: stats.courses, icon: BookOpen, color: "text-primary" },
            { label: "Offene Deadlines", value: stats.deadlines, icon: Clock, color: "text-warning" },
            { label: "Notizen", value: stats.notes, icon: FileText, color: "text-accent" },
            { label: "Pendente Tasks", value: stats.tasks, icon: Zap, color: "text-primary" },
          ].map((s) => (
            <Card key={s.label}>
              <CardContent className="flex items-center gap-4 p-4">
                <div className={`rounded-lg bg-muted p-2.5 ${s.color}`}>
                  <s.icon className="h-4 w-4" />
                </div>
                <div>
                  <p className="text-xl font-bold">{s.value}</p>
                  <p className="text-xs text-muted-foreground">{s.label}</p>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </DashboardLayout>
  );
}
