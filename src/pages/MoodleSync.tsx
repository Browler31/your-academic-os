import { useState, useEffect } from "react";
import { DashboardLayout } from "@/components/DashboardLayout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { RefreshCw, Check, AlertCircle, Loader2, Settings2, Wifi, WifiOff } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";

interface CourseToSync {
  id: string;
  moodle_course_id: number;
  name: string;
  short_name: string | null;
}

export default function MoodleSync() {
  const { session } = useAuth();
  const [moodleToken, setMoodleToken] = useState("");
  const [moodleUrl, setMoodleUrl] = useState("https://moodle.zhaw.ch");
  const [isVerified, setIsVerified] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [showTokenInput, setShowTokenInput] = useState(false);
  const [lastSynced, setLastSynced] = useState<string | null>(null);
  const [profileLoaded, setProfileLoaded] = useState(false);

  // Progress tracking
  const [syncPhase, setSyncPhase] = useState<string>("");
  const [syncProgress, setSyncProgress] = useState(0);
  const [syncTotal, setSyncTotal] = useState(0);
  const [currentCourse, setCurrentCourse] = useState<string>("");
  const [syncResults, setSyncResults] = useState<{ course: string; files: number; notes: number }[]>([]);
  const [syncErrors, setSyncErrors] = useState<string[]>([]);

  // Auto-parse pipeline state
  const [pipelinePhase, setPipelinePhase] = useState<string>("");
  const [parseProgress, setParseProgress] = useState(0);
  const [parseTotal, setParseTotal] = useState(0);
  const [parsedCount, setParsedCount] = useState(0);
  const [flashcardsGenerated, setFlashcardsGenerated] = useState(0);

  useEffect(() => {
    const savedToken = typeof window !== "undefined" ? localStorage.getItem("moodle_token") : null;
    const savedUrl = typeof window !== "undefined" ? localStorage.getItem("moodle_url") : null;
    if (savedToken) {
      setMoodleToken(savedToken);
      if (savedUrl) setMoodleUrl(savedUrl);
      setIsVerified(true);
      setShowTokenInput(false);
    }
    if (!session?.user?.id) return;
    (async () => {
      const { data } = await supabase
        .from("profiles")
        .select("moodle_token, moodle_base_url, moodle_verified_at")
        .eq("user_id", session.user.id)
        .maybeSingle();
      if (data?.moodle_token) {
        setMoodleToken(data.moodle_token);
        setMoodleUrl(data.moodle_base_url || "https://moodle.zhaw.ch");
        setIsVerified(!!data.moodle_verified_at);
        setLastSynced(data.moodle_verified_at);
        setShowTokenInput(false);
      } else if (!savedToken) {
        setShowTokenInput(true);
      }
      setProfileLoaded(true);
    })();
  }, [session?.user?.id]);

  useEffect(() => {
    if (!session?.user?.id) return;
    (async () => {
      const { data } = await supabase
        .from("courses").select("last_synced_at")
        .eq("user_id", session.user.id)
        .order("last_synced_at", { ascending: false }).limit(1).maybeSingle();
      if (data?.last_synced_at) setLastSynced(data.last_synced_at);
    })();
  }, [session?.user?.id]);

  const callMoodleSync = async (action: string, extra: Record<string, unknown> = {}) => {
    try {
      const res = await fetch("/api/moodle-sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          moodle_token: moodleToken,
          moodle_base_url: moodleUrl,
          user_id: session?.user?.id || "59255661-ce8b-476c-8e00-408b55843c58",
          ...extra,
        }),
      });
      if (res.ok) {
        return await res.json();
      }
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || res.statusText);
    } catch (e: any) {
      // Fallback to supabase edge function if /api/moodle-sync is not available
      const { data, error } = await supabase.functions.invoke("moodle-sync", {
        body: { action, moodle_token: moodleToken, moodle_base_url: moodleUrl, ...extra },
      });
      if (error) throw (e.message ? e : error);
      return data;
    }
  };

  const saveTokenToProfile = async () => {
    try {
      localStorage.setItem("moodle_token", moodleToken);
      localStorage.setItem("moodle_url", moodleUrl);
    } catch {}
    if (!session?.user?.id) return;
    await supabase.from("profiles").upsert({
      user_id: session.user.id,
      moodle_token: moodleToken,
      moodle_base_url: moodleUrl,
      moodle_verified_at: new Date().toISOString(),
    }, { onConflict: "user_id" });
  };

  const handleVerifyAndSave = async () => {
    if (!moodleToken.trim()) { toast.error("Please enter your Moodle token"); return; }
    setVerifying(true);
    try {
      const info = await callMoodleSync("verify");
      toast.success(`Connected as ${info.fullname} (${info.sitename})`);
      setIsVerified(true);
      await saveTokenToProfile();
      setShowTokenInput(false);
    } catch (error: any) {
      toast.error(`Verification failed: ${error.message}`);
      setIsVerified(false);
    } finally {
      setVerifying(false);
    }
  };

  const [availableSemesters, setAvailableSemesters] = useState<string[]>([]);
  const [selectedSemester, setSelectedSemester] = useState<string>("all");

  const loadSemesters = async () => {
    try {
      const res = await callMoodleSync("get_available_semesters");
      if (res?.semesters?.length) {
        setAvailableSemesters(res.semesters);
        // Default to first (most recent) semester
        if (selectedSemester === "all") {
          setSelectedSemester(res.semesters[0]);
        }
      }
    } catch {}
  };

  useEffect(() => {
    if (isVerified && moodleToken) {
      loadSemesters();
    }
  }, [isVerified, moodleToken]);

  const handleSync = async () => {
    setSyncing(true);
    setSyncPhase("Sync läuft im Hintergrund auf dem Server...");
    setSyncResults([]);
    setSyncErrors([]);

    try {
      const res = await callMoodleSync("sync_all", {
        semester_filter: selectedSemester,
        sync_files: true,
      });

      toast.success(res.message || "Sync erfolgreich abgeschlossen!");
      setSyncResults([
        {
          course: `${res.synced_courses} Kurse (${selectedSemester === "all" ? "Alle Semester" : selectedSemester})`,
          files: res.total_files || 0,
          notes: res.total_notes || 0,
        },
      ]);
      setLastSynced(new Date().toISOString());
    } catch (error: any) {
      toast.error(`Sync fehlgeschlagen: ${error.message}`);
      setSyncErrors([error.message]);
    } finally {
      setSyncing(false);
      setSyncPhase("");
    }
  };

  const runAutoParsePipeline = async () => {
    if (!session?.user?.id) return;

    // Step 1: Find unparsed PDF files
    setPipelinePhase("Finding unparsed files...");
    const { data: unparsed } = await supabase
      .from("files")
      .select("id, file_name, course_id")
      .eq("user_id", session.user.id)
      .is("extracted_content", null)
      .in("extraction_status", ["pending", "error"])
      .not("file_name", "not.ilike", "%.pdf");

    const pdfFiles = (unparsed || []).filter(f => f.file_name.toLowerCase().endsWith(".pdf"));
    if (pdfFiles.length === 0) {
      setPipelinePhase("No new PDFs to parse.");
      return;
    }

    setParseTotal(pdfFiles.length);
    setParsedCount(0);
    setPipelinePhase(`Parsing ${pdfFiles.length} PDFs with AI...`);

    // Step 2: Parse each PDF
    const parsedFileIds: { id: string; course_id: string | null }[] = [];
    for (let i = 0; i < pdfFiles.length; i++) {
      setParseProgress(i + 1);
      try {
        await supabase.functions.invoke("parse-pdf", {
          body: { action: "parse", file_id: pdfFiles[i].id },
        });
        parsedFileIds.push({ id: pdfFiles[i].id, course_id: pdfFiles[i].course_id });
        setParsedCount(prev => prev + 1);
      } catch (err: any) {
        console.error(`Parse failed for ${pdfFiles[i].file_name}:`, err.message);
        // Continue with next file on error
      }
    }

    // Step 3: Auto-generate flashcards from parsed content
    if (parsedFileIds.length > 0) {
      setPipelinePhase("Generating flashcards from parsed content...");
      let fcCount = 0;

      // Get notes linked to parsed courses for flashcard generation
      const courseIds = [...new Set(parsedFileIds.map(f => f.course_id).filter(Boolean))];
      if (courseIds.length > 0) {
        const { data: notes } = await supabase
          .from("notes")
          .select("id, course_id")
          .eq("user_id", session.user.id)
          .in("course_id", courseIds as string[])
          .not("content", "is", null);

        // Check which notes don't have flashcards yet
        const { data: existingFcNotes } = await supabase
          .from("flashcards")
          .select("note_id")
          .eq("user_id", session.user.id);

        const existingNoteIds = new Set((existingFcNotes || []).map(f => f.note_id));
        const notesToGenerate = (notes || []).filter(n => !existingNoteIds.has(n.id)).slice(0, 10);

        for (const note of notesToGenerate) {
          try {
            const { data } = await supabase.functions.invoke("generate-anki-cards", {
              body: { action: "generate", note_id: note.id },
            });
            fcCount += data?.created || 0;
          } catch (err: any) {
            console.error(`Flashcard gen failed for note ${note.id}:`, err.message);
          }
        }
      }

      setFlashcardsGenerated(fcCount);
    }

    setPipelinePhase(`Pipeline done! ${parsedFileIds.length} PDFs parsed, ${flashcardsGenerated} flashcards.`);
    toast.success(`🚀 Auto-pipeline: ${parsedFileIds.length} PDFs parsed, flashcards generated!`);
  };

  if (!profileLoaded) {
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
      <div className="animate-fade-in max-w-2xl">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Moodle Sync</h1>
            <p className="mt-1 text-muted-foreground">
              {isVerified ? "Connected. Sync courses, deadlines, and files." : "Connect to ZHAW Moodle."}
            </p>
          </div>
          <Badge variant="outline" className={isVerified
            ? "gap-1.5 border-success/30 text-success"
            : "gap-1.5 border-destructive/30 text-destructive"
          }>
            {isVerified ? <><Wifi className="h-3 w-3" /> Connected</> : <><WifiOff className="h-3 w-3" /> Not Connected</>}
          </Badge>
        </div>

        {/* Sync card */}
        {isVerified && !showTokenInput && (
          <Card className="mt-8">
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-lg">Sync Moodle Data</CardTitle>
                  <CardDescription>
                    {lastSynced
                      ? `Last synced: ${new Date(lastSynced).toLocaleString("de-CH")}`
                      : "Never synced yet"}
                  </CardDescription>
                </div>
                <Button variant="ghost" size="sm" onClick={() => setShowTokenInput(true)} className="text-muted-foreground">
                  <Settings2 className="mr-1.5 h-4 w-4" /> Change Token
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-5">
              {/* Semester filter */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                    Semester-Filter
                  </Label>
                  <span className="text-xs text-muted-foreground">
                    {selectedSemester === "all" ? "Alle Kurse" : `Nur ${selectedSemester}`}
                  </span>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Badge
                    variant={selectedSemester === "all" ? "default" : "outline"}
                    className="cursor-pointer px-3 py-1 text-xs transition-colors"
                    onClick={() => setSelectedSemester("all")}
                  >
                    Alle Semester
                  </Badge>
                  {availableSemesters.map((sem) => (
                    <Badge
                      key={sem}
                      variant={selectedSemester === sem ? "default" : "outline"}
                      className="cursor-pointer px-3 py-1 text-xs transition-colors"
                      onClick={() => setSelectedSemester(sem)}
                    >
                      {sem.includes("FS") ? `Frühlingssemester ${sem.split("-")[0]} (${sem})` : sem.includes("HS") ? `Herbstsemester ${sem.split("-")[0]} (${sem})` : sem}
                    </Badge>
                  ))}
                </div>
              </div>

              <div className="space-y-2">
                <Button onClick={handleSync} disabled={syncing} className="w-full" size="lg">
                  {syncing ? (
                    <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> {syncPhase}</>
                  ) : (
                    <><RefreshCw className="mr-2 h-4 w-4" /> {selectedSemester === "all" ? "Alle Kurse synchronisieren" : `${selectedSemester} synchronisieren`}</>
                  )}
                </Button>
                <p className="text-center text-xs text-muted-foreground">
                  ⚡ Läuft serverseitig — du kannst die Seite nach dem Klick sofort verlassen.
                </p>
              </div>

              {/* Progress bar */}
              {syncing && syncTotal > 0 && (
                <div className="space-y-2">
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>{currentCourse}</span>
                    <span>{syncProgress}/{syncTotal}</span>
                  </div>
                  <Progress value={(syncProgress / syncTotal) * 100} />
                </div>
              )}

              {/* Results */}
              {syncResults.length > 0 && (
                <div className="space-y-1.5">
                  <div className="flex items-center gap-2 rounded-lg border border-success/30 bg-success/5 p-3 text-sm">
                    <Check className="h-4 w-4 text-success shrink-0" />
                    <span>
                      {syncResults.reduce((s, r) => s + r.files, 0)} new files,{" "}
                      {syncResults.reduce((s, r) => s + r.notes, 0)} new notes
                    </span>
                  </div>
                  <div className="max-h-48 overflow-auto space-y-1">
                    {syncResults.map((r, i) => (
                      <div key={i} className="flex justify-between text-xs text-muted-foreground px-1">
                        <span className="truncate">{r.course}</span>
                        <span className="shrink-0 ml-2">{r.files} files, {r.notes} notes</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {syncErrors.length > 0 && (
                <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                  <p className="font-medium">Errors:</p>
                  <ul className="mt-1 list-disc list-inside text-xs">
                    {syncErrors.map((e, i) => <li key={i}>{e}</li>)}
                  </ul>
                </div>
              )}

              {/* Auto-parse pipeline progress */}
              {pipelinePhase && (
                <div className="space-y-2 rounded-lg border border-primary/20 bg-primary/5 p-3">
                  <div className="flex items-center gap-2 text-sm">
                    <Loader2 className="h-4 w-4 animate-spin text-primary" />
                    <span className="font-medium text-primary">{pipelinePhase}</span>
                  </div>
                  {parseTotal > 0 && (
                    <div className="space-y-1">
                      <div className="flex justify-between text-xs text-muted-foreground">
                        <span>Parsing PDF {parseProgress}/{parseTotal}</span>
                        <span>{parsedCount} done</span>
                      </div>
                      <Progress value={(parseProgress / parseTotal) * 100} />
                    </div>
                  )}
                  {flashcardsGenerated > 0 && (
                    <p className="text-xs text-muted-foreground">✨ {flashcardsGenerated} flashcards generated</p>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* Token input */}
        {(showTokenInput || !isVerified) && (
          <Card className="mt-8">
            <CardHeader>
              <CardTitle className="text-lg">{isVerified ? "Update Connection" : "Connect to Moodle"}</CardTitle>
              <CardDescription>
                Enter your Moodle Web Services token from{" "}
                <span className="font-mono text-xs">Preferences → Security Keys</span>
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="moodle-url">Moodle URL</Label>
                <Input id="moodle-url" value={moodleUrl} onChange={(e) => setMoodleUrl(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="moodle-token">API Token</Label>
                <Input id="moodle-token" type="password" value={moodleToken}
                  onChange={(e) => setMoodleToken(e.target.value)} placeholder="Paste your Moodle token" />
              </div>
              <div className="flex gap-2">
                <Button onClick={handleVerifyAndSave} disabled={verifying || !moodleToken.trim()}>
                  {verifying ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Verifying...</> : "Verify & Save"}
                </Button>
                {isVerified && showTokenInput && (
                  <Button variant="ghost" onClick={() => setShowTokenInput(false)}>Cancel</Button>
                )}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Help */}
        <Card className="mt-4">
          <CardContent className="flex items-start gap-3 p-4">
            <AlertCircle className="h-5 w-5 text-muted-foreground mt-0.5 shrink-0" />
            <div className="text-sm text-muted-foreground">
              <p className="font-medium text-foreground">How to get your Moodle token:</p>
              <ol className="mt-2 space-y-1 list-decimal list-inside">
                <li>Log in to moodle.zhaw.ch</li>
                <li>Go to Preferences → Security Keys</li>
                <li>Generate a token for "Moodle mobile web service"</li>
                <li>Copy and paste it above</li>
              </ol>
            </div>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
