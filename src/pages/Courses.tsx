import { useEffect, useState, useCallback } from "react";
import { DashboardLayout } from "@/components/DashboardLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
} from "lucide-react";
import { format } from "date-fns";
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
  const [selectedSemester, setSelectedSemester] = useState<string>("latest");

  // Active full-page Course Workspace
  const [selectedCourse, setSelectedCourse] = useState<any | null>(null);
  const [briefingData, setBriefingData] = useState<any | null>(null);
  const [loadingBriefing, setLoadingBriefing] = useState(false);

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

  const handleOpenCourse = (course: any) => {
    setSelectedCourse(course);
    setBriefingData(null);
    loadCourseBriefing(course);
  };

  const toggleDeadlineDone = async (id: string, done: boolean) => {
    await supabase.from("deadlines").update({ is_completed: done }).eq("id", id);
    toast.success(done ? "Frist erledigt!" : "Frist wieder geöffnet");
    await fetchAllCourseData();
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
  // FULL-PAGE MODULE WORKSPACE VIEW (When a course is clicked)
  // ===========================================================================
  if (selectedCourse) {
    const cDeadlines = deadlinesByCourse[selectedCourse.id] || [];
    const cFiles = filesByCourse[selectedCourse.id] || [];
    const cNotes = notesByCourse[selectedCourse.id] || [];

    const keyDocs = cFiles.filter((f: any) =>
      /(leistungsnachweis|usln|fallbearbeitung|merkblatt|modulübersicht|modulbeschreibung|semesterprogramm|semesterwochenprogramm|programm|zeitplan|leitfaden)/i.test(
        f.file_name || ""
      )
    );

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

          {/* 1. SPIELREGELN & LEISTUNGSNACHWEISE (USLN) */}
          <div className="grid gap-6 lg:grid-cols-2">
            {/* Deadlines & USLNs Card */}
            <Card className="border-warning/30 bg-gradient-to-br from-warning/5 to-transparent">
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center justify-between">
                  <span className="flex items-center gap-2">
                    <Calendar className="h-4 w-4 text-warning" />
                    Fristen & Leistungsnachweise (USLN)
                  </span>
                  {loadingBriefing && (
                    <span className="text-xs font-normal text-muted-foreground flex items-center gap-1">
                      <Loader2 className="h-3 w-3 animate-spin" /> Prüfe Modul-PDFs...
                    </span>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2.5">
                {cDeadlines.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    {loadingBriefing
                      ? "Dokumente werden automatisch nach Terminen durchsucht..."
                      : "Keine Fristen in diesem Modul erkannt."}
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

            {/* Pinned Key Documents (Leistungsnachweis / Merkblatt / Semesterprogramm) */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <Pin className="h-4 w-4 text-primary" />
                  Wichtige Modul-Dokumente & Spielregeln
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {keyDocs.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Keine separaten Merkblätter oder Semesterprogramme gefunden.
                  </p>
                ) : (
                  keyDocs.map((doc: any) => (
                    <div key={doc.id} className="rounded-lg border p-3 space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <FileText className="h-4 w-4 text-primary shrink-0" />
                          <span className="text-sm font-semibold truncate">{doc.file_name}</span>
                        </div>
                        {doc.file_url && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 text-xs shrink-0"
                            onClick={() => window.open(doc.file_url, "_blank")}
                          >
                            <ExternalLink className="h-3 w-3 mr-1" /> PDF öffnen
                          </Button>
                        )}
                      </div>
                      {doc.extracted_content?.summary && (
                        <p className="text-xs text-muted-foreground line-clamp-4 leading-relaxed bg-muted/30 p-2.5 rounded">
                          {doc.extracted_content.summary}
                        </p>
                      )}
                    </div>
                  ))
                )}

                {briefingData?.key_norms?.length > 0 && (
                  <div className="pt-2">
                    <p className="text-xs font-semibold uppercase text-muted-foreground mb-1.5 flex items-center gap-1.5">
                      <Scale className="h-3.5 w-3.5 text-primary" /> Erkannte Gesetzesnormen
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {briefingData.key_norms.map((n: any, idx: number) => (
                        <Badge key={idx} variant="secondary" className="font-mono text-xs">
                          {n.article}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* 2. ALL FILES & COURSE NOTES IN ONE PLACE */}
          <Tabs defaultValue="files" className="w-full">
            <TabsList>
              <TabsTrigger value="files">
                📂 Unterlagen & Folien ({cFiles.length})
              </TabsTrigger>
              <TabsTrigger value="notes">
                📝 Kurshinweise, Literatur & Lernziele ({cNotes.length})
              </TabsTrigger>
            </TabsList>

            <TabsContent value="files" className="mt-4">
              {cFiles.length === 0 ? (
                <Card>
                  <CardContent className="py-10 text-center text-muted-foreground text-sm">
                    Keine Dateien in diesem Modul.
                  </CardContent>
                </Card>
              ) : (
                <div className="grid gap-2.5 sm:grid-cols-2">
                  {cFiles.map((f: any) => (
                    <Card
                      key={f.id}
                      onClick={() => f.file_url && window.open(f.file_url, "_blank")}
                      className="cursor-pointer hover:border-primary/40 transition-colors"
                    >
                      <CardContent className="flex items-center justify-between p-3.5 gap-3">
                        <div className="flex items-center gap-3 min-w-0">
                          {f.extraction_status === "done" ? (
                            <CheckCircle2 className="h-4 w-4 text-success shrink-0" />
                          ) : (
                            <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                          )}
                          <span className="text-sm font-medium truncate">{f.file_name}</span>
                        </div>
                        <ExternalLink className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}
            </TabsContent>

            <TabsContent value="notes" className="mt-4 space-y-3">
              {cNotes.length === 0 ? (
                <Card>
                  <CardContent className="py-10 text-center text-muted-foreground text-sm">
                    Keine Kursnotizen vorhanden.
                  </CardContent>
                </Card>
              ) : (
                cNotes.map((n: any) => (
                  <Card key={n.id}>
                    <CardContent className="p-4 space-y-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <h4 className="font-semibold text-sm">{n.title}</h4>
                        <Badge variant="outline" className="text-[10px]">
                          {n.note_type || "Info"}
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground whitespace-pre-line leading-relaxed">
                        {n.content}
                      </p>
                    </CardContent>
                  </Card>
                ))
              )}
            </TabsContent>
          </Tabs>
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
            <h1 className="text-3xl font-bold tracking-tight">Meine Module</h1>
            <p className="mt-1 text-muted-foreground">
              Wähle ein Modul für deine Leistungsnachweise (USLN), Merkblätter, Vorlesungsfolien & Lernziele.
            </p>
          </div>

          {/* Clean Semester Filter Pills */}
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
              const cNotes = notesByCourse[course.id] || [];

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
                        Klicken für Modulübersicht, USLN-Check & Folien
                      </p>
                    )}

                    <div className="flex flex-wrap items-center gap-2 pt-1">
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
                      <Badge variant="secondary" className="text-xs gap-1">
                        <FolderOpen className="h-3 w-3" />
                        {cFiles.length} Unterlagen
                      </Badge>
                      <Badge variant="secondary" className="text-xs gap-1">
                        <FileText className="h-3 w-3" />
                        {cNotes.length} Hinweise
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
