// =====================================================================
// netlify/functions/collect-diag.mts — 백그라운드 수집 경로 진단(동기 함수)
//
// collect-background.mts 와 **동일한 모듈 그래프·초기 단계**를 밟되, 결과를 응답으로
// 돌려준다. 백그라운드 함수는 202만 반환하고 내부 오류가 보이지 않으므로, 실패 지점을
// (env / 토큰 / DB 접근 / 번들 로딩) 단계별로 특정하기 위한 도구다.
//
// 보호: collect-background 와 동일한 HMAC 토큰(x-collect-token) 필수 → 서비스 키를
//   가진 서버·운영자만 호출 가능. 값은 절대 반환하지 않고 존재 여부(boolean)만 알린다.
// =====================================================================
import { createClient } from "@supabase/supabase-js";
import { COLLECT_TOKEN_HEADER, verifyCollectRunToken } from "../../lib/collect/trigger-token";

export default async (req: Request): Promise<Response> => {
  const body = (await req.json().catch(() => ({}))) as { runId?: number };
  const runId = Number(body?.runId) || 0;
  const env = {
    SUPABASE_URL: !!process.env.SUPABASE_URL,
    SUPABASE_SERVICE_KEY: !!process.env.SUPABASE_SERVICE_KEY,
    NARA_SERVICE_KEY: !!process.env.NARA_SERVICE_KEY,
    OPENROUTER_API_KEY: !!process.env.OPENROUTER_API_KEY,
  };
  const meta = { node: process.version, runtime: process.env.AWS_EXECUTION_ENV ?? null };

  if (!verifyCollectRunToken(runId, req.headers.get(COLLECT_TOKEN_HEADER))) {
    return Response.json({ stage: "token", ok: false, env, meta }, { status: 403 });
  }
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) {
    return Response.json({ stage: "env", ok: false, env, meta }, { status: 500 });
  }

  try {
    const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!, {
      auth: { persistSession: false },
    });
    const { data, error } = await sb
      .from("collect_runs")
      .select("id,status,source,started_at")
      .eq("id", runId)
      .maybeSingle();
    return Response.json({
      stage: "db",
      ok: !error,
      env,
      meta,
      row: data ?? null,
      error: error?.message ?? null,
    });
  } catch (e) {
    return Response.json({ stage: "db-throw", ok: false, env, meta, error: (e as Error).message }, { status: 500 });
  }
};
