"use client";

// S-04 입찰 목록(메인) — FR-07(Realtime)/13(키워드)/14(상태). active 전체.
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getSupabaseClient } from "@/lib/supabase/client";
import { fetchBids, fetchKeywordGroups } from "@/lib/queries/bids";
import { useRealtimeInvalidate } from "@/lib/hooks/useRealtimeInvalidate";
import {
  FilterBar,
  EMPTY_FILTERS,
  type BidFilters,
} from "@/components/bids/FilterBar";
import { BidCard } from "@/components/bids/BidCard";
import { CleanupPanel } from "@/components/bids/CleanupPanel";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { Pill } from "@/components/ui/Pill";
import { useSession } from "@/lib/auth/SessionProvider";

export default function DashboardPage() {
  const supabase = getSupabaseClient();
  const { role } = useSession();
  const [filters, setFilters] = useState<BidFilters>(EMPTY_FILTERS);

  const groupsQ = useQuery({
    queryKey: ["keyword_groups"],
    queryFn: () => fetchKeywordGroups(supabase),
  });

  const group = useMemo(
    () =>
      groupsQ.data?.find((g) => g.group_id === filters.groupId) ?? null,
    [groupsQ.data, filters.groupId]
  );

  const bidsQ = useQuery({
    queryKey: ["bids", filters],
    queryFn: () => fetchBids(supabase, filters, group),
  });

  // FR-07 실시간 구독 (bids 변경 시 목록 자동 갱신)
  const { connected } = useRealtimeInvalidate("bids", ["bids"]);

  return (
    <div>
      <PageHeader
        title="입찰 목록"
        screen="S-04"
        desc="나라장터 수집·AI 분석 공고를 실시간으로 확인합니다."
        action={
          <div className="flex items-center gap-2">
            <Pill tone={connected ? "success" : "muted"}>
              {connected ? "실시간 연결됨" : "실시간 대기 · 수동 새로고침"}
            </Pill>
            <button
              onClick={() => bidsQ.refetch()}
              className="rounded-md px-2.5 py-1.5 text-xs text-subtle ring-1 ring-border hover:bg-bg"
            >
              새로고침
            </button>
          </div>
        }
      />

      {role === "admin" && <CleanupPanel />}

      <FilterBar
        value={filters}
        onChange={setFilters}
        groups={groupsQ.data ?? []}
      />

      {bidsQ.isLoading ? (
        <p className="text-sm text-subtle">불러오는 중…</p>
      ) : bidsQ.isError ? (
        <EmptyState
          title="공고를 불러올 수 없습니다"
          hint="권한(RLS) 또는 네트워크를 확인하세요. 로그인 상태가 active인지 확인이 필요합니다."
        />
      ) : (bidsQ.data?.length ?? 0) === 0 ? (
        <EmptyState
          title="조건에 맞는 공고가 없습니다"
          hint="필터를 조정하거나 초기화해 보세요."
        />
      ) : (
        <>
          <p className="mb-2 text-xs text-subtle">
            총 {bidsQ.data!.length}건
          </p>
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 xl:grid-cols-3">
            {bidsQ.data!.map((b) => (
              <BidCard key={`${b.bid_no}-${b.bid_seq}`} bid={b} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
