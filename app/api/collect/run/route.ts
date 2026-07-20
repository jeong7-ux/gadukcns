// 수집 파이프라인 수동 트리거 + 실행 이력 조회 (S-10 수집 모니터, FR-02 수동)
//   POST: "바로 수집하기" — collect_runs에 running 행을 만들고 실제 수집은
//         **Netlify Background Function(최대 15분)** 에 위임한 뒤 즉시 runId를 반환한다.
//         (동기 함수 응답 상한 10~26초 < 실제 수집 소요 ~30초+ → 응답 유실 문제 근본 해결)
//         백그라운드 함수가 없는 환경(로컬 next dev 등)은 자동으로 인라인 실행으로 폴백.
//   GET : 최근 수집 이력 조회(모니터·폴링용). collect_runs 미배포 시 deployed:false.
//   권한: 트리거는 strategy/pm/admin(그룹/운영 권한), 조회는 active 사용자 전체.
import { NextRequest, NextResponse } from "next/server";
import { getRequester, serviceClient } from "@/lib/server/auth";
import { runBoundedCollect } from "@/lib/collect/runner";
import { COLLECT_TOKEN_HEADER, collectRunToken } from "@/lib/collect/trigger-token";

export const runtime = "nodejs";
export const maxDuration = 60; // 인라인 폴백 경로용. 백그라운드 위임 시 POST는 수 초 내 반환된다.

const CAN_TRIGGER = ["strategy", "pm", "admin"];
const BASE_RUN_COLUMNS =
  "id,trigger,status,started_at,finished_at,duration_ms,window_bgn,window_end,pages,scanned,bids_upserted,prices_upserted,changes_appended,cursor_advanced,error_count,errors,checks";
const BACKGROUND_FN_PATH = "/.netlify/functions/collect-background";

function tokenOf(req: NextRequest) {
  return req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
}

// 백그라운드 실행이 실제로 시작됐는지 확인(runBoundedCollect는 시작 즉시 window_bgn 을 채운다).
// 시작하지 않으면 호출 측이 인라인으로 대신 수행한다(플랫폼 미실행 대비 자기치유).
async function waitForStart(
  svc: ReturnType<typeof serviceClient>,
  runId: number,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    const { data } = await svc.from("collect_runs").select("window_bgn").eq("id", runId).maybeSingle();
    if (data?.window_bgn) return true;
  }
  return false;
}

// 자기 자신(같은 사이트)의 백그라운드 함수 URL. 프록시 헤더 우선 → Netlify 사이트 URL → 요청 URL.
function siteOrigin(req: NextRequest): string {
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (host) {
    const local = /^(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(host);
    return `${req.headers.get("x-forwarded-proto") ?? (local ? "http" : "https")}://${host}`;
  }
  return process.env.URL ?? new URL(req.url).origin;
}

// ── GET: 최근 실행 이력 ──────────────────────────────────────────
export async function GET(req: NextRequest) {
  const me = await getRequester(tokenOf(req));
  if (!me) return NextResponse.json({ error: "인증이 필요합니다." }, { status: 401 });

  const svc = serviceClient();
  const canTrigger = CAN_TRIGGER.includes(me.role);
  const query = (cols: string) =>
    svc.from("collect_runs").select(cols).order("started_at", { ascending: false }).limit(20);

  // classify 컬럼(분류 통계)은 classify.sql 적용 시에만 존재 → 실패하면 기본 컬럼으로 재조회
  let { data, error } = await query(`${BASE_RUN_COLUMNS},classify`);
  if (error) ({ data, error } = await query(BASE_RUN_COLUMNS));

  if (error) {
    // 테이블 미배포(42P01 등) → 모니터는 "미배포" 안내 상태로 폴백
    return NextResponse.json({ deployed: false, runs: [], canTrigger });
  }
  return NextResponse.json({ deployed: true, runs: data ?? [], canTrigger });
}

// ── POST: "바로 수집하기" 트리거 ─────────────────────────────────
export async function POST(req: NextRequest) {
  const me = await getRequester(tokenOf(req));
  if (!me || !CAN_TRIGGER.includes(me.role)) {
    return NextResponse.json({ error: "수집 실행 권한이 없습니다(운영자 전용)." }, { status: 403 });
  }
  if (!process.env.NARA_SERVICE_KEY || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return NextResponse.json(
      { error: "서버 환경변수(NARA_SERVICE_KEY/SUPABASE)가 설정되지 않았습니다." },
      { status: 500 }
    );
  }

  const svc = serviceClient();

  // 동시 실행 가드: 15분 내 running 이 있으면 중복 실행 차단(테이블 미배포 시 가드 생략)
  const since = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const { data: running, error: guardErr } = await svc
    .from("collect_runs")
    .select("id,started_at")
    .eq("status", "running")
    .gte("started_at", since)
    .limit(1);
  if (!guardErr && running && running.length > 0) {
    return NextResponse.json(
      { error: "이미 수집이 진행 중입니다. 잠시 후 다시 시도하세요.", running: running[0] },
      { status: 409 }
    );
  }

  // 옵션(선택): body.days(1~7), body.maxPages(1~20)
  const body = await req.json().catch(() => ({}));
  const days = Number(body?.days) || undefined;
  const maxPages = Number(body?.maxPages) || undefined;

  // ① 실행 행 선생성 — 클라이언트가 폴링할 runId를 즉시 확보(백그라운드 결과 수신처)
  const { data: created, error: createErr } = await svc
    .from("collect_runs")
    .insert({ source: "nara", trigger: "manual", status: "running", triggered_by: me.userId })
    .select("id")
    .single();

  // collect_runs 미배포 → 폴링 대상이 없으므로 기존 인라인 실행으로 처리(26초 초과 시 응답 유실 가능)
  if (createErr || !created) {
    try {
      const result = await runBoundedCollect(svc, { days, maxPages, triggeredBy: me.userId });
      return NextResponse.json({ ok: true, mode: "inline", runId: result.runId, result });
    } catch (e) {
      return NextResponse.json({ error: `수집 실패: ${(e as Error).message}` }, { status: 500 });
    }
  }
  const runId = (created as { id: number }).id;

  // ② 백그라운드 함수로 위임(202 즉시 응답). 실패하면 인라인 폴백.
  let dispatched = false;
  let dispatchNote = "";
  try {
    const res = await fetch(`${siteOrigin(req)}${BACKGROUND_FN_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [COLLECT_TOKEN_HEADER]: collectRunToken(runId),
      },
      body: JSON.stringify({ runId, days, maxPages, triggeredBy: me.userId }),
      signal: AbortSignal.timeout(10000),
    });
    dispatched = res.ok; // 백그라운드 함수는 202 Accepted
    if (!dispatched) dispatchNote = `HTTP ${res.status}`;
  } catch (e) {
    dispatchNote = (e as Error).message;
  }

  // 백그라운드 함수는 즉시 202를 돌려주므로 "접수됨"이 곧 "실행됨"은 아니다.
  //   실제 시작 여부는 runBoundedCollect가 시작 시 채우는 window_bgn 으로 확인한다.
  if (dispatched && (await waitForStart(svc, runId, 8000))) {
    return NextResponse.json({ ok: true, mode: "background", runId }, { status: 202 });
  }

  // ③ 폴백: 백그라운드 함수 부재(로컬 dev)·미실행 시 같은 행으로 인라인 실행.
  //   아직 시작 전(window_bgn is null)일 때만 source 마커로 선점 → 콜드스타트로 늦게
  //   깨어난 백그라운드와의 중복 실행을 막는다(선점 실패 = 백그라운드가 이미 시작).
  const { data: claimed } = await svc
    .from("collect_runs")
    .update({ source: "nara-inline" })
    .eq("id", runId)
    .is("window_bgn", null)
    .select("id");
  if (!claimed?.length) {
    return NextResponse.json({ ok: true, mode: "background", runId }, { status: 202 });
  }
  try {
    const result = await runBoundedCollect(svc, { runId, days, maxPages, triggeredBy: me.userId });
    return NextResponse.json({ ok: true, mode: "inline", runId, result, dispatchNote });
  } catch (e) {
    await svc
      .from("collect_runs")
      .update({
        status: "failed",
        finished_at: new Date().toISOString(),
        error_count: 1,
        errors: [`수집 실패: ${(e as Error).message}`.slice(0, 500)],
      })
      .eq("id", runId);
    return NextResponse.json({ error: `수집 실패: ${(e as Error).message}` }, { status: 500 });
  }
}
