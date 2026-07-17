// 수집 파이프라인 수동 트리거 + 실행 이력 조회 (S-10 수집 모니터, FR-02 수동)
//   POST: "바로 수집하기" — 서버(service key)에서 바운드 수집 실행(runBoundedCollect).
//   GET : 최근 수집 이력 조회(모니터 시각화용). collect_runs 미배포 시 deployed:false.
//   권한: 트리거는 strategy/pm/admin(그룹/운영 권한), 조회는 active 사용자 전체.
import { NextRequest, NextResponse } from "next/server";
import { getRequester, serviceClient } from "@/lib/server/auth";
import { runBoundedCollect } from "@/lib/collect/runner";

export const runtime = "nodejs";
export const maxDuration = 60; // 서버리스 함수 상한(초) — 바운드 수집이 초과하지 않도록

const CAN_TRIGGER = ["strategy", "pm", "admin"];
const RUN_COLUMNS =
  "id,trigger,status,started_at,finished_at,duration_ms,window_bgn,window_end,pages,scanned,bids_upserted,prices_upserted,changes_appended,cursor_advanced,error_count,errors,checks";

function tokenOf(req: NextRequest) {
  return req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
}

// ── GET: 최근 실행 이력 ──────────────────────────────────────────
export async function GET(req: NextRequest) {
  const me = await getRequester(tokenOf(req));
  if (!me) return NextResponse.json({ error: "인증이 필요합니다." }, { status: 401 });

  const svc = serviceClient();
  const { data, error } = await svc
    .from("collect_runs")
    .select(RUN_COLUMNS)
    .order("started_at", { ascending: false })
    .limit(20);

  if (error) {
    // 테이블 미배포(42P01 등) → 모니터는 "미배포" 안내 상태로 폴백
    return NextResponse.json({ deployed: false, runs: [], canTrigger: CAN_TRIGGER.includes(me.role) });
  }
  return NextResponse.json({
    deployed: true,
    runs: data ?? [],
    canTrigger: CAN_TRIGGER.includes(me.role),
  });
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

  try {
    const result = await runBoundedCollect(svc, { days, maxPages, triggeredBy: me.userId });
    return NextResponse.json({ ok: true, result });
  } catch (e) {
    return NextResponse.json({ error: `수집 실패: ${(e as Error).message}` }, { status: 500 });
  }
}
