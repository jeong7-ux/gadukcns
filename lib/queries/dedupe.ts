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
