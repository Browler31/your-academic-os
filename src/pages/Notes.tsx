import { useEffect, useState } from "react";
import { DashboardLayout } from "@/components/DashboardLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { FileText, ChevronDown, ChevronRight, Sparkles, Loader2, Maximize2 } from "lucide-react";
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
  exercise: "bg-warning/10 text-warning border-warning/20",
  reading: "bg-primary/10 text-primary border-primary/20",
  organizational: "bg-muted text-muted-foreground border-border",
};

export default function Notes() {
  const { user } = useAuth();
  const [notes, setNotes] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedCourses, setExpandedCourses] = useState<Set<string>>(new Set());
  const [expandedNotes, setExpandedNotes] = useState<Set<string>>(new Set());
  const [classifying, setClassifying] = useState(false);
  const [selectedNote, setSelectedNote] = useState<any | null>(null);

  const fetchNotes = async () => {
    if (!user) return;
    const { data } = await supabase
      .from("notes")
      .select("*, courses(name, short_name)")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });
    setNotes(data || []);
    if (data && data.length > 0) {
      const firstCourse = data[0].courses?.name || "Ohne Kurs";
      setExpandedCourses((prev) => prev.size === 0 ? new Set([firstCourse]) : prev);
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchNotes();
  }, [user]);

  const handleClassify = async () => {
    if (!user) return;
    setClassifying(true);
    try {
      const res = await fetch("/api/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "classify_notes",
          user_id: user.id,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Klassifizierung fehlgeschlagen");
      const extraMsg =
        data.deadlines_extracted > 0
          ? ` (+ ${data.deadlines_extracted} versteckte Fristen entdeckt!)`
          : "";
      toast.success(
        `${data.classified} von ${data.total_processed} Notizen klassifiziert${extraMsg}`
      );
      await fetchNotes();
    } catch (err: any) {
      toast.error(`Klassifizierung fehlgeschlagen: ${err.message}`);
    } finally {
      setClassifying(false);
    }
  };

  const toggleCourse = (courseName: string) => {
    setExpandedCourses((prev) => {
      const next = new Set(prev);
      if (next.has(courseName)) next.delete(courseName);
      else next.add(courseName);
      return next;
    });
  };

  const toggleNote = (noteId: string) => {
    setExpandedNotes((prev) => {
      const next = new Set(prev);
      if (next.has(noteId)) next.delete(noteId);
      else next.add(noteId);
      return next;
    });
  };

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
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Notes</h1>
            <p className="mt-1 text-muted-foreground">
              {notes.length} Notizen aus {courseNames.length} Kursen.
            </p>
          </div>
          {notes.some((n) => n.note_type === "general") && (
            <Button onClick={handleClassify} disabled={classifying} variant="outline">
              {classifying ? (
                <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Klassifiziere...</>
              ) : (
                <><Sparkles className="mr-2 h-4 w-4" /> AI Klassifizierung</>
              )}
            </Button>
          )}
        </div>

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
              const typeCounts = courseNotes.reduce((acc: Record<string, number>, n: any) => {
                const t = n.note_type || "general";
                acc[t] = (acc[t] || 0) + 1;
                return acc;
              }, {});

              return (
                <div key={courseName} className="rounded-lg border overflow-hidden">
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
                      {Object.entries(typeCounts).filter(([t]) => t !== "general").map(([t, c]) => (
                        <Badge key={t} variant="outline" className={cn("text-xs", typeColors[t])}>
                          {c as number} {typeLabels[t] || t}
                        </Badge>
                      ))}
                      <span className="text-xs text-muted-foreground">{courseNotes.length} Notizen</span>
                    </div>
                  </button>

                  {isExpanded && (
                    <div className="border-t divide-y">
                      {courseNotes.map((note: any) => {
                        const isNoteExpanded = expandedNotes.has(note.id);
                        const hasLongContent = note.content && note.content.length > 200;

                        return (
                          <div key={note.id} className="p-4 hover:bg-muted/30 transition-colors">
                            <div className="flex items-start justify-between gap-2">
                              <button
                                onClick={() => hasLongContent && toggleNote(note.id)}
                                className={cn("font-medium text-sm text-left", hasLongContent && "hover:text-primary cursor-pointer")}
                              >
                                {note.title}
                              </button>
                              <div className="flex items-center gap-1.5 shrink-0">
                                <Badge
                                  variant="outline"
                                  className={cn("text-xs", typeColors[note.note_type || "general"])}
                                >
                                  {typeLabels[note.note_type || "general"] || note.note_type}
                                </Badge>
                                {hasLongContent && (
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-6 w-6"
                                    onClick={() => setSelectedNote(note)}
                                  >
                                    <Maximize2 className="h-3 w-3" />
                                  </Button>
                                )}
                              </div>
                            </div>
                            {note.content && (
                              <p className={cn(
                                "text-sm text-muted-foreground mt-2 whitespace-pre-line",
                                !isNoteExpanded && "line-clamp-3"
                              )}>
                                {note.content}
                              </p>
                            )}
                            {hasLongContent && !isNoteExpanded && (
                              <button
                                onClick={() => toggleNote(note.id)}
                                className="text-xs text-primary mt-1 hover:underline"
                              >
                                Mehr anzeigen
                              </button>
                            )}
                            {isNoteExpanded && (
                              <button
                                onClick={() => toggleNote(note.id)}
                                className="text-xs text-primary mt-1 hover:underline"
                              >
                                Weniger anzeigen
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Full note dialog */}
        <Dialog open={!!selectedNote} onOpenChange={(open) => !open && setSelectedNote(null)}>
          <DialogContent className="sm:max-w-2xl max-h-[80vh]">
            {selectedNote && (
              <>
                <DialogHeader>
                  <div className="flex items-center gap-2">
                    <DialogTitle className="text-lg">{selectedNote.title}</DialogTitle>
                    <Badge
                      variant="outline"
                      className={cn("text-xs", typeColors[selectedNote.note_type || "general"])}
                    >
                      {typeLabels[selectedNote.note_type || "general"] || selectedNote.note_type}
                    </Badge>
                  </div>
                  {selectedNote.courses && (
                    <p className="text-sm text-muted-foreground">
                      {cleanCourseName(selectedNote.courses.name, selectedNote.courses.short_name)}
                    </p>
                  )}
                </DialogHeader>
                <ScrollArea className="max-h-[60vh]">
                  <div className="text-sm whitespace-pre-line leading-relaxed pr-4">
                    {selectedNote.content}
                  </div>
                </ScrollArea>
              </>
            )}
          </DialogContent>
        </Dialog>
      </div>
    </DashboardLayout>
  );
}
