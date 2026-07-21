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

/**
 * 마감 임박도 구간 — S-10 '입찰 마감 현황' 도넛과 S-04 상태 필터 **공용 정의**.
 * 두 화면의 구간이 어긋나지 않도록 경계를 한 곳에서만 정한다.
 *   `label` = 도넛 범례(기존 표기 유지) · `chip` = 필터 칩(압축 표기)
 * 입력 `days`는 **유효 마감**(deadline_dt ?? open_dt) 기준 D-day여야 한다.
 * 위 `ddayBucket`(0~3/4~6/7~9/10+)은 pill 색상용 구간으로 목적이 달라 그대로 둔다.
 */
export const DEADLINE_BUCKETS = [
  { key: "today", label: "오늘 마감", chip: "오늘마감", colorVar: "--color-dday-urgent", fb: "#dc2626", match: (d: number | null) => d === 0 },
  { key: "soon", label: "임박 (1~3일)", chip: "임박 1~3일", colorVar: "--color-dday-soon", fb: "#f97316", match: (d: number | null) => d !== null && d >= 1 && d <= 3 },
  { key: "week", label: "이번주 (4~7일)", chip: "이번주 4~7일", colorVar: "--color-dday-near", fb: "#eab308", match: (d: number | null) => d !== null && d >= 4 && d <= 7 },
  { key: "far", label: "여유 (8일+)", chip: "여유 8일+", colorVar: "--color-success", fb: "#16a34a", match: (d: number | null) => d !== null && d >= 8 },
  { key: "none", label: "마감 미정", chip: "마감 미정", colorVar: "--color-text-subtle", fb: "#94a3b8", match: (d: number | null) => d === null },
] as const;

export type DeadlineBucketKey = (typeof DEADLINE_BUCKETS)[number]["key"];

/** 배경/텍스트용 Tailwind 클래스 (pill) */
export const DDAY_PILL_CLASS: Record<DdayBucket, string> = {
  urgent: "bg-dday-urgent/10 text-dday-urgent ring-1 ring-dday-urgent/30",
  soon: "bg-dday-soon/10 text-dday-soon ring-1 ring-dday-soon/30",
  near: "bg-dday-near/10 text-dday-near ring-1 ring-dday-near/30",
  far: "bg-dday-far/10 text-dday-far ring-1 ring-dday-far/30",
  past: "bg-dday-far/10 text-dday-far ring-1 ring-dday-far/30",
};
