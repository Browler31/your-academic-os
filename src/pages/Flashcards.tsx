import { useEffect, useState } from "react";
import { DashboardLayout } from "@/components/DashboardLayout";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Sparkles, Download, Check, X, Loader2, CreditCard } from "lucide-react";
import { cleanCourseName } from "@/lib/semester";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

export default function Flashcards() {
  const { user } = useAuth();
  const [notes, setNotes] = useState<any[]>([]);
  const [flashcards, setFlashcards] = useState<any[]>([]);
  const [courses, setCourses] = useState<any[]>([]);
  const [selectedNote, setSelectedNote] = useState<string>("");
  const [selectedCourseFilter, setSelectedCourseFilter] = useState<string>("all");
  const [generating, setGenerating] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;
    Promise.all([
      supabase.from("notes").select("id, title, note_type, course_id, courses(name, short_name), content").eq("user_id", user.id).order("created_at", { ascending: false }),
      supabase.from("flashcards").select("*, courses(name, short_name), notes(title)").eq("user_id", user.id).order("created_at", { ascending: false }),
      supabase.from("courses").select("id, name, short_name").eq("user_id", user.id),
    ]).then(([notesRes, cardsRes, coursesRes]) => {
      // Only show notes with enough content
      setNotes((notesRes.data || []).filter((n: any) => n.content && n.content.length >= 20));
      setFlashcards(cardsRes.data || []);
      setCourses(coursesRes.data || []);
      setLoading(false);
    });
  }, [user]);

  const handleGenerate = async () => {
    if (!selectedNote) {
      toast.error("Wähle eine Notiz aus");
      return;
    }
    setGenerating(true);
    try {
      const { data, error } = await supabase.functions.invoke("generate-anki-cards", {
        body: { action: "generate", note_id: selectedNote },
      });
      if (error) throw error;
      toast.success(`${data.created} Flashcards generiert!`);
      // Refresh
      const { data: updated } = await supabase
        .from("flashcards")
        .select("*, courses(name, short_name), notes(title)")
        .eq("user_id", user!.id)
        .order("created_at", { ascending: false });
      setFlashcards(updated || []);
    } catch (err: any) {
      toast.error(err.message || "Fehler bei der Generierung");
    } finally {
      setGenerating(false);
    }
  };

  const toggleApproval = async (id: string, currentApproval: boolean) => {
    const { error } = await supabase
      .from("flashcards")
      .update({ is_approved: !currentApproval })
      .eq("id", id);
    if (error) {
      toast.error("Fehler beim Aktualisieren");
      return;
    }
    setFlashcards((prev) =>
      prev.map((c) => (c.id === id ? { ...c, is_approved: !currentApproval } : c))
    );
  };

  const handleDelete = async (id: string) => {
    const { error } = await supabase.from("flashcards").delete().eq("id", id);
    if (!error) {
      setFlashcards((prev) => prev.filter((c) => c.id !== id));
      toast.success("Karte gelöscht");
    }
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      const courseId = selectedCourseFilter !== "all" ? selectedCourseFilter : undefined;
      const { data, error } = await supabase.functions.invoke("generate-anki-cards", {
        body: { action: "export_csv", course_id: courseId },
      });
      if (error) throw error;

      // Download as file
      const blob = new Blob([data], { type: "text/tab-separated-values" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "anki_flashcards.txt";
      a.click();
      URL.revokeObjectURL(url);
      toast.success("Export gestartet!");
    } catch (err: any) {
      toast.error(err.message || "Export fehlgeschlagen");
    } finally {
      setExporting(false);
    }
  };

  const filteredCards = selectedCourseFilter === "all"
    ? flashcards
    : flashcards.filter((c) => c.course_id === selectedCourseFilter);

  const approvedCount = filteredCards.filter((c) => c.is_approved).length;

  const renderCloze = (text: string) => {
    const parts = text.split(/(\{\{c\d+::.*?\}\})/g);
    return parts.map((part, i) => {
      const match = part.match(/\{\{c(\d+)::(.*?)\}\}/);
      if (match) {
        return (
          <span key={i} className="bg-primary/15 text-primary font-semibold px-1 rounded">
            {match[2]}
          </span>
        );
      }
      return <span key={i}>{part}</span>;
    });
  };

  return (
    <DashboardLayout>
      <div className="animate-fade-in">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Flashcards</h1>
            <p className="mt-1 text-muted-foreground">
              {flashcards.length} Karten · {approvedCount} approved · Anki-ready
            </p>
          </div>
          <Button onClick={handleExport} disabled={exporting || approvedCount === 0} variant="outline">
            {exporting ? (
              <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Exportiere...</>
            ) : (
              <><Download className="mr-2 h-4 w-4" /> Anki Export ({approvedCount})</>
            )}
          </Button>
        </div>

        {/* Generator */}
        <Card className="mt-6">
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-primary" />
              Flashcards generieren
            </CardTitle>
            <CardDescription>
              Wähle eine Notiz aus und generiere Cloze-Deletion Karten für Anki.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex items-end gap-3">
            <div className="flex-1">
              <Select value={selectedNote} onValueChange={setSelectedNote}>
                <SelectTrigger>
                  <SelectValue placeholder="Notiz auswählen..." />
                </SelectTrigger>
                <SelectContent>
                  {notes.map((n) => (
                    <SelectItem key={n.id} value={n.id}>
                      <span className="truncate">
                        {n.courses ? cleanCourseName(n.courses.name, n.courses.short_name) + " — " : ""}
                        {n.title}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button onClick={handleGenerate} disabled={generating || !selectedNote}>
              {generating ? (
                <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Generiere...</>
              ) : (
                <><Sparkles className="mr-2 h-4 w-4" /> Generieren</>
              )}
            </Button>
          </CardContent>
        </Card>

        {/* Filter */}
        {flashcards.length > 0 && (
          <div className="mt-4 flex items-center gap-3">
            <span className="text-sm text-muted-foreground">Filter:</span>
            <Select value={selectedCourseFilter} onValueChange={setSelectedCourseFilter}>
              <SelectTrigger className="w-64">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Alle Kurse</SelectItem>
                {courses.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {cleanCourseName(c.name, c.short_name)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {/* Cards */}
        {loading ? (
          <div className="mt-6 space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-20 rounded-lg bg-muted animate-pulse" />
            ))}
          </div>
        ) : filteredCards.length === 0 ? (
          <Card className="mt-6">
            <CardContent className="flex flex-col items-center justify-center py-12 text-center">
              <CreditCard className="h-12 w-12 text-muted-foreground/40" />
              <h3 className="mt-4 font-semibold">Keine Flashcards</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Wähle oben eine Notiz und generiere deine ersten Karten.
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="mt-6 space-y-2">
            {filteredCards.map((card) => (
              <div
                key={card.id}
                className={cn(
                  "flex items-start gap-3 rounded-lg border p-4 transition-colors",
                  card.is_approved ? "border-primary/30 bg-primary/5" : "hover:bg-muted/30"
                )}
              >
                <div className="flex-1 min-w-0">
                  <p className="text-sm leading-relaxed">{renderCloze(card.cloze_text)}</p>
                  <div className="flex items-center gap-2 mt-2">
                    {card.courses && (
                      <Badge variant="outline" className="text-xs">
                        {cleanCourseName(card.courses.name, card.courses.short_name)}
                      </Badge>
                    )}
                    {(card.tags || []).map((tag: string) => (
                      <Badge key={tag} variant="secondary" className="text-xs">
                        {tag}
                      </Badge>
                    ))}
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button
                    variant={card.is_approved ? "default" : "outline"}
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => toggleApproval(card.id, card.is_approved)}
                    title={card.is_approved ? "Unapprove" : "Approve"}
                  >
                    <Check className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-destructive hover:text-destructive"
                    onClick={() => handleDelete(card.id)}
                    title="Löschen"
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
