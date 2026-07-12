import Link from "next/link";
import type { Bid } from "@/lib/supabase/types";
import { StatusPill } from "@/components/ui/StatusPill";
import { DdayPill } from "@/components/ui/DdayPill";
import { deriveStatus } from "@/lib/design/dday";
import { fmtDate, fmtWon } from "@/lib/utils/format";

/** S-04 입찰 카드: 공고명·기관·마감·점수·상태 pill·D-day. 고객사 공고는 강조(FR-18) */
export function BidCard({ bid }: { bid: Bid }) {
  const isClient = !!bid.client_name;
  return (
    <Link
      href={`/bids/${encodeURIComponent(bid.bid_no)}`}
      className={`block rounded-card border p-4 shadow-card transition-colors hover:border-accent ${
        isClient
          ? "border-accent/40 bg-priority ring-1 ring-accent/20"
          : "border-border bg-surface"
      }`}
    >
      {isClient && (
        <div className="mb-1.5">
          <span className="inline-flex items-center gap-1 rounded bg-accent/10 px-1.5 py-0.5 text-[11px] font-semibold text-accent">
            ⭐ 고객사 · {bid.client_name}
          </span>
        </div>
      )}
      <div className="mb-2 flex items-start justify-between gap-3">
        <h3 className="line-clamp-2 text-sm font-semibold text-text">
          {bid.title ?? "(제목 없음)"}
        </h3>
        <div className="flex shrink-0 flex-col items-end gap-1">
          {/* 상태 pill: deadline_dt에서 실시간 파생(우선), 서버 status는 폴백 */}
          <StatusPill status={deriveStatus(bid.deadline_dt) ?? bid.status} />
          <DdayPill deadline={bid.deadline_dt} />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-subtle">
        <span>발주 {bid.order_org ?? "-"}</span>
        {bid.contract_method && <span>· {bid.contract_method}</span>}
        <span>· 마감 {fmtDate(bid.deadline_dt)}</span>
        <span>· 추정가 {fmtWon(bid.est_price)}</span>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[11px] font-semibold text-primary">
          점수 {bid.score}
        </span>
        {bid.ai_score !== null && bid.ai_score !== undefined && (
          <span className="rounded bg-accent/10 px-1.5 py-0.5 text-[11px] font-semibold text-accent">
            AI {bid.ai_score}
          </span>
        )}
        {(bid.tags ?? []).slice(0, 3).map((t) => (
          <span
            key={t}
            className="rounded bg-bg px-1.5 py-0.5 text-[11px] text-subtle ring-1 ring-border"
          >
            #{t}
          </span>
        ))}
        {(bid.attachment_count ?? 0) > 0 && (
          <span
            className="rounded bg-bg px-1.5 py-0.5 text-[11px] font-medium text-subtle ring-1 ring-border"
            title="첨부파일 있음"
          >
            📎 첨부 {bid.attachment_count}
          </span>
        )}
      </div>
    </Link>
  );
}
