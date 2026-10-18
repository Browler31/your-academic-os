import { useState, useEffect } from "react";
import { DashboardLayout } from "@/components/DashboardLayout";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Check, KeyRound, School, Sparkles } from "lucide-react";
import { toast } from "sonner";

export default function SettingsPage() {
  const [moodleToken, setMoodleToken] = useState("");
  const [geminiKey, setGeminiKey] = useState("");

  useEffect(() => {
    setMoodleToken(localStorage.getItem("study_os_moodle_token") || "");
    setGeminiKey(localStorage.getItem("study_os_gemini_key") || "");
  }, []);

  const handleSave = () => {
    if (moodleToken.trim()) {
      localStorage.setItem("study_os_moodle_token", moodleToken.trim());
    }
    if (geminiKey.trim()) {
      localStorage.setItem("study_os_gemini_key", geminiKey.trim());
    } else {
      localStorage.removeItem("study_os_gemini_key");
    }
    toast.success("Einstellungen gespeichert!");
  };

  return (
    <DashboardLayout>
      <div className="animate-fade-in max-w-2xl space-y-6">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Einstellungen</h1>
          <p className="mt-1 text-muted-foreground">
            Verwalte deine ZHAW Moodle-Verbindung und optionale AI-Schlüssel.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <School className="h-5 w-5 text-primary" />
              ZHAW Moodle & AI Konfiguration
            </CardTitle>
            <CardDescription>
              Dein Fristen-Scanner und Normen-Extraktor funktioniert standardmässig ohne externen
              API-Key. Optional kannst du einen kostenlosen Google Gemini API Key hinterlegen, um
              komplexe PDF-Folien zusätzlich mit Gemini 2.5 Flash zu analysieren.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="moodle-token">ZHAW Moodle Security Token (Mobile Web Service)</Label>
              <Input
                id="moodle-token"
                type="password"
                placeholder="Dein Moodle Token..."
                value={moodleToken}
                onChange={(e) => setMoodleToken(e.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="gemini-key" className="flex items-center gap-1.5">
                <Sparkles className="h-3.5 w-3.5 text-primary" />
                Google Gemini API Key (optional für Deep-PDF-Analyse)
              </Label>
              <Input
                id="gemini-key"
                type="password"
                placeholder="AIzaSy... (optional)"
                value={geminiKey}
                onChange={(e) => setGeminiKey(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Wird lokal in deinem Browser gespeichert und für PDF-Tiefenanalysen verwendet.
              </p>
            </div>

            <Button onClick={handleSave} className="gap-2">
              <Check className="h-4 w-4" /> Einstellungen speichern
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <KeyRound className="h-5 w-5 text-muted-foreground" />
              System-Status
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground space-y-1">
            <p>
              <strong>Modus:</strong> Zero-Login Single-User (Marc — ZHAW SML Wirtschaftsrecht)
            </p>
            <p>
              <strong>Background Sync:</strong> Aktiv (Vercel Serverless)
            </p>
            <p>
              <strong>Fristen-Scanner:</strong> Aktiv (Moodle Aufgaben + Quizzes + Kalender +
              Abschnitts-Texte + PDF-Syllabi + E-Mail/Text-Import)
            </p>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
