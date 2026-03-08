import { useState } from "react";
import { DashboardLayout } from "@/components/DashboardLayout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { RefreshCw, Check, AlertCircle, Loader2 } from "lucide-react";
import { toast } from "sonner";

export default function MoodleSync() {
  const { session } = useAuth();
  const [moodleToken, setMoodleToken] = useState("");
  const [moodleUrl, setMoodleUrl] = useState("https://moodle.zhaw.ch");
  const [isVerified, setIsVerified] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [syncResult, setSyncResult] = useState<{ synced_courses: number; synced_files?: number } | null>(null);

  const callMoodleSync = async (action: string, extra: Record<string, unknown> = {}) => {
    const { data, error } = await supabase.functions.invoke("moodle-sync", {
      body: { action, moodle_token: moodleToken, moodle_base_url: moodleUrl, ...extra },
    });
    if (error) throw error;
    return data;
  };

  const handleVerify = async () => {
    if (!moodleToken.trim()) {
      toast.error("Please enter your Moodle token");
      return;
    }
    setVerifying(true);
    try {
      const info = await callMoodleSync("verify");
      toast.success(`Connected as ${info.fullname} (${info.sitename})`);
      setIsVerified(true);
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
      toast.success(`Synced ${result.synced_courses} courses, ${result.synced_files || 0} files!`);
    } catch (error: any) {
      toast.error(`Sync failed: ${error.message}`);
    } finally {
      setSyncing(false);
    }
  };

  return (
    <DashboardLayout>
      <div className="animate-fade-in max-w-2xl">
        <h1 className="text-3xl font-bold tracking-tight">Moodle Sync</h1>
        <p className="mt-1 text-muted-foreground">Connect to ZHAW Moodle and import your courses, deadlines, and Lernziele.</p>

        {/* Step 1: Token */}
        <Card className="mt-8">
          <CardHeader>
            <CardTitle className="text-lg">1. Connect to Moodle</CardTitle>
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
                onChange={(e) => { setMoodleToken(e.target.value); setIsVerified(false); }}
                placeholder="Paste your Moodle token here"
              />
            </div>
            <Button onClick={handleVerify} disabled={verifying || !moodleToken.trim()}>
              {verifying ? (
                <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Verifying...</>
              ) : isVerified ? (
                <><Check className="mr-2 h-4 w-4" /> Verified</>
              ) : (
                "Verify Connection"
              )}
            </Button>
          </CardContent>
        </Card>

        {/* Step 2: Sync */}
        <Card className="mt-4">
          <CardHeader>
            <CardTitle className="text-lg">2. Sync Everything</CardTitle>
            <CardDescription>
              Pull all courses, assignments, deadlines, and Lernziele from Moodle.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={handleSync} disabled={!isVerified || syncing} className="w-full">
              {syncing ? (
                <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Syncing...</>
              ) : (
                <><RefreshCw className="mr-2 h-4 w-4" /> Sync Now</>
              )}
            </Button>

            {syncResult && (
              <div className="mt-4 flex items-center gap-2 rounded-lg border border-success/30 bg-success/5 p-3 text-sm">
                <Check className="h-4 w-4 text-success" />
                <span>Synced {syncResult.synced_courses} courses. Check your Dashboard, Courses, Deadlines, and Notes pages.</span>
              </div>
            )}
          </CardContent>
        </Card>

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
