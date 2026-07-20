// =====================================================================
// lib/collect/attachments.ts — 공고 raw → bid_attachments 정규화 (수집 파이프라인 내장)
//
// 배경: S-06 상세는 첨부를 bid_attachments 에서 읽는데, 수집(collect/runner)은 원문만
//   bids.raw 에 담고 정규화는 별도 수동 스크립트(scripts/extract_attachment_info.mjs)에
//   맡겨져 있었다. 그래서 갭 백필·바로수집으로 새로 들어온 공고는 "첨부파일이 없습니다"로
//   보였다(§53 2026-07-19, §55 2026-07-20 재발). → 수집 단계에 내장해 재발을 막는다.
//
// 매핑(실측): ntceSpecDocUrl1~10 + ntceSpecFileNm1~10(첨부), stdNtceDocUrl(규격서).
//   stdNtceDocUrl 은 ntceSpecDocUrl1 과 **같은 URL인 경우가 많다** → 실제 파일명을 살리기
//   위해 첨부 목록을 먼저 만들고, 중복되지 않을 때만 규격서 행을 추가한다.
// 보호: downloaded=true(실물 다운로드 완료) 행은 삭제하지 않고 URL 재삽입도 건너뛴다.
// =====================================================================
import type { SupabaseClient } from "@supabase/supabase-js";

export interface AttachmentSource {
  bid_no: string;
  bid_seq: string;
  raw?: Record<string, unknown> | null;
}
export interface AttachmentRow {
  bid_no: string;
  bid_seq: string;
  seq: number;
  doc_type: string;
  file_name: string | null;
  file_url: string;
  downloaded: boolean;
}

const str = (v: unknown): string => (v == null ? "" : String(v).trim());

export function extractAttachmentRows(bid: AttachmentSource): AttachmentRow[] {
  const raw = (bid.raw ?? {}) as Record<string, unknown>;
  const rows: AttachmentRow[] = [];
  const seen = new Set<string>();

  // ① 첨부 1~10 — 실제 파일명이 있으므로 먼저 처리(규격서와 URL이 겹쳐도 이름을 살린다)
  for (let i = 1; i <= 10; i++) {
    const url = str(raw[`ntceSpecDocUrl${i}`]);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    rows.push({
      bid_no: bid.bid_no,
      bid_seq: bid.bid_seq,
      seq: i,
      doc_type: "첨부",
      file_name: str(raw[`ntceSpecFileNm${i}`]) || null,
      file_url: url,
      downloaded: false,
    });
  }
  // ② 규격서(공고 표준문서) — 위 목록과 URL이 겹치지 않을 때만
  const std = str(raw.stdNtceDocUrl);
  if (std && !seen.has(std)) {
    rows.push({
      bid_no: bid.bid_no,
      bid_seq: bid.bid_seq,
      seq: 0,
      doc_type: "규격서",
      file_name: "규격서(공고)",
      file_url: std,
      downloaded: false,
    });
  }
  return rows;
}

// 대상 공고들의 첨부행을 멱등 동기화. downloaded=true 행은 보존한다.
export async function syncAttachments(
  sb: SupabaseClient,
  bids: AttachmentSource[]
): Promise<{ inserted: number; bids: number; protected: number }> {
  const targets = bids.filter((b) => extractAttachmentRows(b).length > 0);
  if (!targets.length) return { inserted: 0, bids: 0, protected: 0 };
  const bidNos = [...new Set(targets.map((b) => b.bid_no))];

  // 보호 대상(실물 다운로드 완료) URL 수집
  const { data: kept, error: ke } = await sb
    .from("bid_attachments")
    .select("file_url")
    .in("bid_no", bidNos)
    .eq("downloaded", true);
  if (ke) throw new Error(`다운로드 행 조회 실패: ${ke.message}`);
  const keptUrls = new Set((kept ?? []).map((r) => (r as { file_url: string }).file_url));

  // 재생성 가능한 행(비다운로드)만 제거 → 멱등
  const { error: de } = await sb
    .from("bid_attachments")
    .delete()
    .in("bid_no", bidNos)
    .or("downloaded.is.null,downloaded.eq.false");
  if (de) throw new Error(`첨부 정리 실패: ${de.message}`);

  const rows = targets.flatMap((b) => extractAttachmentRows(b)).filter((r) => !keptUrls.has(r.file_url));
  if (!rows.length) return { inserted: 0, bids: bidNos.length, protected: keptUrls.size };
  const { error: ie } = await sb.from("bid_attachments").insert(rows);
  if (ie) throw new Error(`첨부 삽입 실패: ${ie.message}`);
  return { inserted: rows.length, bids: bidNos.length, protected: keptUrls.size };
}
