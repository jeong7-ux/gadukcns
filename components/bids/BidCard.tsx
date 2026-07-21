import Link from "next/link";
import type { Bid } from "@/lib/supabase/types";
import { DdayPill } from "@/components/ui/DdayPill";
import { fmtDate, fmtWon } from "@/lib/utils/format";
import { deadlineView } from "@/lib/queries/deadline";

/** S-04 입찰 카드: 공고명·기관·마감·점수·상태 pill·D-day. 고객사 공고는 강조(FR-18) */
export function BidCard({ bid }: { bid: Bid }) {
  const isClient = !!bid.client_name;
  // 마감일이 없는 공고(협상계약류)는 개찰일을 라벨과 함께 병기
  const dl = deadlineView(bid);
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
          <span className="animate-blink inline-flex items-center gap-1 rounded bg-accent/10 px-1.5 py-0.5 text-[11px] font-semibold text-accent ring-1 ring-accent/40">
            ⭐ 고객사 · {bid.client_name}
          </span>
        </div>
      )}
      <div className="mb-2 flex items-start justify-between gap-3">
        <h3 className="line-clamp-2 text-sm font-semibold text-text">
          {bid.title ?? "(제목 없음)"}
        </h3>
        <div className="flex shrink-0 flex-col items-end gap-1">
          {dl.dt && <DdayPill deadline={dl.dt} />}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-subtle">
        <span>발주 {bid.order_org ?? "-"}</span>
        {bid.contract_method && <span>· {bid.contract_method}</span>}
        <span>· 추정가 {fmtWon(bid.est_price)}</span>
      </div>

      {/* 공고일 · 마감일 구분 */}
      <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px]">
        <span className="flex items-center gap-1">
          <span className="rounded bg-bg px-1 text-[10px] text-subtle ring-1 ring-border">공고일</span>
          <span className="text-text">{bid.notice_dt ? fmtDate(bid.notice_dt) : "-"}</span>
        </span>
        {dl.dt && (
          <span className="flex items-center gap-1">
            <span
              className={`rounded px-1 text-[10px] ${
                dl.isOpen ? "bg-primary/10 text-primary" : "bg-dday-urgent/10 text-dday-urgent"
              }`}
              title={dl.isOpen ? "입찰마감일시가 없는 공고(협상계약 등) — 개찰일시 기준" : undefined}
            >
              {dl.label}일
            </span>
            <span className="text-text">{fmtDate(dl.dt)}</span>
          </span>
        )}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
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
