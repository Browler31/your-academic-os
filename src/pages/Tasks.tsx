import { useEffect, useState, useCallback } from "react";
import { DashboardLayout } from "@/components/DashboardLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import {
  CheckCircle2,
  Clock,
  AlertTriangle,
  Sparkles,
  Loader2,
  ListTodo,
  Target,
  Plus,
  Search,
  Calendar,
  FileSearch,
  Mail,
  Trash2,
} from "lucide-react";
import { format, isPast, isToday, addDays, isWithinInterval } from "date-fns";
import { de } from "date-fns/locale";
import { cleanCourseName } from "@/lib/semester";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

type UrgencyGroup = "overdue" | "today" | "this_week" | "next_two_weeks" | "later";

const urgencyConfig: Record<UrgencyGroup, { label: string; badgeClass: string }> = {
  overdue: { label: "Überfällig", badgeClass: "bg-destructive/10 text-destructive border-destructive/20" },
  today: { label: "Heute", badgeClass: "bg-warning/10 text-warning border-warning/20" },
  this_week: { label: "Diese Woche", badgeClass: "bg-primary/10 text-primary border-primary/20" },
  next_two_weeks: { label: "Nächste 14 Tage", badgeClass: "bg-accent/10 text-accent border-accent/20" },
  later: { label: "Später", badgeClass: "bg-muted text-muted-foreground border-border" },
};

const sourceLabels: Record<string, string> = {
  moodle: "Moodle Aufgabe",
  moodle_calendar: "Moodle Kalender",
  moodle_quiz: "Moodle Test/Quiz",
  moodle_text: "Moodle Beschreibung",
  scanner: "Fristen-Scanner",
  scanner_note: "Kursnotiz-Scan",
  scanner_pdf: "PDF-Scan",
  scanner_file: "Datei-Scan",
  pdf_parser: "PDF-Analyse",
  text_import: "Text/E-Mail Import",
  ai_import: "AI Text-Import",
  manual: "Manuell",
};

const taskTypeLabels: Record<string, string> = {
  prep_reading: "📖 Vorbereitung",
  lecture_review: "📝 Nachbereitung",
  exercises: "✏️ Übung",
  exam_prep: "🎯 Prüfung / USLN",
  custom: "📋 Aufgabe",
  moodle_material: "📂 Moodle",
  meta_skills: "🧠 Metakompetenz",
};

function getUrgencyGroup(dateStr: string | null): UrgencyGroup {
  if (!dateStr) return "later";
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return "later";
  const now = new Date();
  if (isPast(d) && !isToday(d)) return "overdue";
  if (isToday(d)) return "today";
  if (isWithinInterval(d, { start: now, end: addDays(now, 7) })) return "this_week";
  if (isWithinInterval(d, { start: addDays(now, 7), end: addDays(now, 14) })) return "next_two_weeks";
  return "later";
}

export default function Tasks() {
  const { user } = useAuth();
  const [deadlines, setDeadlines] = useState<any[]>([]);
  const [tasks, setTasks] = useState<any[]>([]);
  const [courses, setCourses] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [courseFilter, setCourseFilter] = useState<string>("all");

  // Scanner & Text Extractor Dialog state
  const [scannerOpen, setScannerOpen] = useState(false);
  const [scanningWorkspace, setScanningWorkspace] = useState(false);
  const [scanCourseId, setScanCourseId] = useState<string>("all");
  const [pastedText, setPastedText] = useState("");
  const [pasteCourseId, setPasteCourseId] = useState<string>("none");
  const [extractingText, setExtractingText] = useState(false);
  const [lastScanResult, setLastScanResult] = useState<any | null>(null);

  // Manual Add Dialog state
  const [addOpen, setAddOpen] = useState(false);
  const [addType, setAddType] = useState<"deadline" | "task">("deadline");
  const [newTitle, setNewTitle] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [newDate, setNewDate] = useState(() => format(addDays(new Date(), 7), "yyyy-MM-dd"));
  const [newTime, setNewTime] = useState("23:59");
  const [newCourseId, setNewCourseId] = useState<string>("none");
  const [newIsUsln, setNewIsUsln] = useState(false);
  const [savingItem, setSavingItem] = useState(false);

  // Planner loading
  const [planning, setPlanning] = useState(false);

  const fetchAll = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    const [dlRes, tasksRes, coursesRes] = await Promise.all([
      supabase
        .from("deadlines")
        .select("*, courses(name, short_name)")
        .eq("user_id", user.id)
        .order("due_date", { ascending: true }),
      supabase
        .from("tasks")
        .select("*, courses(name, short_name)")
        .eq("user_id", user.id)
        .order("priority_score", { ascending: false }),
      supabase
        .from("courses")
        .select("id, name, short_name")
        .eq("user_id", user.id)
        .order("name"),
    ]);

    setDeadlines(dlRes.data || []);
    setTasks(tasksRes.data || []);
    setCourses(coursesRes.data || []);
    setLoading(false);
  }, [user]);

  useEffect(() => {
    fetchAll();
    const onSynced = () => fetchAll();
    window.addEventListener("study-os-synced", onSynced);
    return () => window.removeEventListener("study-os-synced", onSynced);
  }, [fetchAll]);

  const toggleDeadline = async (id: string, completed: boolean) => {
    await supabase.from("deadlines").update({ is_completed: completed }).eq("id", id);
    setDeadlines((prev) => prev.map((d) => (d.id === id ? { ...d, is_completed: completed } : d)));
    if (completed) toast.success("Frist als erledigt markiert!");
  };

  const deleteDeadline = async (id: string) => {
    await supabase.from("deadlines").delete().eq("id", id);
    setDeadlines((prev) => prev.filter((d) => d.id !== id));
    toast.success("Termin gelöscht");
  };

  const toggleTask = async (id: string, done: boolean) => {
    const newStatus = done ? "done" : "pending";
    await supabase
      .from("tasks")
      .update({
        status: newStatus,
        completed_at: done ? new Date().toISOString() : null,
      })
      .eq("id", id);
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, status: newStatus } : t)));
    if (done) toast.success("Aufgabe erledigt!");
  };

  const deleteTask = async (id: string) => {
    await supabase.from("tasks").delete().eq("id", id);
    setTasks((prev) => prev.filter((t) => t.id !== id));
    toast.success("Aufgabe gelöscht");
  };

  const handleWorkspaceScan = async () => {
    if (!user) return;
    setScanningWorkspace(true);
    setLastScanResult(null);
    try {
      const moodleToken = localStorage.getItem("study_os_moodle_token") || undefined;
      const geminiKey = localStorage.getItem("study_os_gemini_key") || undefined;

      const res = await fetch("/api/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "extract_deadlines",
          mode: "scan_workspace",
          user_id: user.id,
          course_id: scanCourseId === "all" ? undefined : scanCourseId,
          moodle_token: moodleToken,
          gemini_api_key: geminiKey,
          auto_save: true,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Scan fehlgeschlagen");

      setLastScanResult(data);
      toast.success(
        `Scan abgeschlossen: ${data.discovered?.length || 0} Termine erkannt (${data.inserted_count || 0} neu gespeichert)!`
      );
      await fetchAll();
    } catch (err: any) {
      toast.error(`Fristen-Scan fehlgeschlagen: ${err.message}`);
    } finally {
      setScanningWorkspace(false);
    }
  };

  const handleExtractFromText = async () => {
    if (!user || !pastedText.trim()) return;
    setExtractingText(true);
    setLastScanResult(null);
    try {
      const geminiKey = localStorage.getItem("study_os_gemini_key") || undefined;
      const res = await fetch("/api/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "extract_deadlines",
          mode: "extract_from_text",
          user_id: user.id,
          course_id: pasteCourseId === "none" ? null : pasteCourseId,
          text: pastedText,
          gemini_api_key: geminiKey,
          auto_save: true,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Text-Extraktion fehlgeschlagen");

      setLastScanResult(data);
      if ((data.discovered?.length || 0) === 0) {
        toast.info("Keine klaren Datumsangaben im Text gefunden. Nutze '+ Termin / Aufgabe' für manuelle Eingabe.");
      } else {
        toast.success(
          `${data.discovered.length} Termine aus Text extrahiert (${data.inserted_count} neu gespeichert)!`
        );
        setPastedText("");
        await fetchAll();
      }
    } catch (err: any) {
      toast.error(`Extraktion fehlgeschlagen: ${err.message}`);
    } finally {
      setExtractingText(false);
    }
  };

  const handleManualAdd = async () => {
    if (!user || !newTitle.trim()) return;
    setSavingItem(true);
    try {
      const courseIdVal = newCourseId === "none" ? null : newCourseId;
      if (addType === "deadline") {
        const prefix = newIsUsln && !/usln|leistungsnachweis/i.test(newTitle) ? "🎯 USLN: " : "";
        const dueIso = new Date(`${newDate}T${newTime || "23:59"}:00`).toISOString();
        const { error } = await supabase.from("deadlines").insert({
          user_id: user.id,
          course_id: courseIdVal,
          title: `${prefix}${newTitle.trim()}`,
          description: newDesc.trim() || null,
          due_date: dueIso,
          source: "manual",
          is_completed: false,
        });
        if (error) throw error;
        toast.success("Frist erfolgreich hinzugefügt!");
      } else {
        const { error } = await supabase.from("tasks").insert({
          user_id: user.id,
          course_id: courseIdVal,
          title: newTitle.trim(),
          description: newDesc.trim() || null,
          task_type: newIsUsln ? "exam_prep" : "custom",
          status: "pending",
          priority_score: newIsUsln ? 90 : 60,
          estimated_minutes: 30,
          scheduled_for: newDate,
        });
        if (error) throw error;
        toast.success("Aufgabe erfolgreich hinzugefügt!");
      }

      setNewTitle("");
      setNewDesc("");
      setNewIsUsln(false);
      setAddOpen(false);
      await fetchAll();
    } catch (err: any) {
      toast.error(`Fehler beim Speichern: ${err.message}`);
    } finally {
      setSavingItem(false);
    }
  };

  const handleGenerateStudyTasks = async () => {
    if (!user) return;
    setPlanning(true);
    try {
      const res = await fetch("/api/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "plan_week",
          user_id: user.id,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Fehler bei der Planung");
      toast.success(`${data.created || 0} Lernaufgaben aus deinen Fristen & Kursen abgeleitet!`);
      await fetchAll();
    } catch (err: any) {
      toast.error(`Planung fehlgeschlagen: ${err.message}`);
    } finally {
      setPlanning(false);
    }
  };

  // Apply course filter
  const filteredDeadlines = deadlines.filter(
    (d) => courseFilter === "all" || d.course_id === courseFilter
  );
  const filteredTasks = tasks.filter(
    (t) => courseFilter === "all" || t.course_id === courseFilter
  );

  const openDeadlines = filteredDeadlines.filter((d) => !d.is_completed);
  const completedDeadlines = filteredDeadlines.filter((d) => d.is_completed);
  const openTasks = filteredTasks.filter((t) => t.status !== "done" && t.status !== "skipped");
  const completedTasks = filteredTasks.filter((t) => t.status === "done");

  // Compute #1 Top Priority Focus item locally (preferring upcoming USLNs or overdue/today deadlines)
  const topFocusDeadline =
    openDeadlines.find((d) => /usln|leistungsnachweis/i.test(`${d.title} ${d.description || ""}`)) ||
    openDeadlines[0];
  const topFocusTask = openTasks[0];

  // Build unified items for "Alle Anstehenden"
  const unifiedOpenItems = [
    ...openDeadlines.map((d) => ({
      itemType: "deadline" as const,
      id: d.id,
      title: d.title,
      description: d.description,
      date: d.due_date,
      course: d.courses ? cleanCourseName(d.courses.name, d.courses.short_name) : null,
      source: d.source || "moodle",
      isUsln: /usln|leistungsnachweis/i.test(`${d.title} ${d.description || ""}`),
      raw: d,
    })),
    ...openTasks.map((t) => ({
      itemType: "task" as const,
      id: t.id,
      title: t.title,
      description: t.description,
      date: t.scheduled_for,
      course: t.courses ? cleanCourseName(t.courses.name, t.courses.short_name) : null,
      taskType: t.task_type,
      estimatedMinutes: t.estimated_minutes,
      isUsln: t.task_type === "exam_prep",
      raw: t,
    })),
  ].sort((a, b) => {
    const da = a.date ? new Date(a.date).getTime() : Infinity;
    const db = b.date ? new Date(b.date).getTime() : Infinity;
    return da - db;
  });

  const groupOrder: UrgencyGroup[] = ["overdue", "today", "this_week", "next_two_weeks", "later"];

  return (
    <DashboardLayout>
      <div className="animate-fade-in">
        {/* Header */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Aufgaben & Termine</h1>
            <p className="mt-1 text-muted-foreground">
              {openDeadlines.length} offene Fristen/USLNs · {openTasks.length} offene Lernaufgaben
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setLastScanResult(null);
                setScannerOpen(true);
              }}
              className="gap-2 border-primary/30 hover:bg-primary/5"
            >
              <FileSearch className="h-4 w-4 text-primary" />
              Fristen-Scanner & Text-Import
            </Button>
            <Button onClick={() => setAddOpen(true)} className="gap-2">
              <Plus className="h-4 w-4" />
              Termin / Aufgabe
            </Button>
          </div>
        </div>

        {/* Top Priority Banner ("Dein Fokus") */}
        {(topFocusDeadline || topFocusTask) && (
          <Card className="mt-6 border-primary/30 bg-gradient-to-r from-primary/5 via-accent/5 to-transparent">
            <CardContent className="p-5">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <Target className="h-4 w-4 text-primary" />
                    <span className="text-xs font-semibold uppercase tracking-wider text-primary">
                      Wichtigster Fokus
                    </span>
                    {topFocusDeadline ? (
                      <Badge variant="outline" className="text-xs border-warning/40 text-warning">
                        Frist / Leistungsnachweis
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="text-xs">
                        Lernaufgabe
                      </Badge>
                    )}
                  </div>
                  <h2 className="text-lg font-bold">
                    {topFocusDeadline ? topFocusDeadline.title : topFocusTask?.title}
                  </h2>
                  <p className="text-sm text-muted-foreground">
                    {topFocusDeadline ? (
                      <>
                        {topFocusDeadline.courses
                          ? `${cleanCourseName(
                              topFocusDeadline.courses.name,
                              topFocusDeadline.courses.short_name
                            )} · `
                          : ""}
                        Fällig am{" "}
                        <span className="font-medium text-foreground">
                          {format(new Date(topFocusDeadline.due_date), "EEEE, dd. MMMM yyyy", {
                            locale: de,
                          })}
                        </span>
                      </>
                    ) : (
                      topFocusTask?.description || "Aus deinem aktuellen Lernplan"
                    )}
                  </p>
                </div>
                <Button
                  size="sm"
                  onClick={() =>
                    topFocusDeadline
                      ? toggleDeadline(topFocusDeadline.id, true)
                      : toggleTask(topFocusTask.id, true)
                  }
                  className="shrink-0"
                >
                  <CheckCircle2 className="mr-1.5 h-4 w-4" /> Als erledigt markieren
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Filter Bar */}
        <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
          <Select value={courseFilter} onValueChange={setCourseFilter}>
            <SelectTrigger className="w-[260px]">
              <SelectValue placeholder="Alle Kurse filtern" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Alle Kurse ({courses.length})</SelectItem>
              {courses.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {cleanCourseName(c.name, c.short_name)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Button
            variant="ghost"
            size="sm"
            onClick={handleGenerateStudyTasks}
            disabled={planning}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            {planning ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Sparkles className="mr-1.5 h-3.5 w-3.5 text-primary" />
            )}
            Lernaufgaben aus Fristen ableiten
          </Button>
        </div>

        {/* Main Unified Tabs */}
        <Tabs defaultValue="all" className="mt-4">
          <TabsList className="grid w-full grid-cols-4 sm:w-auto sm:inline-flex">
            <TabsTrigger value="all">
              Alle ({unifiedOpenItems.length})
            </TabsTrigger>
            <TabsTrigger value="deadlines">
              Fristen & USLN ({openDeadlines.length})
            </TabsTrigger>
            <TabsTrigger value="tasks">
              Lernaufgaben ({openTasks.length})
            </TabsTrigger>
            <TabsTrigger value="done">
              Erledigt ({completedDeadlines.length + completedTasks.length})
            </TabsTrigger>
          </TabsList>

          {/* TAB 1: ALLE ANSTEHENDEN (Unified Timeline) */}
          <TabsContent value="all" className="mt-4 space-y-6">
            {loading ? (
              <div className="space-y-3">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="h-16 rounded-lg bg-muted animate-pulse" />
                ))}
              </div>
            ) : unifiedOpenItems.length === 0 ? (
              <Card>
                <CardContent className="flex flex-col items-center justify-center py-12 text-center">
                  <CheckCircle2 className="h-12 w-12 text-success/40" />
                  <h3 className="mt-4 font-semibold">Keine offenen Termine oder Aufgaben</h3>
                  <p className="mt-1 text-sm text-muted-foreground max-w-md">
                    Nutze den <strong>Fristen-Scanner & Text-Import</strong> oben, um deine Moodle-Unterlagen,
                    Modulübersichten oder E-Mails nach versteckten Leistungsnachweisen (USLN) zu durchsuchen.
                  </p>
                  <Button
                    variant="outline"
                    className="mt-4 gap-2"
                    onClick={() => setScannerOpen(true)}
                  >
                    <FileSearch className="h-4 w-4" /> Jetzt nach versteckten Fristen scannen
                  </Button>
                </CardContent>
              </Card>
            ) : (
              groupOrder.map((group) => {
                const items = unifiedOpenItems.filter((i) => getUrgencyGroup(i.date) === group);
                if (items.length === 0) return null;
                const cfg = urgencyConfig[group];

                return (
                  <div key={group} className="space-y-2">
                    <div className="flex items-center gap-2">
                      {group === "overdue" && <AlertTriangle className="h-4 w-4 text-destructive" />}
                      <Badge variant="outline" className={cn("text-xs font-semibold", cfg.badgeClass)}>
                        {cfg.label} ({items.length})
                      </Badge>
                    </div>
                    <div className="space-y-2">
                      {items.map((item) => (
                        <Card
                          key={`${item.itemType}-${item.id}`}
                          className={cn(
                            "transition-colors",
                            item.itemType === "deadline" && "border-l-4 border-l-primary",
                            item.isUsln && "border-l-4 border-l-warning bg-warning/5",
                            group === "overdue" && "border-destructive/30 bg-destructive/5"
                          )}
                        >
                          <CardContent className="flex items-center gap-3 p-4">
                            <Checkbox
                              checked={false}
                              onCheckedChange={() =>
                                item.itemType === "deadline"
                                  ? toggleDeadline(item.id, true)
                                  : toggleTask(item.id, true)
                              }
                            />
                            <div className="flex-1 min-w-0">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="font-medium text-sm">{item.title}</span>
                                {item.itemType === "deadline" ? (
                                  <Badge
                                    variant="outline"
                                    className={cn(
                                      "text-[10px]",
                                      item.isUsln
                                        ? "bg-warning/15 text-warning border-warning/30 font-semibold"
                                        : "bg-primary/10 text-primary border-primary/20"
                                    )}
                                  >
                                    {item.isUsln ? "🎯 USLN / Leistungsnachweis" : "📅 Frist / Termin"}
                                  </Badge>
                                ) : (
                                  <Badge variant="secondary" className="text-[10px]">
                                    {taskTypeLabels[item.taskType || "custom"] || "Aufgabe"}
                                  </Badge>
                                )}
                              </div>
                              <div className="flex flex-wrap items-center gap-2 mt-1 text-xs text-muted-foreground">
                                {item.course && <span className="font-medium text-foreground/80">{item.course}</span>}
                                {item.description && (
                                  <span className="truncate max-w-md">· {item.description}</span>
                                )}
                              </div>
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                              {item.date && (
                                <span
                                  className={cn(
                                    "text-xs font-mono",
                                    group === "overdue"
                                      ? "text-destructive font-semibold"
                                      : group === "today"
                                      ? "text-warning font-semibold"
                                      : "text-muted-foreground"
                                  )}
                                >
                                  {format(new Date(item.date), "dd.MM.yyyy")}
                                </span>
                              )}
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7 text-muted-foreground hover:text-destructive"
                                onClick={() =>
                                  item.itemType === "deadline"
                                    ? deleteDeadline(item.id)
                                    : deleteTask(item.id)
                                }
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            </div>
                          </CardContent>
                        </Card>
                      ))}
                    </div>
                  </div>
                );
              })
            )}
          </TabsContent>

          {/* TAB 2: FRISTEN & USLN */}
          <TabsContent value="deadlines" className="mt-4 space-y-3">
            {openDeadlines.length === 0 ? (
              <Card>
                <CardContent className="py-12 text-center text-muted-foreground">
                  <Calendar className="h-10 w-10 mx-auto mb-3 opacity-30" />
                  <p>Keine offenen Fristen für diese Auswahl.</p>
                </CardContent>
              </Card>
            ) : (
              openDeadlines.map((d) => {
                const isUsln = /usln|leistungsnachweis/i.test(`${d.title} ${d.description || ""}`);
                const group = getUrgencyGroup(d.due_date);
                return (
                  <Card
                    key={d.id}
                    className={cn(
                      isUsln && "border-warning/40 bg-warning/5",
                      group === "overdue" && "border-destructive/30 bg-destructive/5"
                    )}
                  >
                    <CardContent className="flex items-center gap-4 p-4">
                      <Checkbox
                        checked={d.is_completed}
                        onCheckedChange={(v) => toggleDeadline(d.id, !!v)}
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="font-semibold text-sm">{d.title}</p>
                          <Badge variant="outline" className="text-[10px]">
                            {sourceLabels[d.source] || d.source || "Moodle"}
                          </Badge>
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {d.courses
                            ? cleanCourseName(d.courses.name, d.courses.short_name)
                            : "Allgemein"}
                          {d.description ? ` — ${d.description}` : ""}
                        </p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className="text-xs font-mono text-muted-foreground">
                          {format(new Date(d.due_date), "dd. MMM yyyy", { locale: de })}
                        </span>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-muted-foreground hover:text-destructive"
                          onClick={() => deleteDeadline(d.id)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                );
              })
            )}
          </TabsContent>

          {/* TAB 3: LERNAUFGABEN */}
          <TabsContent value="tasks" className="mt-4 space-y-3">
            {openTasks.length === 0 ? (
              <Card>
                <CardContent className="py-12 text-center text-muted-foreground">
                  <ListTodo className="h-10 w-10 mx-auto mb-3 opacity-30" />
                  <p>Keine offenen Lernaufgaben.</p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-3"
                    onClick={handleGenerateStudyTasks}
                    disabled={planning}
                  >
                    <Sparkles className="mr-1.5 h-3.5 w-3.5" /> Aufgaben automatisch generieren
                  </Button>
                </CardContent>
              </Card>
            ) : (
              openTasks.map((t) => (
                <Card key={t.id}>
                  <CardContent className="flex items-center gap-3 p-4">
                    <Checkbox
                      checked={t.status === "done"}
                      onCheckedChange={(v) => toggleTask(t.id, !!v)}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="font-medium text-sm">{t.title}</p>
                        <Badge variant="secondary" className="text-[10px]">
                          {taskTypeLabels[t.task_type] || t.task_type}
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {t.courses ? cleanCourseName(t.courses.name, t.courses.short_name) : ""}
                        {t.description ? ` · ${t.description}` : ""}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {t.estimated_minutes && (
                        <span className="text-xs text-muted-foreground flex items-center gap-1">
                          <Clock className="h-3 w-3" /> {t.estimated_minutes}m
                        </span>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-muted-foreground hover:text-destructive"
                        onClick={() => deleteTask(t.id)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))
            )}
          </TabsContent>

          {/* TAB 4: ERLEDIGT */}
          <TabsContent value="done" className="mt-4 space-y-2">
            {completedDeadlines.length === 0 && completedTasks.length === 0 ? (
              <p className="text-sm text-muted-foreground py-8 text-center">
                Noch keine erledigten Einträge.
              </p>
            ) : (
              <>
                {completedDeadlines.map((d) => (
                  <Card key={`dl-${d.id}`} className="opacity-60">
                    <CardContent className="flex items-center gap-3 p-3">
                      <Checkbox
                        checked={true}
                        onCheckedChange={() => toggleDeadline(d.id, false)}
                      />
                      <span className="text-sm line-through flex-1">{d.title}</span>
                      <Badge variant="outline" className="text-[10px]">Frist</Badge>
                    </CardContent>
                  </Card>
                ))}
                {completedTasks.map((t) => (
                  <Card key={`tk-${t.id}`} className="opacity-60">
                    <CardContent className="flex items-center gap-3 p-3">
                      <Checkbox
                        checked={true}
                        onCheckedChange={() => toggleTask(t.id, false)}
                      />
                      <span className="text-sm line-through flex-1">{t.title}</span>
                      <Badge variant="secondary" className="text-[10px]">Aufgabe</Badge>
                    </CardContent>
                  </Card>
                ))}
              </>
            )}
          </TabsContent>
        </Tabs>

        {/* =====================================================================
            DIALOG 1: MULTI-SOURCE DEADLINE EXTRACTOR (Moodle Deep Scan + External Text/Email Paste)
           ===================================================================== */}
        <Dialog open={scannerOpen} onOpenChange={setScannerOpen}>
          <DialogContent className="sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <FileSearch className="h-5 w-5 text-primary" />
                Universal Fristen-Extractor (Moodle & Extern)
              </DialogTitle>
              <DialogDescription>
                Verpasse nie wieder einen untersemestrigen Leistungsnachweis (USLN) oder eine Abgabe —
                egal ob versteckt in Moodle-Abschnitten, PDF-Modulübersichten oder externen E-Mails.
              </DialogDescription>
            </DialogHeader>

            <Tabs defaultValue="scan" className="mt-2">
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="scan" className="gap-1.5">
                  <Search className="h-3.5 w-3.5" /> 1. Kurs-Unterlagen & PDFs scannen
                </TabsTrigger>
                <TabsTrigger value="paste" className="gap-1.5">
                  <Mail className="h-3.5 w-3.5" /> 2. Aus E-Mail / Text / Dokument
                </TabsTrigger>
              </TabsList>

              {/* Mode 1: Deep Workspace Scan */}
              <TabsContent value="scan" className="space-y-4 pt-4">
                <div className="rounded-lg border bg-muted/30 p-4 space-y-3">
                  <p className="text-sm">
                    Durchsucht automatisch alle synchronisierten <strong>Kursbeschreibungen, Notizen,
                    Semesterprogramme und Merkblatt-PDFs</strong> nach Schweizer Datumsformaten
                    (z.B. <code>14.05.2026</code> oder <code>20. April 2026</code>) in Verbindung mit
                    Schlüsselwörtern wie <em>USLN, Leistungsnachweis, Abgabe, Prüfung, Fallbearbeitung</em>.
                  </p>
                  <div className="flex flex-col sm:flex-row gap-3 pt-1">
                    <Select value={scanCourseId} onValueChange={setScanCourseId}>
                      <SelectTrigger className="flex-1">
                        <SelectValue placeholder="Alle Kurse durchsuchen" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">Alle Kurse durchsuchen</SelectItem>
                        {courses.map((c) => (
                          <SelectItem key={c.id} value={c.id}>
                            {cleanCourseName(c.name, c.short_name)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button onClick={handleWorkspaceScan} disabled={scanningWorkspace}>
                      {scanningWorkspace ? (
                        <>
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Scanne Kurse & PDFs...
                        </>
                      ) : (
                        <>
                          <FileSearch className="mr-2 h-4 w-4" /> Jetzt Tiefenscan starten
                        </>
                      )}
                    </Button>
                  </div>
                </div>
              </TabsContent>

              {/* Mode 2: Paste External Text / Email / Syllabus */}
              <TabsContent value="paste" className="space-y-4 pt-4">
                <div className="space-y-3">
                  <div className="space-y-1.5">
                    <Label>Zugehöriger Kurs (optional)</Label>
                    <Select value={pasteCourseId} onValueChange={setPasteCourseId}>
                      <SelectTrigger>
                        <SelectValue placeholder="Kurs auswählen..." />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">Kein spezifischer Kurs (Allgemein)</SelectItem>
                        {courses.map((c) => (
                          <SelectItem key={c.id} value={c.id}>
                            {cleanCourseName(c.name, c.short_name)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-1.5">
                    <Label>
                      Text aus E-Mail, PDF-Modulübersicht, Vorlesungsfolie oder WhatsApp einfügen
                    </Label>
                    <Textarea
                      rows={6}
                      placeholder="Beispiel: Der untersemestrige Leistungsnachweis (USLN) im Gesellschaftsrecht findet am 14. Mai 2026 um 10:00 Uhr statt. Abgabe der Fallbearbeitung im Obligationsrecht ist bis spätestens 28.04.2026, 23:59 Uhr per Mail..."
                      value={pastedText}
                      onChange={(e) => setPastedText(e.target.value)}
                    />
                  </div>

                  <Button
                    onClick={handleExtractFromText}
                    disabled={extractingText || !pastedText.trim()}
                    className="w-full"
                  >
                    {extractingText ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Extrahiere Termine...
                      </>
                    ) : (
                      <>
                        <Sparkles className="mr-2 h-4 w-4" /> Alle Fristen & Termine aus Text extrahieren
                      </>
                    )}
                  </Button>
                </div>
              </TabsContent>
            </Tabs>

            {/* Scan Results Preview */}
            {lastScanResult && (
              <div className="mt-4 rounded-lg border bg-card p-4 space-y-2 max-h-60 overflow-y-auto">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold uppercase text-muted-foreground">
                    Gefundene Termine ({lastScanResult.discovered?.length || 0})
                  </span>
                  <Badge variant="outline" className="text-xs text-success border-success/30">
                    {lastScanResult.inserted_count || 0} neu gespeichert
                  </Badge>
                </div>
                {(lastScanResult.discovered || []).length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    Keine Datumsangaben erkannt.
                  </p>
                ) : (
                  <div className="space-y-1.5">
                    {lastScanResult.discovered.map((item: any, idx: number) => (
                      <div
                        key={idx}
                        className="flex items-center justify-between rounded border px-3 py-2 text-xs"
                      >
                        <div className="min-w-0 flex-1 pr-2">
                          <p className="font-medium truncate">{item.title}</p>
                          <p className="text-muted-foreground truncate">{item.description}</p>
                        </div>
                        <span className="font-mono shrink-0 text-primary">
                          {format(new Date(item.due_date), "dd.MM.yyyy")}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </DialogContent>
        </Dialog>

        {/* =====================================================================
            DIALOG 2: QUICK MANUAL ADD (Deadline / USLN / Task outside Moodle)
           ===================================================================== */}
        <Dialog open={addOpen} onOpenChange={setAddOpen}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Neuer Termin oder Aufgabe</DialogTitle>
              <DialogDescription>
                Trage eine Frist (z.B. USLN, Prüfung, Fallbearbeitung ausserhalb von Moodle) oder
                eine Lernaufgabe direkt ein.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 py-2">
              <div className="grid grid-cols-2 gap-2">
                <Button
                  type="button"
                  variant={addType === "deadline" ? "default" : "outline"}
                  onClick={() => setAddType("deadline")}
                  className="w-full"
                >
                  📅 Frist / USLN
                </Button>
                <Button
                  type="button"
                  variant={addType === "task" ? "default" : "outline"}
                  onClick={() => setAddType("task")}
                  className="w-full"
                >
                  ✅ Lernaufgabe
                </Button>
              </div>

              <div className="space-y-1.5">
                <Label>Titel</Label>
                <Input
                  placeholder={
                    addType === "deadline"
                      ? "z.B. Fallbearbeitung Obligationsrecht / Online-Test"
                      : "z.B. Kapitel 4 Gesellschaftsrecht zusammenfassen"
                  }
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                />
              </div>

              <div className="flex items-center gap-2">
                <Checkbox
                  id="is-usln"
                  checked={newIsUsln}
                  onCheckedChange={(v) => setNewIsUsln(!!v)}
                />
                <Label htmlFor="is-usln" className="text-sm font-medium cursor-pointer">
                  🎯 Ist ein untersemestriger Leistungsnachweis (USLN) / Prüfung
                </Label>
              </div>

              <div className="space-y-1.5">
                <Label>Kurs</Label>
                <Select value={newCourseId} onValueChange={setNewCourseId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Kurs wählen..." />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Allgemein / Kein Kurs</SelectItem>
                    {courses.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {cleanCourseName(c.name, c.short_name)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Datum</Label>
                  <Input
                    type="date"
                    value={newDate}
                    onChange={(e) => setNewDate(e.target.value)}
                  />
                </div>
                {addType === "deadline" && (
                  <div className="space-y-1.5">
                    <Label>Uhrzeit</Label>
                    <Input
                      type="time"
                      value={newTime}
                      onChange={(e) => setNewTime(e.target.value)}
                    />
                  </div>
                )}
              </div>

              <div className="space-y-1.5">
                <Label>Notizen / Details (optional)</Label>
                <Textarea
                  rows={2}
                  placeholder="z.B. Einreichung per E-Mail an Dozent, zählt 20% zur Modulnote..."
                  value={newDesc}
                  onChange={(e) => setNewDesc(e.target.value)}
                />
              </div>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => setAddOpen(false)}>
                Abbrechen
              </Button>
              <Button onClick={handleManualAdd} disabled={savingItem || !newTitle.trim()}>
                {savingItem ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Speichern
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </DashboardLayout>
  );
}
