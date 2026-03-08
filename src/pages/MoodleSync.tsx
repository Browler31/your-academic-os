import { useState, useEffect } from "react";
import { DashboardLayout } from "@/components/DashboardLayout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { RefreshCw, Check, AlertCircle, Loader2, Settings2, Wifi, WifiOff } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";

export default function MoodleSync() {
  const { session } = useAuth();
  const [moodleToken, setMoodleToken] = useState("");
  const [moodleUrl, setMoodleUrl] = useState("https://moodle.zhaw.ch");
  const [isVerified, setIsVerified] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showTokenInput, setShowTokenInput] = useState(false);
  const [lastSynced, setLastSynced] = useState<string | null>(null);
  const [syncResult, setSyncResult] = useState<{ synced_courses: number; synced_files?: number; errors?: string[] } | null>(null);
  const [profileLoaded, setProfileLoaded] = useState(false);

  // Load saved token from profile on mount
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

  // Also load last sync time from courses
  useEffect(() => {
    if (!session?.user?.id) return;
    (async () => {
      const { data } = await supabase
        .from("courses")
        .select("last_synced_at")
        .eq("user_id", session.user.id)
        .order("last_synced_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (data?.last_synced_at) {
        setLastSynced(data.last_synced_at);
      }
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
    await supabase
      .from("profiles")
      .update({
        moodle_token: moodleToken,
        moodle_base_url: moodleUrl,
        moodle_verified_at: new Date().toISOString(),
      })
      .eq("user_id", session.user.id);
  };

  const handleVerifyAndSave = async () => {
    if (!moodleToken.trim()) {
      toast.error("Please enter your Moodle token");
      return;
    }
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
    setSyncResult(null);
    try {
      const result = await callMoodleSync("sync_all");
      setSyncResult(result);
      setLastSynced(new Date().toISOString());
      toast.success(`Synced ${result.synced_courses} courses, ${result.synced_files || 0} files!`);
    } catch (error: any) {
      toast.error(`Sync failed: ${error.message}`);
    } finally {
      setSyncing(false);
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
              {isVerified
                ? "Connected to Moodle. Sync your courses, deadlines, and files."
                : "Connect to ZHAW Moodle to import your study materials."}
            </p>
          </div>
          {isVerified && (
            <Badge variant="outline" className="gap-1.5 border-success/30 text-success">
              <Wifi className="h-3 w-3" /> Connected
            </Badge>
          )}
          {!isVerified && profileLoaded && (
            <Badge variant="outline" className="gap-1.5 border-destructive/30 text-destructive">
              <WifiOff className="h-3 w-3" /> Not Connected
            </Badge>
          )}
        </div>

        {/* Connected state — main actions */}
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
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowTokenInput(true)}
                  className="text-muted-foreground"
                >
                  <Settings2 className="mr-1.5 h-4 w-4" /> Change Token
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <Button onClick={handleSync} disabled={syncing} className="w-full">
                {syncing ? (
                  <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Syncing...</>
                ) : (
                  <><RefreshCw className="mr-2 h-4 w-4" /> Sync Now</>
                )}
              </Button>

              {syncResult && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 rounded-lg border border-success/30 bg-success/5 p-3 text-sm">
                    <Check className="h-4 w-4 text-success shrink-0" />
                    <span>Synced {syncResult.synced_courses} courses, {syncResult.synced_files || 0} files.</span>
                  </div>
                  {syncResult.errors && syncResult.errors.length > 0 && (
                    <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                      <p className="font-medium">Some courses had errors:</p>
                      <ul className="mt-1 list-disc list-inside">
                        {syncResult.errors.map((e, i) => <li key={i}>{e}</li>)}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* Token input — shown initially or when editing */}
        {(showTokenInput || !isVerified) && (
          <Card className="mt-8">
            <CardHeader>
              <CardTitle className="text-lg">
                {isVerified ? "Update Moodle Connection" : "Connect to Moodle"}
              </CardTitle>
              <CardDescription>
                Enter your Moodle Web Services token. Generate it at{" "}
                <span className="font-mono text-xs">Moodle → Preferences → Security Keys</span>
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="moodle-url">Moodle URL</Label>
                <Input
                  id="moodle-url"
                  value={moodleUrl}
                  onChange={(e) => setMoodleUrl(e.target.value)}
                  placeholder="https://moodle.zhaw.ch"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="moodle-token">API Token</Label>
                <Input
                  id="moodle-token"
                  type="password"
                  value={moodleToken}
                  onChange={(e) => setMoodleToken(e.target.value)}
                  placeholder="Paste your Moodle token here"
                />
              </div>
              <div className="flex gap-2">
                <Button onClick={handleVerifyAndSave} disabled={verifying || !moodleToken.trim()}>
                  {verifying ? (
                    <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Verifying...</>
                  ) : (
                    "Verify & Save"
                  )}
                </Button>
                {isVerified && showTokenInput && (
                  <Button variant="ghost" onClick={() => setShowTokenInput(false)}>
                    Cancel
                  </Button>
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
                <li>Go to Preferences → Security Keys (or User menu → Preferences)</li>
                <li>Look for "Manage Tokens" or generate a new token for "Moodle mobile web service"</li>
                <li>Copy the token and paste it above</li>
              </ol>
            </div>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
