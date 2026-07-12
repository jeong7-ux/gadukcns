// 재스코어링: 현재 rules 테이블로 기존 bids 전체의 score/tags를 재계산(덮어쓰기).
// AI 보강 필드(embedded/summary_ok/matches 등)는 보존(ai_flags 병합). LLM 불필요.
// 사용: node --env-file=.env.local scripts/rescore.mjs
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const norm = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();

// ai.mjs scoreBid 와 동일 로직
function scoreBid(b, rules) {
  const hayAll = norm(`${b.title} ${b.order_org} ${b.demand_org} ${b.contract_method}`);
  const hayOrg = norm(`${b.order_org} ${b.demand_org}`);
  const hayContract = norm(b.contract_method);
  let base = 0, agency = 0, pen = 0; const tags = new Set(); const matched = [];
  for (const r of rules) {
    const p = norm(r.pattern); if (!p) continue; let hit = false, tag = false;
    if (r.type === 'keyword') { hit = hayAll.includes(p); if (hit) { base += r.weight; tag = true; } }
    else if (r.type === 'contract') { hit = hayContract.includes(p); if (hit) { base += r.weight; tag = true; } }
    else if (r.type === 'org') { hit = hayOrg.includes(p); if (hit) { agency += r.weight; tag = true; } }
    else if (r.type === 'exclude') { hit = hayAll.includes(p); if (hit) pen += r.weight; }
    if (hit) matched.push({ type: r.type, pattern: r.pattern, weight: r.weight });
    if (tag) tags.add(r.pattern);
  }
  return { score: base + agency - pen, tags: [...tags], breakdown: { base, agency, exclude: pen, matched } };
}

async function main() {
  const { data: rules, error: re } = await sb.from('rules').select('type,pattern,weight,is_active').eq('is_active', true);
  if (re) throw new Error('rules 조회 실패: ' + re.message);
  console.log(`[start] 활성 룰 ${rules.length}개로 재스코어링`);

  const now = new Date().toISOString();
  let processed = 0, gt0 = 0, gte5 = 0, changed = 0, page = 0;
  const PAGE = 1000;
  for (;;) {
    const from = page * PAGE;
    const { data: bids, error } = await sb
      .from('bids')
      .select('bid_no,bid_seq,title,order_org,demand_org,contract_method,score,ai_flags')
      .order('bid_no', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error('bids 조회 실패: ' + error.message);
    if (!bids.length) break;

    const rows = bids.map((b) => {
      const sc = scoreBid(b, rules);
      if (sc.score !== (b.score ?? 0)) changed++;
      if (sc.score > 0) gt0++;
      if (sc.score >= 5) gte5++;
      processed++;
      return {
        bid_no: b.bid_no, bid_seq: b.bid_seq, score: sc.score, tags: sc.tags,
        ai_flags: { ...(b.ai_flags || {}), score_breakdown: sc.breakdown, rescored_at: now },
        updated_at: now,
      };
    });
    for (let i = 0; i < rows.length; i += 500) {
      const { error: ue } = await sb.from('bids').upsert(rows.slice(i, i + 500), { onConflict: 'bid_no,bid_seq' });
      if (ue) throw new Error('upsert 실패: ' + ue.message);
    }
    console.log(`  page ${page + 1}: ${processed}건 처리`);
    page++;
  }

  try { await sb.rpc('refresh_bids_status'); } catch {}
  console.log(`\n[done] 재스코어링 ${processed}건 | 변경 ${changed}건 | score>0 ${gt0} | score>=5 ${gte5}`);
}

main().catch((e) => { console.error('[FATAL]', e.message); process.exit(1); });
