"use client";

// S-07 관심 목록 — FR-08. 접근: strategy/pm/admin.
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getSupabaseClient } from "@/lib/supabase/client";
import { CAN_WATCH_WRITE } from "@/lib/auth/roles";
import { useSession } from "@/lib/auth/SessionProvider";
import { RoleGuard } from "@/components/layout/RoleGuard";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { AnalysisModal } from "@/components/watch/AnalysisModal";
import { InfoCells, InfoHeaders } from "@/components/bids/InfoRowCells";
import { requestAnalysis } from "@/lib/queries/analysis";
import { daysUntil } from "@/lib/design/dday";
import type { WatchItem } from "@/lib/supabase/types";

const norm = (s: string | null) => (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();

export default function WatchlistPage() {
  return (
    <RoleGuard allow={CAN_WATCH_WRITE}>
      <WatchlistInner />
    </RoleGuard>
  );
}

const DECISION_LABEL = { review: "검토", join: "참여", drop: "포기" };
// 진행단계(분석) 상태 값 라벨
const ANALYSIS_LABEL: Record<string, string> = {
  none: "미요청",
  requested: "분석요청",
  in_progress: "AI분석중",
  done: "분석완료",
};

interface WatchRow extends WatchItem {
  title: string | null;
  order_org: string | null;
  demand_org: string | null;
  est_price: number | null;
  needs_review: boolean;
  demand_client: string | null;
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

  // 분석요청 취소 → 상태 초기화(none) → '분석요청' 버튼 다시 활성화
  async function handleCancel(w: WatchRow) {
    await supabase.from("watchlist").update({ analysis_status: "none" }).eq("bid_no", w.bid_no).eq("bid_seq", w.bid_seq);
    qc.invalidateQueries({ queryKey: ["watchlist"] });
  }

  const q = useQuery({
    queryKey: ["watchlist"],
    queryFn: async (): Promise<WatchRow[]> => {
      const { data, error } = await supabase.from("watchlist").select("*");
      if (error) throw error;
      const wl = (data as WatchItem[]) ?? [];
      // bids 상세(발주/수요기관·사업명·금액·분류) 조인 (S-10 입찰 정보 목록과 동일 항목)
      const bidNos = [...new Set(wl.map((w) => w.bid_no))];
      type BJoin = { bid_no: string; bid_seq: string; title: string | null; order_org: string | null; demand_org: string | null; est_price: number | null; classify: { needs_review?: boolean } | null };
      const map = new Map<string, BJoin>();
      let clients: { name: string; keys: string[] }[] = [];
      if (bidNos.length > 0) {
        const { data: bids } = await supabase
          .from("bids")
          .select("bid_no,bid_seq,title,order_org,demand_org,est_price,classify")
          .in("bid_no", bidNos);
        for (const b of (bids as BJoin[]) ?? []) map.set(`${b.bid_no}|${b.bid_seq}`, b);
        // 고객사(수요기관 ⭐) 매칭용
        const { data: cl } = await supabase.from("clients").select("name,aliases").eq("is_priority", true).eq("status", "active");
        clients = ((cl as { name: string; aliases: string[] | null }[]) ?? []).map((c) => ({
          name: c.name,
          keys: [c.name, ...(c.aliases ?? [])].map(norm).filter(Boolean),
        }));
      }
      const matchOrgClient = (org: string | null) => {
        const hay = norm(org);
        if (!hay) return null;
        return clients.find((c) => c.keys.some((k) => hay.includes(k)))?.name ?? null;
      };
      return wl
        .map((w) => {
          const b = map.get(`${w.bid_no}|${w.bid_seq}`);
          return {
            ...w,
            title: b?.title ?? null,
            order_org: b?.order_org ?? null,
            demand_org: b?.demand_org ?? null,
            est_price: b?.est_price ?? null,
            needs_review: !!b?.classify?.needs_review,
            demand_client: matchOrgClient(b?.demand_org ?? null),
          };
        })
        // S-07은 마감된 사업도 관리 차원에서 표시(다른 화면과 달리 숨기지 않음).
        //   정렬: 진행중(D-day 임박순) 먼저 → 마감된 건 뒤로(최근 마감 우선).
        .sort((a, b) => {
          const da = daysUntil(a.deadline_dt);
          const db = daysUntil(b.deadline_dt);
          const ac = da !== null && da < 0;
          const bc = db !== null && db < 0;
          if (ac !== bc) return ac ? 1 : -1; // 마감된 건 뒤로
          if (ac && bc) return (db ?? 0) - (da ?? 0); // 마감끼리: 최근 마감 우선
          return (da ?? 9999) - (db ?? 9999); // 진행중: 임박순(미정은 뒤)
        });
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
        desc="관심 공고의 발주기관·사업금액·마감일과 분석·제안 진행단계를 관리합니다. 마감된 사업도 관리 차원에서 표시(진행중 임박순 → 마감건 뒤)."
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
          <table className="w-full min-w-[900px] text-left text-xs">
            <thead className="border-b border-border text-subtle">
              <tr>
                <InfoHeaders hideStatus />
                <th className="px-3 py-2 font-medium">진행단계</th>
                {isAdmin && <th className="px-3 py-2 font-medium">결정</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {q.data!.map((w) => {
                const closed = (daysUntil(w.deadline_dt) ?? 0) < 0; // 마감 지남
                return (
                <tr key={`${w.bid_no}-${w.bid_seq}`} className={`align-top hover:bg-bg ${closed ? "opacity-60" : ""}`}>
                  {/* S-10 입찰 정보 목록과 동일 6열: 상세·일정정보·기관정보·금액·사업명·공고번호 */}
                  <InfoCells
                    hideStatus
                    bidNo={w.bid_no}
                    title={w.title}
                    orderOrg={w.order_org}
                    demandOrg={w.demand_org}
                    noticeDt={w.notice_dt}
                    deadlineDt={w.deadline_dt}
                    estPrice={w.est_price}
                    needsReview={w.needs_review}
                    demandClient={w.demand_client}
                  />
                  {/* 진행단계 — 상태 값 + 3단계 버튼(미요청→요청·진행중→완료) */}
                  <td className="px-3 py-2">
                    <div className="mb-1 text-[11px] font-medium text-subtle">
                      {ANALYSIS_LABEL[w.analysis_status] ?? w.analysis_status}
                    </div>
                    {w.analysis_status === "done" ? (
                      <button
                        onClick={() => setModalBid(w)}
                        className="inline-flex items-center gap-1 rounded-md bg-success px-3 py-1.5 text-xs font-semibold text-white transition hover:opacity-90"
                      >
                        📄 분석결과
                      </button>
                    ) : w.analysis_status === "none" ? (
                      <button
                        onClick={() => handleRequest(w)}
                        className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-white transition hover:opacity-90"
                      >
                        🔍 분석요청
                      </button>
                    ) : isAdmin ? (
                      // 요청·진행중 · 관리자: 클릭 시 파일 업로드 모달(전부 업로드 후 '분석완료 확정')
                      <button
                        onClick={() => setModalBid(w)}
                        className="inline-flex items-center gap-1 rounded-md bg-dday-soon px-3 py-1.5 text-xs font-semibold text-white transition hover:opacity-90"
                      >
                        ⏳ 분석중 (업로드)
                      </button>
                    ) : (
                      // 요청·진행중 · 일반계정: 대기 안내 메시지 + 취소
                      <div className="inline-flex items-center gap-2">
                        <span className="inline-flex items-center gap-1 rounded-md bg-dday-soon/10 px-3 py-1.5 text-xs font-medium text-dday-soon ring-1 ring-dday-soon/30">
                          ⏳ 분석중입니다. 잠시만 기다려주세요..
                        </span>
                        <button
                          onClick={() => handleCancel(w)}
                          title="분석요청 취소"
                          className="rounded-md px-2.5 py-1.5 text-xs font-medium text-subtle ring-1 ring-border transition hover:bg-bg hover:text-text"
                        >
                          취소
                        </button>
                      </div>
                    )}
                  </td>
                  {/* 결정 — 관리자만 노출(일반계정 숨김) */}
                  {isAdmin && (
                    <td className="px-3 py-2">
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
                  )}
                </tr>
                );
              })}
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
