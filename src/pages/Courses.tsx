import { useEffect, useState } from "react";
import { DashboardLayout } from "@/components/DashboardLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { BookOpen } from "lucide-react";
import { format } from "date-fns";
import { parseSemester, cleanCourseName, groupBy, sortSemesters } from "@/lib/semester";

export default function Courses() {
  const { user } = useAuth();
  const [courses, setCourses] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;
    supabase
      .from("courses")
      .select("*")
      .eq("user_id", user.id)
      .order("name")
      .then(({ data }) => {
        setCourses(data || []);
        setLoading(false);
      });
  }, [user]);

  const grouped = groupBy(courses, (c) => parseSemester(c.name, c.short_name).semester);
  const semesters = sortSemesters(Object.keys(grouped));

  return (
    <DashboardLayout>
      <div className="animate-fade-in">
        <h1 className="text-3xl font-bold tracking-tight">Courses</h1>
        <p className="mt-1 text-muted-foreground">{courses.length} courses from Moodle.</p>

        {loading ? (
          <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[1, 2, 3].map((i) => (
              <Card key={i} className="animate-pulse">
                <CardContent className="p-6">
                  <div className="h-4 w-3/4 rounded bg-muted mb-2" />
                  <div className="h-3 w-1/2 rounded bg-muted" />
                </CardContent>
              </Card>
            ))}
          </div>
        ) : courses.length === 0 ? (
          <Card className="mt-8">
            <CardContent className="flex flex-col items-center justify-center py-12 text-center">
              <BookOpen className="h-12 w-12 text-muted-foreground/40" />
              <h3 className="mt-4 font-semibold">No courses yet</h3>
              <p className="mt-1 text-sm text-muted-foreground">Go to Moodle Sync to import your courses.</p>
            </CardContent>
          </Card>
        ) : (
          <div className="mt-8 space-y-8">
            {semesters.map((semester) => {
              const semesterInfo = parseSemester(grouped[semester][0].name, grouped[semester][0].short_name);
              return (
                <div key={semester}>
                  <div className="flex items-center gap-3 mb-4">
                    <h2 className="text-lg font-semibold">{semesterInfo.label}</h2>
                    {semesterInfo.isCurrent && (
                      <Badge className="bg-primary/10 text-primary border-primary/20" variant="outline">
                        Aktuell
                      </Badge>
                    )}
                    <span className="text-sm text-muted-foreground">{grouped[semester].length} Kurse</span>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {grouped[semester].map((course) => (
                      <Card key={course.id} className="hover:shadow-md transition-shadow">
                        <CardContent className="p-5">
                          <h3 className="font-semibold text-sm leading-snug">
                            {cleanCourseName(course.name, course.short_name)}
                          </h3>
                          {course.last_synced_at && (
                            <p className="text-xs text-muted-foreground mt-2">
                              Synced {format(new Date(course.last_synced_at), "MMM d, HH:mm")}
                            </p>
                          )}
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
