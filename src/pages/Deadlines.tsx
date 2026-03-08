import { useEffect, useState } from "react";
import { DashboardLayout } from "@/components/DashboardLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Clock } from "lucide-react";
import { format, isPast } from "date-fns";
import { cn } from "@/lib/utils";

export default function Deadlines() {
  const { user } = useAuth();
  const [deadlines, setDeadlines] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchDeadlines = async () => {
    if (!user) return;
    const { data } = await supabase
      .from("deadlines")
      .select("*, courses(name)")
      .eq("user_id", user.id)
      .order("due_date", { ascending: true });
    setDeadlines(data || []);
    setLoading(false);
  };

  useEffect(() => { fetchDeadlines(); }, [user]);

  const toggleComplete = async (id: string, current: boolean) => {
    await supabase.from("deadlines").update({ is_completed: !current }).eq("id", id);
    setDeadlines((prev) =>
      prev.map((d) => (d.id === id ? { ...d, is_completed: !current } : d))
    );
  };

  const openDeadlines = deadlines.filter((d) => !d.is_completed);
  const completedDeadlines = deadlines.filter((d) => d.is_completed);

  return (
    <DashboardLayout>
      <div className="animate-fade-in">
        <h1 className="text-3xl font-bold tracking-tight">Deadlines</h1>
        <p className="mt-1 text-muted-foreground">Track your assignments and due dates.</p>

        {loading ? (
          <div className="mt-8 space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-16 rounded-lg bg-muted animate-pulse" />
            ))}
          </div>
        ) : deadlines.length === 0 ? (
          <Card className="mt-8">
            <CardContent className="flex flex-col items-center justify-center py-12 text-center">
              <Clock className="h-12 w-12 text-muted-foreground/40" />
              <h3 className="mt-4 font-semibold">No deadlines yet</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Sync from Moodle to import your assignment deadlines.
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="mt-8 space-y-6">
            {openDeadlines.length > 0 && (
              <div>
                <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">Open</h2>
                <div className="space-y-2">
                  {openDeadlines.map((d) => (
                    <div
                      key={d.id}
                      className={cn(
                        "flex items-center gap-4 rounded-lg border p-4 transition-colors",
                        isPast(new Date(d.due_date)) && "border-destructive/30 bg-destructive/5"
                      )}
                    >
                      <Checkbox
                        checked={false}
                        onCheckedChange={() => toggleComplete(d.id, false)}
                      />
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-sm">{d.title}</p>
                        <p className="text-xs text-muted-foreground">{d.courses?.name || "No course"}</p>
                      </div>
                      <span className={cn(
                        "text-xs font-mono whitespace-nowrap",
                        isPast(new Date(d.due_date)) ? "text-destructive font-semibold" : "text-muted-foreground"
                      )}>
                        {format(new Date(d.due_date), "MMM d, HH:mm")}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {completedDeadlines.length > 0 && (
              <div>
                <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">Completed</h2>
                <div className="space-y-2">
                  {completedDeadlines.map((d) => (
                    <div key={d.id} className="flex items-center gap-4 rounded-lg border p-4 opacity-60">
                      <Checkbox
                        checked={true}
                        onCheckedChange={() => toggleComplete(d.id, true)}
                      />
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-sm line-through">{d.title}</p>
                        <p className="text-xs text-muted-foreground">{d.courses?.name || "No course"}</p>
                      </div>
                      <span className="text-xs font-mono text-muted-foreground">
                        {format(new Date(d.due_date), "MMM d, HH:mm")}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
