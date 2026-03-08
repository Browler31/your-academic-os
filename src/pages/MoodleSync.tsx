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

  useEffect(() => {
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
      } else {
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
    const { data, error } = await supabase.functions.invoke("moodle-sync", {
      body: { action, moodle_token: moodleToken, moodle_base_url: moodleUrl, ...extra },
    });
    if (error) throw error;
    return data;
  };

  const saveTokenToProfile = async () => {
    if (!session?.user?.id) return;
    await supabase.from("profiles").update({
      moodle_token: moodleToken,
      moodle_base_url: moodleUrl,
      moodle_verified_at: new Date().toISOString(),
    }).eq("user_id", session.user.id);
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

  const handleSync = async () => {
    setSyncing(true);
    setSyncResults([]);
    setSyncErrors([]);
    setSyncProgress(0);

    try {
      // Phase 1: Sync course list + deadlines
      setSyncPhase("Syncing courses & deadlines...");
      const phase1 = await callMoodleSync("sync_all");
      const coursesToSync: CourseToSync[] = phase1.courses_to_sync || [];
      setSyncTotal(coursesToSync.length);

      // Phase 2: Sync each course's files individually
      setSyncPhase("Syncing files & notes...");
      const results: typeof syncResults = [];
      const errors: string[] = [];

      for (let i = 0; i < coursesToSync.length; i++) {
        const course = coursesToSync[i];
        setCurrentCourse(course.short_name || course.name);
        setSyncProgress(i + 1);

        try {
          const res = await callMoodleSync("sync_course", {
            moodle_course_id: course.moodle_course_id,
            course_db_id: course.id,
          });
          if (res.files > 0 || res.notes > 0) {
            results.push({
              course: course.short_name || course.name,
              files: res.files,
              notes: res.notes,
            });
          }
        } catch (err: any) {
          errors.push(`${course.short_name || course.name}: ${err.message}`);
        }
      }

      setSyncResults(results);
      setSyncErrors(errors);
      setLastSynced(new Date().toISOString());

      const totalFiles = results.reduce((s, r) => s + r.files, 0);
      const totalNotes = results.reduce((s, r) => s + r.notes, 0);
      toast.success(`Done! ${totalFiles} files, ${totalNotes} notes from ${coursesToSync.length} courses`);
    } catch (error: any) {
      toast.error(`Sync failed: ${error.message}`);
    } finally {
      setSyncing(false);
      setSyncPhase("");
      setCurrentCourse("");
    }
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
            <CardContent className="space-y-4">
              <Button onClick={handleSync} disabled={syncing} className="w-full">
                {syncing ? (
                  <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> {syncPhase}</>
                ) : (
                  <><RefreshCw className="mr-2 h-4 w-4" /> Sync Now</>
                )}
              </Button>

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
