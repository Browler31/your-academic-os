import { useEffect, useState, useCallback, useMemo } from "react";
import { DashboardLayout } from "@/components/DashboardLayout";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import {
  BookOpen,
  ExternalLink,
  FileText,
  FolderOpen,
  Calendar,
  ArrowLeft,
  Scale,
  CheckCircle2,
  Loader2,
  Pin,
  Brain,
  Sparkles,
  Eye,
  EyeOff,
  AlertTriangle,
  Gavel,
  ListChecks,
  GraduationCap,
  FileCheck2,
} from "lucide-react";
import { format } from "date-fns";
import { de } from "date-fns/locale";
import { parseSemester, cleanCourseName, groupBy } from "@/lib/semester";
import { structureCourseFiles, CourseChapter, ClassifiedFile } from "@/lib/courseStructure";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

export default function Courses() {
  const { user } = useAuth();
  const [courses, setCourses] = useState<any[]>([]);
  const [deadlinesByCourse, setDeadlinesByCourse] = useState<Record<string, any[]>>({});
  const [filesByCourse, setFilesByCourse] = useState<Record<string, any[]>>({});
  const [notesByCourse, setNotesByCourse] = useState<Record<string, any[]>>({});
  const [loading, setLoading] = useState(true);
  const [selectedSemester, setSelectedSemester] = useState<string>("latest");

  // Active full-page Course Workspace
  const [selectedCourse, setSelectedCourse] = useState<any | null>(null);
  const [briefingData, setBriefingData] = useState<any | null>(null);
  const [loadingBriefing, setLoadingBriefing] = useState(false);

  // Active Chapter (Semesterwoche SW 1..14) & Deep Notes
  const [selectedWeek, setSelectedWeek] = useState<number>(1);
  const [deepNotesCache, setDeepNotesCache] = useState<Record<string, any>>({});
  const [loadingDeepNotes, setLoadingDeepNotes] = useState(false);
  const [hideDefinitionsMode, setHideDefinitionsMode] = useState(false);
  const [revealedDefs, setRevealedDefs] = useState<Record<number, boolean>>({});

  // Interactive Legal Learning State (Definition Drill & Gutachtenstil/Syllogismus Trainer)
  const [selectedDefIdx, setSelectedDefIdx] = useState<number>(0);
  const [drillInput, setDrillInput] = useState<string>("");
  const [drillResult, setDrillResult] = useState<any | null>(null);
  const [evaluatingDrill, setEvaluatingDrill] = useState(false);

  const [gutachtenInput, setGutachtenInput] = useState<string>("");
  const [gutachtenResult, setGutachtenResult] = useState<any | null>(null);
  const [evaluatingGutachten, setEvaluatingGutachten] = useState(false);

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
    const onSynced = () => fetchAllCourseData();
    window.addEventListener("study-os-synced", onSynced);
    return () => window.removeEventListener("study-os-synced", onSynced);
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
        fetchAllCourseData();
      }
    } catch (e) {
      console.warn("Could not load briefing:", e);
    } finally {
      setLoadingBriefing(false);
    }
  };

  const loadChapterDeepNotes = useCallback(
    async (course: any, chapter: CourseChapter | null, fallbackFiles: any[]) => {
      if (!user || !course) return;
      const weekNum = chapter?.weekNumber || 1;
      const cacheKey = `${course.id}::SW${weekNum}`;
      if (deepNotesCache[cacheKey]) return;

      setLoadingDeepNotes(true);
      try {
        const fileIds = chapter
          ? chapter.allFiles.map((f) => f.id)
          : fallbackFiles.slice(0, 6).map((f: any) => f.id);

        const res = await fetch("/api/ai", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "chapter_deep_notes",
            user_id: user.id,
            course_id: course.id,
            course_name: course.cleanName || course.name,
            week_number: weekNum,
            file_ids: fileIds,
          }),
        });
        const data = await res.json();
        if (res.ok && data.deep_notes) {
          setDeepNotesCache((prev) => ({ ...prev, [cacheKey]: data.deep_notes }));
        }
      } catch (e) {
        console.warn("Could not load chapter deep notes:", e);
      } finally {
        setLoadingDeepNotes(false);
      }
    },
    [user, deepNotesCache]
  );

  const structuredCourse = useMemo(() => {
    if (!selectedCourse) return null;
    const rawFiles = filesByCourse[selectedCourse.id] || [];
    return structureCourseFiles(rawFiles);
  }, [selectedCourse, filesByCourse]);

  const handleOpenCourse = (course: any) => {
    setSelectedCourse(course);
    setBriefingData(null);
    setDrillResult(null);
    setGutachtenResult(null);
    setDrillInput("");
    setGutachtenInput("");
    setRevealedDefs({});

    const cFiles = filesByCourse[course.id] || [];
    const structured = structureCourseFiles(cFiles);
    const firstWeek = structured.chapters[0]?.weekNumber || 1;
    setSelectedWeek(firstWeek);

    loadCourseBriefing(course);
    loadChapterDeepNotes(course, structured.chapters[0] || null, cFiles);
  };

  const handleSelectChapter = (chapter: CourseChapter) => {
    setSelectedWeek(chapter.weekNumber);
    setSelectedDefIdx(0);
    setDrillResult(null);
    setGutachtenResult(null);
    setRevealedDefs({});
    if (selectedCourse) {
      loadChapterDeepNotes(
        selectedCourse,
        chapter,
        filesByCourse[selectedCourse.id] || []
      );
    }
  };

  const toggleDeadlineDone = async (id: string, done: boolean) => {
    await supabase.from("deadlines").update({ is_completed: done }).eq("id", id);
    toast.success(done ? "Frist erledigt!" : "Frist wieder geöffnet");
    await fetchAllCourseData();
  };

  const handleRunDefinitionDrill = async (defItem: any) => {
    if (!drillInput.trim()) {
      toast.error("Schreibe zuerst deine Definition aus dem Gedächtnis auf.");
      return;
    }
    setEvaluatingDrill(true);
    try {
      const res = await fetch("/api/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "chapter_tutor_interaction",
          mode: "definition_drill",
          user_answer: drillInput,
          target_term: defItem.term,
          target_definition: defItem.definition,
          target_keywords: defItem.keywords || [],
        }),
      });
      const data = await res.json();
      if (res.ok && data.evaluation) {
        setDrillResult(data.evaluation);
      }
    } catch (e: any) {
      toast.error("Fehler bei der Auswertung");
    } finally {
      setEvaluatingDrill(false);
    }
  };

  const handleRunGutachtenCheck = async () => {
    if (!gutachtenInput.trim()) {
      toast.error("Schreibe zuerst deinen Syllogismus (Obersatz → Definition → Subsumtion → Konklusion).");
      return;
    }
    setEvaluatingGutachten(true);
    try {
      const res = await fetch("/api/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "chapter_tutor_interaction",
          mode: "gutachten_trainer",
          user_answer: gutachtenInput,
        }),
      });
      const data = await res.json();
      if (res.ok && data.evaluation) {
        setGutachtenResult(data.evaluation);
      }
    } catch (e: any) {
      toast.error("Fehler bei der Gutachtenstil-Prüfung");
    } finally {
      setEvaluatingGutachten(false);
    }
  };

  const insertSyllogismusTemplate = (snippet: string) => {
    setGutachtenInput((prev) => (prev ? `${prev}\n\n${snippet}` : snippet));
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

  const activeSemesterKey =
    selectedSemester === "latest" ? semesterKeys[0] || "all" : selectedSemester;

  const visibleCourses =
    activeSemesterKey === "all"
      ? coursesWithMeta
      : bySemester[activeSemesterKey] || coursesWithMeta;

  // ===========================================================================
  // FULL-PAGE ZHAW LEGAL STUDYSMARTER WORKSPACE (When a module is opened)
  // ===========================================================================
  if (selectedCourse && structuredCourse) {
    const cDeadlines = deadlinesByCourse[selectedCourse.id] || [];
    const cNotes = notesByCourse[selectedCourse.id] || [];
    const activeChapter =
      structuredCourse.chapters.find((ch) => ch.weekNumber === selectedWeek) ||
      structuredCourse.chapters[0] ||
      null;

    const cacheKey = `${selectedCourse.id}::SW${activeChapter?.weekNumber || 1}`;
    const activeDeepNotes = deepNotesCache[cacheKey] || null;
    const definitions: any[] = activeDeepNotes?.memorize_definitions || [];
    const activeDef = definitions[selectedDefIdx] || definitions[0] || null;

    return (
      <DashboardLayout>
        <div className="animate-fade-in space-y-6">
          {/* Top Navigation Bar */}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-1">
              <Button
                variant="ghost"
                size="sm"
                className="-ml-2 h-8 text-muted-foreground hover:text-foreground gap-1.5"
                onClick={() => setSelectedCourse(null)}
              >
                <ArrowLeft className="h-4 w-4" /> Zurück zu meinen Modulen
              </Button>
              <div className="flex flex-wrap items-center gap-2.5">
                <h1 className="text-3xl font-bold tracking-tight">
                  {selectedCourse.cleanName}
                </h1>
                <Badge variant="outline">
                  {selectedCourse.semesterInfo?.label || selectedCourse.semesterInfo?.semester}
                </Badge>
                <Badge className="bg-primary/15 text-primary border-primary/30 hover:bg-primary/20">
                  <Scale className="h-3 w-3 mr-1" /> Gutachtenstil & Definitionen-Cockpit
                </Badge>
              </div>
            </div>

            {selectedCourse.moodle_course_id && (
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  window.open(
                    `https://moodle.zhaw.ch/course/view.php?id=${selectedCourse.moodle_course_id}`,
                    "_blank"
                  )
                }
              >
                <ExternalLink className="mr-1.5 h-3.5 w-3.5" /> In ZHAW Moodle öffnen
              </Button>
            )}
          </div>

          {/* 1. MODUL-KOMPASS: USLN-FRISTEN & WICHTIGE MODUL-DOKUMENTE */}
          <div className="grid gap-5 lg:grid-cols-2">
            {/* USLNs & Deadlines */}
            <Card className="border-warning/30 bg-gradient-to-br from-warning/5 to-transparent">
              <CardHeader className="pb-2.5">
                <CardTitle className="text-base flex items-center justify-between">
                  <span className="flex items-center gap-2">
                    <Calendar className="h-4 w-4 text-warning" />
                    Pflichttermine & Leistungsnachweise (USLN)
                  </span>
                  {loadingBriefing && (
                    <span className="text-xs font-normal text-muted-foreground flex items-center gap-1">
                      <Loader2 className="h-3 w-3 animate-spin" /> Prüfe Modul-PDFs...
                    </span>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {cDeadlines.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    {loadingBriefing
                      ? "Merkblätter und Semesterprogramm werden nach USLN-Fristen durchsucht..."
                      : "Keine offenen USLN-Fristen in diesem Modul erkannt."}
                  </p>
                ) : (
                  cDeadlines.map((dl: any) => (
                    <div
                      key={dl.id}
                      className={cn(
                        "flex items-start justify-between gap-3 rounded-lg border bg-card p-3",
                        dl.is_completed && "opacity-60"
                      )}
                    >
                      <div className="flex items-start gap-2.5 min-w-0">
                        <Checkbox
                          className="mt-0.5"
                          checked={dl.is_completed}
                          onCheckedChange={(v) => toggleDeadlineDone(dl.id, !!v)}
                        />
                        <div className="min-w-0">
                          <p
                            className={cn(
                              "text-sm font-semibold leading-snug",
                              dl.is_completed && "line-through"
                            )}
                          >
                            {dl.title}
                          </p>
                          {dl.description && (
                            <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                              {dl.description}
                            </p>
                          )}
                        </div>
                      </div>
                      <Badge variant="outline" className="font-mono text-xs shrink-0">
                        {format(new Date(dl.due_date), "dd.MM.yyyy · HH:mm")}
                      </Badge>
                    </div>
                  ))
                )}
              </CardContent>
            </Card>

            {/* Modul-Kompass: Modulbeschreibung, Semesterprogramm & Alte MEPs */}
            <Card>
              <CardHeader className="pb-2.5">
                <CardTitle className="text-base flex items-center gap-2">
                  <Pin className="h-4 w-4 text-primary" />
                  Modul-Kompass, Spielregeln & Alte MEPs
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2.5">
                <div className="flex flex-wrap gap-2">
                  {[...structuredCourse.compassDocs, ...structuredCourse.oldExams]
                    .slice(0, 6)
                    .map((doc) => (
                      <Button
                        key={doc.id}
                        size="sm"
                        variant={doc.role === "old_exam" ? "secondary" : "outline"}
                        className="h-8 text-xs gap-1.5 max-w-full"
                        onClick={() => doc.file_url && window.open(doc.file_url, "_blank")}
                      >
                        <FileText className="h-3.5 w-3.5 text-primary shrink-0" />
                        <span className="truncate max-w-[230px]">{doc.clean_title}</span>
                        <ExternalLink className="h-3 w-3 opacity-60 shrink-0" />
                      </Button>
                    ))}
                </div>

                {briefingData?.key_norms?.length > 0 && (
                  <div className="pt-1">
                    <p className="text-[11px] font-semibold uppercase text-muted-foreground mb-1.5 flex items-center gap-1">
                      <Scale className="h-3 w-3 text-primary" /> Zentrale Gesetzesnormen im Modul
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {briefingData.key_norms.slice(0, 10).map((n: any, idx: number) => (
                        <Badge key={idx} variant="secondary" className="font-mono text-[11px]">
                          {n.article}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* 2. SEMESTERWOCHEN-KAPITEL (SW 1 – SW 14) + DEEP STUDYSMARTER WORKSPACE */}
          <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
            {/* Left Column: Semesterwochen Navigator */}
            <div className="space-y-2.5">
              <div className="flex items-center justify-between px-1">
                <h2 className="text-sm font-bold uppercase tracking-wider text-muted-foreground">
                  Semesterwochen ({structuredCourse.chapters.length})
                </h2>
                <Badge variant="outline" className="text-[10px]">
                  Auto-Strukturiert
                </Badge>
              </div>

              {structuredCourse.chapters.length === 0 ? (
                <Card className="p-4 text-xs text-muted-foreground">
                  Dieses Modul verwendet allgemeine Projektdokumente statt nummerierter Semesterwochen.
                </Card>
              ) : (
                <div className="space-y-2 max-h-[680px] overflow-y-auto pr-1">
                  {structuredCourse.chapters.map((ch) => {
                    const isSelected = activeChapter?.weekNumber === ch.weekNumber;
                    return (
                      <div
                        key={ch.weekNumber}
                        onClick={() => handleSelectChapter(ch)}
                        className={cn(
                          "cursor-pointer rounded-xl border p-3 transition-all",
                          isSelected
                            ? "border-primary bg-primary/10 shadow-sm"
                            : "bg-card hover:border-primary/40 hover:bg-muted/40"
                        )}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-mono text-xs font-bold text-primary">
                            {ch.title}
                          </span>
                          <div className="flex items-center gap-1">
                            {ch.lectures.length > 0 && (
                              <span
                                className="h-2 w-2 rounded-full bg-sky-500"
                                title={`${ch.lectures.length} Vorlesung`}
                              />
                            )}
                            {ch.exercises.length > 0 && (
                              <span
                                className="h-2 w-2 rounded-full bg-amber-500"
                                title={`${ch.exercises.length} Übungsfall`}
                              />
                            )}
                            {ch.solutions.length > 0 && (
                              <span
                                className="h-2 w-2 rounded-full bg-emerald-500"
                                title={`${ch.solutions.length} Musterlösung / Lösungsskizze`}
                              />
                            )}
                          </div>
                        </div>
                        <p className="mt-1 text-xs font-medium leading-snug line-clamp-2">
                          {ch.topicSubtitle}
                        </p>
                        <div className="mt-2 flex flex-wrap gap-1">
                          {ch.lectures.length > 0 && (
                            <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                              📘 {ch.lectures.length} Folien
                            </Badge>
                          )}
                          {ch.exercises.length > 0 && (
                            <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                              📙 {ch.exercises.length} Fall
                            </Badge>
                          )}
                          {ch.solutions.length > 0 && (
                            <Badge
                              variant="outline"
                              className="text-[10px] px-1.5 py-0 border-emerald-500/40 text-emerald-600 dark:text-emerald-400"
                            >
                              📗 Lösungsskizze
                            </Badge>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Right Column: Active Chapter StudySmarter Legal Cockpit */}
            <div className="space-y-5 min-w-0">
              {/* Chapter Header Bar */}
              <Card className="border-primary/25 bg-gradient-to-r from-primary/5 via-transparent to-transparent">
                <CardContent className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <Badge variant="default" className="font-mono text-xs">
                        {activeChapter ? activeChapter.title : "Gesamtmodul"}
                      </Badge>
                      {activeChapter?.solutions && activeChapter.solutions.length > 0 && (
                        <Badge
                          variant="outline"
                          className="border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 text-xs gap-1"
                        >
                          <FileCheck2 className="h-3 w-3" /> Offizielle ZHAW-Lösungsskizze gekoppelt
                        </Badge>
                      )}
                    </div>
                    <h2 className="text-xl font-bold mt-1.5">
                      {activeChapter
                        ? activeChapter.topicSubtitle
                        : `${selectedCourse.cleanName} — Kernkonzepte & Gutachtenstil`}
                    </h2>
                  </div>

                  {/* Direct 1-click access to this week's Exercise & Official Solution PDF */}
                  {activeChapter && (
                    <div className="flex flex-wrap items-center gap-2 shrink-0">
                      {activeChapter.lectures[0]?.file_url && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 text-xs"
                          onClick={() => window.open(activeChapter.lectures[0].file_url!, "_blank")}
                        >
                          📘 Vorlesung PDF
                        </Button>
                      )}
                      {activeChapter.exercises[0]?.file_url && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 text-xs border-amber-500/40"
                          onClick={() =>
                            window.open(activeChapter.exercises[0].file_url!, "_blank")
                          }
                        >
                          📙 Übungsfall PDF
                        </Button>
                      )}
                      {activeChapter.solutions[0]?.file_url && (
                        <Button
                          size="sm"
                          variant="default"
                          className="h-8 text-xs bg-emerald-600 hover:bg-emerald-700 text-white"
                          onClick={() =>
                            window.open(activeChapter.solutions[0].file_url!, "_blank")
                          }
                        >
                          📗 ZHAW Lösungsskizze öffnen
                        </Button>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* 4 Law-Specific Study Tabs */}
              <Tabs defaultValue="deep_notes" className="w-full">
                <TabsList className="flex flex-wrap h-auto gap-1 p-1">
                  <TabsTrigger value="deep_notes" className="gap-1.5 text-xs sm:text-sm">
                    <Sparkles className="h-3.5 w-3.5" />
                    1. Auswendig-Definitionen & Prüfungsschema
                  </TabsTrigger>
                  <TabsTrigger value="syllogismus" className="gap-1.5 text-xs sm:text-sm">
                    <Gavel className="h-3.5 w-3.5" />
                    2. Gutachtenstil & Syllogismus-Trainer
                  </TabsTrigger>
                  <TabsTrigger value="drill" className="gap-1.5 text-xs sm:text-sm">
                    <Brain className="h-3.5 w-3.5" />
                    3. Definitionen-Abfrage (Active Recall)
                  </TabsTrigger>
                  <TabsTrigger value="files" className="gap-1.5 text-xs sm:text-sm">
                    <FolderOpen className="h-3.5 w-3.5" />
                    4. Alle Unterlagen ({activeChapter?.allFiles.length || 0})
                  </TabsTrigger>
                </TabsList>

                {/* =============================================================== */}
                {/* TAB 1: AUSWENDIG-DEFINITIONEN & PRÜFUNGSSCHEMA                  */}
                {/* =============================================================== */}
                <TabsContent value="deep_notes" className="mt-4 space-y-5">
                  {loadingDeepNotes && !activeDeepNotes ? (
                    <Card className="p-8 text-center">
                      <Loader2 className="h-6 w-6 animate-spin mx-auto text-primary" />
                      <p className="text-sm font-medium mt-2">
                        Extrahiere juristische Definitionen, Prüfungsschemata & Lösungsskizze...
                      </p>
                    </Card>
                  ) : (
                    <>
                      {/* 1A. AUSWENDIG-DEFINITIONEN (Stehen NICHT im Gesetz!) */}
                      <Card className="border-sky-500/30">
                        <CardHeader className="pb-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                          <div>
                            <CardTitle className="text-base flex items-center gap-2">
                              <GraduationCap className="h-5 w-5 text-sky-500" />
                              Auswendig-Definitionen (Stehen NICHT im Gesetzestext!)
                            </CardTitle>
                            <CardDescription className="text-xs mt-0.5">
                              Da du das Gesetz an die MEP mitnehmen darfst, entscheiden diese ungeschriebenen BGE- & Lehrbuch-Definitionen im Rechtssatz über die Punkte.
                            </CardDescription>
                          </div>
                          <Button
                            size="sm"
                            variant={hideDefinitionsMode ? "default" : "outline"}
                            className="h-8 text-xs gap-1.5 shrink-0"
                            onClick={() => {
                              setHideDefinitionsMode((v) => !v);
                              setRevealedDefs({});
                            }}
                          >
                            {hideDefinitionsMode ? (
                              <>
                                <Eye className="h-3.5 w-3.5" /> Alle Definitionen aufdecken
                              </>
                            ) : (
                              <>
                                <EyeOff className="h-3.5 w-3.5" /> Auswendig-Modus (Text verdecken)
                              </>
                            )}
                          </Button>
                        </CardHeader>
                        <CardContent className="space-y-3">
                          {definitions.map((def: any, idx: number) => {
                            const isHidden = hideDefinitionsMode && !revealedDefs[idx];
                            return (
                              <div
                                key={idx}
                                className="rounded-xl border border-sky-500/25 bg-sky-500/[0.04] p-4 space-y-2.5"
                              >
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                  <span className="font-bold text-sm text-foreground flex items-center gap-2">
                                    <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-sky-500/20 text-sky-600 dark:text-sky-300 text-xs font-mono">
                                      {idx + 1}
                                    </span>
                                    {def.term}
                                  </span>
                                  <Badge variant="outline" className="font-mono text-[11px]">
                                    {def.norm_anchor}
                                  </Badge>
                                </div>

                                {isHidden ? (
                                  <div
                                    onClick={() =>
                                      setRevealedDefs((prev) => ({ ...prev, [idx]: true }))
                                    }
                                    className="cursor-pointer rounded-lg border border-dashed border-sky-500/40 bg-background/60 p-4 text-center hover:bg-sky-500/10 transition-colors"
                                  >
                                    <p className="text-xs font-medium text-sky-600 dark:text-sky-400">
                                      🔒 Definition im Kopf aufsagen — Klicken zum Aufdecken & Überprüfen
                                    </p>
                                  </div>
                                ) : (
                                  <>
                                    <p className="text-sm leading-relaxed font-medium bg-background/80 rounded-lg p-3 border border-border/60">
                                      «{def.definition}»
                                    </p>
                                    {def.keywords?.length > 0 && (
                                      <div className="flex flex-wrap items-center gap-1.5">
                                        <span className="text-[11px] text-muted-foreground font-medium mr-1">
                                          Schlüsselwörter für die Lösungsskizze:
                                        </span>
                                        {def.keywords.map((kw: string, kIdx: number) => (
                                          <Badge
                                            key={kIdx}
                                            variant="secondary"
                                            className="text-[11px] bg-sky-500/15 text-sky-900 dark:text-sky-200"
                                          >
                                            ✓ {kw}
                                          </Badge>
                                        ))}
                                      </div>
                                    )}
                                    {def.why_memorize && (
                                      <p className="text-xs text-muted-foreground italic">
                                        💡 Klausur-Hinweis: {def.why_memorize}
                                      </p>
                                    )}
                                  </>
                                )}
                              </div>
                            );
                          })}
                        </CardContent>
                      </Card>

                      {/* 1B. PRÜFUNGSSCHEMA (REIHENFOLGE IM GUTACHTEN) */}
                      {activeDeepNotes?.pruefungsschema && (
                        <Card className="border-violet-500/30">
                          <CardHeader className="pb-3">
                            <CardTitle className="text-base flex items-center gap-2">
                              <ListChecks className="h-5 w-5 text-violet-500" />
                              {activeDeepNotes.pruefungsschema.title}
                            </CardTitle>
                            <CardDescription className="text-xs">
                              Zwingende Prüfungsreihenfolge für deine Falllösung im Gutachtenstil.
                            </CardDescription>
                          </CardHeader>
                          <CardContent className="space-y-2.5">
                            {activeDeepNotes.pruefungsschema.steps?.map(
                              (st: any, idx: number) => (
                                <div
                                  key={idx}
                                  className="rounded-lg border border-violet-500/20 bg-violet-500/[0.03] p-3"
                                >
                                  <p className="text-sm font-semibold text-foreground">
                                    {st.step}
                                  </p>
                                  <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                                    {st.detail}
                                  </p>
                                </div>
                              )
                            )}
                          </CardContent>
                        </Card>
                      )}

                      {/* 1C. TYPISCHE KLAUSUR-FALLEN (MISCONCEPTIONS) */}
                      {activeDeepNotes?.pitfalls?.length > 0 && (
                        <Card className="border-rose-500/30 bg-rose-500/[0.02]">
                          <CardHeader className="pb-2.5">
                            <CardTitle className="text-base flex items-center gap-2 text-rose-600 dark:text-rose-400">
                              <AlertTriangle className="h-4 w-4" />
                              Typische Klausur-Fallen & Urteilsstil-Fehler vermeiden
                            </CardTitle>
                          </CardHeader>
                          <CardContent className="space-y-2">
                            {activeDeepNotes.pitfalls.map((pf: string, idx: number) => (
                              <div
                                key={idx}
                                className="flex items-start gap-2.5 text-xs leading-relaxed bg-background/80 p-2.5 rounded-lg border border-rose-500/20"
                              >
                                <span className="font-bold text-rose-500 shrink-0">!</span>
                                <span>{pf}</span>
                              </div>
                            ))}
                          </CardContent>
                        </Card>
                      )}
                    </>
                  )}
                </TabsContent>

                {/* =============================================================== */}
                {/* TAB 2: GUTACHTENSTIL & SYLLOGISMUS-TRAINER                      */}
                {/* =============================================================== */}
                <TabsContent value="syllogismus" className="mt-4 space-y-5">
                  {/* Reference Syllogismus Pattern */}
                  {activeDeepNotes?.syllogismus_guide && (
                    <Card className="border-emerald-500/30">
                      <CardHeader className="pb-3">
                        <CardTitle className="text-base flex items-center gap-2">
                          <Gavel className="h-5 w-5 text-emerald-500" />
                          Muster-Syllogismus (Strikter 4-Schritt-Gutachtenstil wie in der ZHAW-Lösungsskizze)
                        </CardTitle>
                        <CardDescription className="text-xs">
                          Jedes einzelne Tatbestandsmerkmal wird in der Klausur exakt nach diesem 4-Schritt-Schema abgearbeitet.
                        </CardDescription>
                      </CardHeader>
                      <CardContent className="space-y-3">
                        <div className="grid gap-2.5 sm:grid-cols-2">
                          <div className="rounded-lg border border-sky-500/30 bg-sky-500/5 p-3">
                            <Badge className="bg-sky-600 text-white text-[10px] mb-1.5">
                              1. Obersatz (Hypothese im Konjunktiv)
                            </Badge>
                            <p className="text-xs leading-relaxed">
                              {activeDeepNotes.syllogismus_guide.obersatz}
                            </p>
                          </div>
                          <div className="rounded-lg border border-violet-500/30 bg-violet-500/5 p-3">
                            <Badge className="bg-violet-600 text-white text-[10px] mb-1.5">
                              2. Voraussetzungen & Auswendig-Definition (Rechtssatz)
                            </Badge>
                            <p className="text-xs leading-relaxed">
                              {activeDeepNotes.syllogismus_guide.definition_rechtssatz}
                            </p>
                          </div>
                          <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
                            <Badge className="bg-amber-600 text-white text-[10px] mb-1.5">
                              3. Subsumtion am konkreten Sachverhalt (Untersatz)
                            </Badge>
                            <p className="text-xs leading-relaxed">
                              {activeDeepNotes.syllogismus_guide.subsumtion}
                            </p>
                          </div>
                          <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3">
                            <Badge className="bg-emerald-600 text-white text-[10px] mb-1.5">
                              4. Konklusion (Spiegelbild zum Obersatz)
                            </Badge>
                            <p className="text-xs leading-relaxed">
                              {activeDeepNotes.syllogismus_guide.konklusion}
                            </p>
                          </div>
                        </div>

                        {/* Authentic Excerpt from Decompressed ZHAW Lösungsskizze if available */}
                        {activeDeepNotes.solution_excerpts?.length > 0 && (
                          <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-3.5 space-y-1.5">
                            <p className="text-xs font-bold text-emerald-800 dark:text-emerald-300 flex items-center gap-1.5">
                              <FileCheck2 className="h-4 w-4" />
                              Original-Auszug aus der ZHAW-Musterlösung ({activeChapter?.title}):
                            </p>
                            <p className="text-xs text-muted-foreground leading-relaxed line-clamp-5">
                              {activeDeepNotes.solution_excerpts[0]}
                            </p>
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  )}

                  {/* Interactive Gutachtenstil & Syllogismus Editor + Checker */}
                  <Card>
                    <CardHeader className="pb-3">
                      <CardTitle className="text-base">
                        ✍️ Dein Gutachtenstil- & Syllogismus-Trainer
                      </CardTitle>
                      <CardDescription className="text-xs">
                        Formuliere hier deine Falllösung (oder einen Teil-Syllogismus zur aktuellen Übung). Unser Prüfer kontrolliert strikt Obersatz, Auswendig-Definition, Sachverhalts-Subsumtion, Konklusion und warnt vor Urteilsstil-Fehlern («weil/da»).
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <div className="flex flex-wrap gap-1.5">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs"
                          onClick={() =>
                            insertSyllogismusTemplate(
                              "Zu prüfen ist, ob X gegen Y einen Anspruch auf ... gemäss Art. ... hat."
                            )
                          }
                        >
                          + 1. Obersatz-Baustein
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs"
                          onClick={() =>
                            insertSyllogismusTemplate(
                              "Voraussetzung dafür ist gemäss Art. ... zunächst das Vorliegen von ... Unter ... versteht man nach ständiger Rechtsprechung ..."
                            )
                          }
                        >
                          + 2. Definition / Rechtssatz
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs"
                          onClick={() =>
                            insertSyllogismusTemplate(
                              "Vorliegend hat X laut Sachverhalt ... Damit ist das Merkmal ... verwirklicht."
                            )
                          }
                        >
                          + 3. Subsumtion («Vorliegend...»)
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs"
                          onClick={() =>
                            insertSyllogismusTemplate(
                              "Folglich ist das Tatbestandsmerkmal ... gemäss Art. ... erfüllt."
                            )
                          }
                        >
                          + 4. Konklusion («Folglich...»)
                        </Button>
                      </div>

                      <Textarea
                        rows={6}
                        value={gutachtenInput}
                        onChange={(e) => setGutachtenInput(e.target.value)}
                        placeholder="Schreibe hier im strikten Gutachtenstil:&#10;1. Zu prüfen ist, ob...&#10;2. Voraussetzung ist gemäss Art. ... Unter [Begriff] versteht man...&#10;3. Vorliegend hat X...&#10;4. Folglich..."
                        className="text-sm leading-relaxed"
                      />

                      <div className="flex items-center justify-between gap-2">
                        <Button
                          onClick={handleRunGutachtenCheck}
                          disabled={evaluatingGutachten}
                          className="gap-2"
                        >
                          {evaluatingGutachten ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Gavel className="h-4 w-4" />
                          )}
                          Gutachtenstil & Syllogismus prüfen
                        </Button>
                        {gutachtenInput && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              setGutachtenInput("");
                              setGutachtenResult(null);
                            }}
                          >
                            Zurücksetzen
                          </Button>
                        )}
                      </div>

                      {gutachtenResult && (
                        <div className="mt-4 rounded-xl border bg-muted/30 p-4 space-y-3">
                          <div className="flex items-center justify-between">
                            <span className="font-bold text-sm">{gutachtenResult.verdict}</span>
                            <Badge
                              variant={gutachtenResult.score >= 80 ? "default" : "secondary"}
                              className="font-mono"
                            >
                              Syllogismus-Score: {gutachtenResult.score}%
                            </Badge>
                          </div>
                          <div className="space-y-2">
                            {gutachtenResult.steps_check?.map((st: any, i: number) => (
                              <div
                                key={i}
                                className={cn(
                                  "rounded-lg border p-2.5 text-xs",
                                  st.passed
                                    ? "border-emerald-500/30 bg-emerald-500/5"
                                    : "border-amber-500/40 bg-amber-500/10"
                                )}
                              >
                                <p className="font-semibold">{st.label}</p>
                                <p className="text-muted-foreground mt-0.5">{st.feedback}</p>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                </TabsContent>

                {/* =============================================================== */}
                {/* TAB 3: DEFINITIONEN-ABFRAGE (ACTIVE RECALL DRILL)               */}
                {/* =============================================================== */}
                <TabsContent value="drill" className="mt-4 space-y-4">
                  <Card>
                    <CardHeader className="pb-3">
                      <CardTitle className="text-base flex items-center gap-2">
                        <Brain className="h-5 w-5 text-primary" />
                        Definitionen-Drill (Wort-für-Wort Auswendiglernen für den Rechtssatz)
                      </CardTitle>
                      <CardDescription className="text-xs">
                        Wähle einen Rechtsbegriff und schreibe die Definition frei aus dem Gedächtnis auf. Das System prüft sofort, ob alle für die ZHAW-Lösungsskizze nötigen Tatbestandselemente enthalten sind.
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      <div className="flex flex-wrap gap-1.5">
                        {definitions.map((d: any, idx: number) => (
                          <Button
                            key={idx}
                            size="sm"
                            variant={selectedDefIdx === idx ? "default" : "outline"}
                            className="h-8 text-xs"
                            onClick={() => {
                              setSelectedDefIdx(idx);
                              setDrillInput("");
                              setDrillResult(null);
                            }}
                          >
                            {d.term}
                          </Button>
                        ))}
                      </div>

                      {activeDef && (
                        <div className="space-y-3 rounded-xl border p-4 bg-muted/20">
                          <div className="flex items-center justify-between">
                            <div>
                              <p className="text-xs text-muted-foreground uppercase font-semibold">
                                Gesuchter Rechtsbegriff:
                              </p>
                              <h3 className="text-lg font-bold">{activeDef.term}</h3>
                            </div>
                            <Badge variant="outline" className="font-mono text-xs">
                              {activeDef.norm_anchor}
                            </Badge>
                          </div>

                          <Textarea
                            rows={4}
                            value={drillInput}
                            onChange={(e) => setDrillInput(e.target.value)}
                            placeholder={`Wie lautet die genaue juristische Definition von «${activeDef.term}»?`}
                            className="text-sm"
                          />

                          <Button
                            onClick={() => handleRunDefinitionDrill(activeDef)}
                            disabled={evaluatingDrill}
                            className="gap-2"
                          >
                            {evaluatingDrill ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <CheckCircle2 className="h-4 w-4" />
                            )}
                            Definition überprüfen
                          </Button>

                          {drillResult && (
                            <div className="mt-3 rounded-xl border bg-card p-4 space-y-3">
                              <div className="flex items-center justify-between">
                                <span className="font-bold text-sm">{drillResult.verdict}</span>
                                <Badge className="font-mono">{drillResult.score}% Treffer</Badge>
                              </div>

                              <div className="grid gap-3 sm:grid-cols-2">
                                <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3">
                                  <p className="text-xs font-semibold text-emerald-700 dark:text-emerald-300 mb-1.5">
                                    ✅ Getroffene Tatbestandselemente:
                                  </p>
                                  {drillResult.matched_keywords?.length > 0 ? (
                                    <div className="flex flex-wrap gap-1">
                                      {drillResult.matched_keywords.map((kw: string, i: number) => (
                                        <Badge key={i} variant="secondary" className="text-xs">
                                          ✓ {kw}
                                        </Badge>
                                      ))}
                                    </div>
                                  ) : (
                                    <p className="text-xs text-muted-foreground">
                                      Noch keine Schlüsselbegriffe getroffen.
                                    </p>
                                  )}
                                </div>

                                <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
                                  <p className="text-xs font-semibold text-amber-700 dark:text-amber-300 mb-1.5">
                                    ⚠️ Fehlt noch für volle Punktzahl:
                                  </p>
                                  {drillResult.missed_keywords?.length > 0 ? (
                                    <div className="flex flex-wrap gap-1">
                                      {drillResult.missed_keywords.map((kw: string, i: number) => (
                                        <Badge key={i} variant="outline" className="text-xs">
                                          + {kw}
                                        </Badge>
                                      ))}
                                    </div>
                                  ) : (
                                    <p className="text-xs text-emerald-600 font-medium">
                                      Alle Schlüsselbegriffe vollständig genannt!
                                    </p>
                                  )}
                                </div>
                              </div>

                              <div className="rounded-lg bg-muted p-3 text-xs space-y-1">
                                <p className="font-semibold text-foreground">
                                  Offizielle Muster-Definition zum Einprägen:
                                </p>
                                <p className="leading-relaxed">«{drillResult.official_definition}»</p>
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                </TabsContent>

                {/* =============================================================== */}
                {/* TAB 4: GEORDNETE WOCHEN-UNTERLAGEN & SKRIPTE                    */}
                {/* =============================================================== */}
                <TabsContent value="files" className="mt-4 space-y-5">
                  {activeChapter && (
                    <Card>
                      <CardHeader className="pb-3">
                        <CardTitle className="text-base">
                          Unterlagen zu {activeChapter.title}: {activeChapter.topicSubtitle}
                        </CardTitle>
                        <CardDescription className="text-xs">
                          Farblich getrennt nach Vorlesungsfolien, Factsheets, Übungsfällen und offiziellen Lösungsskizzen.
                        </CardDescription>
                      </CardHeader>
                      <CardContent className="grid gap-2.5 sm:grid-cols-2">
                        {activeChapter.allFiles.map((f: ClassifiedFile) => (
                          <div
                            key={f.id}
                            onClick={() => f.file_url && window.open(f.file_url, "_blank")}
                            className={cn(
                              "cursor-pointer rounded-lg border p-3 flex items-center justify-between gap-3 transition-colors hover:border-primary/50",
                              f.role === "solution" && "border-emerald-500/40 bg-emerald-500/5",
                              f.role === "exercise" && "border-amber-500/40 bg-amber-500/5",
                              f.role === "lecture" && "border-sky-500/30 bg-sky-500/5"
                            )}
                          >
                            <div className="min-w-0 space-y-1">
                              <Badge variant="outline" className="text-[10px]">
                                {f.roleLabel}
                              </Badge>
                              <p className="text-sm font-medium truncate">{f.clean_title}</p>
                            </div>
                            <ExternalLink className="h-4 w-4 text-muted-foreground shrink-0" />
                          </div>
                        ))}
                      </CardContent>
                    </Card>
                  )}

                  {structuredCourse.referenceDocs.length > 0 && (
                    <Card>
                      <CardHeader className="pb-3">
                        <CardTitle className="text-base">
                          Allgemeine Skripte, Bundesgerichtsentscheide (BGE) & Gesetze ({structuredCourse.referenceDocs.length})
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="grid gap-2 sm:grid-cols-2">
                        {structuredCourse.referenceDocs.map((f) => (
                          <div
                            key={f.id}
                            onClick={() => f.file_url && window.open(f.file_url, "_blank")}
                            className="cursor-pointer rounded-lg border p-2.5 flex items-center justify-between gap-2 hover:border-primary/40"
                          >
                            <span className="text-xs font-medium truncate">{f.clean_title}</span>
                            <ExternalLink className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                          </div>
                        ))}
                      </CardContent>
                    </Card>
                  )}

                  {cNotes.length > 0 && (
                    <Card>
                      <CardHeader className="pb-3">
                        <CardTitle className="text-base">
                          Moodle-Hinweise & Pflichtliteratur ({cNotes.length})
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-2.5">
                        {cNotes.map((n: any) => (
                          <div key={n.id} className="rounded-lg border p-3 space-y-1">
                            <div className="flex items-center justify-between">
                              <span className="text-xs font-semibold">{n.title}</span>
                              <Badge variant="outline" className="text-[10px]">
                                {n.note_type || "Info"}
                              </Badge>
                            </div>
                            <p className="text-xs text-muted-foreground whitespace-pre-line leading-relaxed">
                              {n.content}
                            </p>
                          </div>
                        ))}
                      </CardContent>
                    </Card>
                  )}
                </TabsContent>
              </Tabs>
            </div>
          </div>
        </div>
      </DashboardLayout>
    );
  }

  // ===========================================================================
  // DEFAULT MODULE GRID (Filtered to Current Semester by default)
  // ===========================================================================
  return (
    <DashboardLayout>
      <div className="animate-fade-in space-y-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Meine Rechts-Module</h1>
            <p className="mt-1 text-muted-foreground">
              Automatisch strukturiert in Semesterwochen (SW 1–14), Auswendig-Definitionen, Prüfungsschemata & ZHAW-Lösungsskizzen.
            </p>
          </div>

          {semesterKeys.length > 1 && (
            <div className="flex flex-wrap items-center gap-1.5">
              {semesterKeys.map((sem) => (
                <Button
                  key={sem}
                  size="sm"
                  variant={activeSemesterKey === sem ? "default" : "outline"}
                  className="h-8 text-xs"
                  onClick={() => setSelectedSemester(sem)}
                >
                  {bySemester[sem][0]?.semesterInfo.label || sem}
                </Button>
              ))}
              <Button
                size="sm"
                variant={activeSemesterKey === "all" ? "default" : "ghost"}
                className="h-8 text-xs"
                onClick={() => setSelectedSemester("all")}
              >
                Alle ({courses.length})
              </Button>
            </div>
          )}
        </div>

        {loading ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="h-40 rounded-lg bg-muted animate-pulse" />
            ))}
          </div>
        ) : visibleCourses.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-12 text-center">
              <BookOpen className="h-12 w-12 text-muted-foreground/40" />
              <h3 className="mt-4 font-semibold">Noch keine Module geladen</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Der Autopilot synchronisiert deine ZHAW-Kurse automatisch im Hintergrund.
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {visibleCourses.map((course) => {
              const cDeadlines = (deadlinesByCourse[course.id] || []).filter(
                (d: any) => !d.is_completed
              );
              const cFiles = filesByCourse[course.id] || [];
              const structured = structureCourseFiles(cFiles);
              const solutionCount = structured.chapters.reduce(
                (acc, ch) => acc + ch.solutions.length,
                0
              );

              return (
                <Card
                  key={course.id}
                  onClick={() => handleOpenCourse(course)}
                  className={cn(
                    "cursor-pointer transition-all hover:shadow-md hover:border-primary/40 group flex flex-col justify-between",
                    cDeadlines.length > 0 && "border-warning/40"
                  )}
                >
                  <CardHeader className="pb-2">
                    <div className="flex items-start justify-between gap-2">
                      <CardTitle className="text-lg leading-snug group-hover:text-primary transition-colors">
                        {course.cleanName}
                      </CardTitle>
                      <Badge variant="outline" className="shrink-0 text-[10px]">
                        {course.semesterInfo.semester}
                      </Badge>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {cDeadlines.length > 0 ? (
                      <div className="rounded-md bg-warning/10 border border-warning/20 px-3 py-2 text-xs space-y-0.5">
                        <p className="font-semibold text-warning truncate">
                          🎯 {cDeadlines[0].title}
                        </p>
                        <p className="text-muted-foreground font-mono text-[11px]">
                          Fällig am{" "}
                          {format(new Date(cDeadlines[0].due_date), "dd. MMM yyyy · HH:mm", {
                            locale: de,
                          })}{" "}
                          Uhr
                        </p>
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        Klicken für Auswendig-Definitionen, Prüfungsschemata & Gutachtenstil-Trainer
                      </p>
                    )}

                    <div className="flex flex-wrap items-center gap-1.5 pt-1">
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
                        {cDeadlines.length} Fristen
                      </Badge>
                      {structured.chapters.length > 0 && (
                        <Badge variant="secondary" className="text-xs gap-1">
                          📚 {structured.chapters.length} Wochen-Kapitel
                        </Badge>
                      )}
                      {solutionCount > 0 && (
                        <Badge
                          variant="outline"
                          className="text-xs gap-1 border-emerald-500/40 text-emerald-600 dark:text-emerald-400"
                        >
                          📗 {solutionCount} Lösungsskizzen
                        </Badge>
                      )}
                      <Badge variant="secondary" className="text-xs gap-1">
                        <FolderOpen className="h-3 w-3" />
                        {cFiles.length} PDFs
                      </Badge>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
