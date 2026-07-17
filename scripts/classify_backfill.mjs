// =====================================================================
// scripts/classify_backfill.mjs — 기존 bids 소급 AI 사업분류 (기능상세정의서 v1.1 FR-27)
//   lib/collect/classify.ts 와 동일 3-스테이지 게이트를 plain JS로 포팅(수동 실행 배치).
//
// 모드:
//   CLASSIFY_DRY_RUN=1   → 쓰기 없음. 표본을 분류해 결정만 출력(검증용, DDL 불필요·프로덕션 무변경).
//   CLASSIFY_SAMPLE=N    → 스캔할 bids 상한(기본 전량). dry-run 검증 시 소량 권장.
//   CLASSIFY_ARCHIVE=1   → 해당없음 판정분을 archived_at 설정(소프트 아카이브). 기본 off.
//
// 필요 env: SUPABASE_URL, SUPABASE_SERVICE_KEY, OPENROUTER_API_KEY(분류 시).
// =====================================================================
import { createClient } from '@supabase/supabase-js';

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  OPENROUTER_API_KEY,
  OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1',
  CLASSIFY_MODEL = 'anthropic/claude-haiku-4.5',
  CLASSIFY_MIN_PREFILTER = '4',
  CLASSIFY_KEEP_THRESHOLD = '0.6',
  CLASSIFY_DROP_THRESHOLD = '0.4',
  CLASSIFY_MAX_LLM_PER_RUN = '300',
  CLASSIFY_CONCURRENCY = '4',
  CLASSIFY_DRY_RUN = '',
  CLASSIFY_SAMPLE = '',
  CLASSIFY_ARCHIVE = '',
  CLASSIFY_MIN_SCORE = '', // 선택: 이 점수 초과 bids만 대상(주력 후보 타겟 — 검증/부분반영용)
} = process.env;

const MIN = Number(CLASSIFY_MIN_PREFILTER) || 4;
const KEEP = Number(CLASSIFY_KEEP_THRESHOLD) || 0.8; // 강화: 0.6→0.8
const DROP = Number(CLASSIFY_DROP_THRESHOLD) || 0.4;
const MAXLLM = Number(CLASSIFY_MAX_LLM_PER_RUN) || 300;
const CONC = Number(CLASSIFY_CONCURRENCY) || 4;
const VERIFY = process.env.CLASSIFY_VERIFY !== 'false';
const DRY = !!CLASSIFY_DRY_RUN;
const SAMPLE = Number(CLASSIFY_SAMPLE) || 0;
const ARCHIVE = !!CLASSIFY_ARCHIVE;

const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
const STAGE0_CONSTRUCTION = ['건설', '건축', '토목', '소방', '전기공사', '조경', '통신공사', '설비', '도로', '교량', '하천', '상수도', '하수도', '항만', '철도', '플랜트', '시설공사', '정비공사'];
const STAGE0_NONIT = ['청소용역', '경비용역', '급식', '방역', '제초', '시설관리', '차량', '행사대행', '인쇄', '번역', '속기'];
const SUSPECT_DOMAIN = ['교과목', '교육과정', '커리큘럼', '교재', '콘텐츠 개발', '서베이', '설문', '실태조사', '여론조사', '연구용역', '산출 방법', '산출방법', '지원사업 운영', '운영 대행', '홍보', '행사'];
const CORE_KEYWORDS = ['감리', 'isp', 'ismp', '정보화전략', '정보전략계획', '정보화전략계획', '전략계획', '정보화 기본계획', '정보화계획', '정보화 계획', '마스터플랜', 'bpr', '아키텍처', '성과평가', 'pmo', 'isms', '정보보안 컨설팅', '보안 컨설팅', '지능정보화', '정보화 컨설팅', '정보화컨설팅', '상주감리'];
const EXPLICIT_CORE = ['isp', 'ismp', '정보화전략', '정보전략계획', '정보화전략계획', '감리', '성과평가', 'isms', 'bpr'];
const hasCoreSignal = (b) => { const h = `${norm(b.title)} ${norm(b.contract_method)}`; return CORE_KEYWORDS.some((k) => h.includes(k)); };
const isExplicitCore = (b) => { const h = norm(b.title); return EXPLICIT_CORE.some((k) => h.includes(k)); };

function requireEnv() {
  const miss = [];
  if (!SUPABASE_URL) miss.push('SUPABASE_URL');
  if (!SUPABASE_SERVICE_KEY) miss.push('SUPABASE_SERVICE_KEY');
  if (miss.length) { console.error(`[FATAL] env 누락: ${miss.join(', ')}`); process.exit(1); }
  if (!OPENROUTER_API_KEY) console.warn('[WARN] OPENROUTER_API_KEY 없음 → LLM 분류 불가(후보는 보류 처리)');
}

function stage0Drop(b, gamriExclude) {
  const title = norm(b.title), contract = norm(b.contract_method);
  const hay = `${title} ${contract}`;
  if (title.includes('감리') && STAGE0_CONSTRUCTION.some((k) => hay.includes(k))) return true;
  if (title.includes('감리') && gamriExclude.some((ex) => ex && hay.includes(ex))) return true;
  if (STAGE0_NONIT.some((k) => hay.includes(k))) return true;
  // 무관 도메인(교육/조사/연구/운영) — 코어 신호 없으면 드롭
  if (!hasCoreSignal(b) && SUSPECT_DOMAIN.some((k) => hay.includes(k))) return true;
  return false;
}
function prefilterBase(b, rules) {
  const hayContract = norm(b.contract_method);
  const hayAll = `${norm(b.title)} ${norm(b.order_org)} ${norm(b.demand_org)} ${hayContract}`;
  let base = 0;
  for (const r of rules) {
    const p = norm(r.pattern); if (!p) continue;
    if (r.type === 'keyword' && hayAll.includes(p)) base += r.weight;
    else if (r.type === 'contract' && hayContract.includes(p)) base += r.weight;
    else if (r.type === 'exclude' && hayAll.includes(p)) base -= r.weight;
  }
  return base;
}
function groupHit(b, groups) {
  const hay = `${norm(b.title)} ${norm(b.contract_method)}`;
  for (const g of groups) {
    const kws = (g.keywords ?? []).map(norm).filter(Boolean);
    if (!kws.some((k) => hay.includes(k))) continue;
    const ex = (g.exclude ?? []).map(norm).filter(Boolean);
    if (ex.some((e) => hay.includes(e))) continue;
    return true;
  }
  return false;
}
function decide(category, confidence) {
  const c = Math.max(0, Math.min(1, Number.isFinite(confidence) ? confidence : 0.5));
  if (category === '감리' || category === '컨설팅') {
    if (c >= KEEP) return { keep: true, biz: category, review: false, cls: category };
    return { keep: true, biz: category, review: true, cls: '보류' };
  }
  if (category === '해당없음') {
    if (c >= DROP) return { keep: false, biz: null, review: false, cls: '해당없음' };
    return { keep: true, biz: null, review: true, cls: '보류' };
  }
  return { keep: true, biz: null, review: true, cls: '오류' };
}

async function classifyLLM(b) {
  if (!OPENROUTER_API_KEY) return null;
  const sys =
    "너는 '정보시스템(IT) 감리·컨설팅 전문회사'의 입찰 사업분류 분석가다. 아래 셋 중 하나로 판정한다.\n" +
    '[감리] 정보시스템(정보화) 감리 — 정보시스템감리사/감리원 배치·감리대가, 정보화사업 제3자/PMO 감리. ※ 건설/건축/토목/소방/전기 감리는 해당없음.\n' +
    "[컨설팅] 정보화 '자문/전략/계획/평가' 성격만 — ISP·ISMP·정보화전략계획·정보전략계획·BPR·EA·정보화 성과평가·PMO·정보보안(ISMS-P) 컨설팅.\n" +
    '[해당없음] 위가 아니면 전부. 특히: 시스템 구축·고도화·개발·운영·유지관리만(ISP/전략/감리 없음), 데이터 구축·분석·서베이·조사, 교육/교과목/콘텐츠, 연구용역/방법조사, 지원사업 운영·대행, 물품·건설·일반용역. 빅데이터/AI 단어만으로는 컨설팅 아님(ISP/전략/자문/평가/감리 성격일 때만).\n' +
    "예시: 'ISP 수립'→컨설팅 / '정보시스템 감리'→감리 / '빅데이터 교과목 개선'→해당없음 / '빅데이터 통합관리시스템 고도화'(ISP없음)→해당없음 / '지원사업 운영'→해당없음.\n" +
    'reason은 40자 이내. 출력은 JSON 하나만(코드펜스·설명 금지): { "category":"감리|컨설팅|해당없음", "confidence":0.0, "reason":"짧은 근거" }';
  const user = `공고명: ${b.title ?? '-'}\n발주기관: ${b.order_org ?? '-'} / 수요기관: ${b.demand_org ?? '-'}\n계약방법: ${b.contract_method ?? '-'}\n추정가격: ${b.est_price ?? '-'}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (attempt) await new Promise((r) => setTimeout(r, 800));
      const res = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: CLASSIFY_MODEL, temperature: 0, max_tokens: 320, messages: [{ role: 'system', content: sys }, { role: 'user', content: user }] }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      let t = j?.choices?.[0]?.message?.content?.trim() ?? '';
      const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i); if (fence) t = fence[1].trim();
      const s = t.indexOf('{'), e = t.lastIndexOf('}');
      if (s >= 0 && e > s) t = t.slice(s, e + 1);
      return JSON.parse(t);
    } catch { /* retry */ }
  }
  return null;
}
// 2차 검증(adversarial): 구축/운영/교육/연구/조사면 keep=false. 실패 시 보수적 유지.
async function verifyLLM(b) {
  if (!OPENROUTER_API_KEY) return true;
  const sys =
    "너는 정보시스템 감리·컨설팅 전문회사의 최종 검수자다. 아래 공공 입찰 사업이 '정보시스템(정보화) 감리' 또는 '정보화 자문/전략/계획/평가 컨설팅(ISP/ISMP/정보화전략계획/BPR/EA/성과평가/PMO/ISMS-P 보안컨설팅)'에 실제로 해당하면 keep=true. 시스템 구축·개발·고도화·운영·유지관리, 데이터 구축·분석·서베이·조사, 교육/교과목/콘텐츠, 연구용역/방법조사, 지원사업 운영/대행이면 keep=false. 출력은 JSON 하나만: { \"keep\": true, \"why\": \"짧게\" }";
  const user = `공고명: ${b.title ?? '-'} / 발주: ${b.order_org ?? '-'} / 계약: ${b.contract_method ?? '-'}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (attempt) await new Promise((r) => setTimeout(r, 700));
      const res = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
        method: 'POST', headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: CLASSIFY_MODEL, temperature: 0, max_tokens: 120, messages: [{ role: 'system', content: sys }, { role: 'user', content: user }] }),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const j = await res.json(); let t = j?.choices?.[0]?.message?.content?.trim() ?? '';
      const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i); if (fence) t = fence[1].trim();
      const s = t.indexOf('{'), e = t.lastIndexOf('}'); if (s >= 0 && e > s) t = t.slice(s, e + 1);
      const o = JSON.parse(t); if (typeof o.keep === 'boolean') return o.keep;
    } catch { /* retry */ }
  }
  return true;
}
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

async function main() {
  requireEnv();
  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
  console.log(`[INFO] classify_backfill 시작 — DRY_RUN=${DRY} SAMPLE=${SAMPLE || '전량'} ARCHIVE=${ARCHIVE}`);

  const [{ data: rules }, { data: groups }] = await Promise.all([
    sb.from('rules').select('type,pattern,weight').eq('is_active', true).in('type', ['keyword', 'contract', 'exclude']),
    sb.from('keyword_groups').select('name,keywords,exclude'),
  ]);
  const gamriExclude = (groups ?? []).filter((g) => g.name.includes('감리')).flatMap((g) => (g.exclude ?? []).map(norm));

  let q = sb.from('bids').select('bid_no,bid_seq,title,order_org,demand_org,contract_method,est_price,raw').is('archived_at', null).order('notice_dt', { ascending: false });
  if (CLASSIFY_MIN_SCORE) q = q.gt('score', Number(CLASSIFY_MIN_SCORE));
  if (SAMPLE) q = q.limit(SAMPLE);
  const { data: bids, error } = await q;
  if (error) { console.error('[FATAL] bids 조회 실패:', error.message); process.exit(1); }
  console.log(`[INFO] 대상 bids: ${bids.length}건`);

  const stats = { scanned: bids.length, stage0: 0, dropped: 0, candidates: 0, llm: 0, verify: 0, downgraded: 0, errors: 0, 감리: 0, 컨설팅: 0, 보류: 0 };
  const candidates = [];
  const drops = [];
  for (const b of bids) {
    if (stage0Drop(b, gamriExclude)) { stats.stage0++; stats.dropped++; drops.push({ b, cls: '해당없음', reason: 'Stage0' }); continue; }
    const base = prefilterBase(b, rules ?? []);
    // 후보 자격(강화): 코어 신호(감리/ISP/전략/평가) 또는 rules base≥임계. AI/데이터 단독 제외.
    if (!(hasCoreSignal(b) || base >= MIN)) { stats.dropped++; drops.push({ b, base, cls: '해당없음', reason: 'Stage1' }); continue; }
    candidates.push({ b, base });
  }
  stats.candidates = candidates.length;
  console.log(`[INFO] Stage0 드롭 ${stats.stage0} · 후보 ${stats.candidates} (LLM 상한 ${MAXLLM})`);

  const toCall = candidates.slice(0, MAXLLM);
  const results = [];
  await mapLimit(toCall, CONC, async ({ b, base }) => {
    stats.llm++;
    const out = await classifyLLM(b);
    if (!out || !out.category) { stats.errors++; results.push({ b, base, out: null, d: decide(undefined, 0) }); return; }
    let d = decide(out.category, out.confidence ?? 0.5);
    // 2차 검증: 코어 명시가 아닌 적재건 재확인 → 구축/운영/교육 의심 시 보류 강등
    if (VERIFY && d.keep && !d.review && d.biz && !isExplicitCore(b)) {
      stats.llm++; stats.verify++;
      const ok = await verifyLLM(b);
      if (!ok) { d = { keep: true, biz: d.biz, review: true, cls: '보류' }; stats.downgraded++; }
    }
    results.push({ b, base, out, d });
  });

  // 집계 + (비 dry-run) 반영
  const clsRows = [];
  for (const { b, base, out, d } of results) {
    if (d.review) stats.보류++; else if (d.biz === '감리') stats.감리++; else if (d.biz === '컨설팅') stats.컨설팅++; else if (!d.keep) stats.dropped++;
    clsRows.push({ bid_no: b.bid_no, bid_seq: b.bid_seq, category: d.cls, confidence: out?.confidence ?? null, reason: (out?.reason ?? '').slice(0, 500), method: out ? 'llm' : 'llm', model: CLASSIFY_MODEL, title: (b.title ?? '').slice(0, 300), order_org: (b.order_org ?? '').slice(0, 200), prefilter_base: base, keep: d.keep, biz: d.biz, review: d.review });
  }

  if (DRY) {
    console.log('\n===== DRY-RUN 결정(표본) =====');
    for (const r of results.slice(0, 40)) {
      const cat = r.out?.category ?? '오류';
      const conf = r.out?.confidence != null ? r.out.confidence.toFixed(2) : '-';
      const mark = r.d.keep ? (r.d.review ? '보류' : '적재') : '제외';
      console.log(`[${mark}] ${cat}(${conf}) base=${r.base} | ${String(r.b.title ?? '').slice(0, 46)} | ${String(r.b.order_org ?? '').slice(0, 16)}`);
    }
    console.log('\n===== 집계 =====');
    console.log(stats);
    console.log(`(제외 예시 ${Math.min(drops.length, 5)}건):`);
    for (const d of drops.slice(0, 5)) console.log(`  [제외/${d.reason}] ${String(d.b.title ?? '').slice(0, 50)}`);
    console.log('\n[INFO] DRY-RUN — DB 미변경. 실제 반영은 CLASSIFY_DRY_RUN 없이 재실행.');
    return;
  }

  // 실제 반영: bid_classifications upsert + bids.biz_category/classify 갱신 + (옵션)아카이브
  const clsUpsert = clsRows.map(({ keep, biz, review, ...c }) => ({ ...c, decided_at: new Date().toISOString() }));
  // Stage0/1 드롭도 캐시에 기록(재분류 방지)
  for (const d of drops) clsUpsert.push({ bid_no: d.b.bid_no, bid_seq: d.b.bid_seq, category: '해당없음', confidence: null, reason: d.reason, method: 'rule', model: null, title: (d.b.title ?? '').slice(0, 300), order_org: (d.b.order_org ?? '').slice(0, 200), prefilter_base: d.base ?? 0, decided_at: new Date().toISOString() });
  const { error: clsErr } = await sb.from('bid_classifications').upsert(clsUpsert, { onConflict: 'bid_no,bid_seq' });
  if (clsErr) console.error('[ERROR] bid_classifications upsert:', clsErr.message);

  for (const c of clsRows) {
    if (!c.keep) continue;
    const patch = { biz_category: c.biz, classify: { method: 'llm', confidence: c.confidence, reason: c.reason, model: CLASSIFY_MODEL, at: new Date().toISOString(), needs_review: c.review } };
    const { error: upErr } = await sb.from('bids').update(patch).eq('bid_no', c.bid_no).eq('bid_seq', c.bid_seq);
    if (upErr) console.error(`[ERROR] bids update ${c.bid_no}:`, upErr.message);
  }

  if (ARCHIVE) {
    const dropNos = [...clsRows.filter((c) => !c.keep), ...drops].map((x) => x.b?.bid_no ?? x.bid_no).filter(Boolean);
    if (dropNos.length) {
      const { error: arErr } = await sb.from('bids').update({ archived_at: new Date().toISOString() }).in('bid_no', dropNos).is('archived_at', null);
      if (arErr) console.error('[ERROR] 아카이브:', arErr.message); else console.log(`[INFO] 해당없음 아카이브: ${dropNos.length}건`);
    }
  }

  console.log('\n===== 반영 완료 =====');
  console.log(stats);
}

main().catch((e) => { console.error('[FATAL]', e?.stack ?? e); process.exit(1); });
