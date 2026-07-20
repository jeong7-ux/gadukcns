// =====================================================================
// scripts/collect.mjs — 나라장터 OpenAPI 증분 수집 배치 (FR-02/03/04)
// Node 20 ESM. GitHub Actions cron('0 22 * * *' = 07:00 KST)에서 실행.
//
// 수집 순서(7.1) — 실측 매핑(API_실측매핑.md) 반영:
//   1) collect_cursor(source='nara').last_reg_dt 읽기 → inqryBgnDt (증분, YYYYMMDDHHMM)
//   2) getBidPblancListInfo{Servc|Cnstwk|Thng} 페이지네이션 → bids upsert(bid_no,bid_seq)
//      · 목록 응답 내장 변경필드(ntceKindNm='변경공고')에서 bid_changes 파생(append·멱등)
//   3) getBidPblancListInfo{...}BsisAmount(inqryDiv=2,bidNtceNo) → bid_prices upsert(bid_no)
//   4) 전체 성공(무오류) 후에만 collect_cursor 갱신
//
// 실측 정정(2026-07): 스펙의 ...ServcPPSSrch / ...ChgHstry op는 존재하지 않음.
//   목록 op는 getBidPblancListInfoServc(용역), 변경이력·첨부는 목록 응답에 내장.
//   base=https://apis.data.go.kr/1230000/ad/BidPublicInfoService, 인증=serviceKey.
//   응답: response.header.resultCode='00', response.body.items[], body.totalCount.
//
// 원칙: 멱등 upsert · 부분 실패 격리 · 1회 재시도/백오프 · Secrets는 env로만.
// 계약: 01_data-architect_contract.md (컬럼/upsert 키). status는 생성 컬럼 아님(일반 text) →
//   수집기는 여전히 쓰지 않고, 배치 끝에 RPC refresh_bids_status()로 당일 기준 1회 갱신한다.
// =====================================================================

import { createClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------
// 환경변수 / 상수
// ---------------------------------------------------------------------
const {
  NARA_SERVICE_KEY,
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  // 선택(override 가능) — 기본값 제공 (실측: /ad/ 경로, serviceKey 인증)
  NARA_API_BASE = 'https://apis.data.go.kr/1230000/ad/BidPublicInfoService',
  NARA_INQRY_DIV = '1',           // 목록 조회구분=1(등록일시 기준). 가격은 코드에서 2 고정.
  NARA_NUM_OF_ROWS = '100',       // 페이지당 행 수
  NARA_LOOKBACK_DAYS = '1',       // 커서가 없을 때 초기 조회 범위(일)
  NARA_MAX_PAGES = '200',         // 폭주 방지 안전 상한
  NARA_BID_TYPES = 'servc',       // 수집 유형(쉼표구분): servc|cnstwk|thng. 기본 용역만.
  COLLECT_SOURCE = 'nara',        // collect_cursor.source
  COLLECT_TRIGGER = 'cron',       // collect_runs.trigger — cron(자동) / manual
  COLLECT_SKIP_PRICES = '',       // '1'이면 가격(기초금액) 조회 생략 — 대량 갭 백필용(§7-3과 동일). 신규 공고는 예정가 미공개라 손실 적음.
} = process.env;

// 유형 → 오퍼레이션 접미사(실측 확정). 목록/가격 op는 접미사만 상이.
const TYPE_SUFFIX = { servc: 'Servc', cnstwk: 'Cnstwk', thng: 'Thng' };
function opsForType(type) {
  const suffix = TYPE_SUFFIX[type];
  if (!suffix) throw new Error(`알 수 없는 NARA_BID_TYPES 값: ${type}`);
  return {
    list: `getBidPblancListInfo${suffix}`,             // 공고 목록(증분) → bids (+변경 파생)
    price: `getBidPblancListInfo${suffix}BsisAmount`,  // 기초금액 → bid_prices (inqryDiv=2)
  };
}
const BID_TYPES = NARA_BID_TYPES.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

const NUM_OF_ROWS = Number(NARA_NUM_OF_ROWS) || 100;
const MAX_PAGES = Number(NARA_MAX_PAGES) || 200;

// 배치 전역 상태: 하나라도 오류가 있으면 커서를 전진시키지 않는다(자연 재시도).
let hadError = false;
const errors = [];
function fail(context, err) {
  hadError = true;
  const msg = err && err.stack ? err.stack : String(err);
  errors.push(`${context}: ${msg}`);
  console.error(`[ERROR] ${context}: ${msg}`);
}

// ---------------------------------------------------------------------
// 수집 실행 로그(collect_runs) — S-10 수집 모니터용. 검증 단계·건수·오류 집계.
//   테이블 미배포(collect_runs.sql 미적용) 시에도 배치는 정상 동작(로깅만 건너뜀).
// ---------------------------------------------------------------------
const runStats = {
  pages: 0,
  scanned: 0,
  bidsUpserted: 0,
  pricesUpserted: 0,
  changesAppended: 0,
  attachmentsUpserted: 0,
  cursorAdvanced: false,
};
const checks = { env_ok: false, api_reachable: false, upsert_ok: false, status_refreshed: false };
let runId = null;

async function startRun(sb, windowBgn, windowEnd) {
  try {
    const { data, error } = await sb
      .from('collect_runs')
      .insert({
        source: COLLECT_SOURCE,
        trigger: COLLECT_TRIGGER === 'manual' ? 'manual' : 'cron',
        status: 'running',
        window_bgn: windowBgn,
        window_end: windowEnd,
        checks,
      })
      .select('id')
      .single();
    if (error) throw new Error(error.message);
    runId = data?.id ?? null;
  } catch (e) {
    console.warn(`[WARN] collect_runs 시작 기록 건너뜀(테이블 미배포 가능): ${e?.message ?? e}`);
  }
}

async function finishRun(sb, startedMs) {
  if (runId == null) return; // 시작 기록 실패 시 종료 기록도 생략
  const durationMs = Date.now() - startedMs;
  // 상태: 무오류=success / 오류+일부적재=partial / 오류+적재0=failed
  const status = !hadError ? 'success' : runStats.bidsUpserted > 0 ? 'partial' : 'failed';
  try {
    const { error } = await sb
      .from('collect_runs')
      .update({
        status,
        finished_at: new Date().toISOString(),
        duration_ms: durationMs,
        pages: runStats.pages,
        scanned: runStats.scanned,
        bids_upserted: runStats.bidsUpserted,
        prices_upserted: runStats.pricesUpserted,
        changes_appended: runStats.changesAppended,
        cursor_advanced: runStats.cursorAdvanced,
        error_count: errors.length,
        errors: errors.slice(0, 20).map((e) => String(e).slice(0, 500)),
        checks,
      })
      .eq('id', runId);
    if (error) throw new Error(error.message);
  } catch (e) {
    console.warn(`[WARN] collect_runs 종료 기록 실패: ${e?.message ?? e}`);
  }
}

// ---------------------------------------------------------------------
// 유틸: 환경 검증
// ---------------------------------------------------------------------
function requireEnv() {
  const missing = [];
  if (!NARA_SERVICE_KEY) missing.push('NARA_SERVICE_KEY');
  if (!SUPABASE_URL) missing.push('SUPABASE_URL');
  if (!SUPABASE_SERVICE_KEY) missing.push('SUPABASE_SERVICE_KEY');
  if (missing.length) {
    // 인증/설정 실패는 조용한 실패 금지 → 즉시 종료(워크플로우 실패)
    console.error(`[FATAL] 필수 환경변수 누락: ${missing.join(', ')}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------
// 유틸: 날짜 (KST 기준 yyyyMMddHHmm) — GitHub Actions는 UTC라 오프셋 보정 필요
// ---------------------------------------------------------------------
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

function toKstInqryDt(date) {
  // Date → KST 벽시계 'yyyyMMddHHmm'
  const k = new Date(date.getTime() + KST_OFFSET_MS);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return (
    k.getUTCFullYear().toString() +
    p(k.getUTCMonth() + 1) +
    p(k.getUTCDate()) +
    p(k.getUTCHours()) +
    p(k.getUTCMinutes())
  );
}

// 나라장터 응답 일시("2026-07-10 18:00:00" 또는 "202607101800" 등) → ISO(+09:00)
function parseKstToIso(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  // 전부 숫자면 yyyyMMdd[HHmm[ss]]
  const digits = s.replace(/[^0-9]/g, '');
  if (/^[0-9]+$/.test(s) && digits.length >= 8) {
    const y = digits.slice(0, 4);
    const mo = digits.slice(4, 6);
    const d = digits.slice(6, 8);
    const h = digits.slice(8, 10) || '00';
    const mi = digits.slice(10, 12) || '00';
    const se = digits.slice(12, 14) || '00';
    return `${y}-${mo}-${d}T${h}:${mi}:${se}+09:00`;
  }
  // "2026-07-10 18:00[:00]" 형태
  const m = s.match(
    /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})[ T]?(\d{1,2})?:?(\d{1,2})?:?(\d{1,2})?/
  );
  if (m) {
    const [, y, mo, d, h = '00', mi = '00', se = '00'] = m;
    const pad = (x) => String(x).padStart(2, '0');
    return `${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:${pad(se)}+09:00`;
  }
  return null; // 파싱 불가 → null (raw에는 원본 보존)
}

// ---------------------------------------------------------------------
// 유틸: 여러 후보 키 중 첫 유효값 (나라장터 필드명이 서비스 버전별로 상이)
// ---------------------------------------------------------------------
function pick(obj, ...keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return null;
}
function toBigint(v) {
  if (v == null) return null;
  const n = Number(String(v).replace(/[, ]/g, ''));
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

// ---------------------------------------------------------------------
// HTTP: 1회 재시도 + 지수 백오프. JSON 파싱 + 나라장터 헤더 검사.
// ---------------------------------------------------------------------
function buildUrl(operation, params) {
  const qs = new URLSearchParams({
    numOfRows: String(NUM_OF_ROWS),
    type: 'json',
    ...params,
  });
  // serviceKey는 이미 URL 인코딩된 '인코딩 키'를 그대로 붙인다(이중 인코딩 방지).
  return `${NARA_API_BASE}/${operation}?serviceKey=${NARA_SERVICE_KEY}&${qs.toString()}`;
}

async function fetchJson(operation, params, { retries = 1, backoffMs = 1500 } = {}) {
  const url = buildUrl(operation, params);
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      if (attempt > 0) await sleep(backoffMs * attempt); // 백오프
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        // 인증 실패/에러 시 XML 반환하는 경우가 있음 → 앞부분만 노출(키는 URL에만)
        throw new Error(`JSON 파싱 실패(비정상 응답): ${text.slice(0, 200)}`);
      }
      const header = json?.response?.header ?? {};
      const code = String(header.resultCode ?? '');
      if (code && code !== '00' && code !== '0') {
        throw new Error(`API resultCode=${code} msg=${header.resultMsg ?? ''}`);
      }
      return json?.response?.body ?? {};
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

function itemsOf(body) {
  const it = body?.items;
  if (!it) return [];
  if (Array.isArray(it)) return it;
  if (Array.isArray(it.item)) return it.item;
  if (it.item) return [it.item];
  return [];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------
// 정규화: API 응답(카멜) → 스키마 컬럼(스네이크)
// ---------------------------------------------------------------------
function normalizeBid(item) {
  // 실측 확정 매핑(API_실측매핑.md §bids). 후보 fallback 제거 — 정확 필드명 고정.
  const bidNo = pick(item, 'bidNtceNo');
  if (!bidNo) return null; // PK 없으면 스킵
  const seqRaw = pick(item, 'bidNtceOrd');
  const bidSeq = seqRaw ? String(seqRaw).trim() : '00';
  return {
    row: {
      bid_no: String(bidNo).trim(),
      bid_seq: bidSeq,
      title: pick(item, 'bidNtceNm'),
      order_org: pick(item, 'ntceInsttNm'),      // 공고기관
      demand_org: pick(item, 'dminsttNm'),       // 수요기관
      contract_method: pick(item, 'cntrctCnclsMthdNm'),
      notice_dt: parseKstToIso(pick(item, 'bidNtceDt')),
      deadline_dt: parseKstToIso(pick(item, 'bidClseDt')),
      open_dt: parseKstToIso(pick(item, 'opengDt')),
      est_price: toBigint(pick(item, 'presmptPrce')),
      raw: item,
      updated_at: new Date().toISOString(),
      // status는 수집기가 계산하지 않는다(배치 끝 RPC refresh_bids_status로 일 1회 갱신).
      // score·ai_*·embedding도 절대 쓰지 않는다.
    },
    // 커서 전진 기준: 등록일시(rgstDt)
    regIso: parseKstToIso(pick(item, 'rgstDt', 'bidNtceDt')),
    // 변경공고면 목록 응답 내장 필드에서 bid_changes 파생(전용 op 없음)
    change: deriveChange(String(bidNo).trim(), item),
  };
}

function normalizePrice(bidNo, item) {
  // 실측 확정 매핑(API_실측매핑.md §bid_prices, getBidPblancListInfo{...}BsisAmount)
  return {
    bid_no: bidNo,
    base_amount: toBigint(pick(item, 'bssamt')),          // 기초금액
    est_price: toBigint(pick(item, 'presmptPrce')),       // 추정가격(목록값 보조)
    preprice_range: buildRange(item),
    eval_base_amount: toBigint(pick(item, 'evlBssAmt')),  // 평가기준금액
    public_dt: parseKstToIso(pick(item, 'bssamtOpenDt')), // 기초금액 공개일시
  };
}
function buildRange(item) {
  // 예비가격 범위: rsrvtnPrceRngBgnRate ~ rsrvtnPrceRngEndRate (문자열 결합)
  const bgn = pick(item, 'rsrvtnPrceRngBgnRate');
  const end = pick(item, 'rsrvtnPrceRngEndRate');
  if (bgn == null && end == null) return null;
  return `${bgn ?? ''} ~ ${end ?? ''}`;
}

// 목록 응답에서 bid_changes 파생 (전용 op 없음 — API_실측매핑.md §bid_changes).
// ntceKindNm='변경공고'일 때만 생성. 멱등: (change_item|before_val|after_val|changed_dt) 지문.
function deriveChange(bidNo, item) {
  const kind = pick(item, 'ntceKindNm');
  if (!kind || String(kind).trim() !== '변경공고') return null;
  return {
    bid_no: bidNo,
    change_item: '공고변경',
    before_val: pick(item, 'befBidBbancNo'),  // 이전 공고번호
    after_val: pick(item, 'chgNtceRsn'),       // 변경사유 요약
    changed_dt: parseKstToIso(pick(item, 'chgDt')),
  };
}

// ---------------------------------------------------------------------
// Supabase 클라이언트 (service key — RLS 우회, 백엔드 전용)
// ---------------------------------------------------------------------
function makeClient() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// ---------------------------------------------------------------------
// 1) 커서 읽기
// ---------------------------------------------------------------------
async function readCursor(sb) {
  const { data, error } = await sb
    .from('collect_cursor')
    .select('last_reg_dt')
    .eq('source', COLLECT_SOURCE)
    .maybeSingle();
  if (error) throw new Error(`커서 조회 실패: ${error.message}`);
  if (data?.last_reg_dt) return new Date(data.last_reg_dt);
  // 커서 없음 → lookback 기본값
  const back = Number(NARA_LOOKBACK_DAYS) || 1;
  return new Date(Date.now() - back * 24 * 60 * 60 * 1000);
}

// ---------------------------------------------------------------------
// 2) 공고 목록 페이지네이션 → bids upsert
// ---------------------------------------------------------------------
async function collectBids(sb, ops, type, inqryBgnDt, inqryEndDt) {
  console.log(`[INFO] [${type}] 공고 조회 범위(KST): ${inqryBgnDt} ~ ${inqryEndDt}`);

  const seen = new Map(); // `${bid_no}|${bid_seq}` → {bid_no,bid_seq,type}
  const changes = [];     // 목록에서 파생된 bid_changes 후보
  let maxRegIso = null;
  let pageNo = 1;

  for (; pageNo <= MAX_PAGES; pageNo++) {
    let body;
    try {
      body = await fetchJson(ops.list, {
        inqryDiv: NARA_INQRY_DIV,   // =1(등록일시). inqryBgnDt/EndDt=YYYYMMDDHHMM 12자리
        inqryBgnDt,
        inqryEndDt,
        pageNo: String(pageNo),
      });
    } catch (e) {
      fail(`[${type}] 공고목록 pageNo=${pageNo}`, e);
      break; // 목록 실패 시 이 배치의 커서는 전진하지 않음(hadError)
    }

    // 검증: 목록 응답 정상 수신(resultCode 00) → API 도달 확인
    checks.api_reachable = true;
    runStats.pages++;

    const items = itemsOf(body);
    runStats.scanned += items.length;
    if (items.length === 0) break;

    const rows = [];
    for (const it of items) {
      const n = normalizeBid(it);
      if (!n) continue;
      rows.push(n.row);
      seen.set(`${n.row.bid_no}|${n.row.bid_seq}`, {
        bid_no: n.row.bid_no,
        bid_seq: n.row.bid_seq,
        type,
      });
      if (n.change) changes.push(n.change);
      if (n.regIso && (!maxRegIso || n.regIso > maxRegIso)) maxRegIso = n.regIso;
    }

    if (rows.length) {
      const { error } = await sb
        .from('bids')
        .upsert(rows, { onConflict: 'bid_no,bid_seq' });
      if (error) fail(`[${type}] bids upsert pageNo=${pageNo}`, error);
      else {
        runStats.bidsUpserted += rows.length;
        checks.upsert_ok = true;
        console.log(`[INFO] [${type}] bids upsert: page ${pageNo}, ${rows.length}건`);
        // 첨부 정보 정규화(S-06은 bid_attachments를 읽는다). 수집 단계에 내장해
        //   "수집됐는데 첨부가 비어 있는" 재발(§53·§55)을 막는다. lib/collect/attachments.ts와 동일 규칙.
        //   COLLECT_SKIP_ATTACHMENTS=1 로 대량 백필 시 생략 가능.
        if (process.env.COLLECT_SKIP_ATTACHMENTS !== '1') {
          try {
            const n = await syncAttachments(rows);
            runStats.attachmentsUpserted = (runStats.attachmentsUpserted ?? 0) + n;
          } catch (e) {
            fail(`[${type}] 첨부 정규화 pageNo=${pageNo}`, e);
          }
        }
      }
    }

    const total = Number(body.totalCount ?? 0);
    if (total && pageNo * NUM_OF_ROWS >= total) break;
    if (items.length < NUM_OF_ROWS) break;
    await sleep(300); // 레이트 리밋 완화
  }

  return { bids: [...seen.values()], changes, maxRegIso };
}

// ---------------------------------------------------------------------
// 2b) 첨부 정보 정규화 — bids.raw(ntceSpecDocUrl1~10/ntceSpecFileNm1~10, stdNtceDocUrl)
//     → bid_attachments. 다운로드는 하지 않는다(attachments.mjs 담당). 멱등.
//     stdNtceDocUrl은 ntceSpecDocUrl1과 같은 URL인 경우가 많아, 실제 파일명을 살리기 위해
//     첨부를 먼저 만들고 중복되지 않을 때만 규격서 행을 추가한다.
//     보호: downloaded=true 행은 삭제·재삽입 대상에서 제외.
// ---------------------------------------------------------------------
function extractAttachmentRows(bid) {
  const raw = bid.raw || {};
  const s = (v) => (v == null ? '' : String(v).trim());
  const rows = [];
  const seen = new Set();
  for (let i = 1; i <= 10; i++) {
    const url = s(raw[`ntceSpecDocUrl${i}`]);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    rows.push({
      bid_no: bid.bid_no, bid_seq: bid.bid_seq, seq: i, doc_type: '첨부',
      file_name: s(raw[`ntceSpecFileNm${i}`]) || null, file_url: url, downloaded: false,
    });
  }
  const std = s(raw.stdNtceDocUrl);
  if (std && !seen.has(std)) {
    rows.push({
      bid_no: bid.bid_no, bid_seq: bid.bid_seq, seq: 0, doc_type: '규격서',
      file_name: '규격서(공고)', file_url: std, downloaded: false,
    });
  }
  return rows;
}

async function syncAttachments(bids) {
  const targets = bids.filter((b) => extractAttachmentRows(b).length > 0);
  if (!targets.length) return 0;
  const bidNos = [...new Set(targets.map((b) => b.bid_no))];

  const { data: kept, error: ke } = await sb
    .from('bid_attachments').select('file_url').in('bid_no', bidNos).eq('downloaded', true);
  if (ke) throw new Error('다운로드 행 조회 실패: ' + ke.message);
  const keptUrls = new Set((kept ?? []).map((r) => r.file_url));

  const { error: de } = await sb
    .from('bid_attachments').delete().in('bid_no', bidNos)
    .or('downloaded.is.null,downloaded.eq.false');
  if (de) throw new Error('첨부 정리 실패: ' + de.message);

  const rows = targets.flatMap(extractAttachmentRows).filter((r) => !keptUrls.has(r.file_url));
  if (!rows.length) return 0;
  const { error: ie } = await sb.from('bid_attachments').insert(rows);
  if (ie) throw new Error('첨부 삽입 실패: ' + ie.message);
  return rows.length;
}

// ---------------------------------------------------------------------
// 3a) 가격 → bid_prices upsert(bid_no) — getBidPblancListInfo{...}BsisAmount, inqryDiv=2
// ---------------------------------------------------------------------
async function collectPrice(sb, priceOp, bid) {
  try {
    const body = await fetchJson(priceOp, {
      inqryDiv: '2',              // 실측: 가격 조회는 공고번호(bidNtceNo) 기준=2 고정
      bidNtceNo: bid.bid_no,
    });
    const items = itemsOf(body);
    if (!items.length) return;
    const row = normalizePrice(bid.bid_no, items[0]); // 공고당 1건 기준
    const { error } = await sb
      .from('bid_prices')
      .upsert(row, { onConflict: 'bid_no' });
    if (error) fail(`bid_prices upsert ${bid.bid_no}`, error);
    else runStats.pricesUpserted++;
  } catch (e) {
    fail(`가격 수집 ${bid.bid_no}`, e);
  }
}

// ---------------------------------------------------------------------
// 3b) 변경이력 → bid_changes append (목록 응답에서 파생, 전용 op 없음).
//     재실행 멱등: 기존과 (change_item|before_val|after_val|changed_dt) 지문 대조 후 신규만 insert.
// ---------------------------------------------------------------------
async function appendChanges(sb, changes) {
  if (!changes.length) return;
  const fp = (r) =>
    `${r.change_item ?? ''}|${r.before_val ?? ''}|${r.after_val ?? ''}|${r.changed_dt ?? ''}`;

  // 공고번호별로 묶어 기존 이력을 1회 조회하며 중복 판정
  const byBid = new Map();
  for (const c of changes) {
    if (!byBid.has(c.bid_no)) byBid.set(c.bid_no, []);
    byBid.get(c.bid_no).push(c);
  }

  for (const [bidNo, incoming] of byBid) {
    try {
      const { data: existing, error: selErr } = await sb
        .from('bid_changes')
        .select('change_item, before_val, after_val, changed_dt')
        .eq('bid_no', bidNo);
      if (selErr) throw new Error(selErr.message);
      const known = new Set((existing ?? []).map((r) => fp({
        ...r,
        changed_dt: r.changed_dt ? new Date(r.changed_dt).toISOString() : null,
      })));

      // 배치 내부 중복도 제거(같은 공고가 여러 유형/페이지에서 중복 파생될 가능성)
      const seenFp = new Set();
      const fresh = incoming.filter((r) => {
        const f = fp(r);
        if (known.has(f) || seenFp.has(f)) return false;
        seenFp.add(f);
        return true;
      });
      if (!fresh.length) continue;
      const { error } = await sb.from('bid_changes').insert(fresh);
      if (error) fail(`bid_changes insert ${bidNo}`, error);
      else {
        runStats.changesAppended += fresh.length;
        console.log(`[INFO] bid_changes append: ${bidNo}, ${fresh.length}건`);
      }
    } catch (e) {
      fail(`변경이력 append ${bidNo}`, e);
    }
  }
}

// ---------------------------------------------------------------------
// 4) 커서 갱신 (전체 성공 시에만)
// ---------------------------------------------------------------------
async function updateCursor(sb, maxRegIso) {
  if (!maxRegIso) {
    console.log('[INFO] 갱신할 등록일시 없음 — 커서 유지');
    return;
  }
  const { error } = await sb.from('collect_cursor').upsert(
    { source: COLLECT_SOURCE, last_reg_dt: maxRegIso, updated_at: new Date().toISOString() },
    { onConflict: 'source' }
  );
  if (error) throw new Error(`커서 갱신 실패: ${error.message}`);
  console.log(`[INFO] 커서 갱신: source=${COLLECT_SOURCE} last_reg_dt=${maxRegIso}`);
}

// ---------------------------------------------------------------------
// 4b) status 신선화 — bids.status는 생성 컬럼 아님(일반 text, check ongoing/today/closed).
//     생성 컬럼 식이 current_date에 의존 → IMMUTABLE 위반(42P17)이라 불가.
//     대신 스키마 함수 refresh_bids_status()(일반 UPDATE 전체 재계산)를 배치 끝에 1회 호출.
//     실패해도 배치를 죽이지 않음(수집 자체는 성공) — 로그만 남기고 다음 실행에서 자연 재시도.
// ---------------------------------------------------------------------
async function refreshBidsStatus(sb) {
  const { error } = await sb.rpc('refresh_bids_status');
  if (error) {
    // hadError로 승격하지 않는다: status 신선화 실패는 수집 결과를 무효화하지 않음.
    console.warn(`[WARN] refresh_bids_status 실패(수집은 성공 처리): ${error.message}`);
    return;
  }
  checks.status_refreshed = true;
  console.log('[INFO] refresh_bids_status: status 당일 기준 신선화 완료');
}

// ---------------------------------------------------------------------
// main
// ---------------------------------------------------------------------
async function main() {
  requireEnv();
  if (!BID_TYPES.length) {
    console.error('[FATAL] NARA_BID_TYPES가 비어 있음');
    process.exit(1);
  }
  checks.env_ok = true;
  const sb = makeClient();
  const started = Date.now();
  console.log(`[INFO] collect 시작 ${new Date().toISOString()} — 유형: ${BID_TYPES.join(',')}`);

  const bgn = await readCursor(sb);
  const end = new Date();
  const inqryBgnDt = toKstInqryDt(bgn);
  const inqryEndDt = toKstInqryDt(end);

  // 수집 실행 로그 시작(running) — 테이블 미배포 시 조용히 건너뜀
  await startRun(sb, inqryBgnDt, inqryEndDt);

  let maxRegIso = null;

  // 유형별(용역/공사/물품) 순차 수집. 오퍼레이션 접미사만 상이(실측 확정).
  for (const type of BID_TYPES) {
    let ops;
    try {
      ops = opsForType(type);
    } catch (e) {
      fail('유형 매핑', e);
      continue;
    }
    const { bids, changes, maxRegIso: typeMax } =
      await collectBids(sb, ops, type, inqryBgnDt, inqryEndDt);
    if (typeMax && (!maxRegIso || typeMax > maxRegIso)) maxRegIso = typeMax;

    // 변경이력: 목록 응답에서 파생분을 멱등 append
    await appendChanges(sb, changes);

    if (COLLECT_SKIP_PRICES === '1') {
      console.log(`[INFO] [${type}] 수집 공고 ${bids.length}건 — 가격 조회 생략(COLLECT_SKIP_PRICES=1)`);
    } else {
      console.log(`[INFO] [${type}] 수집 공고 ${bids.length}건 — 가격 처리 시작`);
      // 부분 실패 격리: 공고별로 순차 처리, 한 건 실패가 배치를 멈추지 않음
      for (const bid of bids) {
        await collectPrice(sb, ops.price, bid);
        await sleep(150);
      }
    }
  }

  // status 신선화: 모든 유형 수집 완료 후 당일 기준으로 status를 1회 재계산.
  // 실패해도 배치를 죽이지 않음(hadError 미승격 → 커서 정책·exit 코드에 영향 없음).
  try {
    await refreshBidsStatus(sb);
  } catch (e) {
    console.warn(`[WARN] refresh_bids_status 예외(수집은 성공 처리): ${e?.message ?? e}`);
  }

  // 전체 성공(무오류) 시에만 커서 전진 → 다음 실행에서 자연 재시도
  if (!hadError) {
    try {
      await updateCursor(sb, maxRegIso);
      runStats.cursorAdvanced = !!maxRegIso; // 실제 전진한 경우만 true
    } catch (e) {
      fail('커서 갱신', e);
    }
  } else {
    console.warn(
      `[WARN] 오류 ${errors.length}건 → 커서 미갱신(다음 실행 재시도). ` +
      `bids/prices/changes upsert는 멱등이므로 안전.`
    );
  }

  // 수집 실행 로그 종료(success/partial/failed) — 검증단계·건수·오류 기록
  await finishRun(sb, started);

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`[INFO] collect 종료 (${secs}s) 오류=${errors.length}`);

  // 오류가 있으면 워크플로우를 실패로 표시(조용한 실패 금지)
  if (hadError) process.exit(1);
}

main().catch((e) => {
  console.error('[FATAL]', e?.stack ?? e);
  process.exit(1);
});
