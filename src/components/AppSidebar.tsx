import { LayoutDashboard, BookOpen, Clock, FileText, ListTodo, RefreshCw, Settings, CalendarDays, CreditCard, FolderOpen, BarChart3, LogOut } from "lucide-react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";

const navItems = [
  { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { to: "/tasks", label: "Tasks", icon: ListTodo },
  { to: "/courses", label: "Courses", icon: BookOpen },
  { to: "/deadlines", label: "Deadlines", icon: Clock },
  { to: "/timetable", label: "Stundenplan", icon: CalendarDays },
  { to: "/notes", label: "Notes", icon: FileText },
  { to: "/files", label: "Files", icon: FolderOpen },
  { to: "/flashcards", label: "Flashcards", icon: CreditCard },
  { to: "/analytics", label: "Analytics", icon: BarChart3 },
  { to: "/moodle-sync", label: "Moodle Sync", icon: RefreshCw },
  { to: "/settings", label: "Settings", icon: Settings },
];

export function AppSidebar() {
  const location = useLocation();
  const navigate = useNavigate();
  const { user, signOut } = useAuth();

  const handleSignOut = async () => {
    await signOut();
    navigate("/auth");
  };

  return (
    <aside className="fixed inset-y-0 left-0 z-30 flex w-64 flex-col bg-sidebar border-r border-sidebar-border">
      <div className="flex h-16 items-center gap-3 px-6 border-b border-sidebar-border">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground font-bold text-sm">
          SO
        </div>
        <span className="text-lg font-semibold text-sidebar-foreground tracking-tight">Study OS</span>
      </div>

      <nav className="flex-1 space-y-1 px-3 py-4">
        {navItems.map((item) => {
          const isActive = location.pathname === item.to;
          return (
            <NavLink
              key={item.to}
              to={item.to}
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
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

      {user && (
        <div className="border-t border-sidebar-border p-3">
          <div className="flex items-center gap-3 rounded-lg px-3 py-2">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-sidebar-foreground truncate">
                {user.user_metadata?.full_name || "Marc"}
              </p>
              <p className="text-xs text-sidebar-foreground/60 truncate">
                {user.email || "marc@zhaw.ch"}
              </p>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
