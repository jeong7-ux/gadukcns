import type { SupabaseClient } from "@supabase/supabase-js";
import { coreScore } from "@/lib/queries/score";
import { keepLatestSeq, keepFirstSeq, collapseRebids } from "@/lib/queries/dedupe";
import { notClosedOr } from "@/lib/queries/deadline";

// S-10 대시보드 v3 집계용 원천 데이터 로드. 미아카이브 + 마감전 공고 + 부가 데이터를 병렬 조회.
export interface DashboardData {
  bids: DashBid[];
  clients: DashClient[];
  watch: DashWatch[];
  groups: DashGroup[]; // keyword_groups (감리/컨설팅 분류용)
  trendBids: { bid_no: string; bid_seq: string; notice_dt: string | null; biz_category: "감리" | "컨설팅" | null }[]; // 마감 무관 전체(추이용·최초 차수)
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
  biz_category: "감리" | "컨설팅" | null; // 수집 시 AI 분류(권위값). null이면 프론트 키워드 분류 폴백
  needs_review: boolean;
}
export interface DashClient {
  name: string;
  aliases: string[] | null;
  category: string;
}
export interface DashWatch {
  bid_no: string;
  bid_seq: string;
  analysis_status: string;
  proposal_status: string;
  decision: string;
}
export interface DashGroup {
  name: string;
  keywords: string[];
  exclude: string[] | null;
}

export async function fetchDashboardData(
  supabase: SupabaseClient
): Promise<DashboardData> {
  const head = { count: "exact" as const, head: true };
  // 마감된 사업 제외: deadline_dt ≥ 오늘(로컬). 마감 미정이면 개찰일(open_dt)로 판정. S-04와 동일 기준.
  const todayStr = new Date().toISOString().slice(0, 10);
  const notClosed = notClosedOr(todayStr);

  const [
    bidsRes,
    clientsRes,
    watchRes,
    groupsRes,
    briefRes,
    cursorRes,
    totalRes,
    archivedRes,
    rulesRes,
    clientsCntRes,
    attRes,
    trendRes,
  ] = await Promise.all([
    supabase
      .from("bids")
      .select(
        "bid_no,bid_seq,title,order_org,demand_org,status,notice_dt,deadline_dt,est_price,score,ai_score,ai_summary,tags,ai_flags,biz_category,classify"
      )
      .is("archived_at", null)
      .or(notClosed) // 마감된 사업 제외
      .limit(5000),
    supabase.from("clients").select("name,aliases,category").eq("is_priority", true).eq("status", "active"),
    supabase.from("watchlist").select("bid_no,bid_seq,analysis_status,proposal_status,decision"),
    supabase.from("keyword_groups").select("name,keywords,exclude"),
    supabase.from("daily_brief").select("brief_date,summary,top_bids").order("brief_date", { ascending: false }).limit(1).maybeSingle(),
    supabase.from("collect_cursor").select("last_reg_dt").order("updated_at", { ascending: false }).limit(1).maybeSingle(),
    supabase.from("bids").select("bid_no", head).is("archived_at", null).or(notClosed), // 노출=미아카이브+마감전
    supabase.from("bids").select("bid_no", head).not("archived_at", "is", null),
    supabase.from("rules").select("id", head).eq("is_active", true),
    supabase.from("clients").select("client_id", head),
    supabase.from("bid_attachments").select("bid_no").limit(5000),
    // 추이용: 마감 무관 전체 감리/컨설팅(공고일 기준 추이 — 마감된 공고도 포함)
    //   차수 정리를 위해 bid_no/bid_seq도 함께 조회(최초 차수 = 신규 등록일).
    supabase
      .from("bids")
      .select("bid_no,bid_seq,notice_dt,biz_category")
      .is("archived_at", null)
      .not("biz_category", "is", null)
      .limit(8000),
  ]);

  // 첨부 정규화된 고유 공고 수 (아카이브 무관 — 근사)
  const attSet = new Set<string>();
  for (const a of (attRes.data as { bid_no: string }[] | null) ?? []) attSet.add(a.bid_no);

  // 중복 정리(목록·KPI·도넛 공통): ① 최신 차수만 ② 재공고는 최신 1건만
  const bidRows = collapseRebids(
    keepLatestSeq(
      ((bidsRes.data as (Record<string, unknown> & {
        bid_no: string;
        bid_seq: string;
        title: string | null;
        order_org: string | null;
        notice_dt: string | null;
        deadline_dt: string | null;
      })[] | null) ?? [])
    )
  );

  const bids: DashBid[] = bidRows.map((b) => ({
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
    biz_category: (b.biz_category as "감리" | "컨설팅" | null) ?? null,
    needs_review: !!(b.classify as Record<string, unknown> | null)?.needs_review,
  }));

  return {
    bids,
    clients: (clientsRes.data as DashClient[]) ?? [],
    watch: (watchRes.data as DashWatch[]) ?? [],
    groups: (groupsRes.data as DashGroup[]) ?? [],
    // 정정공고(001/002)가 신규 등록으로 중복 계상되지 않도록 최초 차수만 집계
    trendBids: keepFirstSeq((trendRes.data as DashboardData["trendBids"]) ?? []),
    brief: (briefRes.data as DashboardData["brief"]) ?? null,
    lastCollect: (cursorRes.data as { last_reg_dt: string } | null)?.last_reg_dt ?? null,
    totalBids: totalRes.count ?? 0,
    archivedBids: archivedRes.count ?? 0,
    rulesActive: rulesRes.count ?? 0,
    clientsCount: clientsCntRes.count ?? 0,
    attBidCount: attSet.size,
  };
}
