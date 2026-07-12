// =====================================================================
// scripts/attachments.mjs — 첨부파일 다운로드·저장·추출 (A.5/A.6)
// Node 20 ESM. collect.mjs 이후 실행. watchlist 대상 우선.
//
// 흐름(실측 반영 — 별도 AtachFileInfo op 없음. 첨부는 목록 응답에 내장):
//   1) 대상 공고 결정 — watchlist(bid_no,bid_seq) 우선
//   2) bids.raw(수집 시 보존한 목록 item)에서 첨부 필드 추출.
//      raw 부재 시 목록 op(getBidPblancListInfoServc, inqryDiv=2)로 재조회(폴백)
//      첨부 필드: ntceSpecDocUrl1~10 + ntceSpecFileNm1~10 (+ 규격서 stdNtceDocUrl)
//   3) 파일 다운로드 → Supabase Storage 업로드 → storage_path 기록
//   4) HWP/HWPX/PDF → kordoc(→pdfjs-dist 폴백)으로 Markdown 추출 → extracted_text
//   5) bid_attachments upsert (조회키 bid_no,bid_seq / 파일 seq·file_name으로 멱등)
//
// 원칙: 변환 실패는 downloaded=true + 로그로 남기고 배치 계속. embedding은 ai.mjs 담당(미기록).
// 계약: 01_data-architect_contract.md (bid_attachments append, 조회키 bid_no,bid_seq).
// =====================================================================

import { createClient } from '@supabase/supabase-js';
import { Buffer } from 'node:buffer';

const {
  NARA_SERVICE_KEY,
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  NARA_API_BASE = 'https://apis.data.go.kr/1230000/ad/BidPublicInfoService',
  NARA_NUM_OF_ROWS = '100',
  STORAGE_BUCKET = 'attachments',
  ATTACH_MAX_BIDS = '200',        // 이번 배치에서 처리할 공고 상한(비용 제어)
  ATTACH_MAX_BYTES = '52428800',  // 파일당 다운로드 상한(50MB)
} = process.env;

// 재조회 폴백 목록 op(실측 확정). bids.raw가 없을 때만 사용.
const OP_LIST_FALLBACK = 'getBidPblancListInfoServc';
const NUM_OF_ROWS = Number(NARA_NUM_OF_ROWS) || 100;
const MAX_BIDS = Number(ATTACH_MAX_BIDS) || 200;
const MAX_BYTES = Number(ATTACH_MAX_BYTES) || 50 * 1024 * 1024;
const EXTRACTABLE = new Set(['hwp', 'hwpx', 'pdf']);

let errorCount = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function logErr(context, err) {
  errorCount++;
  console.error(`[ERROR] ${context}: ${err?.stack ?? err}`);
}

function requireEnv() {
  const missing = [];
  if (!NARA_SERVICE_KEY) missing.push('NARA_SERVICE_KEY');
  if (!SUPABASE_URL) missing.push('SUPABASE_URL');
  if (!SUPABASE_SERVICE_KEY) missing.push('SUPABASE_SERVICE_KEY');
  if (missing.length) {
    console.error(`[FATAL] 필수 환경변수 누락: ${missing.join(', ')}`);
    process.exit(1);
  }
}

function pick(obj, ...keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return null;
}

function makeClient() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// ---------------------------------------------------------------------
// HTTP JSON (1회 재시도 + 백오프)
// ---------------------------------------------------------------------
async function fetchJson(operation, params, { retries = 1, backoffMs = 1500 } = {}) {
  const qs = new URLSearchParams({ numOfRows: String(NUM_OF_ROWS), type: 'json', ...params });
  const url = `${NARA_API_BASE}/${operation}?serviceKey=${NARA_SERVICE_KEY}&${qs.toString()}`;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      if (attempt > 0) await sleep(backoffMs * attempt);
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = JSON.parse(await res.text());
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

// ---------------------------------------------------------------------
// 첨부 목록 정규화 — 목록 응답 내장 필드(실측 확정).
//   규격서 URL: ntceSpecDocUrl1~10, 파일명: ntceSpecFileNm1~10
//   추가 규격서: stdNtceDocUrl (파일명 미제공 → null)
//   URL 중복 제거(예: stdNtceDocUrl == ntceSpecDocUrl1인 경우가 흔함)
// ---------------------------------------------------------------------
function extractFiles(bid, item) {
  const files = [];
  const seenUrl = new Set();
  const push = (url, name) => {
    if (!url) return;
    const u = String(url).trim();
    if (!u || seenUrl.has(u)) return;
    seenUrl.add(u);
    files.push({ file_url: u, file_name: name ? String(name).trim() : null });
  };

  // ntceSpecDocUrl1~10 / ntceSpecFileNm1~10 (번호형 다중 파일)
  for (let i = 1; i <= 10; i++) {
    push(pick(item, `ntceSpecDocUrl${i}`), pick(item, `ntceSpecFileNm${i}`));
  }
  // 규격서(별도) — 파일명 없음
  push(pick(item, 'stdNtceDocUrl'), null);

  return files.map((f, idx) => ({
    bid_no: bid.bid_no,
    bid_seq: bid.bid_seq,
    seq: idx + 1,
    doc_type: null, // 목록 내장 첨부는 유형 필드 미제공 → 확장자 기반으로 호출부에서 보정
    file_name: f.file_name,
    file_url: f.file_url,
  }));
}

function extOf(name = '', url = '') {
  const src = (name || url || '').split('?')[0];
  const m = src.match(/\.([a-zA-Z0-9]+)$/);
  return m ? m[1].toLowerCase() : '';
}

function safeName(name, fallback) {
  const base = (name || fallback || 'file').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 120);
  return base || fallback;
}

// ---------------------------------------------------------------------
// 파일 다운로드 (크기 상한, 1회 재시도)
// ---------------------------------------------------------------------
async function downloadFile(url, { retries = 1 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      if (attempt > 0) await sleep(1000 * attempt);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const len = Number(res.headers.get('content-length') || 0);
      if (len && len > MAX_BYTES) throw new Error(`파일 크기 초과 ${len} > ${MAX_BYTES}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.byteLength > MAX_BYTES) throw new Error(`파일 크기 초과 ${buf.byteLength}`);
      const contentType = res.headers.get('content-type') || 'application/octet-stream';
      return { buf, contentType };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------
// 문서 → Markdown 추출. kordoc 우선, PDF는 pdfjs-dist 폴백.
// 실패 시 null 반환(호출부에서 downloaded=true 유지 + 로그).
// kordoc의 실제 export 시그니처는 설치 후 확인 필요 → 여러 형태를 방어적으로 시도.
// ---------------------------------------------------------------------
let _kordoc; // 지연 로드 캐시
async function loadKordoc() {
  if (_kordoc !== undefined) return _kordoc;
  try {
    _kordoc = await import('kordoc');
  } catch (e) {
    console.warn(`[WARN] kordoc 로드 실패(첨부 추출 폴백만 사용): ${e?.message}`);
    _kordoc = null;
  }
  return _kordoc;
}

async function kordocToMarkdown(buf, ext) {
  const mod = await loadKordoc();
  if (!mod) return null;
  const api = mod.default ?? mod;
  // kordoc이 노출할 수 있는 후보 함수들을 순서대로 시도
  const candidates = [
    api.toMarkdown, api.convertToMarkdown, api.parse, api.extract,
    mod.toMarkdown, mod.convert, mod.default,
  ].filter((f) => typeof f === 'function');
  for (const fn of candidates) {
    try {
      const out = await fn(buf, { format: 'markdown', ext });
      const text = typeof out === 'string' ? out : (out?.markdown ?? out?.text ?? out?.content);
      if (text && String(text).trim()) return String(text);
    } catch {
      // 다음 후보 시도
    }
  }
  return null;
}

async function pdfToText(buf) {
  try {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const doc = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
    const parts = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      parts.push(content.items.map((i) => i.str).join(' '));
    }
    const text = parts.join('\n\n').trim();
    return text || null;
  } catch (e) {
    console.warn(`[WARN] pdfjs 폴백 실패: ${e?.message}`);
    return null;
  }
}

async function extractMarkdown(buf, ext) {
  if (!EXTRACTABLE.has(ext)) return null;
  const md = await kordocToMarkdown(buf, ext);
  if (md) return md;
  if (ext === 'pdf') return await pdfToText(buf); // PDF 폴백
  return null; // hwp/hwpx는 kordoc 전용 — 실패 시 null
}

// ---------------------------------------------------------------------
// 대상 공고: watchlist 우선
// ---------------------------------------------------------------------
async function targetBids(sb) {
  const { data, error } = await sb
    .from('watchlist')
    .select('bid_no, bid_seq')
    .order('updated_at', { ascending: false })
    .limit(MAX_BIDS);
  if (error) throw new Error(`watchlist 조회 실패: ${error.message}`);
  const seen = new Set();
  const out = [];
  for (const r of data ?? []) {
    const key = `${r.bid_no}|${r.bid_seq ?? '00'}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ bid_no: r.bid_no, bid_seq: r.bid_seq ?? '00' });
  }
  return out;
}

// 멱등: 기존 첨부(같은 bid_no,bid_seq)에서 file_name/seq 매칭 시 update, 아니면 insert
async function upsertAttachment(sb, existingByKey, row) {
  const key = `${row.file_name ?? ''}|${row.seq ?? ''}|${row.file_url ?? ''}`;
  const existing = existingByKey.get(key);
  if (existing) {
    const { error } = await sb.from('bid_attachments').update(row).eq('id', existing.id);
    if (error) throw new Error(error.message);
    return existing.id;
  }
  const { data, error } = await sb.from('bid_attachments').insert(row).select('id').single();
  if (error) throw new Error(error.message);
  return data.id;
}

async function loadExisting(sb, bid) {
  const { data, error } = await sb
    .from('bid_attachments')
    .select('id, file_name, seq, file_url')
    .eq('bid_no', bid.bid_no)
    .eq('bid_seq', bid.bid_seq);
  if (error) throw new Error(error.message);
  const map = new Map();
  for (const r of data ?? []) {
    map.set(`${r.file_name ?? ''}|${r.seq ?? ''}|${r.file_url ?? ''}`, r);
  }
  return map;
}

// ---------------------------------------------------------------------
// 첨부 소스 item 확보 — bids.raw 우선, 없으면 목록 op 재조회(inqryDiv=2)
// ---------------------------------------------------------------------
async function loadRawItem(sb, bid) {
  const { data, error } = await sb
    .from('bids')
    .select('raw')
    .eq('bid_no', bid.bid_no)
    .eq('bid_seq', bid.bid_seq)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (data?.raw) return data.raw;

  // 폴백: 목록 재조회(공고번호 기준). serviceKey 필요.
  const body = await fetchJson(OP_LIST_FALLBACK, { inqryDiv: '2', bidNtceNo: bid.bid_no });
  const items = itemsOf(body);
  return (
    items.find((it) => String(it?.bidNtceOrd ?? '').trim() === bid.bid_seq) ??
    items[0] ??
    null
  );
}

// ---------------------------------------------------------------------
// 공고 1건의 첨부 처리
// ---------------------------------------------------------------------
async function processBid(sb, bid) {
  let raw;
  try {
    raw = await loadRawItem(sb, bid);
  } catch (e) {
    logErr(`첨부 소스(raw) 로드 ${bid.bid_no}`, e);
    return;
  }
  if (!raw) {
    console.warn(`[WARN] 첨부 소스 없음 — 스킵: ${bid.bid_no}/${bid.bid_seq}`);
    return;
  }
  const files = extractFiles(bid, raw);
  if (!files.length) return;

  let existingByKey;
  try {
    existingByKey = await loadExisting(sb, bid);
  } catch (e) {
    logErr(`기존첨부 조회 ${bid.bid_no}`, e);
    existingByKey = new Map();
  }

  for (const file of files) {
    const ext = extOf(file.file_name, file.file_url);
    const row = {
      ...file,
      doc_type: file.doc_type ?? (ext ? ext.toUpperCase() : null),
      storage_path: null,
      extracted_text: null,
      downloaded: false,
      fetched_at: new Date().toISOString(),
    };

    // 1) 다운로드
    let dl;
    try {
      dl = await downloadFile(file.file_url);
      row.downloaded = true;
    } catch (e) {
      logErr(`다운로드 ${bid.bid_no} ${file.file_name}`, e);
      // 다운로드 실패도 메타 행은 남긴다(downloaded=false)
      try { await upsertAttachment(sb, existingByKey, row); } catch (e2) { logErr('메타 upsert', e2); }
      continue;
    }

    // 2) Storage 업로드
    const path = `${bid.bid_no}/${bid.bid_seq}/${row.seq}_${safeName(file.file_name, `file.${ext || 'bin'}`)}`;
    try {
      const { error } = await sb.storage
        .from(STORAGE_BUCKET)
        .upload(path, dl.buf, { contentType: dl.contentType, upsert: true });
      if (error) throw new Error(error.message);
      row.storage_path = path;
    } catch (e) {
      logErr(`Storage 업로드 ${path}`, e);
      // 업로드 실패해도 추출은 시도 가능하나, 저장 경로 없이 진행
    }

    // 3) 추출 (실패해도 downloaded=true 유지, extracted_text=null, 배치 계속)
    try {
      const md = await extractMarkdown(dl.buf, ext);
      if (md) row.extracted_text = md;
      else if (EXTRACTABLE.has(ext)) {
        console.warn(`[WARN] 추출 결과 없음(downloaded 유지): ${bid.bid_no} ${file.file_name}`);
      }
    } catch (e) {
      logErr(`추출 ${bid.bid_no} ${file.file_name}`, e);
    }

    // 4) 저장
    try {
      await upsertAttachment(sb, existingByKey, row);
    } catch (e) {
      logErr(`bid_attachments upsert ${bid.bid_no} ${file.file_name}`, e);
    }
    await sleep(120);
  }
}

// ---------------------------------------------------------------------
// Storage 버킷 보장(없으면 생성 시도, 이미 있으면 무시)
// ---------------------------------------------------------------------
async function ensureBucket(sb) {
  try {
    const { data } = await sb.storage.getBucket(STORAGE_BUCKET);
    if (data) return;
  } catch { /* 조회 실패는 무시하고 생성 시도 */ }
  try {
    await sb.storage.createBucket(STORAGE_BUCKET, { public: false });
    console.log(`[INFO] Storage 버킷 생성: ${STORAGE_BUCKET}`);
  } catch (e) {
    console.warn(`[WARN] 버킷 생성 스킵(이미 존재 가능): ${e?.message}`);
  }
}

async function main() {
  requireEnv();
  const sb = makeClient();
  const started = Date.now();
  console.log(`[INFO] attachments 시작 ${new Date().toISOString()}`);

  await ensureBucket(sb);

  let bids;
  try {
    bids = await targetBids(sb);
  } catch (e) {
    console.error('[FATAL]', e?.stack ?? e);
    process.exit(1);
  }
  console.log(`[INFO] 대상 공고(watchlist 우선) ${bids.length}건`);

  for (const bid of bids) {
    await processBid(sb, bid);
    await sleep(200);
  }

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`[INFO] attachments 종료 (${secs}s) 오류=${errorCount}`);
  // 첨부 배치는 부분 실패를 허용(변환 실패는 정상 흐름) → 치명 오류만 exit 1.
  // 개별 오류는 로그로 남기고 성공 종료하여 다음 스텝(ai.mjs)을 막지 않는다.
}

main().catch((e) => {
  console.error('[FATAL]', e?.stack ?? e);
  process.exit(1);
});
