"use client";

// AI 분석 결과파일 업로드·열람 모달 (FR-22/23/24). admin은 업로드, active 전원 열람.
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getSupabaseClient } from "@/lib/supabase/client";
import { Pill } from "@/components/ui/Pill";
import { Button } from "@/components/ui/Button";
import {
  fetchAnalysisReports,
  uploadAnalysisFile,
  signedUrl,
  markAnalysisDone,
} from "@/lib/queries/analysis";
import { ANALYSIS_DOC_TYPES, type AnalysisDocType } from "@/lib/supabase/types";
import { fmtDateTime } from "@/lib/utils/format";

interface Props {
  bid: { bid_no: string; bid_seq: string; title: string | null };
  isAdmin: boolean;
  onClose: () => void;
  onChanged: () => void; // 분석완료 등 상태 변경 시 부모 갱신
}

export function AnalysisModal({ bid, isAdmin, onClose, onChanged }: Props) {
  const supabase = getSupabaseClient();
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const key = ["analysis-reports", bid.bid_no, bid.bid_seq];
  const q = useQuery({
    queryKey: key,
    queryFn: () => fetchAnalysisReports(supabase, bid.bid_no, bid.bid_seq),
  });
  const byType = new Map((q.data ?? []).map((r) => [r.doc_type, r]));

  async function onUpload(docType: AnalysisDocType, file: File) {
    setErr(null);
    setBusy(docType);
    try {
      await uploadAnalysisFile(supabase, { bidNo: bid.bid_no, bidSeq: bid.bid_seq, title: bid.title, docType, file });
      qc.invalidateQueries({ queryKey: key });
    } catch (e) {
      setErr(fnMsg((e as Error).message));
    } finally {
      setBusy(null);
    }
  }
  async function onOpen(path: string) {
    const url = await signedUrl(supabase, path);
    if (url) window.open(url, "_blank", "noopener");
    else setErr("파일 URL을 가져오지 못했습니다(Storage 정책 확인).");
  }
  async function onDone() {
    setErr(null);
    setBusy("done");
    try {
      await markAnalysisDone(supabase, bid.bid_no, bid.bid_seq);
      onChanged();
      onClose();
    } catch (e) {
      setErr(fnMsg((e as Error).message));
    } finally {
      setBusy(null);
    }
  }

  const uploaded = q.data?.length ?? 0;
  const hasReport = byType.has("분석보고서");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="max-h-[86vh] w-full max-w-2xl overflow-auto rounded-card border border-border bg-surface shadow-card"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-border p-4">
          <div>
            <p className="text-sm font-semibold text-text">AI 분석 결과 · 업로드/열람</p>
            <p className="mt-0.5 text-xs text-subtle">{bid.title ?? bid.bid_no}</p>
          </div>
          <button onClick={onClose} className="text-sm text-subtle hover:underline">
            닫기
          </button>
        </div>

        <div className="p-4">
          <div className="mb-2 flex items-center gap-2 text-xs">
            <Pill tone={uploaded === 7 ? "success" : "accent"}>업로드 {uploaded}/7</Pill>
            {!isAdmin && <span className="text-subtle">열람 전용(업로드는 관리자)</span>}
          </div>

          <ul className="divide-y divide-border">
            {ANALYSIS_DOC_TYPES.map((dt) => {
              const r = byType.get(dt);
              return (
                <li key={dt} className="flex items-center justify-between gap-3 py-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="shrink-0 rounded bg-bg px-1.5 py-0.5 text-[11px] text-subtle ring-1 ring-border">
                      {dt}
                    </span>
                    {r ? (
                      <span className="truncate text-xs text-text" title={r.file_name}>
                        {r.file_name}
                        <span className="ml-1 text-subtle">· {fmtDateTime(r.uploaded_at)}</span>
                      </span>
                    ) : (
                      <span className="text-xs text-subtle">미업로드</span>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {r && (
                      <button onClick={() => onOpen(r.storage_path)} className="text-xs font-medium text-accent hover:underline">
                        열기 ↗
                      </button>
                    )}
                    {isAdmin && (
                      <label className="cursor-pointer text-xs text-subtle ring-1 ring-border rounded px-2 py-1 hover:bg-bg">
                        {busy === dt ? "업로드…" : r ? "교체" : "업로드"}
                        <input
                          type="file"
                          accept=".html,text/html"
                          className="hidden"
                          disabled={busy === dt}
                          onChange={(e) => {
                            const f = e.target.files?.[0];
                            if (f) onUpload(dt, f);
                            e.target.value = "";
                          }}
                        />
                      </label>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>

          {err && <p className="mt-3 text-xs text-danger">{err}</p>}

          {isAdmin && (
            <div className="mt-4 flex items-center justify-between border-t border-border pt-3">
              <span className="text-xs text-subtle">
                최소 ‘분석보고서’ 업로드 후 분석완료로 확정할 수 있습니다.
              </span>
              <Button onClick={onDone} disabled={!hasReport || busy === "done"}>
                {busy === "done" ? "처리 중…" : "분석완료 확정"}
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function fnMsg(msg: string) {
  return /analysis_reports|bucket|storage|does not exist|schema cache|violates|policy|constraint/i.test(msg)
    ? "DB/Storage 미배포 또는 권한 문제입니다. supabase/analysis_reports.sql 을 SQL Editor에서 실행했는지 확인하세요."
    : `실패: ${msg}`;
}
