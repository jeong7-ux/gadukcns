import type { SupabaseClient } from "@supabase/supabase-js";
import type { Bid, KeywordGroup } from "@/lib/supabase/types";
import type { BidFilters } from "@/components/bids/FilterBar";

const BID_COLS =
  "bid_no,bid_seq,title,order_org,demand_org,contract_method,notice_dt,deadline_dt,open_dt,est_price,status,score,tags,ai_summary,ai_score,ai_flags,updated_at";

/**
 * S-04/S-05 공통 입찰 조회. RLS(bids_read: active면 R)에 정렬.
 * 키워드그룹 AND/OR(FR-13)은 title 기준 ilike로 근사 매칭.
 */
export async function fetchBids(
  supabase: SupabaseClient,
  filters: BidFilters,
  group: KeywordGroup | null
): Promise<Bid[]> {
  // 오늘(로컬) 00:00 이후 마감만 = 입찰 마감 공고 제외
  const todayStr = new Date().toISOString().slice(0, 10);
  let q = supabase
    .from("bids")
    .select(BID_COLS)
    .is("archived_at", null) // 정리(아카이브)된 공고 숨김
    .gt("score", 2) // 가중치 2 이하(score ≤ 2) 사업 제외
    .or(`deadline_dt.gte.${todayStr},deadline_dt.is.null`) // 입찰 마감 사업 제외(마감일 미정은 유지)
    // FR-18: 고객사(org 룰 가중) 공고가 상단에 오도록 점수 우선, 그다음 최신순
    .order("score", { ascending: false })
    .order("notice_dt", { ascending: false })
    .limit(200);

  if (filters.org) q = q.ilike("order_org", `%${filters.org}%`);
  if (filters.contractMethod)
    q = q.ilike("contract_method", `%${filters.contractMethod}%`);
  // 서버 필터: 저장 `status`는 일 배치(refresh_bids_status() RPC)로 갱신됨.
  // 클라이언트 표시는 deriveStatus(deadline_dt) 파생값을 사용(첫 배치 전 null 대비).
  if (filters.status) q = q.eq("status", filters.status);
  if (filters.from) q = q.gte("deadline_dt", filters.from);
  if (filters.to) q = q.lte("deadline_dt", `${filters.to}T23:59:59`);

  // 키워드그룹 매칭 로직 (match_logic AND/OR)
  if (group && group.keywords.length > 0) {
    if (group.match_logic === "OR") {
      const orExpr = group.keywords
        .map((k) => `title.ilike.%${k.replace(/[,()]/g, "")}%`)
        .join(",");
      q = q.or(orExpr);
    } else {
      // AND: 각 키워드를 개별 ilike로 연쇄
      for (const k of group.keywords) {
        q = q.ilike("title", `%${k}%`);
      }
    }
    // 제외어
    for (const ex of group.exclude ?? []) {
      q = q.not("title", "ilike", `%${ex}%`);
    }
  }

  const { data, error } = await q;
  if (error) throw error;
  const bids = (data as Bid[]) ?? [];

  // 첨부 개수 부착 (bid_attachments) — 카드에 '첨부 N' 표시용
  if (bids.length > 0) {
    const bidNos = [...new Set(bids.map((b) => b.bid_no))];
    const { data: atts } = await supabase
      .from("bid_attachments")
      .select("bid_no,bid_seq")
      .in("bid_no", bidNos);
    const cnt = new Map<string, number>();
    for (const a of (atts as { bid_no: string; bid_seq: string }[]) ?? []) {
      const k = `${a.bid_no}|${a.bid_seq}`;
      cnt.set(k, (cnt.get(k) ?? 0) + 1);
    }
    for (const b of bids) {
      b.attachment_count = cnt.get(`${b.bid_no}|${b.bid_seq}`) ?? 0;
    }

    // FR-18: 우선 고객사 매칭 — 발주/수요기관이 고객사명/별칭을 포함하면 client_name 부착
    const { data: clients } = await supabase
      .from("clients")
      .select("name,aliases")
      .eq("is_priority", true)
      .eq("status", "active");
    if (clients && clients.length > 0) {
      const norm = (s: string | null) =>
        (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
      const pats = (clients as { name: string; aliases: string[] | null }[]).map(
        (c) => ({ name: c.name, keys: [c.name, ...(c.aliases ?? [])].map(norm).filter(Boolean) })
      );
      for (const b of bids) {
        const hay = norm(`${b.order_org ?? ""} ${b.demand_org ?? ""}`);
        const hit = pats.find((p) => p.keys.some((k) => hay.includes(k)));
        b.client_name = hit ? hit.name : null;
      }
    }
  }

  // 우선순위 정렬: ① 주력사업(키워드 점수) → ② 고객사 → ③ 최신 공고순
  //   주력사업 점수 = score_breakdown.base(키워드/계약) − exclude. 없으면 총점으로 폴백.
  const kwScore = (b: Bid): number => {
    const bd = b.ai_flags?.score_breakdown as
      | { base?: number; exclude?: number }
      | undefined;
    if (bd && typeof bd.base === "number") return bd.base - (bd.exclude ?? 0);
    return b.score ?? 0;
  };
  bids.sort((a, b) => {
    const kb = kwScore(b) - kwScore(a);
    if (kb !== 0) return kb; // ① 주력사업 관련성
    const ca = a.client_name ? 1 : 0;
    const cb = b.client_name ? 1 : 0;
    if (cb !== ca) return cb - ca; // ② 고객사
    return (b.notice_dt ?? "").localeCompare(a.notice_dt ?? ""); // ③ 최신
  });

  return bids;
}

export async function fetchKeywordGroups(
  supabase: SupabaseClient
): Promise<KeywordGroup[]> {
  const { data, error } = await supabase
    .from("keyword_groups")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data as KeywordGroup[]) ?? [];
}
