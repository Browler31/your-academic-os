import { useEffect, useState, useCallback } from "react";
import { DashboardLayout } from "@/components/DashboardLayout";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Flame, Target, TrendingUp, BookOpen, Brain, Clock, Loader2 } from "lucide-react";
import { format, subDays, differenceInDays, isToday, isYesterday } from "date-fns";
import { de } from "date-fns/locale";
import {
  AreaChart, Area, PieChart, Pie, Cell,
  XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
  ComposedChart, Line, Bar,
} from "recharts";

interface CourseProgress {
  name: string;
  shortName: string;
  totalFiles: number;
  parsedFiles: number;
  totalFlashcards: number;
  approvedFlashcards: number;
  coverage: number;
}

export default function Analytics() {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [streak, setStreak] = useState({ current: 0, longest: 0 });
  const [weeklyData, setWeeklyData] = useState<any[]>([]);
  const [courseProgress, setCourseProgress] = useState<CourseProgress[]>([]);
  const [totalStats, setTotalStats] = useState({
    totalStudyMinutes: 0,
    totalSessions: 0,
    totalFlashcards: 0,
    totalNorms: 0,
  });

  const COLORS = [
    "hsl(var(--primary))",
    "hsl(var(--accent))",
    "hsl(210, 70%, 50%)",
    "hsl(150, 60%, 45%)",
    "hsl(30, 80%, 55%)",
    "hsl(280, 60%, 55%)",
    "hsl(0, 70%, 55%)",
    "hsl(180, 50%, 45%)",
  ];

  const fetchAnalytics = useCallback(async () => {
    if (!user) return;
    setLoading(true);

    try {
      // 1. Study sessions for the last 14 days
      const twoWeeksAgo = subDays(new Date(), 14).toISOString();
      const { data: sessions } = await supabase
        .from("study_sessions")
        .select("started_at, duration_minutes, session_type, course_id")
        .eq("user_id", user.id)
        .gte("started_at", twoWeeksAgo)
        .order("started_at");

      // Build daily chart data
      const dailyMap: Record<string, { study: number; anki: number }> = {};
      for (let i = 13; i >= 0; i--) {
        const d = format(subDays(new Date(), i), "yyyy-MM-dd");
        dailyMap[d] = { study: 0, anki: 0 };
      }
      for (const s of sessions || []) {
        const day = format(new Date(s.started_at), "yyyy-MM-dd");
        if (dailyMap[day]) {
          const mins = s.duration_minutes || 0;
          if (s.session_type === "anki") {
            dailyMap[day].anki += mins;
          } else {
            dailyMap[day].study += mins;
          }
        }
      }
      const chartData = Object.entries(dailyMap).map(([date, vals]) => ({
        date: format(new Date(date), "dd. MMM", { locale: de }),
        study: Math.round(vals.study),
        anki: Math.round(vals.anki),
        total: Math.round(vals.study + vals.anki),
      }));
      setWeeklyData(chartData);

      // 2. Calculate streak
      const studyDates = new Set(
        (sessions || [])
          .filter(s => (s.duration_minutes || 0) > 0)
          .map(s => format(new Date(s.started_at), "yyyy-MM-dd"))
      );

      let currentStreak = 0;
      let checkDate = new Date();
      // Check if studied today
      if (studyDates.has(format(checkDate, "yyyy-MM-dd"))) {
        currentStreak = 1;
        checkDate = subDays(checkDate, 1);
      } else {
        // Check yesterday (allow a grace period)
        checkDate = subDays(checkDate, 1);
      }
      while (studyDates.has(format(checkDate, "yyyy-MM-dd"))) {
        currentStreak++;
        checkDate = subDays(checkDate, 1);
      }

      // Get or update streak record
      const { data: streakData } = await supabase
        .from("study_streaks")
        .select("*")
        .eq("user_id", user.id)
        .maybeSingle();

      const longest = Math.max(currentStreak, streakData?.longest_streak || 0);
      if (streakData) {
        await supabase.from("study_streaks").update({
          current_streak: currentStreak,
          longest_streak: longest,
          last_study_date: format(new Date(), "yyyy-MM-dd"),
        }).eq("id", streakData.id);
      } else {
        await supabase.from("study_streaks").insert({
          user_id: user.id,
          current_streak: currentStreak,
          longest_streak: longest,
          last_study_date: format(new Date(), "yyyy-MM-dd"),
        });
      }
      setStreak({ current: currentStreak, longest });

      // 3. Course progress
      const { data: courses } = await supabase
        .from("courses")
        .select("id, name, short_name")
        .eq("user_id", user.id);

      const progress: CourseProgress[] = [];
      let totalNorms = 0;

      for (const course of courses || []) {
        const [filesRes, flashcardsRes] = await Promise.all([
          supabase.from("files").select("id, extraction_status, extracted_content").eq("course_id", course.id).eq("user_id", user.id),
          supabase.from("flashcards").select("id, is_approved").eq("course_id", course.id).eq("user_id", user.id),
        ]);

        const files = filesRes.data || [];
        const flashcards = flashcardsRes.data || [];
        const parsedFiles = files.filter(f => f.extraction_status === "done");
        const normsCount = parsedFiles.reduce((sum, f) => {
          const content = f.extracted_content as any;
          return sum + (content?.norms?.length || 0);
        }, 0);
        totalNorms += normsCount;

        const totalElements = normsCount || files.length || 1;
        const mastered = flashcards.filter(f => f.is_approved).length;

        progress.push({
          name: course.name,
          shortName: course.short_name || course.name.substring(0, 8),
          totalFiles: files.length,
          parsedFiles: parsedFiles.length,
          totalFlashcards: flashcards.length,
          approvedFlashcards: mastered,
          coverage: Math.min(100, Math.round((mastered / totalElements) * 100)),
        });
      }
      setCourseProgress(progress);

      // 4. Total stats
      const totalMins = (sessions || []).reduce((s, x) => s + (x.duration_minutes || 0), 0);
      const { count: fcCount } = await supabase
        .from("flashcards")
        .select("id", { count: "exact", head: true })
        .eq("user_id", user.id);

      setTotalStats({
        totalStudyMinutes: totalMins,
        totalSessions: (sessions || []).length,
        totalFlashcards: fcCount || 0,
        totalNorms: totalNorms,
      });
    } catch (err) {
      console.error("Analytics fetch error:", err);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    fetchAnalytics();
  }, [fetchAnalytics]);

  if (loading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div className="animate-fade-in">
        <h1 className="text-3xl font-bold tracking-tight">Study Analytics</h1>
        <p className="mt-1 text-muted-foreground">Dein Fortschritt auf einen Blick</p>

        {/* Streak + Stats Row */}
        <div className="mt-6 grid gap-4 sm:grid-cols-4">
          <Card className="border-warning/30 bg-gradient-to-br from-warning/5 to-transparent">
            <CardContent className="p-5 flex items-center gap-4">
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-warning/10">
                <Flame className="h-6 w-6 text-warning" />
              </div>
              <div>
                <p className="text-3xl font-bold">{streak.current}</p>
                <p className="text-xs text-muted-foreground">Tage Streak</p>
                <p className="text-xs text-muted-foreground">Best: {streak.longest}</p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-5 flex items-center gap-4">
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
                <Clock className="h-6 w-6 text-primary" />
              </div>
              <div>
                <p className="text-3xl font-bold">{Math.round(totalStats.totalStudyMinutes / 60)}</p>
                <p className="text-xs text-muted-foreground">Stunden gelernt</p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-5 flex items-center gap-4">
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-accent/20">
                <Brain className="h-6 w-6 text-accent-foreground" />
              </div>
              <div>
                <p className="text-3xl font-bold">{totalStats.totalFlashcards}</p>
                <p className="text-xs text-muted-foreground">Flashcards</p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-5 flex items-center gap-4">
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-success/10">
                <Target className="h-6 w-6 text-success" />
              </div>
              <div>
                <p className="text-3xl font-bold">{totalStats.totalNorms}</p>
                <p className="text-xs text-muted-foreground">Rechtsnormen extrahiert</p>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Study Hours Chart */}
        <Card className="mt-6">
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <TrendingUp className="h-4 w-4" /> Lernzeit (letzte 14 Tage)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={280}>
              <AreaChart data={weeklyData}>
                <defs>
                  <linearGradient id="studyGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="ankiGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="hsl(var(--accent))" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="hsl(var(--accent))" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                <XAxis dataKey="date" className="text-xs" tick={{ fill: "hsl(var(--muted-foreground))" }} />
                <YAxis className="text-xs" tick={{ fill: "hsl(var(--muted-foreground))" }} unit=" min" />
                <Tooltip
                  contentStyle={{
                    background: "hsl(var(--card))",
                    border: "1px solid hsl(var(--border))",
                    borderRadius: "8px",
                    color: "hsl(var(--foreground))",
                  }}
                />
                <Area
                  type="monotone"
                  dataKey="study"
                  stackId="1"
                  stroke="hsl(var(--primary))"
                  fill="url(#studyGrad)"
                  name="Lernzeit"
                />
                <Area
                  type="monotone"
                  dataKey="anki"
                  stackId="1"
                  stroke="hsl(var(--accent))"
                  fill="url(#ankiGrad)"
                  name="Anki"
                />
              </AreaChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        {/* Syllabus Coverage */}
        <Card className="mt-6">
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <BookOpen className="h-4 w-4" /> Syllabus Coverage pro Kurs
            </CardTitle>
            <CardDescription>
              Mastered Flashcards / Extrahierte Rechtsnormen
            </CardDescription>
          </CardHeader>
          <CardContent>
            {courseProgress.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4">
                Noch keine Kurse synchronisiert. Starte mit Moodle Sync.
              </p>
            ) : (
              <div className="grid gap-4 md:grid-cols-2">
                {/* Sunburst-style Pie */}
                <ResponsiveContainer width="100%" height={300}>
                  <PieChart>
                    <Pie
                      data={courseProgress.map((c, i) => ({
                        name: c.shortName,
                        value: Math.max(c.coverage, 2), // min visible slice
                        fill: COLORS[i % COLORS.length],
                      }))}
                      cx="50%"
                      cy="50%"
                      innerRadius={60}
                      outerRadius={120}
                      paddingAngle={2}
                      dataKey="value"
                      label={({ name, value }) => `${name}: ${value}%`}
                    >
                      {courseProgress.map((_, i) => (
                        <Cell key={i} fill={COLORS[i % COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip />
                  </PieChart>
                </ResponsiveContainer>

                {/* Course detail list */}
                <div className="space-y-3">
                  {courseProgress.map((c, i) => (
                    <div key={i} className="rounded-lg border p-3">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-sm font-medium truncate flex-1">{c.shortName}</span>
                        <Badge variant="outline" className="text-xs">{c.coverage}%</Badge>
                      </div>
                      <div className="h-2 rounded-full bg-muted overflow-hidden">
                        <div
                          className="h-full rounded-full transition-all"
                          style={{
                            width: `${c.coverage}%`,
                            backgroundColor: COLORS[i % COLORS.length],
                          }}
                        />
                      </div>
                      <div className="mt-1 flex gap-3 text-xs text-muted-foreground">
                        <span>{c.totalFiles} Dateien</span>
                        <span>{c.parsedFiles} geparst</span>
                        <span>{c.approvedFlashcards}/{c.totalFlashcards} Karten</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
