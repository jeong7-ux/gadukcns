"use client";

// S-10 우측 상단 간단 수집 컨트롤 — "바로수집" + 최근 수집일시.
//   기능은 CollectMonitor와 동일 백엔드(POST/GET /api/collect/run)를 사용하되 UI만 최소화.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getSupabaseClient } from "@/lib/supabase/client";

interface Run {
  status: "running" | "success" | "partial" | "failed";
  started_at: string;
  finished_at: string | null;
  bids_upserted: number;
}
interface RunsPayload {
  deployed: boolean;
  runs: Run[];
  canTrigger: boolean;
}

async function authHeader() {
  const supabase = getSupabaseClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return { Authorization: `Bearer ${session?.access_token ?? ""}` };
}

// ISO → KST "YYYY. M. D. HH:mm"
function fmtKst(iso: string | null | undefined): string {
  if (!iso) return "기록 없음";
  const k = new Date(new Date(iso).getTime() + 9 * 60 * 60 * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${k.getUTCFullYear()}. ${k.getUTCMonth() + 1}. ${k.getUTCDate()}. ${p(k.getUTCHours())}:${p(k.getUTCMinutes())}`;
}

export function CollectButton({ fallbackTime }: { fallbackTime?: string | null }) {
  const qc = useQueryClient();
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [justAt, setJustAt] = useState<string | null>(null);

  const { data } = useQuery<RunsPayload>({
    queryKey: ["collect-runs"],
    queryFn: async () => {
      const res = await fetch("/api/collect/run", { headers: await authHeader() });
      if (!res.ok) throw new Error(`이력 조회 실패 (${res.status})`);
      return res.json();
    },
    refetchInterval: 60000,
  });

  const trigger = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/collect/run", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(await authHeader()) },
        body: JSON.stringify({}),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error ?? `실패 (${res.status})`);
      return json;
    },
    onMutate: () => {
      setErr(null);
      setNote(null);
    },
    onSuccess: (json) => {
      setJustAt(new Date().toISOString());
      qc.invalidateQueries({ queryKey: ["collect-runs"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      const r = json?.result;
      const c = r?.classify;
      if (c) {
        // AI 분류 게이트 결과 요약(감리/컨설팅만 적재, 해당없음 제외)
        setNote(
          `적재 ${r.bidsUpserted ?? 0} (감리 ${c.kept_감리 ?? 0}·컨설팅 ${c.kept_컨설팅 ?? 0}` +
            `${c.pending_review ? `·보류 ${c.pending_review}` : ""}) · 제외 ${c.dropped ?? 0} · LLM ${c.llm_calls ?? 0}` +
            `${r.classifyDeployed === false ? " · 분류스키마 미배포(적재만)" : ""}`
        );
      } else if (r) {
        setNote(`적재 ${r.bidsUpserted ?? 0}건`);
      }
      if (r?.errors?.length) setErr(`부분 오류 ${r.errors.length}건`);
    },
    onError: (e: Error) => setErr(e.message),
  });

  const latest = data?.runs?.[0];
  const canTrigger = data?.canTrigger ?? true;
  const running = latest?.status === "running" || trigger.isPending;
  // 최근 갱신 일시(실데이터): 방금 실행 > 최근 실행 완료/시작 > 폴백(대시보드 last collect)
  const collectedAt = fmtKst(justAt ?? latest?.finished_at ?? latest?.started_at ?? fallbackTime);

  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-subtle">
        최근 갱신 <span className="font-medium text-text">{collectedAt}</span>
      </span>
      <button
        onClick={() => trigger.mutate()}
        disabled={!canTrigger || running}
        title={canTrigger ? "최근 공고를 즉시 수집합니다" : "운영자(strategy/pm/admin) 전용"}
        className="inline-flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {running ? "수집 중…" : "⚡ 바로수집"}
      </button>
      {note && <span className="hidden text-xs text-success md:inline">{note}</span>}
      {err && <span className="text-xs text-dday-urgent">{err}</span>}
    </div>
  );
}
