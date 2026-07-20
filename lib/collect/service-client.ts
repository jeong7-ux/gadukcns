// =====================================================================
// lib/collect/service-client.ts — Netlify Functions(Node 20 Lambda)용 Supabase 서비스 클라이언트
//
// 문제: @supabase/supabase-js 2.110 은 createClient 단계에서 RealtimeClient를 만들고,
//   realtime-js/websocket-factory 가 전역 WebSocket을 찾지 못하면 **즉시 throw** 한다
//   ("Node.js detected but native WebSocket not found" — 전역 WebSocket은 Node 22+).
//   Netlify Functions 런타임이 nodejs20.x 라 백그라운드 함수가 여기서 죽어
//   collect_runs 가 running 상태로 정체됐다(202만 반환돼 오류가 보이지 않음).
//
// 해결: 우리는 Realtime을 쓰지 않으므로 transport를 명시 주입해 감지 로직을 건너뛴다
//   (realtime-js: `options?.transport ?? WebSocketFactory.getWebSocketConstructor()`).
//   Node 22+ 로 올라가면 전역 WebSocket을 그대로 사용한다.
// =====================================================================
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

class UnusedWebSocket {
  constructor() {
    throw new Error("Realtime은 수집 함수에서 사용하지 않습니다.");
  }
}

export function collectServiceClient(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL/SUPABASE_SERVICE_KEY 미설정");
  const transport = (globalThis as { WebSocket?: unknown }).WebSocket ?? UnusedWebSocket;
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { transport: transport as never },
  });
}
