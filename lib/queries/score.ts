/**
 * 주력사업 점수(coreScore) 공통 정의 — S-04 목록(bids.ts)·S-10 대시보드(stats.ts) 단일 소스.
 *
 * 주력점수 = score_breakdown.base(키워드/계약 매칭) − exclude(제외어 감점).
 * breakdown이 없으면 총점(score)으로 폴백한다.
 * 발주/고객사 가산은 base에 포함되지 않으므로, "실제 주력 적합도"만 남는다.
 * (v3 체크리스트: stats.ts ↔ bids.ts 중복 헬퍼 제거)
 */
type ScoreBreakdown = { base?: number; exclude?: number };

export function coreScore(
  aiFlags: unknown,
  score: number | null | undefined
): number {
  const bd = (aiFlags as { score_breakdown?: ScoreBreakdown } | null | undefined)
    ?.score_breakdown;
  if (bd && typeof bd.base === "number") return bd.base - (bd.exclude ?? 0);
  return score ?? 0;
}
