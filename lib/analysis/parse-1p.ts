// 1페이지상세요약 HTML → 정형 KPI 파싱 (의존성 0, 서버/클라이언트 공용)
//
// 대상 구조(5종 샘플 + 운영 실파일에서 100% 일관 확인):
//   <div class="hdr-kpi"><div class="lbl">감리예산</div>
//     <div class="val">98</div><div class="unit">백만원·부가세 포함</div></div>
//   <div class="go-val">GO</div><div class="go-lbl">조건부 수주 권고</div>
//
// 설계 원칙
//   ① 원문(kpi_raw) 무손실 보존 — 표기가 파일마다 달라 정규화가 항상 성공하지 않는다.
//   ② 정규화 실패·모호는 드롭 금지 → null + parse_warnings(fail-open).
//   ③ 4번째 슬롯 라벨이 가변(대상사업/요구사항/MD단가)이므로 위치가 아닌 **라벨 키**로 찾는다.

export const PARSER_VERSION = "parse-1p@0.1";

export interface KpiCell {
  label: string;
  value: string | null;
  unit: string | null;
}

export interface Raw1p {
  kpis: KpiCell[];
  go_value: string | null;
  go_label: string | null;
}

export type GoDecision = "go" | "conditional_go" | "no_go" | "unknown";

export interface Parsed1p {
  audit_budget_krw: number | null;
  audit_ratio_pct_min: number | null;
  audit_ratio_pct_max: number | null;
  effort_md_min: number | null;
  effort_md_max: number | null;
  target_budget_krw: number | null;
  toxic_total: number | null;
  toxic_high: number | null;
  toxic_mid: number | null;
  toxic_low: number | null;
  go_decision: GoDecision | null;
  go_reason: string | null;
  kpi_raw: KpiCell[];
  extra_kpis: KpiCell[];
  parse_warnings: string[];
  parser_version: string;
}

/** 표준 라벨(고정 슬롯). 그 외 라벨은 extra_kpis로 보존한다. */
const KNOWN_LABELS = ["감리예산", "감리비율", "투입공수", "대상사업", "독소조항"];

const strip = (s: string) =>
  s
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .trim();

/** hdr-kpi 블록 + GO 판정 원문 추출 */
export function extractRaw(html: string): Raw1p {
  const kpis: KpiCell[] = [];
  const re = /<div class="hdr-kpi">([\s\S]*?)<\/div>\s*<\/div>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const block = m[1];
    // 마지막(unit) 셀은 바깥 매치가 닫는 태그를 소비하므로 `</div>` 또는 문자열 끝 둘 다 허용.
    const pick = (cls: string) => {
      const x = block.match(new RegExp(`<div class="${cls}"[^>]*>([\\s\\S]*?)(?:</div>|$)`));
      return x ? strip(x[1]) : null;
    };
    const label = pick("lbl");
    if (label) kpis.push({ label, value: pick("val"), unit: pick("unit") });
  }
  const one = (cls: string) => {
    const x = html.match(new RegExp(`<div class="${cls}"[^>]*>([\\s\\S]*?)</div>`));
    return x ? strip(x[1]) : null;
  };
  return { kpis, go_value: one("go-val"), go_label: one("go-lbl") };
}

const num = (s: unknown): number | null => {
  const x = String(s ?? "").replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  return x ? parseFloat(x[0]) : null;
};

/** "150~180", "3~5.7%" → [min,max] / 단일값 → [n,n] */
const range = (s: unknown): [number | null, number | null] => {
  const t = String(s ?? "").replace(/,/g, "");
  const r = t.match(/(-?\d+(?:\.\d+)?)\s*[~∼–-]\s*(-?\d+(?:\.\d+)?)/);
  if (r) return [parseFloat(r[1]), parseFloat(r[2])];
  const n = num(t);
  return [n, n];
};

/**
 * 금액 → 원(KRW). 단위가 value에 있기도 하고(2억, 170,000천원) unit에만 있기도 해서
 * (98 + "백만원·부가세 포함") 둘을 결합해 판정한다. 판정 불가 시 null(원문 보존).
 */
export function toKrw(value: string | null, unit: string | null): number | null {
  const v = String(value ?? "");
  const u = String(unit ?? "");
  const n = num(v);
  if (n === null) return null;
  if (/억/.test(v)) return Math.round(n * 1e8);
  if (/천원/.test(v)) return Math.round(n * 1e3);
  if (/백만/.test(v + " " + u)) return Math.round(n * 1e6);
  if (/억/.test(u)) return Math.round(n * 1e8);
  if (/만원/.test(v)) return Math.round(n * 1e4);
  if (/원/.test(u) && n > 1e6) return Math.round(n); // 이미 원 단위 표기
  return null;
}

/** "GO" / "조건부 GO" / "No-Go" → enum */
export function normGo(v: string | null): GoDecision | null {
  const t = String(v ?? "").trim();
  if (!t) return null;
  if (/no[\s-]?go/i.test(t)) return "no_go";
  if (/조건부/.test(t)) return "conditional_go";
  if (/^go$/i.test(t)) return "go";
  return "unknown";
}

/** 독소조항 심각도: "High(+Mid 2)" · "High3·Mid6" · "High 3 · Mid 3 · Low 1" */
function severity(unit: string | null) {
  const u = String(unit ?? "");
  const g = (k: string) => {
    const m = u.match(new RegExp(`${k}\\s*(\\d+)`, "i"));
    return m ? parseInt(m[1], 10) : null;
  };
  return { high: g("High"), mid: g("Mid"), low: g("Low") };
}

/** HTML 한 건 파싱 → 정규화 지표 + 경고 */
export function parse1pSummary(html: string): Parsed1p {
  const raw = extractRaw(html);
  const by = new Map(raw.kpis.map((k) => [k.label, k]));
  const warnings: string[] = [];

  const budget = by.get("감리예산");
  const ratio = by.get("감리비율");
  const effort = by.get("투입공수");
  const target = by.get("대상사업");
  const toxic = by.get("독소조항");

  if (raw.kpis.length === 0) warnings.push("KPI 블록(hdr-kpi) 없음 — 1페이지상세요약 양식이 아닐 수 있음");

  const audit_budget_krw = budget ? toKrw(budget.value, budget.unit) : null;
  if (budget && audit_budget_krw === null)
    warnings.push(`감리예산 단위 판정 실패: "${budget.value}" [${budget.unit ?? ""}]`);

  const target_budget_krw = target ? toKrw(target.value, target.unit) : null;
  if (target && target_budget_krw === null)
    warnings.push(`대상사업 단위 판정 실패: "${target.value}" [${target.unit ?? ""}]`);

  const [ratioMin, ratioMax] = ratio ? range(ratio.value) : [null, null];
  const [mdMin, mdMax] = effort ? range(effort.value) : [null, null];

  const sev = toxic ? severity(toxic.unit) : { high: null, mid: null, low: null };
  const toxicTotal = toxic ? num(toxic.value) : null;
  const sevSum = (sev.high ?? 0) + (sev.mid ?? 0) + (sev.low ?? 0);
  if (toxic && sev.high === null && sevSum > 0)
    warnings.push(`독소조항 High 미표기 — unit 원문 확인 필요: "${toxic.unit ?? ""}"`);
  if (toxicTotal !== null && sevSum > toxicTotal)
    warnings.push(`독소조항 심각도 합(${sevSum}) > 총건수(${toxicTotal})`);

  const go_decision = normGo(raw.go_value);
  if (go_decision === "unknown") warnings.push(`판정값 미매핑: "${raw.go_value}"`);

  return {
    audit_budget_krw,
    audit_ratio_pct_min: ratioMin,
    audit_ratio_pct_max: ratioMax,
    effort_md_min: mdMin,
    effort_md_max: mdMax,
    target_budget_krw,
    toxic_total: toxicTotal,
    toxic_high: sev.high,
    toxic_mid: sev.mid,
    toxic_low: sev.low,
    go_decision,
    go_reason: raw.go_label,
    kpi_raw: raw.kpis,
    extra_kpis: raw.kpis.filter((k) => !KNOWN_LABELS.includes(k.label)),
    parse_warnings: warnings,
    parser_version: PARSER_VERSION,
  };
}
