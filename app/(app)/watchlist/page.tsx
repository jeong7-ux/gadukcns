"use client";

// S-07 관심 목록 — FR-08. 접근: strategy/pm/admin.
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { getSupabaseClient } from "@/lib/supabase/client";
import { CAN_WATCH_WRITE } from "@/lib/auth/roles";
import { useSession } from "@/lib/auth/SessionProvider";
import { RoleGuard } from "@/components/layout/RoleGuard";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card } from "@/components/ui/Card";
import { DdayPill } from "@/components/ui/DdayPill";
import { Pill } from "@/components/ui/Pill";
import { EmptyState } from "@/components/ui/EmptyState";
import { AnalysisModal } from "@/components/watch/AnalysisModal";
import { requestAnalysis } from "@/lib/queries/analysis";
import { daysUntil } from "@/lib/design/dday";
import { fmtDate, fmtWon } from "@/lib/utils/format";
import type { WatchItem, AnalysisStatus } from "@/lib/supabase/types";

export default function WatchlistPage() {
  return (
    <RoleGuard allow={CAN_WATCH_WRITE}>
      <WatchlistInner />
    </RoleGuard>
  );
}

const ANALYSIS_TONE: Record<AnalysisStatus, "muted" | "accent" | "success"> = {
  none: "muted",
  requested: "accent",
  in_progress: "accent",
  done: "success",
};
const ANALYSIS_LABEL: Record<AnalysisStatus, string> = {
  none: "미요청",
  requested: "분석요청",
  in_progress: "AI분석중",
  done: "분석완료",
};
const PROPOSAL_TONE = { none: "muted", writing: "accent", done: "success" } as const;
const PROPOSAL_LABEL = { none: "미작성", writing: "작성중", done: "완료" };
const DECISION_LABEL = { review: "검토", join: "참여", drop: "포기" };

interface WatchRow extends WatchItem {
  title: string | null;
  order_org: string | null;
  est_price: number | null;
}

function WatchlistInner() {
  const supabase = getSupabaseClient();
  const qc = useQueryClient();
  const { role } = useSession();
  const isAdmin = role === "admin";
  const [modalBid, setModalBid] = useState<WatchRow | null>(null);

  async function handleRequest(w: WatchRow) {
    try {
      await requestAnalysis(supabase, w.bid_no, w.bid_seq);
      qc.invalidateQueries({ queryKey: ["watchlist"] });
    } catch {
      alert("분석 요청 실패 — supabase/analysis_reports.sql 적용 여부/권한을 확인하세요.");
    }
  }

  const q = useQuery({
    queryKey: ["watchlist"],
    queryFn: async (): Promise<WatchRow[]> => {
      const { data, error } = await supabase.from("watchlist").select("*");
      if (error) throw error;
      const wl = (data as WatchItem[]) ?? [];
      // bids 상세(발주기관·사업명·사업금액) 조인
      const bidNos = [...new Set(wl.map((w) => w.bid_no))];
      const map = new Map<string, { title: string | null; order_org: string | null; est_price: number | null }>();
      if (bidNos.length > 0) {
        const { data: bids } = await supabase
          .from("bids")
          .select("bid_no,bid_seq,title,order_org,est_price")
          .in("bid_no", bidNos);
        for (const b of (bids as { bid_no: string; bid_seq: string; title: string | null; order_org: string | null; est_price: number | null }[]) ?? []) {
          map.set(`${b.bid_no}|${b.bid_seq}`, b);
        }
      }
      return wl
        .map((w) => ({
          ...w,
          title: map.get(`${w.bid_no}|${w.bid_seq}`)?.title ?? null,
          order_org: map.get(`${w.bid_no}|${w.bid_seq}`)?.order_org ?? null,
          est_price: map.get(`${w.bid_no}|${w.bid_seq}`)?.est_price ?? null,
        }))
        .sort((a, b) => (daysUntil(a.deadline_dt) ?? 9999) - (daysUntil(b.deadline_dt) ?? 9999));
    },
  });

  async function setDecision(w: WatchRow, decision: WatchItem["decision"]) {
    await supabase.from("watchlist").update({ decision }).eq("bid_no", w.bid_no).eq("bid_seq", w.bid_seq);
    qc.invalidateQueries({ queryKey: ["watchlist"] });
  }

  return (
    <div>
      <PageHeader
        title="관심 목록"
        screen="S-07"
        desc="관심 공고의 발주기관·사업금액·마감일과 분석·제안 진행단계를 관리합니다. (D-day 임박순)"
      />
      {q.isLoading ? (
        <p className="text-sm text-subtle">불러오는 중…</p>
      ) : (q.data?.length ?? 0) === 0 ? (
        <EmptyState
          title="관심 공고가 없습니다"
          hint="입찰 상세(S-06)에서 ‘관심 추가’로 담을 수 있습니다."
        />
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[860px] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-subtle">
                <th className="px-4 py-2.5 font-medium">사업명</th>
                <th className="px-4 py-2.5 font-medium">발주기관</th>
                <th className="px-4 py-2.5 font-medium">사업금액</th>
                <th className="px-4 py-2.5 font-medium">마감일</th>
                <th className="px-4 py-2.5 font-medium">진행단계</th>
                <th className="px-4 py-2.5 font-medium">결정</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {q.data!.map((w) => (
                <tr key={`${w.bid_no}-${w.bid_seq}`} className="align-top hover:bg-bg">
                  {/* 사업명 */}
                  <td className="px-4 py-3">
                    <Link
                      href={`/bids/${encodeURIComponent(w.bid_no)}`}
                      className="font-medium text-text hover:text-primary hover:underline"
                    >
                      {w.title ?? w.bid_no}
                    </Link>
                    <p className="text-[11px] text-subtle">{w.bid_no}-{w.bid_seq}</p>
                    {w.memo && <p className="mt-0.5 text-xs text-subtle">📝 {w.memo}</p>}
                  </td>
                  {/* 발주기관 */}
                  <td className="px-4 py-3 text-sm text-text">{w.order_org ?? "-"}</td>
                  {/* 사업금액 */}
                  <td className="px-4 py-3 text-sm font-medium text-text">{fmtWon(w.est_price)}</td>
                  {/* 마감일 + D-day */}
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs text-subtle">{fmtDate(w.deadline_dt)}</span>
                      <DdayPill deadline={w.deadline_dt} />
                    </div>
                  </td>
                  {/* 진행단계 — 분석 워크플로우(요청→업로드→완료) → 제안 */}
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Pill tone={ANALYSIS_TONE[w.analysis_status]}>
                        {ANALYSIS_LABEL[w.analysis_status]}
                      </Pill>
                      {w.analysis_status === "none" && (
                        <button
                          onClick={() => handleRequest(w)}
                          className="rounded px-1.5 py-0.5 text-[11px] text-subtle ring-1 ring-border hover:bg-bg"
                        >
                          분석 요청
                        </button>
                      )}
                      {(w.analysis_status === "requested" ||
                        w.analysis_status === "in_progress") &&
                        isAdmin && (
                          <button
                            onClick={() => setModalBid(w)}
                            className="rounded px-1.5 py-0.5 text-[11px] font-medium text-accent ring-1 ring-accent/40 hover:bg-accent/5"
                          >
                            결과 업로드
                          </button>
                        )}
                      {w.analysis_status === "done" && (
                        <button
                          onClick={() => setModalBid(w)}
                          className="rounded px-1.5 py-0.5 text-[11px] font-medium text-primary ring-1 ring-border hover:bg-bg"
                        >
                          결과 보기
                        </button>
                      )}
                      <span className="text-subtle">›</span>
                      <Pill tone={PROPOSAL_TONE[w.proposal_status]}>
                        제안 {PROPOSAL_LABEL[w.proposal_status]}
                      </Pill>
                    </div>
                  </td>
                  {/* 결정 */}
                  <td className="px-4 py-3">
                    <select
                      value={w.decision}
                      onChange={(e) => setDecision(w, e.target.value as WatchItem["decision"])}
                      className="rounded-md border border-border bg-surface px-2 py-1 text-xs text-text outline-none focus:border-accent"
                    >
                      {(["review", "join", "drop"] as const).map((d) => (
                        <option key={d} value={d}>
                          {DECISION_LABEL[d]}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {modalBid && (
        <AnalysisModal
          bid={{ bid_no: modalBid.bid_no, bid_seq: modalBid.bid_seq, title: modalBid.title }}
          isAdmin={isAdmin}
          onClose={() => setModalBid(null)}
          onChanged={() => qc.invalidateQueries({ queryKey: ["watchlist"] })}
        />
      )}
    </div>
  );
}
