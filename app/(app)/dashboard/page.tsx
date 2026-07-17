"use client";

// S-04 입찰 목록(메인) — FR-07(Realtime). 탭(전체/감리/컨설팅) · 수집일 최신순 · 검색.
import { Suspense, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { getSupabaseClient } from "@/lib/supabase/client";
import { fetchBids } from "@/lib/queries/bids";
import { EMPTY_FILTERS } from "@/components/bids/FilterBar";
import { useRealtimeInvalidate } from "@/lib/hooks/useRealtimeInvalidate";
import { BidCard } from "@/components/bids/BidCard";
import { CleanupPanel } from "@/components/bids/CleanupPanel";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { useSession } from "@/lib/auth/SessionProvider";

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
  const { role } = useSession();
  const [q, setQ] = useState("");

  // S-10 '입찰 공고 요약' KPI 연동 (URL 파라미터): 당일신규(today)·감리/컨설팅(cat)
  const searchParams = useSearchParams();
  const cat = ["감리", "컨설팅"].includes(searchParams.get("cat") ?? "")
    ? (searchParams.get("cat") as "감리" | "컨설팅")
    : null;
  const isToday = searchParams.get("new") === "today";
  const [tab, setTab] = useState<Tab>(cat ?? "전체"); // cat 파라미터는 초기 탭으로

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
  const shown = tab === "전체" ? searched : searched.filter((b) => b.biz_category === tab);

  return (
    <div>
      <PageHeader
        title="입찰 목록"
        screen="S-04"
        desc="나라장터 수집·AI 분석 공고를 실시간으로 확인합니다."
      />

      {role === "admin" && <CleanupPanel />}

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

      {bidsQ.isLoading ? (
        <p className="text-sm text-subtle">불러오는 중…</p>
      ) : bidsQ.isError ? (
        <EmptyState
          title="공고를 불러올 수 없습니다"
          hint="권한(RLS) 또는 네트워크를 확인하세요. 로그인 상태가 active인지 확인이 필요합니다."
        />
      ) : shown.length === 0 ? (
        <EmptyState
          title={query ? "검색 결과가 없습니다" : `${tab === "전체" ? "" : tab + " "}공고가 없습니다`}
          hint="공고명 · 발주기관 · 공고번호로 검색하거나 다른 탭을 선택해 보세요."
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
