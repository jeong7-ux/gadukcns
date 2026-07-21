// =====================================================================
// lib/collect/classify.ts — 수집 시 AI 사업분류 게이트 (기능상세정의서 v1.1, FR-21~24)
//   Stage 0 하드필터 → Stage 1 저비용 사전선별(rules/keyword_groups) →
//   Stage 2 LLM 분류(감리/컨설팅/해당없음, 캐시) → Stage 3 적재 결정.
//   수동 "바로수집"(runner.ts)에서만 호출한다(자동수집 폐지).
// =====================================================================
import type { SupabaseClient } from "@supabase/supabase-js";
// 상대경로 import 유지: 이 모듈은 Next(webpack) 외에 Netlify Background Function(esbuild)
//   에서도 번들되므로 tsconfig paths(@/) 해석에 의존하지 않는다.
import { chatJson, openRouterKey, type ChatMessage } from "../ai/openrouter";

// ── 설정(env override) ──────────────────────────────────────────
const CFG = {
  enabled: process.env.CLASSIFY_ENABLED !== "false",
  model: process.env.CLASSIFY_MODEL || "anthropic/claude-haiku-4.5",
  minPrefilter: Number(process.env.CLASSIFY_MIN_PREFILTER) || 4,
  keep: Number(process.env.CLASSIFY_KEEP_THRESHOLD) || 0.8, // 강화(v1.1→): 0.6→0.8, 경계는 보류
  drop: Number(process.env.CLASSIFY_DROP_THRESHOLD) || 0.4,
  maxLlm: Number(process.env.CLASSIFY_MAX_LLM_PER_RUN) || 300,
  concurrency: Number(process.env.CLASSIFY_CONCURRENCY) || 4,
  verify: process.env.CLASSIFY_VERIFY !== "false", // 2차 검증(adversarial) on/off
};
// haiku-4.5 개략 단가로 1콜당 비용 추정(메타 ~500 in + ~60 out)
const EST_COST_PER_CALL = 0.0006;

const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();

// Stage0 하드 제외: 정보시스템 감리가 아닌 '건설·시설' 감리 및 비-IT 일반용역
const STAGE0_CONSTRUCTION = ["건설", "건축", "토목", "소방", "전기공사", "조경", "통신공사", "설비", "도로", "교량", "하천", "상수도", "하수도", "항만", "철도", "플랜트", "시설공사", "정비공사"];
const STAGE0_NONIT = ["청소용역", "경비용역", "급식", "방역", "제초", "시설관리", "차량", "행사대행", "인쇄", "번역", "속기"];
// 무관 도메인(교육/조사/연구/운영) — 코어 신호 없으면 Stage0 드롭
const SUSPECT_DOMAIN = ["교과목", "교육과정", "커리큘럼", "교재", "콘텐츠 개발", "서베이", "설문", "실태조사", "여론조사", "연구용역", "산출 방법", "산출방법", "지원사업 운영", "운영 대행", "홍보", "행사"];
// 코어 신호(감리/컨설팅 자문·전략·계획·평가). 후보 자격 + Stage0 제외 예외 판정.
const CORE_KEYWORDS = ["감리", "isp", "ismp", "정보화전략", "정보전략계획", "정보화전략계획", "전략계획", "정보화 기본계획", "정보화계획", "정보화 계획", "마스터플랜", "bpr", "아키텍처", "성과평가", "pmo", "isms", "정보보안 컨설팅", "보안 컨설팅", "지능정보화", "정보화 컨설팅", "정보화컨설팅", "상주감리"];
// 명시적 코어(오분류 거의 없음) → 2차 검증 생략 대상
const EXPLICIT_CORE = ["isp", "ismp", "정보화전략", "정보전략계획", "정보화전략계획", "감리", "성과평가", "isms", "bpr"];
function hasCoreSignal(bid: RawBid): boolean {
  const h = `${norm(bid.title)} ${norm(bid.contract_method)}`;
  return CORE_KEYWORDS.some((k) => h.includes(k));
}
function isExplicitCore(bid: RawBid): boolean {
  const h = norm(bid.title);
  return EXPLICIT_CORE.some((k) => h.includes(k));
}

export interface RawBid {
  bid_no: string;
  bid_seq: string;
  title?: unknown;
  order_org?: unknown;
  demand_org?: unknown;
  contract_method?: unknown;
  est_price?: number | null;
  notice_dt?: string | null;
  deadline_dt?: string | null;
  raw?: Record<string, unknown>;
  [k: string]: unknown;
}
interface Rule { type: string; pattern: string; weight: number }
interface Group { name: string; keywords: string[]; exclude: string[] | null }

export interface ClassifyContext {
  rules: Rule[];
  groups: Group[];
  hasBizCol: boolean;   // bids.biz_category 배포 여부
  hasClsTable: boolean; // bid_classifications 배포 여부
  cache: Map<string, { category: string }>;
}
export type BizCategory = "감리" | "컨설팅";
export interface KeepItem {
  row: RawBid;
  biz_category: BizCategory | null;
  needs_review: boolean;
  confidence: number | null;
  reason: string | null;
  method: "llm" | "cache" | "rule";
}
export interface Decision {
  bid_no: string;
  bid_seq: string;
  category: "감리" | "컨설팅" | "해당없음" | "보류" | "오류";
  confidence: number | null;
  reason: string | null;
  method: "llm" | "cache" | "rule";
  model: string | null;
  title: string | null;
  order_org: string | null;
  prefilter_base: number;
}
export interface ClassifyStats {
  enabled: boolean;
  scanned: number;
  stage0_dropped: number;
  candidates: number;
  cache_hits: number;
  llm_calls: number;
  llm_errors: number;
  kept_감리: number;
  kept_컨설팅: number;
  pending_review: number;
  dropped: number;
  capped: number; // 상한 초과로 보류된 후보 수
  est_cost: number;
  verify_calls: number; // 2차 검증 호출 수
  verify_downgraded: number; // 2차 검증으로 보류 강등된 수
}
export interface ClassifyResult {
  keep: KeepItem[];
  decisions: Decision[];
  stats: ClassifyStats;
}

// ── 스키마 감지(미배포 시 폴백) ─────────────────────────────────
async function detectSchema(sb: SupabaseClient) {
  let hasBizCol = true, hasClsTable = true;
  const a = await sb.from("bids").select("biz_category").limit(1);
  if (a.error) hasBizCol = false;
  const b = await sb.from("bid_classifications").select("bid_no").limit(1);
  if (b.error) hasClsTable = false;
  return { hasBizCol, hasClsTable };
}

export async function loadClassifyContext(
  sb: SupabaseClient,
  candidateKeys: { bid_no: string; bid_seq: string }[] = []
): Promise<ClassifyContext> {
  const [rulesRes, groupsRes, schema] = await Promise.all([
    sb.from("rules").select("type,pattern,weight").eq("is_active", true).in("type", ["keyword", "contract", "exclude"]),
    sb.from("keyword_groups").select("name,keywords,exclude"),
    detectSchema(sb),
  ]);
  const cache = new Map<string, { category: string }>();
  if (schema.hasClsTable && candidateKeys.length) {
    // 캐시 조회(오류 판정은 재분류 대상이므로 제외)
    const bidNos = [...new Set(candidateKeys.map((k) => k.bid_no))];
    const { data } = await sb
      .from("bid_classifications")
      .select("bid_no,bid_seq,category")
      .in("bid_no", bidNos)
      .neq("category", "오류");
    for (const r of (data as { bid_no: string; bid_seq: string; category: string }[] | null) ?? []) {
      cache.set(`${r.bid_no}|${r.bid_seq}`, { category: r.category });
    }
  }
  return {
    rules: (rulesRes.data as Rule[]) ?? [],
    groups: (groupsRes.data as Group[]) ?? [],
    hasBizCol: schema.hasBizCol,
    hasClsTable: schema.hasClsTable,
    cache,
  };
}

// ── Stage 0: 하드 필터 ──────────────────────────────────────────
function stage0Drop(bid: RawBid, groups: Group[]): boolean {
  const title = norm(bid.title);
  const contract = norm(bid.contract_method);
  const hay = `${title} ${contract}`;
  // 건설·시설 감리(정보시스템 감리 아님): '감리' 포함 + 건설류 키워드
  if (title.includes("감리") && STAGE0_CONSTRUCTION.some((k) => hay.includes(k))) return true;
  // 감리 그룹 exclude(건설/건축/토목/소방/전기/조경/통신) 이면서 IT 신호 없음
  const gamriGroup = groups.find((g) => g.name.includes("감리"));
  if (gamriGroup?.exclude?.length && title.includes("감리")) {
    if (gamriGroup.exclude.some((ex) => ex && hay.includes(norm(ex)))) return true;
  }
  // 비-IT 일반용역
  if (STAGE0_NONIT.some((k) => hay.includes(k))) return true;
  // 무관 도메인(교육/조사/연구/운영) — 코어 신호가 없으면 드롭(있으면 예외 유지)
  if (!hasCoreSignal(bid) && SUSPECT_DOMAIN.some((k) => hay.includes(k))) return true;
  return false;
}

// ── Stage 1: 저비용 사전선별(base) ──────────────────────────────
function prefilterBase(bid: RawBid, ctx: ClassifyContext): number {
  const hayTitle = norm(bid.title);
  const hayContract = norm(bid.contract_method);
  const hayAll = `${hayTitle} ${norm(bid.order_org)} ${norm(bid.demand_org)} ${hayContract}`;
  let base = 0;
  for (const r of ctx.rules) {
    const p = norm(r.pattern);
    if (!p) continue;
    if (r.type === "keyword" && hayAll.includes(p)) base += r.weight;
    else if (r.type === "contract" && hayContract.includes(p)) base += r.weight;
    else if (r.type === "exclude" && hayAll.includes(p)) base -= r.weight;
  }
  return base;
}
// Stage1 후보 자격(강화): 코어 신호(감리/ISP/전략/평가 등) 또는 rules base≥임계.
//   'AI/데이터' 단독 매칭은 후보 제외 — hasCoreSignal에 포함하지 않음(과대매칭 방지).
function isCandidate(bid: RawBid, _ctx: ClassifyContext, base: number): boolean {
  return hasCoreSignal(bid) || base >= CFG.minPrefilter;
}

// ── Stage 2: LLM 분류 프롬프트 ──────────────────────────────────
function buildMessages(bid: RawBid): ChatMessage[] {
  const sys =
    "너는 '정보시스템(IT) 감리·컨설팅 전문회사'의 입찰 사업분류 분석가다. 아래 셋 중 하나로 판정한다.\n" +
    "[감리] 정보시스템(정보화) 감리 — 정보시스템감리사/감리원 배치·감리대가 산정, 정보화사업의 제3자/PMO 감리. " +
    "※ 건설/건축/토목/소방/전기 감리는 감리 아님(해당없음).\n" +
    "[컨설팅] 정보화 '자문/전략/계획/평가' 성격만 해당 — ISP·ISMP·정보화전략계획·정보전략계획·BPR·EA·정보화 성과평가·PMO·정보보안(ISMS-P) 컨설팅.\n" +
    "[해당없음] 위가 아니면 전부. 특히 다음은 반드시 해당없음:\n" +
    "- 시스템 '구축·고도화·개발·운영·유지관리'만 있고 ISP/전략/감리 성격이 없는 것\n" +
    "- 데이터 '구축·분석·서베이·조사', 교육/교과목/콘텐츠 개발, 연구용역/방법 조사, 지원사업 운영·대행, 물품·건설·일반용역\n" +
    "- '빅데이터/인공지능' 단어가 있어도 그 자체로 컨설팅이 아니다. ISP/전략/자문/평가/감리 성격일 때만 감리/컨설팅이다.\n" +
    "예시:\n" +
    "- '○○정보시스템 구축 감리 용역' → 감리\n" +
    "- '△△ 정보화전략계획(ISP) 수립' → 컨설팅\n" +
    "- '□□ 정보보안(ISMS-P) 인증 컨설팅' → 컨설팅\n" +
    "- '빅데이터 교과목 2단계 개선' → 해당없음(교육)\n" +
    "- '고객 빅데이터 기반 서베이' → 해당없음(조사)\n" +
    "- '□□ 빅데이터 통합관리시스템 고도화'(ISP 없음) → 해당없음(구축)\n" +
    "- '게임 개발 AX 지원사업 운영' → 해당없음(운영)\n" +
    "애매하면 confidence를 낮게. reason은 40자 이내. 출력은 JSON 하나만(코드펜스·설명 금지):\n" +
    '{ "category": "감리|컨설팅|해당없음", "confidence": 0.0, "reason": "짧은 근거" }';
  const user = [
    `공고명: ${bid.title ?? "-"}`,
    `발주기관: ${bid.order_org ?? "-"} / 수요기관: ${bid.demand_org ?? "-"}`,
    `계약방법: ${bid.contract_method ?? "-"}`,
    `추정가격: ${bid.est_price ?? "-"}`,
  ].join("\n");
  return [
    { role: "system", content: sys },
    { role: "user", content: user },
  ];
}
interface LlmOut { category?: string; confidence?: number; reason?: string }

// 2차 검증(adversarial): 적재 후보가 실제 자문/전략/계획/평가/감리인지 재확인.
//   구축/개발/고도화/운영/유지/데이터구축/조사/교육/연구면 keep=false. 실패 시 보수적 유지.
async function verifyKeep(bid: RawBid): Promise<boolean> {
  const sys =
    "너는 정보시스템 감리·컨설팅 전문회사의 최종 검수자다. " +
    "아래 공공 입찰 사업이 '정보시스템(정보화) 감리' 또는 '정보화 자문/전략/계획/평가 컨설팅(ISP/ISMP/정보화전략계획/BPR/EA/성과평가/PMO/ISMS-P 보안컨설팅)'에 실제로 해당하면 keep=true. " +
    "시스템 구축·개발·고도화·운영·유지관리, 데이터 구축·분석·서베이·조사, 교육/교과목/콘텐츠, 연구용역/방법조사, 지원사업 운영/대행이면 keep=false. " +
    '출력은 JSON 하나만: { "keep": true, "why": "짧게" }';
  const user = `공고명: ${bid.title ?? "-"} / 발주: ${bid.order_org ?? "-"} / 계약: ${bid.contract_method ?? "-"}`;
  try {
    const out = await chatJson<{ keep?: boolean }>(
      [
        { role: "system", content: sys },
        { role: "user", content: user },
      ],
      { model: CFG.model, maxTokens: 120 }
    );
    if (out && typeof out.keep === "boolean") return out.keep;
  } catch {
    /* 검증 실패 → 보수적 유지 */
  }
  return true;
}

// ── Stage 3: 적재 결정 ──────────────────────────────────────────
type Decided = {
  keep: boolean;
  biz: BizCategory | null;
  needsReview: boolean;
  clsCategory: Decision["category"];
};
function decide(category: string | undefined, confidence: number): Decided {
  const c = Math.max(0, Math.min(1, Number.isFinite(confidence) ? confidence : 0.5));
  if (category === "감리" || category === "컨설팅") {
    if (c >= CFG.keep) return { keep: true, biz: category, needsReview: false, clsCategory: category };
    // 애매(낮은 신뢰) → 보류 적재(놓침 방지)
    return { keep: true, biz: category, needsReview: true, clsCategory: "보류" };
  }
  if (category === "해당없음") {
    if (c >= CFG.drop) return { keep: false, biz: null, needsReview: false, clsCategory: "해당없음" };
    return { keep: true, biz: null, needsReview: true, clsCategory: "보류" }; // 애매한 해당없음 → 보류
  }
  // 알 수 없음/파싱 실패
  return { keep: true, biz: null, needsReview: true, clsCategory: "오류" };
}

// 동시성 제한 병렬 map
async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

// ── 메인: 분류 + 필터 ───────────────────────────────────────────
export async function classifyBids(rows: RawBid[], ctx: ClassifyContext): Promise<ClassifyResult> {
  const stats: ClassifyStats = {
    enabled: CFG.enabled, scanned: rows.length, stage0_dropped: 0, candidates: 0,
    cache_hits: 0, llm_calls: 0, llm_errors: 0, kept_감리: 0, kept_컨설팅: 0,
    pending_review: 0, dropped: 0, capped: 0, est_cost: 0, verify_calls: 0, verify_downgraded: 0,
  };
  const keep: KeepItem[] = [];
  const decisions: Decision[] = [];

  // 게이트 비활성/키 없음 → 전량 통과(기존 동작 폴백)
  if (!CFG.enabled || !openRouterKey()) {
    for (const row of rows) keep.push({ row, biz_category: null, needs_review: false, confidence: null, reason: null, method: "rule" });
    stats.candidates = rows.length;
    return { keep, decisions, stats };
  }

  // Stage 0 + Stage 1 (동기, LLM 0)
  type Cand = { bid: RawBid; base: number };
  const candidates: Cand[] = [];
  for (const bid of rows) {
    if (stage0Drop(bid, ctx.groups)) {
      stats.stage0_dropped++;
      decisions.push(mkDecision(bid, "해당없음", 1, "Stage0 하드필터(건설감리/비IT)", "rule", null, 0));
      stats.dropped++;
      continue;
    }
    const base = prefilterBase(bid, ctx);
    if (!isCandidate(bid, ctx, base)) {
      decisions.push(mkDecision(bid, "해당없음", 0.8, "Stage1 사전선별 미통과(관련성 낮음)", "rule", null, base));
      stats.dropped++;
      continue;
    }
    candidates.push({ bid, base });
  }
  stats.candidates = candidates.length;

  // 캐시 히트 분리
  const needLlm: Cand[] = [];
  for (const c of candidates) {
    const hit = ctx.cache.get(`${c.bid.bid_no}|${c.bid.bid_seq}`);
    const changed = norm(c.bid.raw?.ntceKindNm) === "변경공고";
    if (hit && !changed) {
      stats.cache_hits++;
      // 캐시는 이미 확정된 판정 → decide() 재적용 없이 그대로 반영
      const cat = hit.category;
      decisions.push(mkDecision(c.bid, cat as Decision["category"], null, "캐시", "cache", null, c.base));
      if (cat === "해당없음") {
        stats.dropped++;
      } else if (cat === "보류" || cat === "오류") {
        keep.push({ row: c.bid, biz_category: null, needs_review: true, confidence: null, reason: "캐시(보류)", method: "cache" });
        stats.pending_review++;
      } else {
        keep.push({ row: c.bid, biz_category: cat as BizCategory, needs_review: false, confidence: null, reason: "캐시", method: "cache" });
        if (cat === "감리") stats.kept_감리++;
        else stats.kept_컨설팅++;
      }
    } else {
      needLlm.push(c);
    }
  }

  // 상한 적용: 초과분은 보류 적재(다음 실행 재분류)
  const toCall = needLlm.slice(0, CFG.maxLlm);
  const capped = needLlm.slice(CFG.maxLlm);
  for (const c of capped) {
    stats.capped++;
    keep.push({ row: c.bid, biz_category: null, needs_review: true, confidence: null, reason: "LLM 상한 초과(보류)", method: "rule" });
    stats.pending_review++;
    decisions.push(mkDecision(c.bid, "보류", null, "LLM 상한 초과", "rule", null, c.base));
  }

  // Stage 2 LLM (동시성 제한) + 2차 검증
  await mapLimit(toCall, CFG.concurrency, async (c) => {
    stats.llm_calls++;
    stats.est_cost += EST_COST_PER_CALL;
    let out: LlmOut | null = null;
    try {
      out = await chatJson<LlmOut>(buildMessages(c.bid), { model: CFG.model, maxTokens: 320 });
    } catch {
      out = null;
    }
    if (!out || !out.category) {
      stats.llm_errors++;
      // fail-open: 보류 적재
      keep.push({ row: c.bid, biz_category: null, needs_review: true, confidence: null, reason: "LLM 분류 실패(보류)", method: "llm" });
      stats.pending_review++;
      decisions.push(mkDecision(c.bid, "오류", null, "LLM 분류 실패", "llm", CFG.model, c.base));
      return;
    }

    let d = decide(out.category, out.confidence ?? 0.5);
    let reason = out.reason ?? null;

    // 2차 검증: 코어 명시가 아닌 '적재 확정'건은 재확인 → 구축/운영/교육 의심 시 보류 강등
    if (CFG.verify && d.keep && !d.needsReview && d.biz && !isExplicitCore(c.bid)) {
      stats.llm_calls++;
      stats.est_cost += EST_COST_PER_CALL;
      stats.verify_calls++;
      const ok = await verifyKeep(c.bid);
      if (!ok) {
        d = { keep: true, biz: d.biz, needsReview: true, clsCategory: "보류" };
        reason = `2차검증 보류: ${reason ?? ""}`.slice(0, 120);
        stats.verify_downgraded++;
      }
    }

    decisions.push(mkDecision(c.bid, d.clsCategory, out.confidence ?? null, reason, "llm", CFG.model, c.base));
    if (!d.keep) {
      stats.dropped++;
      return;
    }
    keep.push({ row: c.bid, biz_category: d.biz, needs_review: d.needsReview, confidence: out.confidence ?? null, reason, method: "llm" });
    if (d.needsReview) stats.pending_review++;
    else if (d.biz === "감리") stats.kept_감리++;
    else if (d.biz === "컨설팅") stats.kept_컨설팅++;
  });

  return { keep, decisions, stats };
}

function mkDecision(
  bid: RawBid,
  category: Decision["category"],
  confidence: number | null,
  reason: string | null,
  method: Decision["method"],
  model: string | null,
  base: number
): Decision {
  return {
    bid_no: bid.bid_no,
    bid_seq: bid.bid_seq,
    category,
    confidence,
    reason,
    method,
    model,
    title: (bid.title as string) ?? null,
    order_org: (bid.order_org as string) ?? null,
    prefilter_base: base,
  };
}

// keep 아이템에 분류 컬럼을 부착한 upsert row 생성(스키마 배포 시에만 컬럼 포함)
export function withClassifyColumns(item: KeepItem, hasBizCol: boolean): RawBid {
  if (!hasBizCol) return item.row;
  return {
    ...item.row,
    biz_category: item.biz_category,
    classify: {
      method: item.method,
      confidence: item.confidence,
      reason: item.reason,
      model: item.method === "llm" ? CFG.model : null,
      at: new Date().toISOString(),
      needs_review: item.needs_review,
    },
  };
}

// bid_classifications 멱등 upsert(테이블 배포 시)
export async function persistDecisions(sb: SupabaseClient, decisions: Decision[]): Promise<number> {
  if (!decisions.length) return 0;
  const rows = decisions.map((d) => ({
    bid_no: d.bid_no,
    bid_seq: d.bid_seq,
    category: d.category,
    confidence: d.confidence,
    reason: d.reason ? d.reason.slice(0, 500) : null,
    method: d.method,
    model: d.model,
    title: d.title ? d.title.slice(0, 300) : null,
    order_org: d.order_org ? d.order_org.slice(0, 200) : null,
    prefilter_base: d.prefilter_base,
    decided_at: new Date().toISOString(),
  }));
  const { error } = await sb.from("bid_classifications").upsert(rows, { onConflict: "bid_no,bid_seq" });
  return error ? 0 : rows.length;
}
