import { useEffect, useState } from "react";
import {
  LayoutDashboard,
  BookOpen,
  ListTodo,
  RefreshCw,
  Settings,
  CalendarDays,
  CheckCircle2,
} from "lucide-react";
import { NavLink, useLocation } from "react-router-dom";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

const navItems = [
  { to: "/dashboard", label: "Heute & Fokus", icon: LayoutDashboard },
  { to: "/courses", label: "Meine Module", icon: BookOpen },
  { to: "/tasks", label: "Aufgaben & Fristen", icon: ListTodo },
  { to: "/timetable", label: "Stundenplan", icon: CalendarDays },
];

const AUTOPILOT_KEY = "study_os_last_autopilot_v3";
const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;

export function AppSidebar() {
  const location = useLocation();
  const { user } = useAuth();
  const [syncing, setSyncing] = useState(false);
  const [lastSyncedLabel, setLastSyncedLabel] = useState<string>("Heute aktiv");

  const runAutopilot = async (manual = false) => {
    if (!user || syncing) return;
    setSyncing(true);
    try {
      const moodleToken = localStorage.getItem("study_os_moodle_token") || undefined;

      // 1. Deep-scan existing workspace & decompress USLN/Merkblatt PDFs immediately
      await fetch("/api/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "extract_deadlines",
          mode: "scan_workspace",
          user_id: user.id,
          moodle_token: moodleToken,
          auto_save: true,
        }),
      });

      // 2. Sync Moodle courses, assignments, quizzes, calendar & new PDFs for active semester
      const syncRes = await fetch("/api/moodle-sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "autopilot_sync",
          user_id: user.id,
          moodle_token: moodleToken,
        }),
      });

      // 3. Auto-classify notes & prepare study tasks
      await Promise.all([
        fetch("/api/ai", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "classify_notes", user_id: user.id }),
        }),
        fetch("/api/ai", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "plan_week", user_id: user.id }),
        }),
      ]);

      const now = Date.now();
      localStorage.setItem(AUTOPILOT_KEY, String(now));
      setLastSyncedLabel(
        new Date(now).toLocaleTimeString("de-CH", { hour: "2-digit", minute: "2-digit" })
      );

      // Notify active page to reload fresh data seamlessly
      window.dispatchEvent(new Event("study-os-synced"));

      if (manual && syncRes.ok) {
        toast.success("Autopilot Sync abgeschlossen — alle Kurse & Fristen sind aktuell!");
      }
    } catch (e) {
      console.warn("Silent autopilot check:", e);
    } finally {
      setSyncing(false);
    }
  };

  useEffect(() => {
    const raw = localStorage.getItem(AUTOPILOT_KEY);
    const lastTs = raw ? parseInt(raw, 10) : 0;
    if (lastTs > 0) {
      setLastSyncedLabel(
        new Date(lastTs).toLocaleTimeString("de-CH", { hour: "2-digit", minute: "2-digit" })
      );
    }
    if (!lastTs || Date.now() - lastTs > TWELVE_HOURS_MS) {
      runAutopilot(false);
    }
  }, [user]);

  return (
    <aside className="fixed inset-y-0 left-0 z-30 flex w-64 flex-col bg-sidebar border-r border-sidebar-border">
      <div className="flex h-16 items-center gap-3 px-6 border-b border-sidebar-border">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground font-bold text-sm">
          SO
        </div>
        <div>
          <span className="text-base font-semibold text-sidebar-foreground tracking-tight block leading-none">
            Study OS
          </span>
          <span className="text-[11px] text-sidebar-foreground/60">
            ZHAW Wirtschaftsrecht
          </span>
        </div>
      </div>

      <nav className="flex-1 space-y-1.5 px-3 py-5">
        {navItems.map((item) => {
          const isActive = location.pathname === item.to;
          return (
            <NavLink
              key={item.to}
              to={item.to}
              className={cn(
                "flex items-center gap-3 rounded-lg px-3.5 py-2.5 text-sm font-medium transition-colors",
                isActive
                  ? "bg-sidebar-accent text-sidebar-primary"
                  : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
              )}
            >
              <item.icon className="h-4 w-4" />
              {item.label}
            </NavLink>
          );
        })}
      </nav>

      {/* Autopilot Status & Settings Footer */}
      <div className="border-t border-sidebar-border p-3 space-y-2">
        <div className="rounded-lg bg-sidebar-accent/40 px-3 py-2.5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 min-w-0">
              {syncing ? (
                <RefreshCw className="h-3.5 w-3.5 text-sidebar-primary animate-spin shrink-0" />
              ) : (
                <CheckCircle2 className="h-3.5 w-3.5 text-success shrink-0" />
              )}
              <span className="text-xs font-medium text-sidebar-foreground truncate">
                {syncing ? "Autopilot synchronisiert..." : "Autopilot aktiv"}
              </span>
            </div>
            <div className="flex items-center gap-0.5 shrink-0">
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 text-sidebar-foreground/60 hover:text-sidebar-foreground"
                onClick={() => runAutopilot(true)}
                disabled={syncing}
                title="Jetzt im Hintergrund aktualisieren"
              >
                <RefreshCw className={cn("h-3 w-3", syncing && "animate-spin")} />
              </Button>
              <NavLink
                to="/settings"
                className="inline-flex h-6 w-6 items-center justify-center rounded-md text-sidebar-foreground/60 hover:text-sidebar-foreground"
                title="Einstellungen & Moodle Sync"
              >
                <Settings className="h-3.5 w-3.5" />
              </NavLink>
            </div>
          </div>
          <p className="text-[11px] text-sidebar-foreground/50 mt-0.5">
            {syncing
              ? "Prüft Kurse, PDFs & Fristen..."
              : `Täglicher Sync · Stand ${lastSyncedLabel}`}
          </p>
        </div>
      </div>
    </aside>
  );
}
