// =====================================================================
// 나라장터 입찰정보시스템 — AI 보강 파이프라인 (scripts/ai.mjs)
// Node 20 ESM. 수집(collect.mjs) 직후 실행된다. (기능정의서 7.1)
//
// 파이프라인:
//   1) 신규/변경 bids 조회 (이미 처리된 row 스킵 — 멱등)
//   2) 임베딩: 메타+extracted_text → bge-m3(/embeddings) → bids/bid_attachments.embedding (1024)
//   3) 요약(FR-06): LLM(/chat/completions) → bids.ai_summary  ("제공 텍스트 범위 내에서만")
//   4) 스코어링(7.2): score(rules 결정적) + ai_score(cosine×100) → bids.score/ai_score/tags/ai_flags
//   5) 인력매칭(FR-10): 공고 요건 ↔ member_table → ai_flags.matches (S-06 렌더용 shape)
//   6) daily_brief: 당일 top_bids + 다이제스트
//
// 원칙: 멱등성(재처리 금지) · 결정적 스코어링(rules 테이블) · 환각 최소화 · 키 비로그
// 계약: _workspace/01_data-architect_contract.md (embedding=vector(1024), 코사인 <=>)
// =====================================================================

import { createClient } from '@supabase/supabase-js';
import crypto from 'node:crypto';

// ---------------------------------------------------------------------
// 0. 설정 / 상수
// ---------------------------------------------------------------------
const OPENROUTER_BASE = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
const EMBED_MODEL = process.env.AI_EMBED_MODEL || 'baai/bge-m3';       // 1024차원 고정
const LLM_MODEL = process.env.AI_LLM_MODEL || 'anthropic/claude-haiku-4.5'; // OpenRouter 라우팅 (유효 ID)
const EMBED_DIM = 1024;                                                 // 계약: vector(1024)

const BATCH_LIMIT = Number(process.env.AI_BATCH_LIMIT || 200);         // 1회 처리 상한
const SCORE_THRESHOLD = Number(process.env.SCORE_THRESHOLD || 60);     // 알림대상 룰점수
const AI_THRESHOLD = Number(process.env.AI_THRESHOLD || 70);           // 알림대상 AI점수
const TOP_BIDS_N = Number(process.env.DAILY_TOP_N || 10);              // 브리핑 상위 N
const MATCH_TOP_N = Number(process.env.MATCH_TOP_N || 5);              // 추천 인력 상위 N
const EMBED_INPUT_MAX = 8000;                                          // 임베딩 입력 문자 상한
const SUMMARY_INPUT_MAX = 12000;                                       // 요약 입력 문자 상한

// ---------------------------------------------------------------------
// 1. 키/클라이언트 로드 (평문 로그 금지)
// ---------------------------------------------------------------------
function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`환경변수 ${name} 가 필요합니다.`);
  return v;
}

// AES-256-GCM 복호화 (app_settings.value_enc, 형식: iv(12) | ciphertext | tag(16))
function decryptAesGcm(buf, masterKeyB64) {
  const key = Buffer.from(masterKeyB64, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(buf.length - 16);
  const ct = buf.subarray(12, buf.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

// OpenRouter 키: Secrets(OPENROUTER_API_KEY) 우선, 없으면 app_settings.llm_key(암호화) 복호화
async function loadOpenRouterKey(sb) {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  const masterKey = process.env.APP_MASTER_KEY;
  if (!masterKey) throw new Error('OPENROUTER_API_KEY 또는 APP_MASTER_KEY(+app_settings.llm_key)가 필요합니다.');
  const { data, error } = await sb
    .from('app_settings')
    .select('value_enc')
    .eq('setting_key', 'llm_key')
    .maybeSingle();
  if (error) throw new Error(`app_settings 조회 실패: ${error.message}`);
  if (!data?.value_enc) throw new Error('app_settings.llm_key 가 비어 있습니다.');
  // PostgREST bytea → '\x...' hex 문자열
  const hex = String(data.value_enc).replace(/^\\x/, '');
  return decryptAesGcm(Buffer.from(hex, 'hex'), masterKey);
}

// ---------------------------------------------------------------------
// 2. OpenRouter 호출 (재시도 1회)
// ---------------------------------------------------------------------
let OR_KEY = null; // 로드 후 주입 (로그 금지)

async function orFetch(path, body, tries = 2) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`${OPENROUTER_BASE}${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${OR_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://narajangteo.internal',
          'X-Title': 'narajangteo-ai-enrichment',
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const t = await res.text();
        throw new Error(`OpenRouter ${path} ${res.status}: ${t.slice(0, 300)}`);
      }
      return await res.json();
    } catch (e) {
      lastErr = e;
      if (i < tries - 1) await sleep(800 * (i + 1)); // 백오프 후 1회 재시도
    }
  }
  throw lastErr;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 임베딩 (배치 입력 지원). 반환: number[][] (각 1024차원)
async function embed(inputs) {
  if (inputs.length === 0) return [];
  const json = await orFetch('/embeddings', { model: EMBED_MODEL, input: inputs });
  const vecs = (json.data || []).map((d) => d.embedding);
  for (const v of vecs) {
    if (!Array.isArray(v) || v.length !== EMBED_DIM) {
      // 차원 불일치는 즉시 중단 (data-architect 계약: 1024 고정)
      throw new Error(`임베딩 차원 불일치: ${v?.length} (기대 ${EMBED_DIM}). data-architect에 알림 필요.`);
    }
  }
  return vecs;
}

// LLM 요약
async function chat(messages, opts = {}) {
  const json = await orFetch('/chat/completions', {
    model: LLM_MODEL,
    messages,
    temperature: opts.temperature ?? 0.2,
    max_tokens: opts.max_tokens ?? 700,
  });
  return json.choices?.[0]?.message?.content?.trim() || '';
}

// ---------------------------------------------------------------------
// 3. 유틸: 코사인, 벡터 직렬화, 해시, 정규화
// ---------------------------------------------------------------------
function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// pgvector 리터럴 ('[0.1,0.2,...]') — PostgREST가 vector 타입으로 캐스팅
const toVectorLiteral = (arr) => `[${arr.join(',')}]`;

const sha1 = (s) => crypto.createHash('sha1').update(s || '', 'utf8').digest('hex');
const norm = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------------
// 4. bids 조회 (멱등: src_hash 비교로 신규/변경만)
// ---------------------------------------------------------------------
async function loadPendingBids(sb) {
  // AI_MIN_SCORE 설정 시 상위 점수 공고만 대상(점수 높은 순). 미설정 시 최신순 전체.
  const minScore = process.env.AI_MIN_SCORE ? Number(process.env.AI_MIN_SCORE) : null;
  let q = sb
    .from('bids')
    .select('bid_no, bid_seq, title, order_org, demand_org, contract_method, notice_dt, deadline_dt, est_price, tags, ai_flags');
  if (minScore != null) {
    q = q.gte('score', minScore).order('score', { ascending: false }).limit(BATCH_LIMIT * 3);
  } else {
    q = q.order('notice_dt', { ascending: false, nullsFirst: false }).limit(BATCH_LIMIT * 3);
  }
  const { data: bids, error } = await q;
  if (error) throw new Error(`bids 조회 실패: ${error.message}`);

  const bidNos = bids.map((b) => b.bid_no);
  const attByBid = await loadAttachments(sb, bidNos);

  const pending = [];
  for (const b of bids) {
    const atts = attByBid.get(b.bid_no) || [];
    const extracted = atts.map((a) => a.extracted_text).filter(Boolean).join('\n\n');
    const srcHash = sha1([b.title, b.order_org, b.demand_org, b.contract_method, extracted].map(norm).join('|'));
    const flags = b.ai_flags || {};
    // 멱등 판정: src_hash 동일 && 임베딩·요약 완료면 스킵
    const done = flags.src_hash === srcHash && flags.embedded === true && flags.summary_ok === true;
    if (done) continue;
    pending.push({ ...b, _atts: atts, _extracted: extracted, _srcHash: srcHash });
    if (pending.length >= BATCH_LIMIT) break;
  }
  return pending;
}

async function loadAttachments(sb, bidNos) {
  const map = new Map();
  if (bidNos.length === 0) return map;
  const { data, error } = await sb
    .from('bid_attachments')
    .select('id, bid_no, bid_seq, doc_type, file_name, extracted_text, embedding')
    .in('bid_no', bidNos);
  if (error) throw new Error(`bid_attachments 조회 실패: ${error.message}`);
  for (const a of data) {
    if (!map.has(a.bid_no)) map.set(a.bid_no, []);
    map.get(a.bid_no).push(a);
  }
  return map;
}

// ---------------------------------------------------------------------
// 5. rules / keyword_groups / 관심조건 임베딩
// ---------------------------------------------------------------------
async function loadRules(sb) {
  const { data, error } = await sb
    .from('rules')
    .select('id, type, pattern, weight, is_active')
    .eq('is_active', true);
  if (error) throw new Error(`rules 조회 실패: ${error.message}`);
  if (!data || data.length === 0) {
    console.warn('[warn] rules 테이블이 비어 있습니다. 룰 점수 0 으로 진행합니다.');
  }
  return data || [];
}

// 관심조건 임베딩: 활성 keyword/org rules + keyword_groups 키워드를 합쳐 1회 임베딩
async function loadInterestVector(sb, rules) {
  const { data: groups } = await sb.from('keyword_groups').select('keywords');
  const terms = new Set();
  for (const r of rules) if (r.type === 'keyword' || r.type === 'org' || r.type === 'contract') terms.add(r.pattern);
  for (const g of groups || []) for (const k of g.keywords || []) terms.add(k);
  const query = [...terms].join(', ');
  if (!query) {
    console.warn('[warn] 관심조건(키워드/발주기관)이 비어 있어 ai_score 를 0 으로 둡니다.');
    return null;
  }
  const [vec] = await embed([query.slice(0, EMBED_INPUT_MAX)]);
  return vec;
}

// ---------------------------------------------------------------------
// 6. 스코어링 (7.2) — rules 기반 결정적
//   score = Σ(keyword/contract weight) + agency_bonus(org) − exclude_penalty(exclude)
// ---------------------------------------------------------------------
function scoreBid(bid, rules) {
  const hayTitle = norm(bid.title);
  const hayOrg = norm(`${bid.order_org} ${bid.demand_org}`);
  const hayContract = norm(bid.contract_method);
  const hayAll = `${hayTitle} ${hayOrg} ${hayContract} ${norm(bid._extracted).slice(0, 4000)}`;

  let base = 0, agencyBonus = 0, excludePenalty = 0;
  const matchedTags = new Set();
  const matched = [];

  for (const r of rules) {
    const p = norm(r.pattern);
    if (!p) continue;
    let hit = false;
    switch (r.type) {
      case 'keyword': hit = hayAll.includes(p); if (hit) base += r.weight; break;
      case 'contract': hit = hayContract.includes(p); if (hit) base += r.weight; break;
      case 'org': hit = hayOrg.includes(p); if (hit) agencyBonus += r.weight; break;
      case 'exclude': hit = hayAll.includes(p); if (hit) excludePenalty += r.weight; break;
    }
    if (hit) { matched.push({ id: r.id, type: r.type, pattern: r.pattern, weight: r.weight }); matchedTags.add(r.pattern); }
  }

  const score = base + agencyBonus - excludePenalty;
  return {
    score,
    breakdown: { base, agencyBonus, excludePenalty, matched },
    tags: [...matchedTags],
  };
}

// ---------------------------------------------------------------------
// 7. AI 요약 (7.3, FR-06) — 제공 텍스트 범위 내에서만
// ---------------------------------------------------------------------
function buildSummaryMessages(bid) {
  const meta = [
    `공고명: ${bid.title || '(없음)'}`,
    `발주기관: ${bid.order_org || '-'} / 수요기관: ${bid.demand_org || '-'}`,
    `계약방법: ${bid.contract_method || '-'}`,
    `추정가격: ${bid.est_price ?? '-'}`,
    `공고일: ${bid.notice_dt || '-'} / 마감일: ${bid.deadline_dt || '-'}`,
  ].join('\n');
  const body = (bid._extracted || '(첨부 추출 텍스트 없음 — 메타 정보만 사용)').slice(0, SUMMARY_INPUT_MAX);
  return [
    {
      role: 'system',
      content:
        '너는 공공 입찰공고 분석가다. 반드시 제공된 텍스트 범위 내에서만 요약한다. ' +
        '제공되지 않은 정보는 추측하거나 지어내지 말고 "명시되지 않음"으로 표기한다. ' +
        '출력은 한국어 Markdown이며 아래 형식을 따른다:\n' +
        '- 첫 3~5줄: 사업 개요 요약 (불릿)\n' +
        '**핵심 요건** 섹션: 과업범위 / 참가자격 / 사업규모(금액·기간) / 평가방식 / 주요 일정 을 각각 한 줄로.',
    },
    { role: 'user', content: `## 공고 메타\n${meta}\n\n## 첨부 추출 텍스트\n${body}` },
  ];
}

async function summarizeBid(bid) {
  try {
    const out = await chat(buildSummaryMessages(bid)); // orFetch가 내부 1회 재시도
    if (out && out.length > 20) return { summary: out, ok: true };
  } catch (e) {
    console.warn(`[warn] 요약 실패 ${bid.bid_no}: ${e.message}`);
  }
  // 폴백: 원문 일부 발췌 (환각 없이 안전)
  const excerpt = (bid._extracted || bid.title || '').slice(0, 500).trim();
  const fallback = `> AI 요약 생성 실패 — 원문 발췌\n\n${excerpt || '(요약 가능한 텍스트 없음)'}`;
  return { summary: fallback, ok: false };
}

// ---------------------------------------------------------------------
// 8. 인력 매칭 (FR-10) — 공고 요건 ↔ member_table (규칙 + 임베딩 유사도)
//   결과 shape은 S-06 렌더용 (03_ai_scripts.md에 명시)
// ---------------------------------------------------------------------
async function loadMembers(sb) {
  const { data, error } = await sb
    .from('member_table')
    .select('member_id, name, work_type, tech_grade, license_name, specialty_field, career_years, status')
    .eq('status', '재직');
  if (error) throw new Error(`member_table 조회 실패: ${error.message}`);
  return data || [];
}

// 규칙 기반 점수 + (있으면) 공고 임베딩과 전문분야/자격 유사도로 랭킹
function matchMembers(bid, bidVec, members, memberVecs) {
  const hay = `${norm(bid.title)} ${norm(bid._extracted).slice(0, 4000)}`;
  const scored = members.map((m) => {
    let s = 0;
    const reasons = [];
    if (m.specialty_field && hay.includes(norm(m.specialty_field))) { s += 40; reasons.push(`전문분야:${m.specialty_field}`); }
    if (m.license_name && hay.includes(norm(m.license_name))) { s += 35; reasons.push(`자격:${m.license_name}`); }
    // 기술등급 가중 (특급>고급>중급>초급)
    const gradeW = { 특급: 15, 고급: 10, 중급: 5, 초급: 2 }[m.tech_grade] || 0;
    s += gradeW;
    // 임베딩 유사도 보너스 (0~30)
    const mv = memberVecs.get(m.member_id);
    if (bidVec && mv) { const sim = Math.max(0, cosine(bidVec, mv)); s += Math.round(sim * 30); if (sim > 0.3) reasons.push('의미유사'); }
    return {
      member_id: m.member_id,
      name: m.name,
      tech_grade: m.tech_grade,
      specialty_field: m.specialty_field || null,
      license_name: m.license_name || null,
      career_years: m.career_years ?? null,
      work_type: m.work_type,
      match_score: s,
      reasons,
    };
  });
  return scored
    .filter((m) => m.match_score > 0)
    .sort((a, b) => b.match_score - a.match_score)
    .slice(0, MATCH_TOP_N);
}

// ---------------------------------------------------------------------
// 9. 쓰기: bids 갱신
// ---------------------------------------------------------------------
async function updateBid(sb, bid, patch) {
  const { error } = await sb
    .from('bids')
    .update(patch)
    .eq('bid_no', bid.bid_no)
    .eq('bid_seq', bid.bid_seq);
  if (error) throw new Error(`bids 갱신 실패 ${bid.bid_no}/${bid.bid_seq}: ${error.message}`);
}

// ---------------------------------------------------------------------
// 10. daily_brief — 당일 top_bids + 다이제스트
// ---------------------------------------------------------------------
async function buildDailyBrief(sb) {
  const today = new Date().toISOString().slice(0, 10);
  // 당일(=오늘 마감 또는 진행중) 공고 중 상위 점수
  const { data, error } = await sb
    .from('bids')
    .select('bid_no, bid_seq, title, order_org, deadline_dt, score, ai_score, status')
    .not('status', 'is', null)
    .neq('status', 'closed')
    .order('score', { ascending: false, nullsFirst: false })
    .limit(TOP_BIDS_N);
  if (error) throw new Error(`daily_brief 조회 실패: ${error.message}`);
  const top = (data || []).map((b) => ({
    bid_no: b.bid_no,
    bid_seq: b.bid_seq,
    title: b.title,
    order_org: b.order_org,
    deadline_dt: b.deadline_dt,
    score: b.score ?? 0,
    ai_score: b.ai_score ?? 0,
    status: b.status,
  }));

  let summary = `오늘(${today}) 주목할 입찰 ${top.length}건.`;
  if (top.length > 0) {
    try {
      const list = top.map((t, i) => `${i + 1}. [${t.score}점] ${t.title} (${t.order_org || '-'}, 마감 ${t.deadline_dt || '-'})`).join('\n');
      summary = await chat(
        [
          { role: 'system', content: '너는 사내 입찰 브리핑 담당자다. 제공된 목록만 근거로 3~5줄 한국어 다이제스트를 쓴다. 없는 정보는 지어내지 않는다.' },
          { role: 'user', content: `오늘 상위 입찰 목록:\n${list}\n\n핵심 흐름과 우선 검토 대상을 요약해줘.` },
        ],
        { max_tokens: 400 }
      );
    } catch (e) {
      console.warn(`[warn] daily_brief 요약 실패, 기본 문구 사용: ${e.message}`);
    }
  }

  const { error: upErr } = await sb
    .from('daily_brief')
    .upsert({ brief_date: today, summary, top_bids: top }, { onConflict: 'brief_date' });
  if (upErr) throw new Error(`daily_brief upsert 실패: ${upErr.message}`);
  return { today, count: top.length };
}

// ---------------------------------------------------------------------
// 11. 메인
// ---------------------------------------------------------------------
async function main() {
  const SUPABASE_URL = required('SUPABASE_URL');
  const SUPABASE_SERVICE_KEY = required('SUPABASE_SERVICE_KEY');
  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

  OR_KEY = await loadOpenRouterKey(sb);

  const rules = await loadRules(sb);
  const interestVec = await loadInterestVector(sb, rules);
  const members = await loadMembers(sb);

  const pending = await loadPendingBids(sb);
  console.log(`[info] 처리 대상 bids: ${pending.length}건 (batch limit ${BATCH_LIMIT})`);

  // 재사용할 member 임베딩 (전문분야+자격 기반, 1회)
  const memberVecs = new Map();
  if (interestVec && members.length > 0) {
    try {
      const inputs = members.map((m) => `${m.specialty_field || ''} ${m.license_name || ''} ${m.tech_grade || ''}`.trim() || m.name);
      const mvs = await embed(inputs.map((s) => s.slice(0, 500)));
      members.forEach((m, i) => memberVecs.set(m.member_id, mvs[i]));
    } catch (e) {
      console.warn(`[warn] member 임베딩 실패, 규칙 매칭만 사용: ${e.message}`);
    }
  }

  let ok = 0, failed = 0;
  for (const bid of pending) {
    try {
      // --- 2) 임베딩 (공고) ---
      const embedInput = [
        bid.title, bid.order_org, bid.demand_org, bid.contract_method, bid._extracted,
      ].filter(Boolean).join('\n').slice(0, EMBED_INPUT_MAX);
      const [bidVec] = await embed([embedInput || bid.bid_no]);

      // --- 2b) 첨부 임베딩 (embedding 없는 것만 — 멱등) ---
      const attNeed = (bid._atts || []).filter((a) => a.extracted_text && !a.embedding);
      if (attNeed.length > 0) {
        const avs = await embed(attNeed.map((a) => a.extracted_text.slice(0, EMBED_INPUT_MAX)));
        for (let i = 0; i < attNeed.length; i++) {
          const { error } = await sb.from('bid_attachments')
            .update({ embedding: toVectorLiteral(avs[i]) }).eq('id', attNeed[i].id);
          if (error) console.warn(`[warn] 첨부 임베딩 저장 실패 id=${attNeed[i].id}: ${error.message}`);
        }
      }

      // --- 3) 요약 ---
      const { summary, ok: summaryOk } = await summarizeBid(bid);

      // --- 4) 스코어링 ---
      const { score, breakdown, tags } = scoreBid(bid, rules);
      const aiScore = interestVec ? Math.round(Math.max(0, cosine(bidVec, interestVec)) * 100) : 0;
      const alert = score >= SCORE_THRESHOLD || aiScore >= AI_THRESHOLD;

      // --- 5) 인력매칭 ---
      const matches = matchMembers(bid, bidVec, members, memberVecs);

      // --- ai_flags 조립 (멱등 마커 + S-06 부가정보) ---
      const ai_flags = {
        src_hash: bid._srcHash,
        embedded: true,
        summary_ok: summaryOk,
        enriched_at: new Date().toISOString(),
        model: { embed: EMBED_MODEL, llm: LLM_MODEL },
        alert,
        thresholds: { score: SCORE_THRESHOLD, ai_score: AI_THRESHOLD },
        score_breakdown: breakdown,
        matches, // 추천 인력 (S-06 FR-10 렌더용)
      };

      await updateBid(sb, bid, {
        embedding: toVectorLiteral(bidVec),
        ai_summary: summary,
        score,
        ai_score: aiScore,
        tags,
        ai_flags,
        updated_at: new Date().toISOString(),
      });
      ok++;
    } catch (e) {
      failed++;
      console.error(`[error] bid ${bid.bid_no}/${bid.bid_seq} 처리 실패(이번 배치 스킵, 다음 실행 재처리): ${e.message}`);
      // 차원 불일치는 계약 위반 — 전체 중단
      if (/차원 불일치/.test(e.message)) throw e;
    }
  }

  // --- 6) daily_brief ---
  const brief = await buildDailyBrief(sb);

  console.log(`[done] enriched=${ok} failed=${failed} | daily_brief ${brief.today} top=${brief.count}`);
  if (failed > 0) process.exitCode = 0; // 부분 실패는 배치 성공으로 간주(다음 실행 재처리)
}

main().catch((e) => {
  console.error(`[fatal] ${e.message}`);
  process.exit(1);
});
