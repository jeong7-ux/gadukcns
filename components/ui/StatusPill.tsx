import type { BidStatus } from "@/lib/supabase/types";

/**
 * bids.status pill (스토리보드 2 / 계약 §3).
 * ongoing 녹색(#16A34A) · today 빨강(#DC2626) · closed 회색
 */
const MAP: Record<BidStatus, { label: string; cls: string }> = {
  ongoing: { label: "진행중", cls: "bg-success/10 text-success ring-1 ring-success/30" },
  today: { label: "오늘마감", cls: "bg-danger/10 text-danger ring-1 ring-danger/30" },
  closed: { label: "마감", cls: "bg-muted/10 text-muted ring-1 ring-muted/30" },
};

export function StatusPill({ status }: { status: BidStatus | null }) {
  if (!status) return null;
  const s = MAP[status];
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${s.cls}`}
    >
      {s.label}
    </span>
  );
}
