/**
 * D-day 계산 + 3구간(마감 임박도) 토큰 매핑 (스토리보드 2.2).
 * D0~3 urgent(#DC2626) · D4~6 soon(#EA580C) · D7~9 near(#EAB308) · D10+ far(#64748B)
 * 색상 HEX는 여기서 다루지 않는다 — Tailwind 토큰 클래스명만 반환.
 */

import type { BidStatus } from "@/lib/supabase/types";

export type DdayBucket = "urgent" | "soon" | "near" | "far" | "past";

export interface DdayInfo {
  days: number | null; // 오늘 기준 남은 일수(음수=지남)
  bucket: DdayBucket;
  label: string; // 예: "D-3", "D-DAY", "D+2", "-"
}

/** 자정 기준 남은 일수 계산 */
export function daysUntil(deadline: string | Date | null): number | null {
  if (!deadline) return null;
  const d = typeof deadline === "string" ? new Date(deadline) : deadline;
  if (Number.isNaN(d.getTime())) return null;
  const today = new Date();
  const a = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const b = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

export function ddayBucket(days: number | null): DdayBucket {
  if (days === null) return "far";
  if (days < 0) return "past";
  if (days <= 3) return "urgent";
  if (days <= 6) return "soon";
  if (days <= 9) return "near";
  return "far";
}

export function ddayInfo(deadline: string | Date | null): DdayInfo {
  const days = daysUntil(deadline);
  const bucket = ddayBucket(days);
  let label = "-";
  if (days !== null) {
    if (days === 0) label = "D-DAY";
    else if (days > 0) label = `D-${days}`;
    else label = `D+${Math.abs(days)}`;
  }
  return { days, bucket, label };
}

/**
 * 마감상태 파생 (D-day와 동일 소스 deadline_dt에서 계산).
 * `bids.status`는 서버 일 배치(refresh_bids_status() RPC)로만 갱신되어
 * 첫 배치 전엔 null일 수 있으므로, 표시용 상태는 deadline_dt에서 실시간 파생한다.
 *   deadline_dt null → null · 날짜 > 오늘 → 'ongoing' · == 오늘 → 'today' · else 'closed'
 */
export function deriveStatus(deadline: string | Date | null): BidStatus | null {
  const days = daysUntil(deadline);
  if (days === null) return null;
  if (days > 0) return "ongoing";
  if (days === 0) return "today";
  return "closed";
}

/** 배경/텍스트용 Tailwind 클래스 (pill) */
export const DDAY_PILL_CLASS: Record<DdayBucket, string> = {
  urgent: "bg-dday-urgent/10 text-dday-urgent ring-1 ring-dday-urgent/30",
  soon: "bg-dday-soon/10 text-dday-soon ring-1 ring-dday-soon/30",
  near: "bg-dday-near/10 text-dday-near ring-1 ring-dday-near/30",
  far: "bg-dday-far/10 text-dday-far ring-1 ring-dday-far/30",
  past: "bg-dday-far/10 text-dday-far ring-1 ring-dday-far/30",
};
