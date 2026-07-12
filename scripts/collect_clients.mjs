// FR-17 고객사 자동 수집: 회사 홈페이지 고객사 게시판(gadukcns.com/41) 파싱 → clients upsert.
// HTTPS 자체서명이라 HTTP 사용. 신규 기관만 추가(기존 카테고리/설정 보존).
// 사용: node --env-file=.env.local scripts/collect_clients.mjs
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const BASE = 'http://www.gadukcns.com/41';
const CATS = ['중앙정부부처','지방자치단체','공공기관','의료기관','교육기관','금융기관','기타'];

function parseNames(html) {
  const body = html.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  const text = body.replace(/<[^>]+>/g, '\n').replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&');
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  // 카테고리 목록('기타') 이후 ~ 페이지네이션('열린'/'맨끝') 이전의 기관명
  let s = 0;
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i] === '기타') { s = i; break; }
  const out = [];
  for (const l of lines.slice(s + 1)) {
    if (l === '열린' || l === '맨끝') break;
    if (l === '처음' || l === '페이지' || l === '-->' || /^\d+$/.test(l) || l.startsWith('Total') || l.length > 30) continue;
    out.push(l);
  }
  return out;
}

async function main() {
  const seen = new Set();
  const found = [];
  for (let page = 1; page <= 6; page++) {
    let html;
    try {
      const r = await fetch(`${BASE}?page=${page}`, { headers: { 'User-Agent': 'gdcns-bot' } });
      html = await r.text();
    } catch (e) { console.warn(`[warn] page ${page} fetch 실패: ${e.message}`); continue; }
    const names = parseNames(html);
    if (!names.length) break;
    for (const n of names) if (!seen.has(n)) { seen.add(n); found.push(n); }
  }
  console.log(`[info] 수집된 기관명 ${found.length}건`);

  // 기존 clients 조회 → 신규만 upsert(카테고리 미상은 '기타', is_priority 기본 true)
  const { data: existing } = await sb.from('clients').select('name');
  const known = new Set((existing || []).map((c) => c.name));
  const news = found.filter((n) => !known.has(n)).map((name) => ({ name, category: '기타', is_priority: true, weight: 10, source_url: BASE }));
  if (news.length) {
    const { error } = await sb.from('clients').upsert(news, { onConflict: 'name' });
    if (error) throw new Error('upsert 실패: ' + error.message);
  }
  console.log(`[done] 수집 ${found.length}건 | 신규 추가 ${news.length}건 (기존 ${known.size}건 보존). 카테고리 미상은 '기타' → S-14에서 보정.`);
}
main().catch((e) => { console.error('[FATAL]', e.message); process.exit(1); });
