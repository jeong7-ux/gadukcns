// =====================================================================
// netlify/functions/collect-background.mts — "바로수집" 실제 실행부 (백그라운드)
//
// 배경: Next.js API 라우트(/api/collect/run)는 Netlify 동기 함수로 실행되어 응답 상한
//   (기본 10초·최대 26초)을 넘기면 게이트웨이가 HTML 오류페이지를 반환한다. 실제로
//   2026-07-20 실행(run#5)은 28.7초가 걸려 서버 작업은 성공했는데 응답만 유실됐다
//   (클라이언트: `Unexpected token '<'`). → 수집 본체를 **Background Function(최대 15분)**
//   으로 분리하고, 라우트는 running 행 생성 후 즉시 runId만 돌려준다.
//
// 파일명 `-background` 접미사 = Netlify 백그라운드 함수 규약. 호출 즉시 202를 반환하고
//   실행은 뒤에서 계속되며, 결과는 클라이언트가 아니라 **collect_runs 테이블**로 전달된다.
//   (프론트는 GET /api/collect/run 폴링으로 결과를 읽는다.)
//
// 인증: x-collect-token = HMAC(SUPABASE_SERVICE_KEY, "collect-run:<runId>") — 서버끼리만 생성 가능.
// 주의: 예외를 밖으로 던지면 Netlify가 1분·2분 뒤 재시도하므로(중복 수집) 반드시 내부에서 처리한다.
// =====================================================================
import { createClient } from "@supabase/supabase-js";
import { runBoundedCollect } from "../../lib/collect/runner";
import { COLLECT_TOKEN_HEADER, verifyCollectRunToken } from "../../lib/collect/trigger-token";

interface Payload {
  runId?: number;
  days?: number;
  maxPages?: number;
  triggeredBy?: string | null;
}

export default async (req: Request): Promise<Response> => {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  const body = (await req.json().catch(() => ({}))) as Payload;
  const runId = Number(body?.runId);
  if (!Number.isFinite(runId) || runId <= 0) return new Response("Bad Request", { status: 400 });
  if (!verifyCollectRunToken(runId, req.headers.get(COLLECT_TOKEN_HEADER))) {
    return new Response("Forbidden", { status: 403 });
  }

  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !serviceKey) return new Response("Server env missing", { status: 500 });
  const sb = createClient(url, serviceKey, { auth: { persistSession: false } });

  // 재시도·재사용 가드: 대상 행이 아직 running 이고 최근(15분 내) 생성된 것만 실행한다.
  const { data: run } = await sb
    .from("collect_runs")
    .select("id,status,source,started_at")
    .eq("id", runId)
    .maybeSingle();
  if (!run || run.status !== "running") return new Response("Not runnable", { status: 409 });
  // 라우트가 인라인으로 선점한 실행(source='nara-inline')은 건너뛴다(중복 수집 방지)
  if (run.source !== "nara") return new Response("Claimed by inline run", { status: 409 });
  if (Date.now() - new Date(run.started_at as string).getTime() > 15 * 60 * 1000) {
    return new Response("Stale", { status: 409 });
  }

  try {
    if (!process.env.NARA_SERVICE_KEY) throw new Error("NARA_SERVICE_KEY 미설정(Functions 스코프 확인)");
    await runBoundedCollect(sb, {
      runId,
      days: body?.days,
      maxPages: body?.maxPages,
      triggeredBy: body?.triggeredBy ?? null,
    });
  } catch (e) {
    // 실행 실패 시에도 running 으로 방치하지 않는다(UI가 15분간 "수집 중"에 묶이는 것 방지)
    await sb
      .from("collect_runs")
      .update({
        status: "failed",
        finished_at: new Date().toISOString(),
        error_count: 1,
        errors: [`백그라운드 수집 실패: ${(e as Error).message}`.slice(0, 500)],
      })
      .eq("id", runId);
  }
  return new Response("ok"); // 백그라운드 함수의 반환값은 클라이언트에 전달되지 않는다
};
