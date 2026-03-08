import { useEffect, useState } from "react";
import { DashboardLayout } from "@/components/DashboardLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Clock } from "lucide-react";
import { format, isPast, isToday, addDays, isBefore } from "date-fns";
import { cn } from "@/lib/utils";
import { cleanCourseName } from "@/lib/semester";

type UrgencyGroup = "overdue" | "today" | "this_week" | "later" | "completed";

const urgencyConfig: Record<UrgencyGroup, { label: string; badgeClass: string }> = {
  overdue: { label: "Überfällig", badgeClass: "bg-destructive/10 text-destructive border-destructive/20" },
  today: { label: "Heute", badgeClass: "bg-warning/10 text-warning border-warning/20" },
  this_week: { label: "Diese Woche", badgeClass: "bg-primary/10 text-primary border-primary/20" },
  later: { label: "Später", badgeClass: "bg-muted text-muted-foreground border-border" },
  completed: { label: "Erledigt", badgeClass: "bg-success/10 text-success border-success/20" },
};

function getUrgency(dueDate: string, isCompleted: boolean): UrgencyGroup {
  if (isCompleted) return "completed";
  const due = new Date(dueDate);
  const now = new Date();
  if (isPast(due) && !isToday(due)) return "overdue";
  if (isToday(due)) return "today";
  if (isBefore(due, addDays(now, 7))) return "this_week";
  return "later";
}

export default function Deadlines() {
  const { user } = useAuth();
  const [deadlines, setDeadlines] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchDeadlines = async () => {
    if (!user) return;
    const { data } = await supabase
      .from("deadlines")
      .select("*, courses(name, short_name)")
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

  // Group by urgency
  const groups: Record<UrgencyGroup, any[]> = { overdue: [], today: [], this_week: [], later: [], completed: [] };
  for (const d of deadlines) {
    const urgency = getUrgency(d.due_date, d.is_completed);
    groups[urgency].push(d);
  }

  const displayOrder: UrgencyGroup[] = ["overdue", "today", "this_week", "later", "completed"];

  return (
    <DashboardLayout>
      <div className="animate-fade-in">
        <h1 className="text-3xl font-bold tracking-tight">Deadlines</h1>
        <p className="mt-1 text-muted-foreground">{deadlines.filter(d => !d.is_completed).length} open deadlines.</p>

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
              <p className="mt-1 text-sm text-muted-foreground">Sync from Moodle to import deadlines.</p>
            </CardContent>
          </Card>
        ) : (
          <div className="mt-8 space-y-6">
            {displayOrder.map((urgency) => {
              const items = groups[urgency];
              if (items.length === 0) return null;
              const config = urgencyConfig[urgency];

              return (
                <div key={urgency}>
                  <div className="flex items-center gap-2 mb-3">
                    <Badge variant="outline" className={config.badgeClass}>
                      {config.label}
                    </Badge>
                    <span className="text-xs text-muted-foreground">{items.length}</span>
                  </div>
                  <div className="space-y-2">
                    {items.map((d) => (
                      <div
                        key={d.id}
                        className={cn(
                          "flex items-center gap-4 rounded-lg border p-4 transition-colors",
                          urgency === "overdue" && "border-destructive/30 bg-destructive/5",
                          urgency === "today" && "border-warning/30 bg-warning/5",
                          urgency === "completed" && "opacity-60"
                        )}
                      >
                        <Checkbox
                          checked={d.is_completed}
                          onCheckedChange={() => toggleComplete(d.id, d.is_completed)}
                        />
                        <div className="flex-1 min-w-0">
                          <p className={cn("font-medium text-sm", d.is_completed && "line-through")}>
                            {d.title}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {d.courses ? cleanCourseName(d.courses.name, d.courses.short_name) : "Kein Kurs"}
                          </p>
                        </div>
                        <span className={cn(
                          "text-xs font-mono whitespace-nowrap",
                          urgency === "overdue" ? "text-destructive font-semibold" :
                          urgency === "today" ? "text-warning font-semibold" :
                          "text-muted-foreground"
                        )}>
                          {format(new Date(d.due_date), "dd. MMM, HH:mm")}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </DashboardLayout>
  );
}
