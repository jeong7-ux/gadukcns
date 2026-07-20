// 분석 KPI 표시 공용 헬퍼 — S-06 상세 카드 / S-07 진행단계 요약이 함께 쓴다.
import type { BidAnalysisKpi } from "@/lib/supabase/types";

export const GO_LABEL: Record<string, string> = {
  go: "GO",
  conditional_go: "조건부 GO",
  no_go: "NO-GO",
  unknown: "판정 미상",
};

export const GO_TONE: Record<string, "success" | "accent" | "danger" | "muted"> = {
  go: "success",
  conditional_go: "accent",
  no_go: "danger",
  unknown: "muted",
};

/** 원문 unit(예: "백만원·부가세 포함")을 보조 표기로 노출 — 정규화 값의 근거. */
export function kpiUnit(kpi: BidAnalysisKpi, label: string): string | null {
  return (kpi.kpi_raw ?? []).find((k) => k.label === label)?.unit ?? null;
}

/** 원문에 해당 라벨이 있었는지 — 없으면 타일을 숨겨 빈 "-"를 만들지 않는다. */
export function hasLabel(kpi: BidAnalysisKpi, label: string): boolean {
  return (kpi.kpi_raw ?? []).some((k) => k.label === label);
}

/** min/max가 같으면 단일값, 다르면 범위(150~180 MD). 둘 다 없으면 null. */
export function fmtRange(
  min: number | null,
  max: number | null,
  suffix: string
): string | null {
  if (min === null && max === null) return null;
  if (min !== null && max !== null && min !== max) return `${min}~${max}${suffix}`;
  return `${min ?? max}${suffix}`;
}

/** 독소조항 심각도 분해. 파싱된 항목만 표시(미표기는 생략). */
export function severityText(kpi: BidAnalysisKpi): string | null {
  const parts = [
    kpi.toxic_high !== null && `High ${kpi.toxic_high}`,
    kpi.toxic_mid !== null && `Mid ${kpi.toxic_mid}`,
    kpi.toxic_low !== null && `Low ${kpi.toxic_low}`,
  ].filter(Boolean) as string[];
  return parts.length ? parts.join(" · ") : null;
}
