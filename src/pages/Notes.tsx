import { useEffect, useState } from "react";
import { DashboardLayout } from "@/components/DashboardLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { FileText } from "lucide-react";

const typeColors: Record<string, string> = {
  lernziel: "bg-accent text-accent-foreground",
  prep: "bg-warning text-warning-foreground",
  general: "bg-secondary text-secondary-foreground",
  summary: "bg-primary text-primary-foreground",
};

export default function Notes() {
  const { user } = useAuth();
  const [notes, setNotes] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;
    supabase
      .from("notes")
      .select("*, courses(name)")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .then(({ data }) => {
        setNotes(data || []);
        setLoading(false);
      });
  }, [user]);

  return (
    <DashboardLayout>
      <div className="animate-fade-in">
        <h1 className="text-3xl font-bold tracking-tight">Notes</h1>
        <p className="mt-1 text-muted-foreground">Lernziele, prep instructions, and study notes.</p>

        {loading ? (
          <div className="mt-8 grid gap-4 sm:grid-cols-2">
            {[1, 2, 3, 4].map((i) => (
              <Card key={i} className="animate-pulse">
                <CardContent className="p-6">
                  <div className="h-4 w-1/2 rounded bg-muted mb-2" />
                  <div className="h-3 w-full rounded bg-muted mb-1" />
                  <div className="h-3 w-3/4 rounded bg-muted" />
                </CardContent>
              </Card>
            ))}
          </div>
        ) : notes.length === 0 ? (
          <Card className="mt-8">
            <CardContent className="flex flex-col items-center justify-center py-12 text-center">
              <FileText className="h-12 w-12 text-muted-foreground/40" />
              <h3 className="mt-4 font-semibold">No notes yet</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Sync from Moodle to auto-import Lernziele and section content.
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="mt-8 grid gap-4 sm:grid-cols-2">
            {notes.map((note) => (
              <Card key={note.id} className="hover:shadow-md transition-shadow">
                <CardContent className="p-6">
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="font-semibold text-sm">{note.title}</h3>
                    <Badge className={typeColors[note.note_type || "general"] || typeColors.general} variant="secondary">
                      {note.note_type || "general"}
                    </Badge>
                  </div>
                  {note.courses?.name && (
                    <p className="text-xs text-muted-foreground mt-1">{note.courses.name}</p>
                  )}
                  {note.content && (
                    <p className="text-sm text-muted-foreground mt-3 line-clamp-4">{note.content}</p>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
