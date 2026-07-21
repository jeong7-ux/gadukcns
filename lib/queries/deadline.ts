/**
 * 마감 판정 기준 — 유효 마감 = 입찰마감일시(`deadline_dt`) ?? 개찰일시(`open_dt`).
 *
 * 나라장터는 협상에 의한 계약 등 일부 공고에 `bidClseDt`를 **빈 문자열**로 준다(실측: 마감 null
 * 30건 전부 빈값, 키 누락·파싱 실패 0). 그러면 `deadline_dt`가 null이 되는데, 목록 필터가
 * "마감일 미정은 유지"였던 탓에 **개찰이 3개월 지난 공고까지 영구 노출**됐다.
 * 같은 원본에 `opengDt`는 항상 채워져 있으므로(30/30) 이를 폴백 기준으로 쓴다 —
 * 개찰이 지났다는 것은 입찰 참여가 끝났다는 뜻이므로 목록에서 내리는 것이 맞다.
 *
 * 둘 다 없으면 판단 근거가 없으므로 **노출 유지**(fail-open, 추측 금지).
 */

/** 노출(마감 전) 조건의 PostgREST `.or()` 식. `todayStr`은 'YYYY-MM-DD'(로컬 기준). */
export function notClosedOr(todayStr: string): string {
  return [
    `deadline_dt.gte.${todayStr}`,
    `and(deadline_dt.is.null,open_dt.gte.${todayStr})`, // 마감 미정 → 개찰일로 판정
    `and(deadline_dt.is.null,open_dt.is.null)`, // 근거 없음 → 유지
  ].join(",");
}

/** 유효 마감 시각(정렬·비교용). 없으면 null. */
export function effectiveDeadline(b: {
  deadline_dt?: string | null;
  open_dt?: string | null;
}): string | null {
  return b.deadline_dt ?? b.open_dt ?? null;
}

/**
 * 표시용 — 유효 마감과 **그 출처 라벨**.
 * 마감일이 없어 개찰일로 대체할 때는 `개찰`로 라벨을 바꿔 **근거를 병기**한다
 * (마감일인 척 하지 않는다). 둘 다 없으면 `dt: null` → 화면은 "미정".
 */
export function deadlineView(b: { deadline_dt?: string | null; open_dt?: string | null }): {
  dt: string | null;
  label: "마감" | "개찰";
  isOpen: boolean;
} {
  const isOpen = !b.deadline_dt && !!b.open_dt;
  return { dt: b.deadline_dt ?? b.open_dt ?? null, label: isOpen ? "개찰" : "마감", isOpen };
}
