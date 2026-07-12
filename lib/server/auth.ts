// API 라우트용 요청자 검증 (서버 전용). 세션 토큰 → active 사용자 + role.
import { createClient } from "@supabase/supabase-js";

export interface Requester {
  userId: string;
  role: string;
}

export async function getRequester(token: string | null): Promise<Requester | null> {
  if (!token) return null;
  const url = process.env.SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !anon || !serviceKey) return null;

  const authClient = createClient(url, anon, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data } = await authClient.auth.getUser();
  if (!data?.user) return null;

  const svc = createClient(url, serviceKey);
  const { data: prof } = await svc
    .from("users")
    .select("role,status")
    .eq("user_id", data.user.id)
    .maybeSingle();
  if (!prof || prof.status !== "active") return null;
  return { userId: data.user.id, role: prof.role as string };
}

export function serviceClient() {
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);
}
