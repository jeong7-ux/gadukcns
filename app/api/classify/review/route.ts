// AI 분류 검수 (S-12) — admin 전용. bid_classifications/bids 분류 결과를 검토·수정·아카이브.
//   GET  ?tab=pending|gamri|consult|none  → 요약 카운트 + 목록
//   POST { bid_no, bid_seq, action }       → confirm|gamri|consult|reject(개별)
//   POST { action:'archive_none' }         → 해당없음 일괄 소프트 아카이브(자원 회수)
import { NextRequest, NextResponse } from "next/server";
import { getRequester, serviceClient } from "@/lib/server/auth";

export const runtime = "nodejs";
const CAN = ["admin"];

function tokenOf(req: NextRequest) {
  return req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
}
async function guard(req: NextRequest) {
  const me = await getRequester(tokenOf(req));
  if (!me || !CAN.includes(me.role)) return null;
  return me;
}

export async function GET(req: NextRequest) {
  const me = await guard(req);
  if (!me) return NextResponse.json({ error: "관리자 전용" }, { status: 403 });
  const svc = serviceClient();
  const tab = req.nextUrl.searchParams.get("tab") || "pending";

  const head = { count: "exact" as const, head: true };
  const [gamri, consult, none, pending] = await Promise.all([
    svc.from("bids").select("bid_no", head).eq("biz_category", "감리").is("archived_at", null),
    svc.from("bids").select("bid_no", head).eq("biz_category", "컨설팅").is("archived_at", null),
    svc.from("bid_classifications").select("bid_no", head).eq("category", "해당없음"),
    svc.from("bids").select("bid_no", head).eq("classify->>needs_review", "true").is("archived_at", null),
  ]);
  const summary = {
    gamri: gamri.count ?? 0,
    consult: consult.count ?? 0,
    none: none.count ?? 0,
    pending: pending.count ?? 0,
  };

  let items: unknown[] = [];
  if (tab === "none") {
    const { data } = await svc
      .from("bid_classifications")
      .select("bid_no,bid_seq,category,confidence,reason,title,order_org,prefilter_base,method")
      .eq("category", "해당없음")
      .order("decided_at", { ascending: false })
      .limit(100);
    items = data ?? [];
  } else {
    let q = svc
      .from("bids")
      .select("bid_no,bid_seq,title,order_org,demand_org,biz_category,classify,score")
      .is("archived_at", null)
      .limit(100);
    if (tab === "pending") q = q.eq("classify->>needs_review", "true");
    else if (tab === "gamri") q = q.eq("biz_category", "감리");
    else if (tab === "consult") q = q.eq("biz_category", "컨설팅");
    const { data } = await q.order("updated_at", { ascending: false });
    items = data ?? [];
  }
  return NextResponse.json({ summary, items, tab });
}

export async function POST(req: NextRequest) {
  const me = await guard(req);
  if (!me) return NextResponse.json({ error: "관리자 전용" }, { status: 403 });
  const svc = serviceClient();
  const body = await req.json().catch(() => ({}));
  const action: string = body?.action;
  const now = new Date().toISOString();

  // 일괄: 해당없음 소프트 아카이브(자원 회수)
  if (action === "archive_none") {
    const { data: rows } = await svc
      .from("bid_classifications")
      .select("bid_no")
      .eq("category", "해당없음");
    const bidNos = [...new Set((rows as { bid_no: string }[] | null ?? []).map((r) => r.bid_no))];
    let archived = 0;
    for (let i = 0; i < bidNos.length; i += 200) {
      const chunk = bidNos.slice(i, i + 200);
      // 감리/컨설팅으로 재분류됐거나 이미 아카이브된 건 제외(biz_category is null 만)
      const { data, error } = await svc
        .from("bids")
        .update({ archived_at: now })
        .in("bid_no", chunk)
        .is("archived_at", null)
        .is("biz_category", null)
        .select("bid_no");
      if (!error) archived += data?.length ?? 0;
    }
    return NextResponse.json({ ok: true, archived });
  }

  // 개별 검수
  const bid_no: string = body?.bid_no;
  const bid_seq: string = body?.bid_seq ?? "00";
  if (!bid_no) return NextResponse.json({ error: "bid_no 필요" }, { status: 400 });

  const setCls = async (category: string) =>
    svc.from("bid_classifications").upsert(
      { bid_no, bid_seq, category, method: "manual", model: null, decided_at: now },
      { onConflict: "bid_no,bid_seq" }
    );

  if (action === "confirm") {
    // 보류 해제(현재 분류 확정)
    const { data: b } = await svc.from("bids").select("classify,biz_category").eq("bid_no", bid_no).eq("bid_seq", bid_seq).maybeSingle();
    const classify = { ...((b?.classify as Record<string, unknown>) ?? {}), needs_review: false, method: "manual", at: now };
    await svc.from("bids").update({ classify, updated_at: now }).eq("bid_no", bid_no).eq("bid_seq", bid_seq);
    if (b?.biz_category) await setCls(b.biz_category as string);
    return NextResponse.json({ ok: true });
  }
  if (action === "감리" || action === "컨설팅") {
    const classify = { method: "manual", confidence: 1, reason: "관리자 확정", model: null, at: now, needs_review: false };
    await svc.from("bids").update({ biz_category: action, classify, updated_at: now }).eq("bid_no", bid_no).eq("bid_seq", bid_seq);
    await setCls(action);
    return NextResponse.json({ ok: true });
  }
  if (action === "reject") {
    // 해당없음 → biz_category 해제 + 소프트 아카이브
    await svc.from("bids").update({ biz_category: null, archived_at: now, updated_at: now }).eq("bid_no", bid_no).eq("bid_seq", bid_seq);
    await setCls("해당없음");
    return NextResponse.json({ ok: true });
  }
  if (action === "restore") {
    // 아카이브 복원(해당없음 목록에서)
    await svc.from("bids").update({ archived_at: null, updated_at: now }).eq("bid_no", bid_no).eq("bid_seq", bid_seq);
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json({ error: "알 수 없는 action" }, { status: 400 });
}
