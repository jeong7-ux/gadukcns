"use client";

// S-10 우측 상단 간단 수집 컨트롤 — "바로수집" + 최근 수집일시.
//   백엔드(POST/GET /api/collect/run)는 수집 본체를 Netlify Background Function(최대 15분)에
//   위임하고 runId만 즉시 돌려준다. 따라서 이 컴포넌트는 **응답을 기다리지 않고**
//   해당 runId의 collect_runs 행을 3초 간격으로 폴링해 진행/결과를 표시한다.
//   (이전에는 POST 응답을 끝까지 기다려 26초 초과 시 게이트웨이 HTML을 받아
//    `Unexpected token '<'` 파싱 오류가 노출됐다 — readJson 가드로도 이중 방어.)
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getSupabaseClient } from "@/lib/supabase/client";

interface ClassifyStats {
  kept_감리?: number;
  kept_컨설팅?: number;
  dropped?: number;
  llm_calls?: number;
  pending_review?: number;
}
interface Run {
  id: number;
  status: "running" | "success" | "partial" | "failed";
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  bids_upserted: number;
  error_count?: number;
  errors?: string[];
  classify?: ClassifyStats | null;
}
interface RunsPayload {
  deployed: boolean;
  runs: Run[];
  canTrigger: boolean;
}

const POLL_MS = 3000;
const MAX_WAIT_MS = 15 * 60 * 1000; // 백그라운드 함수 상한과 동일

async function authHeader() {
  const supabase = getSupabaseClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return { Authorization: `Bearer ${session?.access_token ?? ""}` };
}

// 응답을 JSON으로 안전하게 읽는다. 게이트웨이 오류페이지(HTML) 등 비-JSON이 오면
// 원문 파싱 오류 대신 원인을 설명하는 메시지로 바꿔 던진다.
async function readJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("json") || text.trim().startsWith("<")) {
    throw new Error(
      `서버가 JSON이 아닌 응답을 반환했습니다 (HTTP ${res.status}). ` +
        `요청 시간 초과일 수 있습니다 — 수집 이력에서 결과를 확인하세요.`
    );
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`응답 파싱 실패 (HTTP ${res.status})`);
  }
}

// ISO → KST "YYYY. M. D. HH:mm"
function fmtKst(iso: string | null | undefined): string {
  if (!iso) return "기록 없음";
  const k = new Date(new Date(iso).getTime() + 9 * 60 * 60 * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${k.getUTCFullYear()}. ${k.getUTCMonth() + 1}. ${k.getUTCDate()}. ${p(k.getUTCHours())}:${p(k.getUTCMinutes())}`;
}

// 완료된 실행 1건 → 사용자 요약 문구(분류 게이트 통계 우선)
function summarize(run: Run): string {
  const secs = run.duration_ms ? ` · ${Math.round(run.duration_ms / 1000)}초` : "";
  const c = run.classify;
  if (c && (c.kept_감리 != null || c.dropped != null)) {
    return (
      `적재 ${run.bids_upserted ?? 0} (감리 ${c.kept_감리 ?? 0}·컨설팅 ${c.kept_컨설팅 ?? 0}` +
      `${c.pending_review ? `·보류 ${c.pending_review}` : ""}) · 제외 ${c.dropped ?? 0}` +
      ` · LLM ${c.llm_calls ?? 0}${secs}`
    );
  }
  return `적재 ${run.bids_upserted ?? 0}건${secs}`;
}

export function CollectButton({ fallbackTime }: { fallbackTime?: string | null }) {
  const qc = useQueryClient();
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [pendingRunId, setPendingRunId] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const startedRef = useRef<number>(0);

  const { data } = useQuery<RunsPayload>({
    queryKey: ["collect-runs"],
    queryFn: async () => {
      const res = await fetch("/api/collect/run", { headers: await authHeader() });
      if (!res.ok) throw new Error(`이력 조회 실패 (${res.status})`);
      return res.json();
    },
    // 백그라운드 실행을 기다리는 동안만 빠르게 폴링
    refetchInterval: pendingRunId != null ? POLL_MS : 60000,
  });

  const trigger = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/collect/run", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(await authHeader()) },
        body: JSON.stringify({}),
      });
      const json = await readJson(res);
      if (!res.ok) throw new Error((json?.error as string) ?? `실패 (${res.status})`);
      return json;
    },
    onMutate: () => {
      setErr(null);
      setNote(null);
    },
    onSuccess: (json) => {
      const runId = Number(json?.runId) || null;
      if (json?.mode === "background") {
        // 서버는 접수만 하고 즉시 반환 → 결과는 폴링으로 수신
        startedRef.current = Date.now();
        setElapsed(0);
        setPendingRunId(runId);
        setNote("수집을 시작했습니다. 백그라운드 실행 중…");
        qc.invalidateQueries({ queryKey: ["collect-runs"] });
        return;
      }
      // 인라인 실행(로컬 dev 등) — 응답에 결과가 실려 온다
      const r = json?.result as
        | { bidsUpserted?: number; classify?: ClassifyStats; durationMs?: number; errors?: string[] }
        | undefined;
      qc.invalidateQueries({ queryKey: ["collect-runs"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      if (r) {
        setNote(
          summarize({
            id: runId ?? 0,
            status: "success",
            started_at: "",
            finished_at: null,
            duration_ms: r.durationMs ?? null,
            bids_upserted: r.bidsUpserted ?? 0,
            classify: r.classify ?? null,
          })
        );
        if (r.errors?.length) setErr(`부분 오류 ${r.errors.length}건`);
      }
    },
    onError: (e: Error) => setErr(e.message),
  });

  const runs = useMemo(() => data?.runs ?? [], [data]);
  const latest = runs[0];

  // 폴링 결과 감시: 대기 중인 run 이 종료되면 요약 표시 + 대시보드 갱신
  useEffect(() => {
    if (pendingRunId == null) return;
    const run = runs.find((r) => r.id === pendingRunId);
    if (!run || run.status === "running") return;
    setPendingRunId(null);
    setNote(summarize(run));
    if (run.status === "failed") setErr(run.errors?.[0] ?? "수집 실패");
    else if (run.error_count) setErr(`부분 오류 ${run.error_count}건`);
    qc.invalidateQueries({ queryKey: ["dashboard"] });
  }, [runs, pendingRunId, qc]);

  // 진행 경과(초) 표시 + 상한 초과 시 대기 중단
  useEffect(() => {
    if (pendingRunId == null) return;
    const t = setInterval(() => {
      const ms = Date.now() - startedRef.current;
      setElapsed(Math.floor(ms / 1000));
      if (ms > MAX_WAIT_MS) {
        setPendingRunId(null);
        setErr("수집 결과를 확인하지 못했습니다. 수집 이력을 확인하세요.");
      }
    }, 1000);
    return () => clearInterval(t);
  }, [pendingRunId]);

  // 수집 실행은 관리자 전용(서버 GET이 역할을 판정해 canTrigger로 내려준다).
  //   권한이 없으면 버튼을 아예 렌더하지 않는다(비활성 버튼 노출 대신). 조회는 전체 허용이라
  //   "최근 갱신" 표시는 유지. 판정 전(로딩)에는 노출하지 않아 깜빡임을 막는다.
  const canTrigger = data?.canTrigger === true;
  const running = pendingRunId != null || latest?.status === "running" || trigger.isPending;
  // 최근 갱신 일시(실데이터): 최근 실행 완료/시작 > 폴백(대시보드 last collect)
  const collectedAt = fmtKst(latest?.finished_at ?? latest?.started_at ?? fallbackTime);

  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-subtle">
        최근 갱신 <span className="font-medium text-text">{collectedAt}</span>
      </span>
      {canTrigger && (
        <>
          <button
            onClick={() => trigger.mutate()}
            disabled={running}
            title="최근 공고를 즉시 수집합니다 (관리자 전용)"
            className="inline-flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {running ? `수집 중…${pendingRunId != null ? ` ${elapsed}초` : ""}` : "⚡ 바로수집"}
          </button>
          {note && <span className="hidden text-xs text-success md:inline">{note}</span>}
          {err && <span className="text-xs text-dday-urgent">{err}</span>}
        </>
      )}
    </div>
  );
}
