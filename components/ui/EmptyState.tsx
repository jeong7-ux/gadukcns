import type { ReactNode } from "react";

/** RLS 거부/빈 결과 공용 빈 상태 (에러 노출 최소화 원칙) */
export function EmptyState({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-card border border-dashed border-border bg-surface px-6 py-16 text-center">
      <p className="text-sm font-semibold text-text">{title}</p>
      {hint && <p className="max-w-md text-xs text-subtle">{hint}</p>}
      {action}
    </div>
  );
}
