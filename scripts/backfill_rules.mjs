// 3개월 룰기반 백필: 나라장터 용역공고를 월 구간으로 수집 → rules 매칭 필터 → score/tags upsert.
// 가격/변경/LLM/임베딩 없음(순수 룰 스코어링). 사용: node --env-file=.env.local scripts/backfill_rules.mjs
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const KEY = process.env.NARA_SERVICE_KEY;
const BASE = process.env.NARA_API_BASE || 'https://apis.data.go.kr/1230000/ad/BidPublicInfoService';
const OP = 'getBidPblancListInfoServc';
const NUM = 100;

// 오늘(KST) 기준 3개월: [04-11~05-11], [05-11~06-11], [06-11~07-11] — API가 월 범위 제한(약 1달)
const WINDOWS = [
  ['202604110000', '202605110000', '04-11~05-11'],
  ['202605110000', '202606110000', '05-11~06-11'],
  ['202606110000', '202607112359', '06-11~07-11'],
];

const norm = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const toInt = (s) => { const n = parseInt(String(s ?? '').replace(/[^\d]/g, ''), 10); return Number.isFinite(n) ? n : null; };
const toTs = (s) => { const t = String(s ?? '').trim(); return t ? t.replace(' ', 'T') + '+09:00' : null; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url, tries = 2) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      const j = await r.json();
      const code = j?.response?.header?.resultCode;
      if (code && code !== '00') throw new Error(`resultCode=${code} ${j?.response?.header?.resultMsg}`);
      return j;
    } catch (e) { if (i === tries - 1) throw e; await sleep(800); }
  }
}

// ai.mjs scoreBid 와 동일 로직 (title+org+demand+contract 대상 substring)
function scoreBid(it, rules) {
  const hayAll = norm(`${it.bidNtceNm} ${it.ntceInsttNm} ${it.dminsttNm} ${it.cntrctCnclsMthdNm}`);
  const hayOrg = norm(`${it.ntceInsttNm} ${it.dminsttNm}`);
  const hayContract = norm(it.cntrctCnclsMthdNm);
  let base = 0, agency = 0, pen = 0; const tags = new Set(); const matched = [];
  for (const r of rules) {
    const p = norm(r.pattern); if (!p) continue; let hit = false;
    if (r.type === 'keyword') { hit = hayAll.includes(p); if (hit) base += r.weight; }
    else if (r.type === 'contract') { hit = hayContract.includes(p); if (hit) base += r.weight; }
    else if (r.type === 'org') { hit = hayOrg.includes(p); if (hit) agency += r.weight; }
    else if (r.type === 'exclude') { hit = hayAll.includes(p); if (hit) pen += r.weight; }
    if (hit) { tags.add(r.pattern); matched.push({ type: r.type, pattern: r.pattern, weight: r.weight }); }
  }
  return { score: base + agency - pen, base, agency, pen, tags: [...tags], matched };
}

function toRow(it, sc) {
  return {
    bid_no: it.bidNtceNo, bid_seq: it.bidNtceOrd || '00',
    title: it.bidNtceNm || null, order_org: it.ntceInsttNm || null, demand_org: it.dminsttNm || null,
    contract_method: it.cntrctCnclsMthdNm || null,
    notice_dt: toTs(it.bidNtceDt), deadline_dt: toTs(it.bidClseDt), open_dt: toTs(it.opengDt),
    est_price: toInt(it.presmptPrce), score: sc.score, tags: sc.tags,
    ai_flags: { backfill: true, score_breakdown: { base: sc.base, agency: sc.agency, exclude: sc.pen, matched: sc.matched } },
    raw: it, updated_at: new Date().toISOString(),
  };
}

async function upsertChunk(rows) {
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { error } = await sb.from('bids').upsert(chunk, { onConflict: 'bid_no,bid_seq' });
    if (error) throw new Error('upsert 실패: ' + error.message);
  }
}

async function main() {
  const { data: rules, error } = await sb.from('rules').select('id,type,pattern,weight,is_active').eq('is_active', true);
  if (error) throw new Error('rules 조회 실패: ' + error.message);
  console.log(`[start] 활성 룰 ${rules.length}개 | 3개월 백필 (가격/LLM 없음)`);

  let scanned = 0, relevant = 0; const seen = new Set();
  for (const [bgn, end, label] of WINDOWS) {
    const first = await fetchJson(`${BASE}/${OP}?serviceKey=${KEY}&type=json&inqryDiv=1&numOfRows=1&pageNo=1&inqryBgnDt=${bgn}&inqryEndDt=${end}`);
    const total = first?.response?.body?.totalCount || 0;
    const pages = Math.ceil(total / NUM);
    console.log(`\n[${label}] totalCount=${total}, pages=${pages}`);
    let winRel = 0;
    for (let pageNo = 1; pageNo <= pages; pageNo++) {
      const j = await fetchJson(`${BASE}/${OP}?serviceKey=${KEY}&type=json&inqryDiv=1&numOfRows=${NUM}&pageNo=${pageNo}&inqryBgnDt=${bgn}&inqryEndDt=${end}`);
      let items = j?.response?.body?.items || [];
      if (!Array.isArray(items)) items = [items];
      const rows = [];
      for (const it of items) {
        scanned++;
        const sc = scoreBid(it, rules);
        if (sc.score > 0) {
          const k = `${it.bidNtceNo}|${it.bidNtceOrd || '00'}`;
          if (seen.has(k)) continue; seen.add(k);
          rows.push(toRow(it, sc)); winRel++; relevant++;
        }
      }
      if (rows.length) await upsertChunk(rows);
      if (pageNo % 20 === 0 || pageNo === pages) console.log(`  [${label}] page ${pageNo}/${pages} — 누적 관련 ${winRel}`);
      await sleep(60);
    }
    console.log(`[${label}] 관련 ${winRel}건 적재`);
  }

  try { await sb.rpc('refresh_bids_status'); console.log('[ok] refresh_bids_status'); } catch (e) { console.warn('[warn] status 갱신 실패:', e.message); }
  console.log(`\n[done] 스캔 ${scanned}건 → 관련(고유) ${relevant}건 적재`);
}

main().catch((e) => { console.error('[FATAL]', e.message); process.exit(1); });
