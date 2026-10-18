import { useEffect, useState, useCallback } from "react";
import { DashboardLayout } from "@/components/DashboardLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import {
  BookOpen,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FileText,
  FolderOpen,
  Calendar,
  AlertTriangle,
  Sparkles,
  Loader2,
  Plus,
  Scale,
  CheckCircle2,
  FileSearch,
} from "lucide-react";
import { format, addDays } from "date-fns";
import { de } from "date-fns/locale";
import { parseSemester, cleanCourseName, groupBy } from "@/lib/semester";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

export default function Courses() {
  const { user } = useAuth();
  const [courses, setCourses] = useState<any[]>([]);
  const [deadlinesByCourse, setDeadlinesByCourse] = useState<Record<string, any[]>>({});
  const [filesByCourse, setFilesByCourse] = useState<Record<string, any[]>>({});
  const [notesByCourse, setNotesByCourse] = useState<Record<string, any[]>>({});
  const [loading, setLoading] = useState(true);
  const [collapsedSemesters, setCollapsedSemesters] = useState<Set<string>>(new Set());

  // Selected Course Cockpit state
  const [selectedCourse, setSelectedCourse] = useState<any | null>(null);
  const [briefingData, setBriefingData] = useState<any | null>(null);
  const [loadingBriefing, setLoadingBriefing] = useState(false);
  const [parsingFileId, setParsingFileId] = useState<string | null>(null);

  // Quick add deadline/extract inside Course Cockpit
  const [quickTitle, setQuickTitle] = useState("");
  const [quickDate, setQuickDate] = useState(() => format(addDays(new Date(), 14), "yyyy-MM-dd"));
  const [quickIsUsln, setQuickIsUsln] = useState(true);
  const [quickPasteText, setQuickPasteText] = useState("");
  const [savingQuick, setSavingQuick] = useState(false);

  const fetchAllCourseData = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    const [coursesRes, dlRes, filesRes, notesRes] = await Promise.all([
      supabase
        .from("courses")
        .select("*")
        .eq("user_id", user.id)
        .order("name", { ascending: true }),
      supabase
        .from("deadlines")
        .select("*")
        .eq("user_id", user.id)
        .order("due_date", { ascending: true }),
      supabase
        .from("files")
        .select("*")
        .eq("user_id", user.id)
        .order("file_name", { ascending: true }),
      supabase
        .from("notes")
        .select("*")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false }),
    ]);

    setCourses(coursesRes.data || []);
    setDeadlinesByCourse(groupBy(dlRes.data || [], (d: any) => d.course_id || "none"));
    setFilesByCourse(groupBy(filesRes.data || [], (f: any) => f.course_id || "none"));
    setNotesByCourse(groupBy(notesRes.data || [], (n: any) => n.course_id || "none"));
    setLoading(false);
  }, [user]);

  useEffect(() => {
    fetchAllCourseData();
  }, [fetchAllCourseData]);

  const loadCourseBriefing = async (course: any) => {
    if (!user) return;
    setLoadingBriefing(true);
    try {
      const res = await fetch("/api/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "course_briefing",
          user_id: user.id,
          course_id: course.id,
        }),
      });
      const data = await res.json();
      if (res.ok && data.briefing) {
        setBriefingData(data.briefing);
        // Refresh counts in case new deadlines were auto-discovered
        fetchAllCourseData();
      }
    } catch (e) {
      console.warn("Could not load briefing:", e);
    } finally {
      setLoadingBriefing(false);
    }
  };

  const handleOpenCourse = (course: any) => {
    setSelectedCourse(course);
    setBriefingData(null);
    loadCourseBriefing(course);
  };

  const handleQuickAddDeadline = async () => {
    if (!user || !selectedCourse || !quickTitle.trim()) return;
    setSavingQuick(true);
    try {
      const prefix = quickIsUsln && !/usln|leistungsnachweis/i.test(quickTitle) ? "🎯 USLN: " : "";
      const dueIso = new Date(`${quickDate}T23:59:00`).toISOString();
      const { error } = await supabase.from("deadlines").insert({
        user_id: user.id,
        course_id: selectedCourse.id,
        title: `${prefix}${quickTitle.trim()}`,
        description: "Im Kurs-Cockpit eingetragen",
        due_date: dueIso,
        source: "manual",
        is_completed: false,
      });
      if (error) throw error;
      toast.success("Frist für diesen Kurs gespeichert!");
      setQuickTitle("");
      await loadCourseBriefing(selectedCourse);
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setSavingQuick(false);
    }
  };

  const handleQuickExtractCourseText = async () => {
    if (!user || !selectedCourse || !quickPasteText.trim()) return;
    setSavingQuick(true);
    try {
      const geminiKey = localStorage.getItem("study_os_gemini_key") || undefined;
      const res = await fetch("/api/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "extract_deadlines",
          mode: "extract_from_text",
          user_id: user.id,
          course_id: selectedCourse.id,
          context_title: cleanCourseName(selectedCourse.name, selectedCourse.short_name),
          text: quickPasteText,
          gemini_api_key: geminiKey,
          auto_save: true,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Extraktion fehlgeschlagen");
      toast.success(
        `${data.discovered?.length || 0} Termine erkannt (${data.inserted_count || 0} neu gespeichert)!`
      );
      setQuickPasteText("");
      await loadCourseBriefing(selectedCourse);
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setSavingQuick(false);
    }
  };

  const handleParseCourseFile = async (fileId: string) => {
    if (!user || !selectedCourse) return;
    setParsingFileId(fileId);
    try {
      const moodleToken = localStorage.getItem("study_os_moodle_token") || undefined;
      const geminiKey = localStorage.getItem("study_os_gemini_key") || undefined;
      const res = await fetch("/api/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "parse_pdf",
          user_id: user.id,
          file_id: fileId,
          moodle_token: moodleToken,
          gemini_api_key: geminiKey,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Analyse fehlgeschlagen");
      toast.success(
        `Dokument analysiert: ${data.norms_count || 0} Rechtsnormen, ${
          data.deadlines_count || 0
        } Fristen erkannt!`
      );
      await loadCourseBriefing(selectedCourse);
    } catch (err: any) {
      toast.error(`Analyse fehlgeschlagen: ${err.message}`);
    } finally {
      setParsingFileId(null);
    }
  };

  const toggleDeadlineDone = async (id: string, done: boolean) => {
    await supabase.from("deadlines").update({ is_completed: done }).eq("id", id);
    await fetchAllCourseData();
    if (selectedCourse) loadCourseBriefing(selectedCourse);
  };

  const coursesWithMeta = courses.map((c) => ({
    ...c,
    semesterInfo: parseSemester(c.name, c.short_name),
    cleanName: cleanCourseName(c.name, c.short_name),
  }));

  const bySemester = groupBy(coursesWithMeta, (c) => c.semesterInfo.semester);
  const semesterKeys = Object.keys(bySemester).sort((a, b) => {
    const orderA = bySemester[a][0].semesterInfo.sortOrder;
    const orderB = bySemester[b][0].semesterInfo.sortOrder;
    return orderB - orderA;
  });

  const toggleSemester = (sem: string) => {
    setCollapsedSemesters((prev) => {
      const next = new Set(prev);
      if (next.has(sem)) next.delete(sem);
      else next.add(sem);
      return next;
    });
  };

  const selectedCourseDeadlines = selectedCourse ? deadlinesByCourse[selectedCourse.id] || [] : [];
  const selectedCourseFiles = selectedCourse ? filesByCourse[selectedCourse.id] || [] : [];
  const selectedCourseNotes = selectedCourse ? notesByCourse[selectedCourse.id] || [] : [];

  return (
    <DashboardLayout>
      <div className="animate-fade-in">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Kurse & Modul-Cockpit</h1>
            <p className="mt-1 text-muted-foreground">
              Klicke auf einen Kurs für die Modul-Spielregeln (USLN, Prüfungen, Rechtsnormen, Folien & Lernziele).
            </p>
          </div>
        </div>

        {loading ? (
          <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-36 rounded-lg bg-muted animate-pulse" />
            ))}
          </div>
        ) : courses.length === 0 ? (
          <Card className="mt-8">
            <CardContent className="flex flex-col items-center justify-center py-12 text-center">
              <BookOpen className="h-12 w-12 text-muted-foreground/40" />
              <h3 className="mt-4 font-semibold">Noch keine Kurse synchronisiert</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Verbinde dein ZHAW Moodle unter "Moodle Sync", um deine Kurse zu importieren.
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="mt-8 space-y-6">
            {semesterKeys.map((sem) => {
              const semCourses = bySemester[sem];
              const isCollapsed = collapsedSemesters.has(sem);
              return (
                <div key={sem}>
                  <button
                    onClick={() => toggleSemester(sem)}
                    className="flex items-center gap-2 mb-3 text-left group"
                  >
                    {isCollapsed ? (
                      <ChevronRight className="h-4 w-4 text-muted-foreground" />
                    ) : (
                      <ChevronDown className="h-4 w-4 text-muted-foreground" />
                    )}
                    <h2 className="text-lg font-semibold group-hover:text-primary transition-colors">
                      {semCourses[0].semesterInfo.label}
                    </h2>
                    <Badge variant="secondary" className="text-xs">
                      {semCourses.length}
                    </Badge>
                  </button>

                  {!isCollapsed && (
                    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                      {semCourses.map((course) => {
                        const cDeadlines = (deadlinesByCourse[course.id] || []).filter(
                          (d: any) => !d.is_completed
                        );
                        const cFiles = filesByCourse[course.id] || [];
                        const cNotes = notesByCourse[course.id] || [];
                        const hasUsln = cDeadlines.some((d: any) =>
                          /usln|leistungsnachweis/i.test(`${d.title} ${d.description || ""}`)
                        );

                        return (
                          <Card
                            key={course.id}
                            onClick={() => handleOpenCourse(course)}
                            className={cn(
                              "cursor-pointer transition-all hover:shadow-md hover:border-primary/40 group",
                              hasUsln && "border-warning/40"
                            )}
                          >
                            <CardHeader className="pb-2">
                              <div className="flex items-start justify-between gap-2">
                                <CardTitle className="text-base leading-snug group-hover:text-primary transition-colors">
                                  {course.cleanName}
                                </CardTitle>
                                <Badge variant="outline" className="shrink-0 text-[10px]">
                                  {course.semesterInfo.semester}
                                </Badge>
                              </div>
                            </CardHeader>
                            <CardContent className="space-y-3">
                              <div className="flex flex-wrap items-center gap-2">
                                <Badge
                                  variant="outline"
                                  className={cn(
                                    "text-xs gap-1",
                                    cDeadlines.length > 0
                                      ? "bg-warning/10 text-warning border-warning/30 font-medium"
                                      : "text-muted-foreground"
                                  )}
                                >
                                  <Calendar className="h-3 w-3" />
                                  {cDeadlines.length} Fristen/USLN
                                </Badge>
                                <Badge variant="secondary" className="text-xs gap-1">
                                  <FolderOpen className="h-3 w-3" />
                                  {cFiles.length} Dateien
                                </Badge>
                                <Badge variant="secondary" className="text-xs gap-1">
                                  <FileText className="h-3 w-3" />
                                  {cNotes.length} Notizen
                                </Badge>
                              </div>

                              {cDeadlines.length > 0 && (
                                <div className="rounded-md bg-muted/50 px-2.5 py-1.5 text-xs">
                                  <p className="font-medium truncate text-foreground">
                                    Nächster Termin: {cDeadlines[0].title}
                                  </p>
                                  <p className="text-muted-foreground font-mono text-[11px]">
                                    {format(new Date(cDeadlines[0].due_date), "dd. MMM yyyy", {
                                      locale: de,
                                    })}
                                  </p>
                                </div>
                              )}
                            </CardContent>
                          </Card>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* =====================================================================
            INTERACTIVE COURSE COCKPIT DIALOG
           ===================================================================== */}
        <Dialog
          open={!!selectedCourse}
          onOpenChange={(open) => !open && setSelectedCourse(null)}
        >
          <DialogContent className="sm:max-w-4xl max-h-[88vh] flex flex-col p-0 overflow-hidden">
            {selectedCourse && (
              <>
                <DialogHeader className="p-6 pb-4 border-b bg-muted/20">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between pr-6">
                    <div>
                      <div className="flex items-center gap-2">
                        <Badge variant="outline">
                          {selectedCourse.semesterInfo?.label || "ZHAW SML"}
                        </Badge>
                        {selectedCourse.short_name && (
                          <span className="text-xs font-mono text-muted-foreground">
                            {selectedCourse.short_name}
                          </span>
                        )}
                      </div>
                      <DialogTitle className="text-2xl font-bold mt-1">
                        {selectedCourse.cleanName}
                      </DialogTitle>
                      <DialogDescription className="mt-0.5">
                        Modul-Cockpit: Spielregeln, USLN-Termine, Vorlesungsunterlagen & Lernziele
                      </DialogDescription>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 shrink-0">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => loadCourseBriefing(selectedCourse)}
                        disabled={loadingBriefing}
                      >
                        {loadingBriefing ? (
                          <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <FileSearch className="mr-1.5 h-3.5 w-3.5 text-primary" />
                        )}
                        Fristen scannen
                      </Button>
                      {selectedCourse.moodle_course_id && (
                        <Button
                          variant="default"
                          size="sm"
                          onClick={() =>
                            window.open(
                              `https://moodle.zhaw.ch/course/view.php?id=${selectedCourse.moodle_course_id}`,
                              "_blank"
                            )
                          }
                        >
                          <ExternalLink className="mr-1.5 h-3.5 w-3.5" /> In Moodle öffnen
                        </Button>
                      )}
                    </div>
                  </div>
                </DialogHeader>

                <ScrollArea className="flex-1 p-6">
                  <Tabs defaultValue="briefing" className="w-full">
                    <TabsList className="grid w-full grid-cols-3 mb-4">
                      <TabsTrigger value="briefing">
                        🎯 Übersicht & USLNs ({selectedCourseDeadlines.length})
                      </TabsTrigger>
                      <TabsTrigger value="files">
                        📂 Unterlagen & PDFs ({selectedCourseFiles.length})
                      </TabsTrigger>
                      <TabsTrigger value="notes">
                        📝 Lernziele & Inhalte ({selectedCourseNotes.length})
                      </TabsTrigger>
                    </TabsList>

                    {/* TAB 1: MODULE BRIEFING & USLN CHECK */}
                    <TabsContent value="briefing" className="space-y-6">
                      {/* 1. Deadlines & USLNs */}
                      <div className="space-y-3">
                        <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
                          <Calendar className="h-4 w-4 text-primary" />
                          Termine, Fristen & Leistungsnachweise (USLN)
                        </h3>

                        {selectedCourseDeadlines.length === 0 ? (
                          <div className="rounded-lg border border-warning/30 bg-warning/5 p-4 space-y-2">
                            <div className="flex items-center gap-2 text-warning font-semibold text-sm">
                              <AlertTriangle className="h-4 w-4" />
                              Noch keine Frist oder USLN für {selectedCourse.cleanName} eingetragen
                            </div>
                            <p className="text-xs text-muted-foreground">
                              Oft stehen USLN-Termine im Dokument <em>Modulübersicht / Semesterprogramm</em> oder in einer E-Mail.
                              Öffne unten die Modulübersicht oder füge den Text hier direkt ein:
                            </p>
                          </div>
                        ) : (
                          <div className="space-y-2">
                            {selectedCourseDeadlines.map((dl: any) => (
                              <div
                                key={dl.id}
                                className={cn(
                                  "flex items-center justify-between rounded-lg border p-3",
                                  dl.is_completed && "opacity-60",
                                  /usln|leistungsnachweis/i.test(dl.title) &&
                                    !dl.is_completed &&
                                    "border-warning/40 bg-warning/5"
                                )}
                              >
                                <div className="flex items-center gap-3 min-w-0">
                                  <Checkbox
                                    checked={dl.is_completed}
                                    onCheckedChange={(v) => toggleDeadlineDone(dl.id, !!v)}
                                  />
                                  <div className="min-w-0">
                                    <p
                                      className={cn(
                                        "text-sm font-medium",
                                        dl.is_completed && "line-through"
                                      )}
                                    >
                                      {dl.title}
                                    </p>
                                    {dl.description && (
                                      <p className="text-xs text-muted-foreground truncate max-w-lg">
                                        {dl.description}
                                      </p>
                                    )}
                                  </div>
                                </div>
                                <Badge variant="outline" className="font-mono text-xs shrink-0">
                                  {format(new Date(dl.due_date), "dd.MM.yyyy")}
                                </Badge>
                              </div>
                            ))}
                          </div>
                        )}

                        {/* Raw USLN / Exam mentions found in course notes */}
                        {briefingData?.usln_mentions?.length > 0 && (
                          <div className="rounded-lg border bg-muted/30 p-3 space-y-1.5">
                            <p className="text-xs font-semibold text-primary">
                              💡 Gefundene Hinweise zu Leistungsnachweisen / Prüfungen im Kurstext:
                            </p>
                            {briefingData.usln_mentions.map((m: string, idx: number) => (
                              <p key={idx} className="text-xs text-muted-foreground">
                                • {m}
                              </p>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* 2. Key Organizational / Syllabus PDFs */}
                      {briefingData?.syllabus_files?.length > 0 && (
                        <div className="space-y-2">
                          <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                            📌 Wichtige Modul-Dokumente (Semesterprogramm / Merkblätter)
                          </h3>
                          <div className="grid gap-2 sm:grid-cols-2">
                            {briefingData.syllabus_files.map((f: any) => (
                              <div
                                key={f.id}
                                className="flex items-center justify-between rounded-lg border bg-card p-3"
                              >
                                <div className="flex items-center gap-2 min-w-0 pr-2">
                                  <FileText className="h-4 w-4 text-primary shrink-0" />
                                  <span className="text-xs font-medium truncate">
                                    {f.file_name}
                                  </span>
                                </div>
                                <div className="flex items-center gap-1 shrink-0">
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className="h-7 text-xs px-2"
                                    onClick={() => handleParseCourseFile(f.id)}
                                    disabled={parsingFileId === f.id}
                                  >
                                    {parsingFileId === f.id ? (
                                      <Loader2 className="h-3 w-3 animate-spin" />
                                    ) : (
                                      "Scannen"
                                    )}
                                  </Button>
                                  {f.file_url && (
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      className="h-7 w-7 p-0"
                                      onClick={() => window.open(f.file_url, "_blank")}
                                    >
                                      <ExternalLink className="h-3.5 w-3.5" />
                                    </Button>
                                  )}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* 3. Detected Legal Norms */}
                      {briefingData?.key_norms?.length > 0 && (
                        <div className="space-y-2">
                          <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
                            <Scale className="h-4 w-4 text-primary" />
                            Wichtige Gesetzesartikel in diesem Kurs
                          </h3>
                          <div className="flex flex-wrap gap-1.5">
                            {briefingData.key_norms.map((n: any, i: number) => (
                              <Badge key={i} variant="secondary" className="font-mono text-xs">
                                {n.article}
                              </Badge>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* 4. Quick Add / Paste Deadline for this Course */}
                      <div className="rounded-lg border bg-muted/20 p-4 space-y-4">
                        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                          ➕ USLN / Termin für {selectedCourse.cleanName} hinzufügen oder aus Text extrahieren
                        </p>
                        <div className="flex flex-col sm:flex-row gap-2">
                          <Input
                            placeholder="z.B. USLN Fallbearbeitung / Kurztest..."
                            value={quickTitle}
                            onChange={(e) => setQuickTitle(e.target.value)}
                            className="flex-1"
                          />
                          <Input
                            type="date"
                            value={quickDate}
                            onChange={(e) => setQuickDate(e.target.value)}
                            className="w-40"
                          />
                          <Button
                            onClick={handleQuickAddDeadline}
                            disabled={savingQuick || !quickTitle.trim()}
                          >
                            <Plus className="mr-1 h-4 w-4" /> Speichern
                          </Button>
                        </div>

                        <div className="space-y-2 pt-2 border-t">
                          <Textarea
                            rows={2}
                            placeholder="Oder Text aus Modulübersicht / E-Mail hier einfügen, um alle Daten für diesen Kurs automatisch zu extrahieren..."
                            value={quickPasteText}
                            onChange={(e) => setQuickPasteText(e.target.value)}
                            className="text-xs"
                          />
                          {quickPasteText.trim().length > 0 && (
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={handleQuickExtractCourseText}
                              disabled={savingQuick}
                            >
                              <Sparkles className="mr-1.5 h-3.5 w-3.5" /> Termine aus Text extrahieren
                            </Button>
                          )}
                        </div>
                      </div>
                    </TabsContent>

                    {/* TAB 2: FILES & SLIDES */}
                    <TabsContent value="files" className="space-y-2">
                      {selectedCourseFiles.length === 0 ? (
                        <p className="text-sm text-muted-foreground py-8 text-center">
                          Keine Dateien für diesen Kurs gefunden.
                        </p>
                      ) : (
                        selectedCourseFiles.map((f: any) => (
                          <div
                            key={f.id}
                            className="flex items-center justify-between rounded-lg border p-3 hover:bg-muted/30"
                          >
                            <div className="flex items-center gap-3 min-w-0 pr-3">
                              {f.extraction_status === "done" ? (
                                <CheckCircle2 className="h-4 w-4 text-success shrink-0" />
                              ) : (
                                <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                              )}
                              <div className="min-w-0">
                                <p className="text-sm font-medium truncate">{f.file_name}</p>
                                {f.extracted_content?.summary && (
                                  <p className="text-xs text-muted-foreground line-clamp-1">
                                    {f.extracted_content.summary}
                                  </p>
                                )}
                              </div>
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => handleParseCourseFile(f.id)}
                                disabled={parsingFileId === f.id}
                              >
                                {parsingFileId === f.id ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
                                ) : (
                                  <Sparkles className="h-3.5 w-3.5 mr-1" />
                                )}
                                Analysieren
                              </Button>
                              {f.file_url && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => window.open(f.file_url, "_blank")}
                                >
                                  <ExternalLink className="h-4 w-4" />
                                </Button>
                              )}
                            </div>
                          </div>
                        ))
                      )}
                    </TabsContent>

                    {/* TAB 3: NOTES & LERNZIELE */}
                    <TabsContent value="notes" className="space-y-3">
                      {selectedCourseNotes.length === 0 ? (
                        <p className="text-sm text-muted-foreground py-8 text-center">
                          Keine Notizen oder Lernziele für diesen Kurs vorhanden.
                        </p>
                      ) : (
                        selectedCourseNotes.map((n: any) => (
                          <div key={n.id} className="rounded-lg border p-4 space-y-1.5">
                            <div className="flex items-center justify-between gap-2">
                              <h4 className="font-semibold text-sm">{n.title}</h4>
                              <Badge variant="outline" className="text-xs">
                                {n.note_type || "general"}
                              </Badge>
                            </div>
                            <p className="text-xs text-muted-foreground whitespace-pre-line leading-relaxed">
                              {n.content}
                            </p>
                          </div>
                        ))
                      )}
                    </TabsContent>
                  </Tabs>
                </ScrollArea>
              </>
            )}
          </DialogContent>
        </Dialog>
      </div>
    </DashboardLayout>
  );
}
