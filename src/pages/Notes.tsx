import { useEffect, useState } from "react";
import { DashboardLayout } from "@/components/DashboardLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { FileText, ChevronDown, ChevronRight, Sparkles, Loader2 } from "lucide-react";
import { cleanCourseName } from "@/lib/semester";
import { groupBy } from "@/lib/semester";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

const typeLabels: Record<string, string> = {
  lernziel: "Lernziel",
  prep: "Vorbereitung",
  general: "Allgemein",
  summary: "Zusammenfassung",
  exercise: "Übung",
  reading: "Pflichtlektüre",
  organizational: "Organisatorisches",
};

const typeColors: Record<string, string> = {
  lernziel: "bg-accent/10 text-accent border-accent/20",
  prep: "bg-warning/10 text-warning border-warning/20",
  general: "bg-secondary text-secondary-foreground border-border",
  summary: "bg-primary/10 text-primary border-primary/20",
};

export default function Notes() {
  const { user } = useAuth();
  const [notes, setNotes] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedCourses, setExpandedCourses] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!user) return;
    supabase
      .from("notes")
      .select("*, courses(name, short_name)")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .then(({ data }) => {
        setNotes(data || []);
        // Auto-expand first course
        if (data && data.length > 0) {
          const firstCourse = data[0].courses?.name || "Ohne Kurs";
          setExpandedCourses(new Set([firstCourse]));
        }
        setLoading(false);
      });
  }, [user]);

  const toggleCourse = (courseName: string) => {
    setExpandedCourses((prev) => {
      const next = new Set(prev);
      if (next.has(courseName)) next.delete(courseName);
      else next.add(courseName);
      return next;
    });
  };

  // Group by course
  const grouped = groupBy(notes, (n) =>
    n.courses ? cleanCourseName(n.courses.name, n.courses.short_name) : "Ohne Kurs"
  );
  const courseNames = Object.keys(grouped).sort((a, b) => {
    if (a === "Ohne Kurs") return 1;
    if (b === "Ohne Kurs") return -1;
    return a.localeCompare(b, "de");
  });

  return (
    <DashboardLayout>
      <div className="animate-fade-in">
        <h1 className="text-3xl font-bold tracking-tight">Notes</h1>
        <p className="mt-1 text-muted-foreground">
          {notes.length} Notizen aus {courseNames.length} Kursen.
        </p>

        {loading ? (
          <div className="mt-8 space-y-4">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-20 rounded-lg bg-muted animate-pulse" />
            ))}
          </div>
        ) : notes.length === 0 ? (
          <Card className="mt-8">
            <CardContent className="flex flex-col items-center justify-center py-12 text-center">
              <FileText className="h-12 w-12 text-muted-foreground/40" />
              <h3 className="mt-4 font-semibold">Keine Notizen</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Sync from Moodle to import Lernziele and section content.
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="mt-8 space-y-3">
            {courseNames.map((courseName) => {
              const courseNotes = grouped[courseName];
              const isExpanded = expandedCourses.has(courseName);
              const lernzielCount = courseNotes.filter((n) => n.note_type === "lernziel").length;

              return (
                <div key={courseName} className="rounded-lg border overflow-hidden">
                  {/* Course header */}
                  <button
                    onClick={() => toggleCourse(courseName)}
                    className="flex w-full items-center gap-3 p-4 text-left hover:bg-muted/50 transition-colors"
                  >
                    {isExpanded ? (
                      <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
                    ) : (
                      <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                    )}
                    <span className="font-semibold text-sm flex-1">{courseName}</span>
                    <div className="flex items-center gap-2">
                      {lernzielCount > 0 && (
                        <Badge variant="outline" className={typeColors.lernziel}>
                          {lernzielCount} Lernziele
                        </Badge>
                      )}
                      <span className="text-xs text-muted-foreground">{courseNotes.length} Notizen</span>
                    </div>
                  </button>

                  {/* Notes list */}
                  {isExpanded && (
                    <div className="border-t divide-y">
                      {courseNotes.map((note) => (
                        <div key={note.id} className="p-4 hover:bg-muted/30 transition-colors">
                          <div className="flex items-start justify-between gap-2">
                            <h4 className="font-medium text-sm">{note.title}</h4>
                            <Badge
                              variant="outline"
                              className={cn("shrink-0 text-xs", typeColors[note.note_type || "general"])}
                            >
                              {typeLabels[note.note_type || "general"] || note.note_type}
                            </Badge>
                          </div>
                          {note.content && (
                            <p className="text-sm text-muted-foreground mt-2 line-clamp-3 whitespace-pre-line">
                              {note.content}
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
