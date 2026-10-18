import { useEffect, useState, useCallback } from "react";
import { DashboardLayout } from "@/components/DashboardLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import {
  FileText, Download, Brain, Loader2, CheckCircle, AlertCircle,
  Clock, Filter, ExternalLink,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

interface FileRecord {
  id: string;
  file_name: string;
  file_type: string | null;
  file_size: number | null;
  file_url: string | null;
  course_id: string | null;
  extraction_status: string | null;
  extracted_content: any;
  extracted_at: string | null;
  courses?: { name: string; short_name: string | null } | null;
}

export default function Files() {
  const { user } = useAuth();
  const [files, setFiles] = useState<FileRecord[]>([]);
  const [courses, setCourses] = useState<{ id: string; name: string; short_name: string | null }[]>([]);
  const [selectedCourse, setSelectedCourse] = useState<string>("all");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [loading, setLoading] = useState(true);
  const [parsing, setParsing] = useState<Set<string>>(new Set());
  const [expandedFile, setExpandedFile] = useState<string | null>(null);

  const fetchFiles = useCallback(async () => {
    if (!user) return;
    setLoading(true);

    const [coursesRes, filesRes] = await Promise.all([
      supabase.from("courses").select("id, name, short_name").eq("user_id", user.id),
      supabase.from("files").select("*, courses(name, short_name)").eq("user_id", user.id).order("file_name"),
    ]);

    setCourses(coursesRes.data || []);
    setFiles((filesRes.data as FileRecord[]) || []);
    setLoading(false);
  }, [user]);

  useEffect(() => { fetchFiles(); }, [fetchFiles]);

  const handleParse = async (fileId: string) => {
    if (!user) return;
    setParsing(prev => new Set(prev).add(fileId));
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
      if (!res.ok) throw new Error(data.error || "Parse fehlgeschlagen");
      toast.success(
        `Analysiert: ${data.norms_count || 0} Normen, ${data.concepts_count || 0} Konzepte, ${
          data.deadlines_count || 0
        } Termine extrahiert!`
      );
      setExpandedFile(fileId);
      await fetchFiles();
    } catch (err: any) {
      toast.error(`Parse fehlgeschlagen: ${err.message}`);
    } finally {
      setParsing(prev => { const n = new Set(prev); n.delete(fileId); return n; });
    }
  };

  const filteredFiles = files.filter(f => {
    if (selectedCourse !== "all" && f.course_id !== selectedCourse) return false;
    if (typeFilter === "pdf" && !f.file_name.toLowerCase().endsWith(".pdf")) return false;
    if (typeFilter === "pptx" && !f.file_name.toLowerCase().match(/\.pptx?$/)) return false;
    if (typeFilter === "parsed" && f.extraction_status !== "done") return false;
    if (typeFilter === "unparsed" && f.extraction_status === "done") return false;
    return true;
  });

  const formatSize = (bytes: number | null) => {
    if (!bytes) return "—";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const isParseable = (name: string) => {
    const lower = name.toLowerCase();
    return lower.endsWith(".pdf") || lower.endsWith(".pptx") || lower.endsWith(".docx");
  };

  const statusIcon = (status: string | null) => {
    switch (status) {
      case "done": return <CheckCircle className="h-4 w-4 text-success" />;
      case "processing": return <Loader2 className="h-4 w-4 animate-spin text-primary" />;
      case "error": return <AlertCircle className="h-4 w-4 text-destructive" />;
      default: return <Clock className="h-4 w-4 text-muted-foreground" />;
    }
  };

  return (
    <DashboardLayout>
      <div className="animate-fade-in">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Files</h1>
            <p className="mt-1 text-muted-foreground">
              {files.length} Dateien synced · {files.filter(f => f.extraction_status === "done").length} geparst
            </p>
          </div>
        </div>

        {/* Filters */}
        <div className="mt-6 flex gap-3">
          <Select value={selectedCourse} onValueChange={setSelectedCourse}>
            <SelectTrigger className="w-[200px]">
              <SelectValue placeholder="Alle Kurse" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Alle Kurse</SelectItem>
              {courses.map(c => (
                <SelectItem key={c.id} value={c.id}>
                  {c.short_name || c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={typeFilter} onValueChange={setTypeFilter}>
            <SelectTrigger className="w-[160px]">
              <SelectValue placeholder="Alle Typen" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Alle Typen</SelectItem>
              <SelectItem value="pdf">PDF</SelectItem>
              <SelectItem value="pptx">PowerPoint</SelectItem>
              <SelectItem value="parsed">✅ Geparst</SelectItem>
              <SelectItem value="unparsed">⏳ Noch nicht geparst</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* File List */}
        <div className="mt-4 space-y-2">
          {loading ? (
            <div className="flex justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : filteredFiles.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center text-muted-foreground">
                <FileText className="h-12 w-12 mx-auto mb-3 opacity-30" />
                <p>Keine Dateien gefunden. Starte einen Moodle Sync.</p>
              </CardContent>
            </Card>
          ) : (
            filteredFiles.map(file => (
              <Card key={file.id} className="overflow-hidden">
                <div
                  className="flex items-center gap-3 p-4 cursor-pointer hover:bg-muted/30 transition-colors"
                  onClick={() => setExpandedFile(expandedFile === file.id ? null : file.id)}
                >
                  {statusIcon(file.extraction_status)}
                  <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{file.file_name}</p>
                    <p className="text-xs text-muted-foreground">
                      {file.courses?.short_name || file.courses?.name || "Kein Kurs"} · {formatSize(file.file_size)}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {isParseable(file.file_name) && file.extraction_status !== "done" && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={(e) => { e.stopPropagation(); handleParse(file.id); }}
                        disabled={parsing.has(file.id)}
                      >
                        {parsing.has(file.id) ? (
                          <Loader2 className="h-3 w-3 animate-spin mr-1" />
                        ) : (
                          <Brain className="h-3 w-3 mr-1" />
                        )}
                        Parse
                      </Button>
                    )}
                    {file.file_url && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={(e) => { e.stopPropagation(); window.open(file.file_url!, "_blank"); }}
                      >
                        <ExternalLink className="h-3 w-3" />
                      </Button>
                    )}
                  </div>
                </div>

                {/* Expanded: show extracted content */}
                {expandedFile === file.id && file.extracted_content && (
                  <div className="border-t bg-muted/20 p-4 space-y-4">
                    {file.extracted_content.summary && (
                      <div>
                        <p className="text-xs font-semibold text-muted-foreground uppercase mb-1">Zusammenfassung</p>
                        <p className="text-sm">{file.extracted_content.summary}</p>
                      </div>
                    )}

                    {file.extracted_content.norms?.length > 0 && (
                      <div>
                        <p className="text-xs font-semibold text-muted-foreground uppercase mb-2">
                          Rechtsnormen ({file.extracted_content.norms.length})
                        </p>
                        <div className="space-y-2">
                          {file.extracted_content.norms.map((norm: any, i: number) => (
                            <div key={i} className="rounded-lg border bg-card p-3">
                              <div className="flex items-center justify-between">
                                <span className="font-mono text-sm font-semibold">{norm.article}</span>
                                <Badge variant="outline" className="text-xs">
                                  Wichtigkeit: {norm.importance}/5
                                </Badge>
                              </div>
                              {norm.tbm?.length > 0 && (
                                <div className="mt-2">
                                  <span className="text-xs text-muted-foreground">TBM: </span>
                                  <div className="flex flex-wrap gap-1 mt-1">
                                    {norm.tbm.map((t: string, j: number) => (
                                      <Badge key={j} variant="secondary" className="text-xs">{t}</Badge>
                                    ))}
                                  </div>
                                </div>
                              )}
                              {norm.rechtsfolge && (
                                <p className="mt-1 text-xs text-muted-foreground">
                                  <strong>Rechtsfolge:</strong> {norm.rechtsfolge}
                                </p>
                              )}
                              {norm.definitionen?.length > 0 && (
                                <div className="mt-2 space-y-1">
                                  {norm.definitionen.map((d: any, k: number) => (
                                    <p key={k} className="text-xs">
                                      <strong>{d.term}:</strong> {d.definition}
                                    </p>
                                  ))}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {file.extracted_content.key_concepts?.length > 0 && (
                      <div>
                        <p className="text-xs font-semibold text-muted-foreground uppercase mb-2">
                          Konzepte ({file.extracted_content.key_concepts.length})
                        </p>
                        <div className="space-y-1">
                          {file.extracted_content.key_concepts.map((c: any, i: number) => (
                            <div key={i} className="text-sm">
                              <strong>{c.concept}:</strong> {c.explanation}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {file.extracted_content.cases?.length > 0 && (
                      <div>
                        <p className="text-xs font-semibold text-muted-foreground uppercase mb-2">
                          Gerichtsentscheide ({file.extracted_content.cases.length})
                        </p>
                        <div className="space-y-1">
                          {file.extracted_content.cases.map((c: any, i: number) => (
                            <div key={i} className="text-sm">
                              <strong>{c.reference}:</strong> {c.summary}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </Card>
            ))
          )}
        </div>
      </div>
    </DashboardLayout>
  );
}
