import { useEffect, useState } from "react";
import { DashboardLayout } from "@/components/DashboardLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { BookOpen, Clock, FileText, AlertCircle, Zap, CalendarDays } from "lucide-react";
import { format, addDays, isPast, isToday } from "date-fns";
import { de } from "date-fns/locale";
import { cleanCourseName, parseSemester } from "@/lib/semester";
import { cn } from "@/lib/utils";

export default function Dashboard() {
  const { user } = useAuth();
  const [stats, setStats] = useState({ courses: 0, deadlines: 0, notes: 0, tasks: 0 });
  const [upcomingDeadlines, setUpcomingDeadlines] = useState<any[]>([]);
  const [currentCourses, setCurrentCourses] = useState<any[]>([]);
  const [todayLessons, setTodayLessons] = useState<any[]>([]);

  useEffect(() => {
    if (!user) return;

    const fetchAll = async () => {
      const today = format(new Date(), "yyyy-MM-dd");
      const [coursesRes, deadlinesRes, notesRes, tasksRes, upcomingRes, coursesData, todayRes] = await Promise.all([
        supabase.from("courses").select("id", { count: "exact", head: true }).eq("user_id", user.id),
        supabase.from("deadlines").select("id", { count: "exact", head: true }).eq("user_id", user.id).eq("is_completed", false),
        supabase.from("notes").select("id", { count: "exact", head: true }).eq("user_id", user.id),
        supabase.from("tasks").select("id", { count: "exact", head: true }).eq("user_id", user.id).eq("status", "pending"),
        supabase
          .from("deadlines")
          .select("*, courses(name, short_name)")
          .eq("user_id", user.id)
          .eq("is_completed", false)
          .gte("due_date", new Date().toISOString())
          .order("due_date", { ascending: true })
          .limit(6),
        supabase
          .from("courses")
          .select("*")
          .eq("user_id", user.id)
          .order("name"),
        supabase
          .from("timetable_entries")
          .select("*")
          .eq("user_id", user.id)
          .eq("date", today)
          .order("start_time"),
      ]);

      setStats({
        courses: coursesRes.count || 0,
        deadlines: deadlinesRes.count || 0,
        notes: notesRes.count || 0,
        tasks: tasksRes.count || 0,
      });
      setUpcomingDeadlines(upcomingRes.data || []);
      setTodayLessons(todayRes.data || []);

      // Filter current semester courses
      const allCourses = coursesData.data || [];
      const current = allCourses.filter((c) => parseSemester(c.name, c.short_name).isCurrent);
      setCurrentCourses(current.length > 0 ? current : allCourses.slice(0, 6));
    };

    fetchAll();
  }, [user]);

  const statCards = [
    { label: "Kurse", value: stats.courses, icon: BookOpen, color: "text-primary" },
    { label: "Offene Deadlines", value: stats.deadlines, icon: Clock, color: "text-warning" },
    { label: "Notizen", value: stats.notes, icon: FileText, color: "text-accent" },
    { label: "Pendente Tasks", value: stats.tasks, icon: Zap, color: "text-primary" },
  ];

  return (
    <DashboardLayout>
      <div className="animate-fade-in">
        <h1 className="text-3xl font-bold tracking-tight">Dashboard</h1>
        <p className="mt-1 text-muted-foreground">Dein Studienüberblick.</p>

        {/* Stats */}
        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {statCards.map((s) => (
            <Card key={s.label}>
              <CardContent className="flex items-center gap-4 p-6">
                <div className={`rounded-lg bg-muted p-3 ${s.color}`}>
                  <s.icon className="h-5 w-5" />
                </div>
                <div>
                  <p className="text-2xl font-bold">{s.value}</p>
                  <p className="text-sm text-muted-foreground">{s.label}</p>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Today's schedule */}
        {todayLessons.length > 0 && (
          <Card className="mt-8">
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <CalendarDays className="h-4 w-4" />
                Heute auf dem Plan
                <Badge variant="outline" className="ml-auto bg-accent/10 text-accent border-accent/20 text-xs">
                  {format(new Date(), "EEEE, d. MMM", { locale: de })}
                </Badge>
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
                        <p className="text-xs text-muted-foreground">{l.room_name}{l.teacher_name ? ` · ${l.teacher_name}` : ""}</p>
                      )}
                    </div>
                    <Badge variant="outline" className="text-xs shrink-0">{l.subject_short}</Badge>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        <div className="mt-8 grid gap-6 lg:grid-cols-2">
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

          {/* Current semester courses */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <BookOpen className="h-4 w-4" />
                Aktuelle Kurse
                <Badge variant="outline" className="ml-auto bg-primary/10 text-primary border-primary/20 text-xs">
                  FS 2026
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {currentCourses.map((c) => (
                  <div key={c.id} className="flex items-center gap-3 rounded-lg border p-3">
                    <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary/10 text-primary text-xs font-bold shrink-0">
                      {cleanCourseName(c.name, c.short_name).substring(0, 2).toUpperCase()}
                    </div>
                    <p className="font-medium text-sm truncate">
                      {cleanCourseName(c.name, c.short_name)}
                    </p>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </DashboardLayout>
  );
}
