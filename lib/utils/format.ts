import { format } from "date-fns";

export function fmtDate(v: string | Date | null, pattern = "yyyy.MM.dd"): string {
  if (!v) return "-";
  const d = typeof v === "string" ? new Date(v) : v;
  if (Number.isNaN(d.getTime())) return "-";
  return format(d, pattern);
}

export function fmtDateTime(v: string | Date | null): string {
  return fmtDate(v, "yyyy.MM.dd HH:mm");
}

/** 원화(억/만 단위 축약) */
export function fmtWon(v: number | null | undefined): string {
  if (v === null || v === undefined) return "-";
  if (v >= 100_000_000) return `${(v / 100_000_000).toFixed(1)}억원`;
  if (v >= 10_000) return `${Math.round(v / 10_000).toLocaleString()}만원`;
  return `${v.toLocaleString()}원`;
}
