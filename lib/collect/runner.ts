// =====================================================================
// lib/collect/runner.ts — 인앱 "바로 수집하기" 바운드 수집 (FR-02/25 수동 트리거)
//
// 정의서 v1.1: 수집은 이 수동 경로 전용(자동 cron 폐지). 여기서는 최근 N일·페이지
// 상한으로 바운드하고, 가져온 공고를 **AI 분류 게이트(lib/collect/classify.ts)** 로
// 감리/컨설팅만 선별해 적재한다(해당없음 미적재 → DB·자원 절감).
//
// 정규 증분 커서(collect_cursor)는 건드리지 않는다. 결과는 collect_runs(trigger='manual',
// classify 통계 포함)에 기록해 S-10 수집 모니터가 시각화한다.
// 매핑은 scripts/collect.mjs(실측 매핑 API_실측매핑.md)와 동일하게 유지한다.
// =====================================================================
import type { SupabaseClient } from "@supabase/supabase-js";
// 상대경로 import: Netlify Background Function(esbuild)에서도 동일 모듈을 번들한다.
import {
  loadClassifyContext,
  classifyBids,
  withClassifyColumns,
  persistDecisions,
  type ClassifyStats,
  type RawBid,
} from "./classify";
import { syncAttachments } from "./attachments";

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const NARA_API_BASE =
  process.env.NARA_API_BASE || "https://apis.data.go.kr/1230000/ad/BidPublicInfoService";
const NARA_BID_TYPES = (process.env.NARA_BID_TYPES || "servc")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const TYPE_SUFFIX: Record<string, string> = { servc: "Servc", cnstwk: "Cnstwk", thng: "Thng" };

export interface CollectRunOptions {
  days?: number; // 조회 범위(최근 N일). 기본 1
  maxPages?: number; // 유형당 페이지 상한(타임아웃 방지). 기본 6(=최대 600건)
  numOfRows?: number; // 페이지당 행. 기본 100
  triggeredBy?: string | null; // 실행자 user_id(감사)
  runId?: number | null; // 이미 생성된 collect_runs 행(백그라운드 위임 경로). 있으면 insert 생략
}
export interface CollectRunResult {
  runId: number | null;
  status: "success" | "partial" | "failed";
  trigger: "manual";
  window: { bgn: string; end: string };
  pages: number;
  scanned: number;
  bidsUpserted: number;
  changesAppended: number;
  attachmentsUpserted: number; // bid_attachments 정규화 삽입 행 수
  durationMs: number;
  checks: Record<string, boolean>;
  errors: string[];
  runsTableDeployed: boolean; // collect_runs 기록 성공 여부(미배포 시 false)
  classify: ClassifyStats | null;   // AI 분류 게이트 통계(FR-23~24)
  classifyDeployed: boolean;        // bids.biz_category / bid_classifications 배포 여부
}

// ── 유틸(collect.mjs와 동일 규칙) ───────────────────────────────
function toKstInqryDt(date: Date): string {
  const k = new Date(date.getTime() + KST_OFFSET_MS);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    k.getUTCFullYear().toString() +
    p(k.getUTCMonth() + 1) +
    p(k.getUTCDate()) +
    p(k.getUTCHours()) +
    p(k.getUTCMinutes())
  );
}
function parseKstToIso(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  const digits = s.replace(/[^0-9]/g, "");
  if (/^[0-9]+$/.test(s) && digits.length >= 8) {
    const y = digits.slice(0, 4), mo = digits.slice(4, 6), d = digits.slice(6, 8);
    const h = digits.slice(8, 10) || "00", mi = digits.slice(10, 12) || "00", se = digits.slice(12, 14) || "00";
    return `${y}-${mo}-${d}T${h}:${mi}:${se}+09:00`;
  }
  const m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})[ T]?(\d{1,2})?:?(\d{1,2})?:?(\d{1,2})?/);
  if (m) {
    const [, y, mo, d, h = "00", mi = "00", se = "00"] = m;
    const pad = (x: string) => String(x).padStart(2, "0");
    return `${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:${pad(se)}+09:00`;
  }
  return null;
}
function pick(obj: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") return v;
  }
  return null;
}
function toBigint(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(String(v).replace(/[, ]/g, ""));
  return Number.isFinite(n) ? Math.trunc(n) : null;
}
function itemsOf(body: Record<string, unknown> | null): Record<string, unknown>[] {
  const it = (body as { items?: unknown })?.items as
    | { item?: unknown }
    | unknown[]
    | undefined;
  if (!it) return [];
  if (Array.isArray(it)) return it as Record<string, unknown>[];
  const item = (it as { item?: unknown }).item;
  if (Array.isArray(item)) return item as Record<string, unknown>[];
  if (item) return [item as Record<string, unknown>];
  return [];
}

function buildUrl(operation: string, params: Record<string, string>, numOfRows: number): string {
  const key = process.env.NARA_SERVICE_KEY ?? "";
  const qs = new URLSearchParams({ numOfRows: String(numOfRows), type: "json", ...params });
  return `${NARA_API_BASE}/${operation}?serviceKey=${key}&${qs.toString()}`;
}
async function fetchJson(
  operation: string,
  params: Record<string, string>,
  numOfRows: number
): Promise<Record<string, unknown>> {
  const url = buildUrl(operation, params, numOfRows);
  let lastErr: unknown;
  for (let attempt = 0; attempt <= 1; attempt++) {
    try {
      if (attempt > 0) await sleep(1200);
      const res = await fetch(url, { headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const text = await res.text();
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(`JSON 파싱 실패(비정상 응답): ${text.slice(0, 160)}`);
      }
      const header = ((json as { response?: { header?: { resultCode?: unknown; resultMsg?: unknown } } })
        ?.response?.header) ?? {};
      const code = String(header.resultCode ?? "");
      if (code && code !== "00" && code !== "0") {
        throw new Error(`API resultCode=${code} msg=${header.resultMsg ?? ""}`);
      }
      return (
        ((json as { response?: { body?: Record<string, unknown> } })?.response?.body) ?? {}
      );
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

function normalizeBid(item: Record<string, unknown>) {
  const bidNo = pick(item, "bidNtceNo");
  if (!bidNo) return null;
  const seqRaw = pick(item, "bidNtceOrd");
  const bidSeq = seqRaw ? String(seqRaw).trim() : "00";
  const bid_no = String(bidNo).trim();
  const kind = pick(item, "ntceKindNm");
  const change =
    kind && String(kind).trim() === "변경공고"
      ? {
          bid_no,
          change_item: "공고변경",
          before_val: pick(item, "befBidBbancNo"),
          after_val: pick(item, "chgNtceRsn"),
          changed_dt: parseKstToIso(pick(item, "chgDt")),
        }
      : null;
  return {
    row: {
      bid_no,
      bid_seq: bidSeq,
      title: pick(item, "bidNtceNm"),
      order_org: pick(item, "ntceInsttNm"),
      demand_org: pick(item, "dminsttNm"),
      contract_method: pick(item, "cntrctCnclsMthdNm"),
      notice_dt: parseKstToIso(pick(item, "bidNtceDt")),
      deadline_dt: parseKstToIso(pick(item, "bidClseDt")),
      open_dt: parseKstToIso(pick(item, "opengDt")),
      est_price: toBigint(pick(item, "presmptPrce")),
      raw: item,
      updated_at: new Date().toISOString(),
    },
    change,
  };
}

// ── 메인: 바운드 수집 ────────────────────────────────────────────
export async function runBoundedCollect(
  sb: SupabaseClient,
  opts: CollectRunOptions = {}
): Promise<CollectRunResult> {
  const days = Math.max(1, Math.min(7, opts.days ?? 1)); // 1~7일로 클램프(타임아웃 방지)
  const maxPages = Math.max(1, Math.min(20, opts.maxPages ?? 6));
  const numOfRows = opts.numOfRows ?? 100;

  const startedMs = Date.now();
  const end = new Date();
  const bgn = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  const windowBgn = toKstInqryDt(bgn);
  const windowEnd = toKstInqryDt(end);

  const checks: Record<string, boolean> = {
    env_ok: !!(process.env.NARA_SERVICE_KEY && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY),
    api_reachable: false,
    upsert_ok: false,
    status_refreshed: false,
  };
  const errors: string[] = [];
  let pages = 0, scanned = 0, bidsUpserted = 0, changesAppended = 0, attachmentsUpserted = 0;

  // collect_runs 시작 기록(테이블 미배포 시 runId=null·runsTableDeployed=false)
  //   백그라운드 위임 경로에서는 API 라우트가 이미 running 행을 만들어 두므로(즉시 runId 반환),
  //   insert 대신 조회범위만 갱신한다. 인라인 경로(로컬 dev)에서는 기존대로 insert.
  let runId: number | null = opts.runId ?? null;
  let runsTableDeployed = true;
  if (runId != null) {
    const { error } = await sb
      .from("collect_runs")
      .update({ window_bgn: windowBgn, window_end: windowEnd, checks })
      .eq("id", runId);
    if (error) runsTableDeployed = false;
  } else {
    const { data, error } = await sb
      .from("collect_runs")
      .insert({
        source: "nara",
        trigger: "manual",
        status: "running",
        window_bgn: windowBgn,
        window_end: windowEnd,
        triggered_by: opts.triggeredBy ?? null,
        checks,
      })
      .select("id")
      .single();
    if (error) runsTableDeployed = false;
    else runId = (data as { id: number }).id;
  }

  const allChanges: Array<Record<string, unknown>> = [];
  const allRows: RawBid[] = []; // 모든 페이지 수집분(분류 게이트 입력)

  for (const type of NARA_BID_TYPES) {
    const suffix = TYPE_SUFFIX[type];
    if (!suffix) {
      errors.push(`알 수 없는 유형: ${type}`);
      continue;
    }
    const listOp = `getBidPblancListInfo${suffix}`;
    for (let pageNo = 1; pageNo <= maxPages; pageNo++) {
      let body: Record<string, unknown>;
      try {
        body = await fetchJson(
          listOp,
          { inqryDiv: "1", inqryBgnDt: windowBgn, inqryEndDt: windowEnd, pageNo: String(pageNo) },
          numOfRows
        );
      } catch (e) {
        errors.push(`[${type}] 목록 pageNo=${pageNo}: ${(e as Error).message}`);
        break;
      }
      checks.api_reachable = true;
      pages++;

      const items = itemsOf(body);
      scanned += items.length;
      if (items.length === 0) break;

      for (const it of items) {
        const n = normalizeBid(it);
        if (!n) continue;
        allRows.push(n.row as RawBid);
        if (n.change) allChanges.push(n.change);
      }

      const total = Number((body as { totalCount?: unknown }).totalCount ?? 0);
      if (total && pageNo * numOfRows >= total) break;
      if (items.length < numOfRows) break;
      await sleep(250);
    }
  }

  // ── AI 분류 게이트(FR-21~24): 감리/컨설팅만 선별 적재 ──
  let classifyStats: ClassifyStats | null = null;
  let classifyDeployed = false;
  let keptBidNos = new Set<string>();
  try {
    const ctx = await loadClassifyContext(
      sb,
      allRows.map((r) => ({ bid_no: r.bid_no, bid_seq: r.bid_seq }))
    );
    classifyDeployed = ctx.hasBizCol && ctx.hasClsTable;
    const { keep, decisions, stats } = await classifyBids(allRows, ctx);
    classifyStats = stats;
    checks.classify_ok = stats.enabled && (stats.llm_calls === 0 || stats.llm_errors < stats.llm_calls);

    const upsertRows = keep.map((k) => withClassifyColumns(k, ctx.hasBizCol));
    keptBidNos = new Set(upsertRows.map((r) => r.bid_no));
    if (upsertRows.length) {
      const { error } = await sb.from("bids").upsert(upsertRows, { onConflict: "bid_no,bid_seq" });
      if (error) errors.push(`bids upsert(분류 적재): ${error.message}`);
      else {
        bidsUpserted += upsertRows.length;
        checks.upsert_ok = true;
      }
    }
    // 첨부 정보 정규화(S-06 상세는 bid_attachments 를 읽는다) — 수집 단계에 내장해
    //   "수집됐는데 첨부가 비어 있는" 재발(§53·§55)을 막는다. 실패해도 수집은 유지.
    if (upsertRows.length) {
      try {
        const att = await syncAttachments(sb, upsertRows);
        attachmentsUpserted = att.inserted;
        checks.attachments_ok = true;
      } catch (e) {
        errors.push(`첨부 정규화: ${(e as Error).message}`);
      }
    }

    // 분류 결정 캐시/감사 기록(테이블 배포 시)
    if (ctx.hasClsTable) await persistDecisions(sb, decisions);
  } catch (e) {
    errors.push(`분류 게이트 실패: ${(e as Error).message}`);
  }

  // 변경이력 멱등 append — 적재된(keep) 공고분만(드롭 공고 참조 방지)
  const keptChanges = allChanges.filter((c) => keptBidNos.has(String(c.bid_no)));
  changesAppended = await appendChanges(sb, keptChanges, errors);

  // status 신선화(실패해도 수집은 성공 처리)
  try {
    const { error } = await sb.rpc("refresh_bids_status");
    if (!error) checks.status_refreshed = true;
  } catch {
    /* status 신선화 실패는 수집 결과를 무효화하지 않음 */
  }

  const hadError = errors.length > 0;
  const status: CollectRunResult["status"] = !hadError
    ? "success"
    : bidsUpserted > 0
    ? "partial"
    : "failed";
  const durationMs = Date.now() - startedMs;

  // collect_runs 종료 기록 (분류 통계 포함). classify 컬럼 미배포 시 update 실패 → 재시도(컬럼 제외)
  if (runId != null) {
    const base = {
      status,
      finished_at: new Date().toISOString(),
      duration_ms: durationMs,
      pages,
      scanned,
      bids_upserted: bidsUpserted,
      changes_appended: changesAppended,
      cursor_advanced: false, // 수동 수집은 증분 커서 미전진(디커플링)
      error_count: errors.length,
      errors: errors.slice(0, 20).map((e) => e.slice(0, 500)),
      checks,
    };
    const { error: upErr } = await sb
      .from("collect_runs")
      .update({ ...base, classify: classifyStats ?? {} })
      .eq("id", runId);
    if (upErr) await sb.from("collect_runs").update(base).eq("id", runId); // classify 컬럼 미배포 폴백
  }

  return {
    runId,
    status,
    trigger: "manual",
    window: { bgn: windowBgn, end: windowEnd },
    pages,
    scanned,
    bidsUpserted,
    changesAppended,
    attachmentsUpserted,
    durationMs,
    checks,
    errors: errors.slice(0, 20),
    runsTableDeployed,
    classify: classifyStats,
    classifyDeployed,
  };
}

async function appendChanges(
  sb: SupabaseClient,
  changes: Array<Record<string, unknown>>,
  errors: string[]
): Promise<number> {
  if (!changes.length) return 0;
  const fp = (r: Record<string, unknown>) =>
    `${r.change_item ?? ""}|${r.before_val ?? ""}|${r.after_val ?? ""}|${r.changed_dt ?? ""}`;
  const byBid = new Map<string, Array<Record<string, unknown>>>();
  for (const c of changes) {
    const key = String(c.bid_no);
    if (!byBid.has(key)) byBid.set(key, []);
    byBid.get(key)!.push(c);
  }
  let appended = 0;
  for (const [bidNo, incoming] of byBid) {
    try {
      const { data: existing, error: selErr } = await sb
        .from("bid_changes")
        .select("change_item, before_val, after_val, changed_dt")
        .eq("bid_no", bidNo);
      if (selErr) throw new Error(selErr.message);
      const known = new Set(
        (existing ?? []).map((r: Record<string, unknown>) =>
          fp({ ...r, changed_dt: r.changed_dt ? new Date(r.changed_dt as string).toISOString() : null })
        )
      );
      const seenFp = new Set<string>();
      const fresh = incoming.filter((r) => {
        const f = fp(r);
        if (known.has(f) || seenFp.has(f)) return false;
        seenFp.add(f);
        return true;
      });
      if (!fresh.length) continue;
      const { error } = await sb.from("bid_changes").insert(fresh);
      if (error) errors.push(`bid_changes insert ${bidNo}: ${error.message}`);
      else appended += fresh.length;
    } catch (e) {
      errors.push(`변경이력 append ${bidNo}: ${(e as Error).message}`);
    }
  }
  return appended;
}
