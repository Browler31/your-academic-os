import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider, useAuth } from "@/hooks/useAuth";
import Dashboard from "./pages/Dashboard";
import Timetable from "./pages/Timetable";
import Courses from "./pages/Courses";
import Deadlines from "./pages/Deadlines";
import Notes from "./pages/Notes";
import Tasks from "./pages/Tasks";
import MoodleSync from "./pages/MoodleSync";
import SettingsPage from "./pages/SettingsPage";
import Flashcards from "./pages/Flashcards";
import Files from "./pages/Files";
import Analytics from "./pages/Analytics";
import Auth from "./pages/Auth";
import NotFound from "./pages/NotFound";

const queryClient = new QueryClient();

function AppRoutes() {
  return (
    <Routes>
      <Route path="/dashboard" element={<Dashboard />} />
      <Route path="/tasks" element={<Tasks />} />
      <Route path="/courses" element={<Courses />} />
      <Route path="/deadlines" element={<Deadlines />} />
      <Route path="/timetable" element={<Timetable />} />
      <Route path="/notes" element={<Notes />} />
      <Route path="/files" element={<Files />} />
      <Route path="/flashcards" element={<Flashcards />} />
      <Route path="/analytics" element={<Analytics />} />
      <Route path="/moodle-sync" element={<MoodleSync />} />
      <Route path="/settings" element={<SettingsPage />} />
      <Route path="/" element={<Navigate to="/dashboard" replace />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <AuthProvider>
          <AppRoutes />
        </AuthProvider>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
