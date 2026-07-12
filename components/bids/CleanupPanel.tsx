"use client";

// S-04 admin 전용 — 룰 기준 공고 정리(DB Cleanup). cleanup_bids() RPC 호출.
// 흐름: 미리보기(dry-run) → 대상 건수 확인 → 아카이브 / 영구삭제.
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getSupabaseClient } from "@/lib/supabase/client";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";

function fnMissing(msg: string) {
  return /cleanup_bids|function|schema cache|PGRST202|does not exist|archived_at/i.test(msg);
}

export function CleanupPanel() {
  const supabase = getSupabaseClient();
  const qc = useQueryClient();

  const [open, setOpen] = useState(false);
  const [threshold, setThreshold] = useState(1);
  const [protectEnriched, setProtectEnriched] = useState(true);
  const [protectDays, setProtectDays] = useState(7);
  const [preview, setPreview] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const params = (mode: "archive" | "delete", dryRun: boolean) => ({
    p_threshold: threshold,
    p_protect_enriched: protectEnriched,
    p_protect_recent_days: protectDays,
    p_mode: mode,
    p_dry_run: dryRun,
  });

  function handleError(message: string) {
    setErr(
      fnMissing(message)
        ? "cleanup_bids() 함수/archived_at 컬럼이 아직 DB에 없습니다. supabase/cleanup_bids.sql 을 SQL Editor에서 실행한 뒤 다시 시도하세요."
        : `실패: ${message}`
    );
  }

  async function runPreview() {
    setErr(null); setMsg(null); setBusy(true);
    const { data, error } = await supabase.rpc("cleanup_bids", params("archive", true));
    setBusy(false);
    if (error) return handleError(error.message);
    setPreview(Number(data));
  }

  async function runCleanup(mode: "archive" | "delete") {
    const label = mode === "archive" ? "아카이브(숨김)" : "영구 삭제";
    if (
      !confirm(
        `대상 ${preview?.toLocaleString() ?? "?"}건을 ${label} 합니다.` +
          (mode === "delete" ? "\n영구 삭제는 되돌릴 수 없습니다. 계속할까요?" : "\n계속할까요?")
      )
    )
      return;
    if (mode === "delete" && !confirm("정말 영구 삭제하시겠습니까? (복구 불가)")) return;

    setErr(null); setMsg(null); setBusy(true);
    const { data, error } = await supabase.rpc("cleanup_bids", params(mode, false));
    setBusy(false);
    if (error) return handleError(error.message);
    setMsg(`${label} 완료 — ${Number(data).toLocaleString()}건 처리됨.`);
    setPreview(null);
    qc.invalidateQueries({ queryKey: ["bids"] });
    qc.invalidateQueries({ queryKey: ["stats-relevant-count"] });
    qc.invalidateQueries({ queryKey: ["stats-high-count"] });
    qc.invalidateQueries({ queryKey: ["stats-bids"] });
  }

  async function restore() {
    if (!confirm("아카이브된 공고를 전체 복구합니다. 계속할까요?")) return;
    setErr(null); setMsg(null); setBusy(true);
    const { data, error } = await supabase.rpc("restore_bids");
    setBusy(false);
    if (error) return handleError(error.message);
    setMsg(`복구 완료 — ${Number(data).toLocaleString()}건.`);
    qc.invalidateQueries({ queryKey: ["bids"] });
  }

  if (!open) {
    return (
      <div className="mb-3 flex justify-end">
        <button
          onClick={() => setOpen(true)}
          className="rounded-md px-2.5 py-1.5 text-xs text-subtle ring-1 ring-border hover:bg-bg"
        >
          DB 정리 (admin)
        </button>
      </div>
    );
  }

  return (
    <Card className="mb-3 border-accent/30">
      <div className="flex flex-col gap-3 p-3">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold text-text">룰 기준 공고 정리</p>
            <p className="mt-0.5 text-xs text-subtle">
              현재 스코어링 규칙(S-12) 기준 점수 미달 공고를 정리합니다. 관심목록은 항상 보호됩니다.
              먼저 재스코어링으로 점수를 최신화하는 것을 권장합니다.
            </p>
          </div>
          <button onClick={() => setOpen(false)} className="text-xs text-subtle hover:underline">
            닫기
          </button>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs text-subtle">
            점수 임계값 (미만 정리)
            <input
              type="number"
              value={threshold}
              onChange={(e) => { setThreshold(Number(e.target.value)); setPreview(null); }}
              className="mt-1 block w-24 rounded-md border border-border px-2.5 py-1.5 text-xs text-text outline-none focus:border-accent"
            />
          </label>
          <label className="text-xs text-subtle">
            최근 보호(일)
            <input
              type="number"
              value={protectDays}
              onChange={(e) => { setProtectDays(Number(e.target.value)); setPreview(null); }}
              className="mt-1 block w-24 rounded-md border border-border px-2.5 py-1.5 text-xs text-text outline-none focus:border-accent"
            />
          </label>
          <label className="flex items-center gap-1.5 text-xs text-subtle">
            <input
              type="checkbox"
              checked={protectEnriched}
              onChange={(e) => { setProtectEnriched(e.target.checked); setPreview(null); }}
            />
            AI 요약분 보호
          </label>
          <Button onClick={runPreview} disabled={busy}>
            {busy ? "확인 중…" : "미리보기"}
          </Button>
        </div>

        {preview !== null && (
          <div className="flex flex-wrap items-center gap-2 rounded-md bg-bg p-2.5">
            <span className="text-sm text-text">
              정리 대상 <b className="text-primary">{preview.toLocaleString()}</b>건
            </span>
            <div className="ml-auto flex gap-2">
              <Button onClick={() => runCleanup("archive")} disabled={busy || preview === 0}>
                아카이브(숨김)
              </Button>
              <button
                onClick={() => runCleanup("delete")}
                disabled={busy || preview === 0}
                className="rounded-md px-3 py-1.5 text-xs font-medium text-danger ring-1 ring-danger/40 hover:bg-danger/5 disabled:opacity-50"
              >
                영구 삭제
              </button>
            </div>
          </div>
        )}

        <div className="flex items-center justify-between">
          <button onClick={restore} disabled={busy} className="text-xs text-subtle hover:underline">
            아카이브 전체 복구
          </button>
          {msg && <span className="text-xs text-success">{msg}</span>}
          {err && <span className="text-xs text-danger">{err}</span>}
        </div>
      </div>
    </Card>
  );
}
