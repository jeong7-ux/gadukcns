/**
 * 공고 차수(bid_seq) 중복 정리.
 *
 * 나라장터는 정정·변경공고를 **같은 공고번호의 새 차수**로 발급한다(`R26BK01637227-000/001/002`).
 * bids의 PK가 (bid_no, bid_seq)라 차수마다 별도 행이 남는데, 목록 화면은 공고번호만 표시하고
 * 상세 링크도 `/bids/{bid_no}` 하나뿐이라 사용자에겐 **동일한 행의 중복**으로 보인다.
 * → 목록 계열 화면은 공고번호당 최신 차수 1건만 노출한다(원본 정렬 순서는 유지).
 */

/** 차수 비교. '00'/'000' 등 자릿수가 섞일 수 있어 숫자 비교 우선, 비숫자면 문자열 비교. */
export function cmpSeq(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return a.localeCompare(b);
}

/** 공고번호별 최신 차수만 남긴다. 입력 배열의 정렬 순서를 보존한다. */
export function keepLatestSeq<T extends { bid_no: string; bid_seq: string }>(rows: T[]): T[] {
  const latest = new Map<string, T>();
  for (const r of rows) {
    const prev = latest.get(r.bid_no);
    if (!prev || cmpSeq(r.bid_seq, prev.bid_seq) > 0) latest.set(r.bid_no, r);
  }
  const keep = new Set<T>(latest.values());
  return rows.filter((r) => keep.has(r));
}

/**
 * 공고번호별 **최초** 차수만 남긴다 — "일별 신규 등록" 추이용.
 * 목록은 최신 차수가 맞지만(현재 유효 내용), 신규 등록 추이는 정정공고가 아니라
 * **최초 공고일**에 1건으로 잡혀야 한다.
 */
export function keepFirstSeq<T extends { bid_no: string; bid_seq: string }>(rows: T[]): T[] {
  const first = new Map<string, T>();
  for (const r of rows) {
    const prev = first.get(r.bid_no);
    if (!prev || cmpSeq(r.bid_seq, prev.bid_seq) < 0) first.set(r.bid_no, r);
  }
  const keep = new Set<T>(first.values());
  return rows.filter((r) => keep.has(r));
}

/** 재공고 판정용 제목 정규화 — 표기 흔들림(괄호·공백·재공고 표시·후행 '용역/사업/공고')을 제거. */
function normTitle(s: string | null | undefined): string {
  return (s ?? "")
    .toLowerCase()
    .replace(/[()（）[\]【】<>《》]/g, " ")
    .replace(/재공고|재입찰|긴급|정정공고|변경공고|재안내/g, " ")
    .replace(/[\s·,.\-_/]/g, "")
    .replace(/(용역|사업|공고)+$/g, "");
}

function normOrg(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().replace(/[\s()（）]/g, "");
}

export interface RebidRow {
  bid_no: string;
  title?: string | null;
  order_org?: string | null;
  notice_dt?: string | null;
  deadline_dt?: string | null;
  open_dt?: string | null;
}

/**
 * 재공고 접기 — **공고명(정규화) + 발주기관**이 같으면 한 사업으로 보고 **가장 최근 공고 1건**만 남긴다.
 *
 * 나라장터는 유찰·정정 후 재공고에 **새 공고번호**를 부여하므로 [keepLatestSeq]로는 걸러지지 않는다.
 * 실측(노출 82건)에서 이 규칙이 묶은 9그룹은 **전부 실제 재공고 쌍**(오탐 0)이었고,
 * 그중 1그룹은 재공고 시 예산이 조정돼 금액이 달랐다 → **금액은 키에서 제외**한다.
 *
 * 우선순위: 공고일시 → 유효 마감(늦은 쪽) → 공고번호. 입력 배열의 정렬 순서를 보존한다.
 */
export function collapseRebids<T extends RebidRow>(rows: T[]): T[] {
  const better = (a: T, b: T): boolean => {
    const na = a.notice_dt ?? "";
    const nb = b.notice_dt ?? "";
    if (na !== nb) return na > nb;
    const da = a.deadline_dt ?? a.open_dt ?? "";
    const db = b.deadline_dt ?? b.open_dt ?? "";
    if (da !== db) return da > db;
    return a.bid_no > b.bid_no;
  };
  const best = new Map<string, T>();
  for (const r of rows) {
    const key = `${normTitle(r.title)}|${normOrg(r.order_org)}`;
    if (!key.startsWith("|")) {
      const prev = best.get(key);
      if (!prev || better(r, prev)) best.set(key, r);
    }
  }
  const keep = new Set<T>(best.values());
  // 제목이 비어 키를 만들 수 없는 행은 판단 근거가 없으므로 유지(fail-open)
  return rows.filter((r) => !normTitle(r.title) || keep.has(r));
}
