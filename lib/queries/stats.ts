import type { SupabaseClient } from "@supabase/supabase-js";
import { coreScore } from "@/lib/queries/score";

// S-10 대시보드 v3 집계용 원천 데이터 로드. 미아카이브 + 마감전 공고 + 부가 데이터를 병렬 조회.
export interface DashboardData {
  bids: DashBid[];
  clients: DashClient[];
  watch: DashWatch[];
  brief: { brief_date: string; summary: string | null; top_bids: unknown } | null;
  lastCollect: string | null;
  totalBids: number;
  archivedBids: number;
  rulesActive: number;
  clientsCount: number;
  attBidCount: number; // 첨부 정규화된 고유 공고 수
}
export interface DashBid {
  bid_no: string;
  bid_seq: string;
  title: string | null;
  order_org: string | null;
  demand_org: string | null;
  status: string | null;
  notice_dt: string | null;
  deadline_dt: string | null;
  est_price: number | null;
  score: number;
  coreScore: number; // 주력사업 점수 = score_breakdown.base − exclude (발주/고객사 가산 제외)
  ai_score: number | null;
  has_summary: boolean;
  tags: string[] | null;
  rescored_at: string | null;
}
export interface DashClient {
  name: string;
  aliases: string[] | null;
  category: string;
}
export interface DashWatch {
  analysis_status: string;
  proposal_status: string;
  decision: string;
}

export async function fetchDashboardData(
  supabase: SupabaseClient
): Promise<DashboardData> {
  const head = { count: "exact" as const, head: true };
  // 마감된 사업 제외: deadline_dt ≥ 오늘(로컬) 또는 마감일 미정. S-04/S-05/S-08과 동일 기준.
  const todayStr = new Date().toISOString().slice(0, 10);
  const notClosed = `deadline_dt.gte.${todayStr},deadline_dt.is.null`;

  const [
    bidsRes,
    clientsRes,
    watchRes,
    briefRes,
    cursorRes,
    totalRes,
    archivedRes,
    rulesRes,
    clientsCntRes,
    attRes,
  ] = await Promise.all([
    supabase
      .from("bids")
      .select(
        "bid_no,bid_seq,title,order_org,demand_org,status,notice_dt,deadline_dt,est_price,score,ai_score,ai_summary,tags,ai_flags"
      )
      .is("archived_at", null)
      .or(notClosed) // 마감된 사업 제외
      .limit(5000),
    supabase.from("clients").select("name,aliases,category").eq("is_priority", true).eq("status", "active"),
    supabase.from("watchlist").select("analysis_status,proposal_status,decision"),
    supabase.from("daily_brief").select("brief_date,summary,top_bids").order("brief_date", { ascending: false }).limit(1).maybeSingle(),
    supabase.from("collect_cursor").select("last_reg_dt").order("updated_at", { ascending: false }).limit(1).maybeSingle(),
    supabase.from("bids").select("bid_no", head).is("archived_at", null).or(notClosed), // 노출=미아카이브+마감전
    supabase.from("bids").select("bid_no", head).not("archived_at", "is", null),
    supabase.from("rules").select("id", head).eq("is_active", true),
    supabase.from("clients").select("client_id", head),
    supabase.from("bid_attachments").select("bid_no").limit(5000),
  ]);

  // 첨부 정규화된 고유 공고 수 (아카이브 무관 — 근사)
  const attSet = new Set<string>();
  for (const a of (attRes.data as { bid_no: string }[] | null) ?? []) attSet.add(a.bid_no);

  const bids: DashBid[] = ((bidsRes.data as Record<string, unknown>[] | null) ?? []).map((b) => ({
    bid_no: b.bid_no as string,
    bid_seq: b.bid_seq as string,
    title: (b.title as string) ?? null,
    order_org: (b.order_org as string) ?? null,
    demand_org: (b.demand_org as string) ?? null,
    status: (b.status as string) ?? null,
    notice_dt: (b.notice_dt as string) ?? null,
    deadline_dt: (b.deadline_dt as string) ?? null,
    est_price: (b.est_price as number) ?? null,
    score: (b.score as number) ?? 0,
    // 주력사업 점수 = base − exclude. breakdown 없으면 총점 폴백 (lib/queries/score.ts 공유 헬퍼)
    coreScore: coreScore(b.ai_flags, b.score as number),
    ai_score: (b.ai_score as number) ?? null,
    has_summary: !!b.ai_summary,
    tags: (b.tags as string[]) ?? null,
    rescored_at: ((b.ai_flags as Record<string, unknown> | null)?.rescored_at as string) ?? null,
  }));

  return {
    bids,
    clients: (clientsRes.data as DashClient[]) ?? [],
    watch: (watchRes.data as DashWatch[]) ?? [],
    brief: (briefRes.data as DashboardData["brief"]) ?? null,
    lastCollect: (cursorRes.data as { last_reg_dt: string } | null)?.last_reg_dt ?? null,
    totalBids: totalRes.count ?? 0,
    archivedBids: archivedRes.count ?? 0,
    rulesActive: rulesRes.count ?? 0,
    clientsCount: clientsCntRes.count ?? 0,
    attBidCount: attSet.size,
  };
}
