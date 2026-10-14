import { useState, useEffect, createContext, useContext, ReactNode } from "react";
import { Session, User } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";

export const MASTER_USER_ID = "59255661-ce8b-476c-8e00-408b55843c58";

const MASTER_USER: User = {
  id: MASTER_USER_ID,
  email: "marc@zhaw.ch",
  user_metadata: { full_name: "Marc" },
  app_metadata: { provider: "email" },
  aud: "authenticated",
  created_at: "2026-03-08T00:00:00.000Z",
} as unknown as User;

const MASTER_SESSION: Session = {
  access_token: "single-user-token",
  token_type: "bearer",
  expires_in: 360000000,
  refresh_token: "single-user-refresh",
  user: MASTER_USER,
} as unknown as Session;

interface AuthContextType {
  session: Session | null;
  user: User | null;
  loading: boolean;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({
  session: MASTER_SESSION,
  user: MASTER_USER,
  loading: false,
  signOut: async () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(MASTER_SESSION);
  const [user, setUser] = useState<User | null>(MASTER_USER);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // Check if an actual Supabase session exists, otherwise keep master user
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) {
        setSession(session);
        setUser(session.user);
      }
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session?.user) {
        setSession(session);
        setUser(session.user);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  const signOut = async () => {
    // In single user mode, sign out is a no-op
    await supabase.auth.signOut();
  };

  return (
    <AuthContext.Provider value={{ session, user, loading, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);

