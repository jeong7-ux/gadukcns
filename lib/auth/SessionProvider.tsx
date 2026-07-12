"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { Session } from "@supabase/supabase-js";
import { getSupabaseClient } from "@/lib/supabase/client";
import type { Role, UserRow, UserStatus } from "@/lib/supabase/types";

interface SessionState {
  loading: boolean;
  session: Session | null;
  /** users 테이블 프로필(role/status/dept 등). RLS 게이팅의 UI 기준. */
  profile: UserRow | null;
  role: Role | null;
  status: UserStatus | null;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

const Ctx = createContext<SessionState | undefined>(undefined);

export function SessionProvider({ children }: { children: ReactNode }) {
  const supabase = getSupabaseClient();
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<UserRow | null>(null);

  async function loadProfile(uid: string | undefined) {
    if (!uid) {
      setProfile(null);
      return;
    }
    // RLS로 본인 row만 조회 가능. 실패해도 화면을 깨뜨리지 않는다.
    const { data } = await supabase
      .from("users")
      .select("*")
      .eq("user_id", uid)
      .maybeSingle();
    setProfile((data as UserRow) ?? null);
  }

  async function refresh() {
    const { data } = await supabase.auth.getSession();
    setSession(data.session);
    await loadProfile(data.session?.user.id);
  }

  useEffect(() => {
    let active = true;
    (async () => {
      await refresh();
      if (active) setLoading(false);
    })();

    const { data: sub } = supabase.auth.onAuthStateChange(async (_e, s) => {
      setSession(s);
      await loadProfile(s?.user.id);
    });
    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function signOut() {
    await supabase.auth.signOut();
    setProfile(null);
  }

  const value = useMemo<SessionState>(
    () => ({
      loading,
      session,
      profile,
      role: profile?.role ?? null,
      status: profile?.status ?? null,
      refresh,
      signOut,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [loading, session, profile]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useSession must be used within SessionProvider");
  return ctx;
}
