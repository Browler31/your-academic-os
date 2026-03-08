import { useEffect, useState } from "react";
import { DashboardLayout } from "@/components/DashboardLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { BookOpen, Clock, FileText, AlertCircle } from "lucide-react";
import { format, isPast, isFuture, addDays } from "date-fns";

export default function Dashboard() {
  const { user } = useAuth();
  const [stats, setStats] = useState({ courses: 0, deadlines: 0, notes: 0, upcoming: 0 });
  const [upcomingDeadlines, setUpcomingDeadlines] = useState<any[]>([]);

  useEffect(() => {
    if (!user) return;

    const fetchStats = async () => {
      const [coursesRes, deadlinesRes, notesRes, upcomingRes] = await Promise.all([
        supabase.from("courses").select("id", { count: "exact", head: true }).eq("user_id", user.id),
        supabase.from("deadlines").select("id", { count: "exact", head: true }).eq("user_id", user.id).eq("is_completed", false),
        supabase.from("notes").select("id", { count: "exact", head: true }).eq("user_id", user.id),
        supabase
          .from("deadlines")
          .select("*, courses(name)")
          .eq("user_id", user.id)
          .eq("is_completed", false)
          .gte("due_date", new Date().toISOString())
          .lte("due_date", addDays(new Date(), 7).toISOString())
          .order("due_date", { ascending: true })
          .limit(5),
      ]);

      setStats({
        courses: coursesRes.count || 0,
        deadlines: deadlinesRes.count || 0,
        notes: notesRes.count || 0,
        upcoming: upcomingRes.data?.length || 0,
      });
      setUpcomingDeadlines(upcomingRes.data || []);
    };

    fetchStats();
  }, [user]);

  const statCards = [
    { label: "Courses", value: stats.courses, icon: BookOpen, color: "text-primary" },
    { label: "Open Deadlines", value: stats.deadlines, icon: Clock, color: "text-warning" },
    { label: "Notes", value: stats.notes, icon: FileText, color: "text-accent" },
    { label: "Due This Week", value: stats.upcoming, icon: AlertCircle, color: "text-destructive" },
  ];

  return (
    <DashboardLayout>
      <div className="animate-fade-in">
        <h1 className="text-3xl font-bold tracking-tight">Dashboard</h1>
        <p className="mt-1 text-muted-foreground">Welcome back. Here's your study overview.</p>

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

        {/* Upcoming deadlines */}
        <Card className="mt-8">
          <CardHeader>
            <CardTitle className="text-lg">Upcoming Deadlines</CardTitle>
          </CardHeader>
          <CardContent>
            {upcomingDeadlines.length === 0 ? (
              <p className="text-sm text-muted-foreground">No deadlines in the next 7 days. 🎉</p>
            ) : (
              <div className="space-y-3">
                {upcomingDeadlines.map((d) => (
                  <div key={d.id} className="flex items-center justify-between rounded-lg border p-3">
                    <div>
                      <p className="font-medium text-sm">{d.title}</p>
                      <p className="text-xs text-muted-foreground">{d.courses?.name || "No course"}</p>
                    </div>
                    <span className="text-xs font-mono text-muted-foreground">
                      {format(new Date(d.due_date), "MMM d, HH:mm")}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
