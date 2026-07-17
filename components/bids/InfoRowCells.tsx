import Link from "next/link";
import { fmtDate } from "@/lib/utils/format";
import { ddayInfo, DDAY_PILL_CLASS } from "@/lib/design/dday";

// S-10 입찰 정보 목록 / S-07 관심 목록 공용 행 셀.
//   순서: 상세 · 일정정보 · 기관정보 · 금액 · 사업명 · 공고번호
export interface InfoCellProps {
  bidNo: string;
  title: string | null;
  orderOrg: string | null;
  demandOrg: string | null;
  noticeDt: string | null;
  deadlineDt: string | null;
  estPrice: number | null;
  needsReview?: boolean;
  demandClient?: string | null; // 수요기관이 고객사면 그 이름(⭐·깜빡임)
  hideStatus?: boolean; // '상세'(상태 pill) 열 숨김 (S-07)
}

// 추정가 축약(억/만)
export function eok(v: number | null | undefined): string {
  if (v == null || v <= 0) return "-";
  if (v >= 1e8) return `${(v / 1e8).toFixed(1)}억`;
  if (v >= 1e4) return `${Math.round(v / 1e4).toLocaleString()}만`;
  return `${v}`;
}

function statusLabel(dd: number | null): string {
  if (dd === null) return "마감미정";
  if (dd < 0) return "마감";
  if (dd === 0) return "오늘마감";
  if (dd <= 3) return "마감임박";
  return "입찰중";
}

/** 목록 헤더 (thead > tr 안에서 사용). hideStatus면 '상세' 열 제외 */
export function InfoHeaders({ hideStatus }: { hideStatus?: boolean } = {}) {
  return (
    <>
      {!hideStatus && <th className="px-3 py-2 font-medium">진행단계</th>}
      <th className="px-3 py-2 font-medium">일정정보</th>
      <th className="px-3 py-2 font-medium">기관정보</th>
      <th className="px-3 py-2 text-right font-medium">금액</th>
      <th className="px-3 py-2 font-medium">사업명</th>
      <th className="px-3 py-2 font-medium">공고번호</th>
    </>
  );
}

/** 목록 셀 6열 (tbody > tr 안에서 사용) */
export function InfoCells(p: InfoCellProps) {
  const info = ddayInfo(p.deadlineDt);
  return (
    <>
      {/* 상세 */}
      {!p.hideStatus && (
        <td className="px-3 py-2">
          <span
            className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold ${
              info.days === null ? DDAY_PILL_CLASS.far : DDAY_PILL_CLASS[info.bucket]
            }`}
          >
            {statusLabel(info.days)}
          </span>
        </td>
      )}
      {/* 일정정보 */}
      <td className="whitespace-nowrap px-3 py-2">
        <div className="flex flex-col gap-0.5 text-[11px]">
          <span className="flex items-center gap-1">
            <span className="rounded bg-bg px-1 text-[10px] text-subtle ring-1 ring-border">공개</span>
            <span className="text-text">{p.noticeDt ? fmtDate(p.noticeDt) : "-"}</span>
          </span>
          <span className="flex items-center gap-1">
            <span className="rounded bg-dday-urgent/10 px-1 text-[10px] text-dday-urgent">마감</span>
            <span className="text-text">{p.deadlineDt ? fmtDate(p.deadlineDt) : "미정"}</span>
          </span>
        </div>
      </td>
      {/* 기관정보 */}
      <td className="px-3 py-2">
        <div className="flex flex-col gap-0.5 text-[11px]">
          <span className="flex items-center gap-1">
            <span className="shrink-0 rounded bg-primary/10 px-1 text-[10px] text-primary">수요</span>
            {p.demandClient && (
              <span className="shrink-0 text-accent" title={`고객사: ${p.demandClient}`} aria-label="고객사">⭐</span>
            )}
            <span
              className={`max-w-[9rem] truncate ${p.demandClient ? "animate-blink font-semibold text-accent" : "text-text"}`}
              title={p.demandOrg ?? ""}
            >
              {p.demandOrg ?? "-"}
            </span>
          </span>
          <span className="flex items-center gap-1">
            <span className="shrink-0 rounded bg-bg px-1 text-[10px] text-subtle ring-1 ring-border">공고</span>
            <span className="max-w-[9rem] truncate text-subtle" title={p.orderOrg ?? ""}>{p.orderOrg ?? "-"}</span>
          </span>
        </div>
      </td>
      {/* 금액 */}
      <td className="whitespace-nowrap px-3 py-2 text-right text-text">{eok(p.estPrice)}</td>
      {/* 사업명 */}
      <td className="px-3 py-2">
        <Link href={`/bids/${encodeURIComponent(p.bidNo)}`} className="flex items-center gap-1.5 hover:text-primary">
          {p.needsReview && (
            <span className="shrink-0 rounded bg-dday-soon/15 px-1 text-[10px] font-semibold text-dday-soon" title="AI 분류 검수 필요">
              검수
            </span>
          )}
          <span className="max-w-[32rem] truncate text-text" title={p.title ?? ""}>{p.title ?? "제목 없음"}</span>
        </Link>
      </td>
      {/* 공고번호 */}
      <td className="whitespace-nowrap px-3 py-2 font-mono text-[11px] text-subtle">{p.bidNo}</td>
    </>
  );
}
