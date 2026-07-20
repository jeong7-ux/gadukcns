// =====================================================================
// lib/collect/trigger-token.ts — 백그라운드 수집 위임용 서버-서버 인증 토큰
//
// Netlify Background Function(/.netlify/functions/collect-background)은 공개 URL이므로
// 아무나 수집을 트리거할 수 없도록 호출자를 검증해야 한다. 신규 환경변수 추가 없이
// 이미 양쪽(Next API 라우트·Netlify 함수)에 주입돼 있는 SUPABASE_SERVICE_KEY를 HMAC 키로
// 사용해 run 단위 토큰을 파생한다. 서비스 키를 모르면 위조 불가하고, runId에 묶여 있어
// 다른 실행으로 재사용할 수 없다(수신 측에서 status='running' + 신선도도 함께 확인).
//
// 상대경로 import만 사용(esbuild 번들 대상).
// =====================================================================
import { createHmac, timingSafeEqual } from "node:crypto";

export const COLLECT_TOKEN_HEADER = "x-collect-token";

export function collectRunToken(runId: number): string {
  const secret = process.env.SUPABASE_SERVICE_KEY ?? "";
  return createHmac("sha256", secret).update(`collect-run:${runId}`).digest("hex");
}

export function verifyCollectRunToken(runId: number, token: string | null | undefined): boolean {
  if (!token || !process.env.SUPABASE_SERVICE_KEY) return false;
  const expected = Buffer.from(collectRunToken(runId), "utf8");
  const given = Buffer.from(String(token), "utf8");
  if (expected.length !== given.length) return false; // 길이 불일치 = 즉시 실패(timingSafeEqual 제약)
  return timingSafeEqual(expected, given);
}
