// 첨부 정보 정규화: bids.raw 의 ntceSpecDocUrl1~10/ntceSpecFileNm1~10(+stdNtceDocUrl)를
// bid_attachments 로 추출(다운로드 없음, downloaded=false). 노출(비아카이브) 공고 대상. 멱등.
// 사용: node --env-file=.env.local scripts/extract_attachment_info.mjs
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

function extractRows(bid) {
  const raw = bid.raw || {};
  const seen = new Set();
  const rows = [];
  // 규격서(공고 표준문서)
  const std = raw.stdNtceDocUrl;
  if (std && !seen.has(std)) {
    seen.add(std);
    rows.push({ bid_no: bid.bid_no, bid_seq: bid.bid_seq, seq: 0, doc_type: '규격서', file_name: '규격서(공고)', file_url: std, downloaded: false });
  }
  // 첨부 1~10
  for (let i = 1; i <= 10; i++) {
    const url = raw[`ntceSpecDocUrl${i}`];
    const name = raw[`ntceSpecFileNm${i}`] || null;
    if (url && !seen.has(url)) {
      seen.add(url);
      rows.push({ bid_no: bid.bid_no, bid_seq: bid.bid_seq, seq: i, doc_type: '첨부', file_name: name, file_url: url, downloaded: false });
    }
  }
  return rows;
}

async function main() {
  let page = 0, bidsWithAtt = 0, totalRows = 0, scanned = 0;
  const PAGE = 500;
  for (;;) {
    const from = page * PAGE;
    const { data: bids, error } = await sb
      .from('bids')
      .select('bid_no,bid_seq,raw')
      .is('archived_at', null)
      .order('bid_no', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error('bids 조회 실패: ' + error.message);
    if (!bids.length) break;

    const bidNos = bids.map((b) => b.bid_no);
    // 멱등: 대상 공고의 기존 첨부행 제거 후 재삽입
    const { error: de } = await sb.from('bid_attachments').delete().in('bid_no', bidNos);
    if (de) throw new Error('기존 첨부 삭제 실패: ' + de.message);

    const rows = [];
    for (const b of bids) {
      scanned++;
      const r = extractRows(b);
      if (r.length) bidsWithAtt++;
      rows.push(...r);
    }
    for (let i = 0; i < rows.length; i += 500) {
      const { error: ie } = await sb.from('bid_attachments').insert(rows.slice(i, i + 500));
      if (ie) throw new Error('첨부 삽입 실패: ' + ie.message);
    }
    totalRows += rows.length;
    console.log(`  page ${page + 1}: 공고 ${scanned}건 처리, 첨부행 누적 ${totalRows}`);
    page++;
  }
  console.log(`\n[done] 스캔 ${scanned}건 | 첨부 있는 공고 ${bidsWithAtt}건 | bid_attachments ${totalRows}행 적재(다운로드=false)`);
}
main().catch((e) => { console.error('[FATAL]', e.message); process.exit(1); });
