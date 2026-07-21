import type { SupabaseClient } from "@supabase/supabase-js";
import type { Bid, KeywordGroup } from "@/lib/supabase/types";
import type { BidFilters } from "@/components/bids/FilterBar";
import { coreScore } from "@/lib/queries/score";
import { keepLatestSeq } from "@/lib/queries/dedupe";

const BID_COLS =
  "bid_no,bid_seq,title,order_org,demand_org,contract_method,notice_dt,deadline_dt,open_dt,est_price,status,score,tags,ai_summary,ai_score,ai_flags,biz_category,updated_at";

/**
 * S-04/S-05 공통 입찰 조회. RLS(bids_read: active면 R)에 정렬.
 * 키워드그룹 AND/OR(FR-13)은 title 기준 ilike로 근사 매칭.
 *
 * KPI 연동(S-10 입찰 공고 요약 → S-04): cat(감리/컨설팅)·today(당일신규)·showAll(전체공고).
 *   이 조건들이 오면 "요약 KPI 기준"과 건수를 맞추기 위해 주력점수(coreScore≥4) 필터를 우회한다
 *   — 적재분은 이미 AI 분류(감리/컨설팅)로 선별됐으므로 biz_category가 곧 관련성이다.
 */
export async function fetchBids(
  supabase: SupabaseClient,
  filters: BidFilters,
  group: KeywordGroup | null,
  opts?: { coreOnly?: boolean; cat?: "감리" | "컨설팅" | null; today?: boolean; showAll?: boolean }
): Promise<Bid[]> {
  // KPI 연동 여부 — cat/today/showAll 중 하나라도 있으면 요약 기준 조회(주력필터 우회)
  const kpiMode = !!(opts?.cat || opts?.today || opts?.showAll);
  // coreOnly(S-04 입찰목록): 주력사업 점수(base−exclude) ≥ 4 만 노출. KPI 연동 시엔 우회.
  const coreOnly = !kpiMode && (opts?.coreOnly ?? false);
  // 오늘(로컬) 00:00 이후 마감만 = 입찰 마감 공고 제외
  const todayStr = new Date().toISOString().slice(0, 10);
  let q = supabase
    .from("bids")
    .select(BID_COLS)
    .is("archived_at", null) // 정리(아카이브)된 공고 숨김
    .or(`deadline_dt.gte.${todayStr},deadline_dt.is.null`) // 입찰 마감 사업 제외(마감일 미정은 유지)
    // FR-18: 고객사(org 룰 가중) 공고가 상단에 오도록 점수 우선, 그다음 최신순
    .order("score", { ascending: false })
    .order("notice_dt", { ascending: false })
    .limit(200);
  // 점수 프리필터: KPI 연동이면 우회(전량), coreOnly면 총점≥4, 아니면 총점>2
  if (!kpiMode) q = coreOnly ? q.gte("score", 4) : q.gt("score", 2);

  // KPI 조건: 분류(감리/컨설팅) / 당일신규(notice_dt 오늘 이후)
  if (opts?.cat) q = q.eq("biz_category", opts.cat);
  if (opts?.today) q = q.gte("notice_dt", `${todayStr}T00:00:00`);

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
  // 정정·변경공고(같은 공고번호의 새 차수)는 최신 차수만 노출 — 목록 중복 방지
  const bids = keepLatestSeq((data as Bid[]) ?? []);

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

  // 우선순위 정렬: ① 고객사(⭐) → ② 마감일 임박순(오름차순, 마감일 미정은 뒤로)
  bids.sort((a, b) => {
    const ca = a.client_name ? 1 : 0;
    const cb = b.client_name ? 1 : 0;
    if (cb !== ca) return cb - ca; // ① 고객사 우선
    // ② 마감일 임박순 — 마감일 미정(null)은 맨 뒤로
    const da = a.deadline_dt ?? "9999-12-31";
    const db = b.deadline_dt ?? "9999-12-31";
    return da.localeCompare(db);
  });

  // 주력사업 위주(coreOnly): 주력 점수(base−exclude) ≥ 4 만 노출 (S-10 '마감 임박·액션'과 동일 기준).
  // 발주/고객사 가산만으로 점수가 오른 공고는 목록에서 제외. 검색(coreOnly=false)은 전체 유지.
  if (!coreOnly) return bids;
  const CORE_MIN = 4;
  return bids.filter((b) => coreScore(b.ai_flags, b.score) >= CORE_MIN);
}

export async function fetchKeywordGroups(
  supabase: SupabaseClient
): Promise<KeywordGroup[]> {
  const { data, error } = await supabase.from("keyword_groups").select("*");
  if (error) throw error;
  const groups = (data as KeywordGroup[]) ?? [];
  // 우선 정렬: ① 감리 → ② 정보전략계획·ISP·ISMP 계열 → ③ 그 외는 그룹명(가나다)순.
  //   그룹명/키워드에 우선 키워드가 있으면 상단. exclude는 판정에서 제외(제외어이므로).
  const rankOf = (g: KeywordGroup): number => {
    const hay = `${g.name} ${(g.keywords ?? []).join(" ")}`.toLowerCase();
    if (hay.includes("감리")) return 0;
    if (["정보전략계획", "정보화전략계획", "isp", "ismp"].some((k) => hay.includes(k))) return 1;
    return 2;
  };
  return groups.sort(
    (a, b) => rankOf(a) - rankOf(b) || a.name.localeCompare(b.name, "ko")
  );
}
