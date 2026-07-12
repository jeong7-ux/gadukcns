import { ddayInfo, DDAY_PILL_CLASS } from "@/lib/design/dday";

/** D-day 3구간 pill (스토리보드 2.2) */
export function DdayPill({ deadline }: { deadline: string | Date | null }) {
  const { label, bucket } = ddayInfo(deadline);
  if (label === "-") return <span className="text-xs text-subtle">마감일 미정</span>;
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${DDAY_PILL_CLASS[bucket]}`}
    >
      {label}
    </span>
  );
}
