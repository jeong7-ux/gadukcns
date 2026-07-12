"use client";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * 브라우저 Supabase 클라이언트 (anon key + RLS).
 * RLS가 최종 방어선 — 여기서는 anon key만 사용하고 service key는 절대 노출하지 않는다.
 */
let browserClient: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient {
  if (browserClient) return browserClient;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    // 환경변수 누락 시에도 화면이 깨지지 않도록 명확한 에러만 남긴다.
    throw new Error(
      "Supabase 환경변수(NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY)가 없습니다. .env.local을 확인하세요."
    );
  }

  browserClient = createClient(url, anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  });
  return browserClient;
}
