import { useEffect, useState, useCallback } from "react";
import { DashboardLayout } from "@/components/DashboardLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { ListTodo, Zap, Check, BookOpen, PenTool, GraduationCap, Dumbbell, Brain } from "lucide-react";
import { format, isPast } from "date-fns";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

const typeIcons: Record<string, typeof BookOpen> = {
  prep_reading: BookOpen,
  lecture_review: PenTool,
  exercises: Dumbbell,
  exam_prep: GraduationCap,
  meta_skills: Brain,
  moodle_material: ListTodo,
  custom: ListTodo,
};

const typeColors: Record<string, string> = {
  prep_reading: "bg-primary/10 text-primary border-primary/20",
  lecture_review: "bg-accent/10 text-accent border-accent/20",
  exercises: "bg-warning/10 text-warning border-warning/20",
  exam_prep: "bg-destructive/10 text-destructive border-destructive/20",
  meta_skills: "bg-secondary text-secondary-foreground border-border",
  moodle_material: "bg-muted text-muted-foreground border-border",
  custom: "bg-muted text-muted-foreground border-border",
};

interface OneThing {
  task: any;
  priority_level: number;
  reason: string;
}

type TaskStatus = "pending" | "in_progress" | "done" | "skipped";

export default function Tasks() {
  const { user } = useAuth();
  const [tasks, setTasks] = useState<any[]>([]);
  const [oneThing, setOneThing] = useState<OneThing | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<TaskStatus>("pending");

  const fetchTasks = useCallback(async () => {
    if (!user) return;
    const { data } = await supabase
      .from("tasks")
      .select("*, courses(name)")
      .eq("user_id", user.id)
      .eq("status", tab)
      .order("due_date", { ascending: true, nullsFirst: false })
      .limit(50);
    setTasks(data || []);
    setLoading(false);
  }, [user, tab]);

  const fetchOneThing = useCallback(async () => {
    if (!user) return;
    const { data, error } = await supabase.functions.invoke("study-tasks", {
      body: { action: "one_thing" },
    });
    if (!error && data) {
      setOneThing(data);
    }
  }, [user]);

  useEffect(() => {
    fetchTasks();
    fetchOneThing();
  }, [fetchTasks, fetchOneThing]);

  const completeTask = async (taskId: string) => {
    await supabase
      .from("tasks")
      .update({ status: "done", completed_at: new Date().toISOString() })
      .eq("id", taskId);
    toast.success("Task completed!");
    fetchTasks();
    fetchOneThing();
  };

  const priorityLabels = [
    "",
    "🔴 Due/Overdue",
    "📖 Prep this week",
    "🆕 New material",
    "📝 Exam approaching",
    "📋 Next step",
  ];

  return (
    <DashboardLayout>
      <div className="animate-fade-in">
        <h1 className="text-3xl font-bold tracking-tight">Tasks</h1>
        <p className="mt-1 text-muted-foreground">Your priority-ordered study tasks.</p>

        {/* One Thing card */}
        {oneThing?.task && (
          <Card className="mt-8 border-primary/30 bg-primary/5">
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2">
                <Zap className="h-5 w-5 text-primary" />
                <CardTitle className="text-lg">Your One Thing</CardTitle>
                <Badge variant="outline" className="ml-auto text-xs">
                  {priorityLabels[oneThing.priority_level] || oneThing.reason}
                </Badge>
              </div>
            </CardHeader>
            <CardContent>
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="font-semibold">{oneThing.task.title}</p>
                  <p className="text-sm text-muted-foreground mt-1">
                    {oneThing.task.courses?.name || "No course"}
                    {oneThing.task.due_date && (
                      <> · Due {format(new Date(oneThing.task.due_date), "MMM d")}</>
                    )}
                  </p>
                  {oneThing.task.description && (
                    <p className="text-sm text-muted-foreground mt-2 line-clamp-2">{oneThing.task.description}</p>
                  )}
                </div>
                <Button size="sm" onClick={() => completeTask(oneThing.task.id)}>
                  <Check className="mr-1 h-4 w-4" /> Done
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {oneThing && !oneThing.task && (
          <Card className="mt-8 border-success/30 bg-success/5">
            <CardContent className="flex items-center gap-3 p-6">
              <Check className="h-6 w-6 text-success" />
              <p className="font-medium">No pending tasks. You're all caught up! 🎉</p>
            </CardContent>
          </Card>
        )}

        {/* Task list */}
        <div className="mt-8">
          <Tabs value={tab} onValueChange={(v) => { setTab(v); setLoading(true); }}>
            <TabsList>
              <TabsTrigger value="pending">Pending</TabsTrigger>
              <TabsTrigger value="in_progress">In Progress</TabsTrigger>
              <TabsTrigger value="done">Done</TabsTrigger>
            </TabsList>

            <TabsContent value={tab} className="mt-4">
              {loading ? (
                <div className="space-y-3">
                  {[1, 2, 3].map((i) => (
                    <div key={i} className="h-16 rounded-lg bg-muted animate-pulse" />
                  ))}
                </div>
              ) : tasks.length === 0 ? (
                <Card>
                  <CardContent className="flex flex-col items-center justify-center py-12 text-center">
                    <ListTodo className="h-12 w-12 text-muted-foreground/40" />
                    <h3 className="mt-4 font-semibold">No {tab} tasks</h3>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Tasks will appear here from Moodle sync or OpenClaw.
                    </p>
                  </CardContent>
                </Card>
              ) : (
                <div className="space-y-2">
                  {tasks.map((task) => {
                    const Icon = typeIcons[task.task_type] || ListTodo;
                    return (
                      <div
                        key={task.id}
                        className={cn(
                          "flex items-center gap-4 rounded-lg border p-4 transition-colors",
                          task.due_date && isPast(new Date(task.due_date)) && task.status === "pending" && "border-destructive/30 bg-destructive/5"
                        )}
                      >
                        {tab === "pending" && (
                          <Checkbox
                            checked={false}
                            onCheckedChange={() => completeTask(task.id)}
                          />
                        )}
                        <div className={cn("rounded-md p-1.5 border", typeColors[task.task_type] || typeColors.custom)}>
                          <Icon className="h-4 w-4" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className={cn("font-medium text-sm", task.status === "done" && "line-through opacity-60")}>
                            {task.title}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {task.courses?.name || "No course"}
                            {task.source && task.source !== "manual" && (
                              <> · via {task.source}</>
                            )}
                          </p>
                        </div>
                        <Badge variant="outline" className="text-xs shrink-0">
                          {task.task_type.replace("_", " ")}
                        </Badge>
                        {task.due_date && (
                          <span className={cn(
                            "text-xs font-mono whitespace-nowrap",
                            isPast(new Date(task.due_date)) && task.status === "pending"
                              ? "text-destructive font-semibold"
                              : "text-muted-foreground"
                          )}>
                            {format(new Date(task.due_date), "MMM d")}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </DashboardLayout>
  );
}
