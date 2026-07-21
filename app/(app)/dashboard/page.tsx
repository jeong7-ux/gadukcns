"use client";

// S-04 입찰 목록(메인) — FR-07(Realtime). 탭(전체/감리/컨설팅) · 수집일 최신순 · 검색.
import { Suspense, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { getSupabaseClient } from "@/lib/supabase/client";
import { fetchBids } from "@/lib/queries/bids";
import { EMPTY_FILTERS } from "@/components/bids/FilterBar";
import { ddayInfo, DEADLINE_BUCKETS, type DeadlineBucketKey } from "@/lib/design/dday";
import { effectiveDeadline } from "@/lib/queries/deadline";
import { useRealtimeInvalidate } from "@/lib/hooks/useRealtimeInvalidate";
import { BidCard } from "@/components/bids/BidCard";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";

type Tab = "전체" | "감리" | "컨설팅";
const norm = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();

export default function DashboardPage() {
  return (
    <Suspense fallback={<p className="text-sm text-subtle">불러오는 중…</p>}>
      <DashboardInner />
    </Suspense>
  );
}

function DashboardInner() {
  const supabase = getSupabaseClient();
  const [q, setQ] = useState("");

  // S-10 '입찰 공고 요약' KPI 연동 (URL 파라미터): 당일신규(today)·감리/컨설팅(cat)
  const searchParams = useSearchParams();
  const cat = ["감리", "컨설팅"].includes(searchParams.get("cat") ?? "")
    ? (searchParams.get("cat") as "감리" | "컨설팅")
    : null;
  const isToday = searchParams.get("new") === "today";
  const [tab, setTab] = useState<Tab>(cat ?? "전체"); // cat 파라미터는 초기 탭으로
  // 마감 임박도 필터(S-10 도넛과 동일 구간). null = 전체
  const [dl, setDl] = useState<DeadlineBucketKey | null>(null);

  const bidsQ = useQuery({
    queryKey: ["bids", isToday],
    // 노출 감리/컨설팅 전체를 수집(showAll: 주력점수 우회) → 탭/검색은 클라이언트에서. today면 당일만.
    queryFn: () => fetchBids(supabase, EMPTY_FILTERS, null, { today: isToday, showAll: true }),
  });

  // FR-07 실시간 구독 (bids 변경 시 목록 자동 갱신)
  useRealtimeInvalidate("bids", ["bids"]);

  // 수집일(공고 등록일) 최신순 정렬 → 검색 → 탭 카운트 → 탭 필터
  const all = [...(bidsQ.data ?? [])].sort((a, b) => {
    const ta = a.notice_dt ? new Date(a.notice_dt).getTime() : 0;
    const tb = b.notice_dt ? new Date(b.notice_dt).getTime() : 0;
    return tb - ta;
  });
  const query = norm(q);
  const searched = query
    ? all.filter((b) => norm(`${b.title ?? ""} ${b.order_org ?? ""} ${b.demand_org ?? ""} ${b.bid_no}`).includes(query))
    : all;
  const counts = {
    전체: searched.length,
    감리: searched.filter((b) => b.biz_category === "감리").length,
    컨설팅: searched.filter((b) => b.biz_category === "컨설팅").length,
  };
  const tabbed = tab === "전체" ? searched : searched.filter((b) => b.biz_category === tab);

  // 마감 임박도: 유효 마감(deadline_dt ?? open_dt) 기준 D-day로 분류 — 서버 왕복 없음.
  //   카운트는 현재 탭 기준(칩이 탭의 하위 필터이므로), 값이 0인 구간은 숨긴다(선택 중이면 유지).
  const ddOf = (b: (typeof tabbed)[number]) => ddayInfo(effectiveDeadline(b)).days;
  const dlBuckets = DEADLINE_BUCKETS.map((bk) => ({
    ...bk,
    count: tabbed.filter((b) => bk.match(ddOf(b))).length,
  })).filter((bk) => bk.count > 0 || dl === bk.key);
  const shown = dl === null ? tabbed : tabbed.filter((b) => DEADLINE_BUCKETS.find((bk) => bk.key === dl)!.match(ddOf(b)));

  return (
    <div>
      <PageHeader
        title="입찰 목록"
        screen="S-04"
        desc="나라장터 수집·AI 분석 공고를 실시간으로 확인합니다."
      />

      {isToday && (
        <div className="mb-3 flex items-center justify-between rounded-lg bg-primary/5 px-3 py-2 text-xs ring-1 ring-primary/20">
          <span className="text-text">
            입찰 공고 요약에서 선택: <b className="text-primary">당일신규</b> 조건으로 조회 중
          </span>
          <Link href="/dashboard" className="shrink-0 text-accent hover:underline">
            조건 해제(전체 보기)
          </Link>
        </div>
      )}

      {/* 검색 바 (공고명 · 발주기관 · 공고번호) */}
      <div className="mb-3">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="공고명 · 발주기관 · 공고번호 검색"
          className="w-full rounded-lg bg-surface px-3 py-2 text-sm text-text ring-1 ring-border placeholder:text-subtle focus:outline-none focus:ring-2 focus:ring-primary"
        />
      </div>

      {/* 탭(전체/감리/컨설팅) + 수집일 최신순 */}
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        {(["전체", "감리", "컨설팅"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`rounded-full px-3 py-1 text-xs font-medium ring-1 transition ${
              tab === t ? "bg-primary text-white ring-primary" : "bg-bg text-subtle ring-border hover:text-text"
            }`}
          >
            {t} <span className="opacity-70">{counts[t]}</span>
          </button>
        ))}
        <span className="ml-auto text-xs text-subtle">수집일 최신순</span>
      </div>

      {/* 마감 임박도 필터 (S-10 '입찰 마감 현황' 도넛과 동일 구간) */}
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        <span className="mr-0.5 text-[11px] text-subtle">마감</span>
        <button
          onClick={() => setDl(null)}
          className={`rounded-full px-2.5 py-1 text-[11px] font-medium ring-1 transition ${
            dl === null ? "bg-primary text-white ring-primary" : "bg-bg text-subtle ring-border hover:text-text"
          }`}
        >
          전체 <span className="opacity-70">{tabbed.length}</span>
        </button>
        {dlBuckets.map((bk) => (
          <button
            key={bk.key}
            onClick={() => setDl(dl === bk.key ? null : bk.key)}
            className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium ring-1 transition ${
              dl === bk.key ? "bg-primary text-white ring-primary" : "bg-bg text-subtle ring-border hover:text-text"
            }`}
          >
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ background: `var(${bk.colorVar}, ${bk.fb})` }}
              aria-hidden
            />
            {bk.chip} <span className="opacity-70">{bk.count}</span>
          </button>
        ))}
      </div>

      {bidsQ.isLoading ? (
        <p className="text-sm text-subtle">불러오는 중…</p>
      ) : bidsQ.isError ? (
        <EmptyState
          title="공고를 불러올 수 없습니다"
          hint="권한(RLS) 또는 네트워크를 확인하세요. 로그인 상태가 active인지 확인이 필요합니다."
        />
      ) : shown.length === 0 ? (
        <EmptyState
          title={
            query
              ? "검색 결과가 없습니다"
              : dl
                ? `'${DEADLINE_BUCKETS.find((bk) => bk.key === dl)!.chip}' 공고가 없습니다`
                : `${tab === "전체" ? "" : tab + " "}공고가 없습니다`
          }
          hint="공고명 · 발주기관 · 공고번호로 검색하거나 다른 탭 · 마감 구간을 선택해 보세요."
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 xl:grid-cols-3">
          {shown.map((b) => (
            <BidCard key={`${b.bid_no}-${b.bid_seq}`} bid={b} />
          ))}
        </div>
      )}
    </div>
  );
}
