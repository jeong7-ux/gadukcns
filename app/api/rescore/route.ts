// 재스코어링 (S-12) — admin 전용. 현재 활성 rules로 전체 bids의 score/tags/breakdown 재계산.
//   DB 함수(rescore_bids) 미배포 환경에서도 동작하도록 서버(service key)에서 직접 처리.
//   scripts/rescore.mjs 와 동일 로직. LLM 불필요.
import { NextRequest, NextResponse } from "next/server";
import { getRequester, serviceClient } from "@/lib/server/auth";

export const runtime = "nodejs";
export const maxDuration = 60;

const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();

interface Rule { type: string; pattern: string; weight: number }
interface BidRow {
  bid_no: string;
  bid_seq: string;
  title: string | null;
  order_org: string | null;
  demand_org: string | null;
  contract_method: string | null;
  score: number | null;
  ai_flags: Record<string, unknown> | null;
}

// ai.mjs scoreBid 와 동일 로직
function scoreBid(b: BidRow, rules: Rule[]) {
  const hayAll = norm(`${b.title} ${b.order_org} ${b.demand_org} ${b.contract_method}`);
  const hayOrg = norm(`${b.order_org} ${b.demand_org}`);
  const hayContract = norm(b.contract_method);
  let base = 0, agency = 0, pen = 0;
  const tags = new Set<string>();
  const matched: { type: string; pattern: string; weight: number }[] = [];
  for (const r of rules) {
    const p = norm(r.pattern);
    if (!p) continue;
    let hit = false, tag = false;
    if (r.type === "keyword") { hit = hayAll.includes(p); if (hit) { base += r.weight; tag = true; } }
    else if (r.type === "contract") { hit = hayContract.includes(p); if (hit) { base += r.weight; tag = true; } }
    else if (r.type === "org") { hit = hayOrg.includes(p); if (hit) { agency += r.weight; tag = true; } }
    else if (r.type === "exclude") { hit = hayAll.includes(p); if (hit) pen += r.weight; }
    if (hit) matched.push({ type: r.type, pattern: r.pattern, weight: r.weight });
    if (tag) tags.add(r.pattern);
  }
  return { score: base + agency - pen, tags: [...tags], breakdown: { base, agency, exclude: pen, matched } };
}

export async function POST(req: NextRequest) {
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
  const me = await getRequester(token);
  if (!me || me.role !== "admin") {
    return NextResponse.json({ error: "관리자 전용" }, { status: 403 });
  }

  const svc = serviceClient();
  const { data: rules, error: re } = await svc
    .from("rules")
    .select("type,pattern,weight")
    .eq("is_active", true);
  if (re) return NextResponse.json({ error: `rules 조회 실패: ${re.message}` }, { status: 500 });

  const now = new Date().toISOString();
  let processed = 0, changed = 0, gt0 = 0, gte5 = 0, page = 0;
  const PAGE = 1000;
  try {
    for (;;) {
      const from = page * PAGE;
      const { data: bids, error } = await svc
        .from("bids")
        .select("bid_no,bid_seq,title,order_org,demand_org,contract_method,score,ai_flags")
        .order("bid_no", { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) throw new Error(`bids 조회 실패: ${error.message}`);
      if (!bids || bids.length === 0) break;

      const rows = (bids as BidRow[]).map((b) => {
        const sc = scoreBid(b, (rules as Rule[]) ?? []);
        if (sc.score !== (b.score ?? 0)) changed++;
        if (sc.score > 0) gt0++;
        if (sc.score >= 5) gte5++;
        processed++;
        return {
          bid_no: b.bid_no,
          bid_seq: b.bid_seq,
          score: sc.score,
          tags: sc.tags,
          ai_flags: { ...(b.ai_flags || {}), score_breakdown: sc.breakdown, rescored_at: now },
          updated_at: now,
        };
      });
      for (let i = 0; i < rows.length; i += 500) {
        const { error: ue } = await svc.from("bids").upsert(rows.slice(i, i + 500), { onConflict: "bid_no,bid_seq" });
        if (ue) throw new Error(`upsert 실패: ${ue.message}`);
      }
      page++;
    }
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message, processed }, { status: 500 });
  }

  // status 신선화(있으면). 실패해도 재스코어링은 성공 처리.
  try { await svc.rpc("refresh_bids_status"); } catch { /* noop */ }

  return NextResponse.json({ ok: true, processed, changed, gt0, gte5, rulesActive: rules?.length ?? 0 });
}
