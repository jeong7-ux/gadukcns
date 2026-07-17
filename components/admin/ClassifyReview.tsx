"use client";

// S-12 AI 분류 검수 큐 — admin. 보류 확정·재분류·해당없음 아카이브(자원 회수).
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getSupabaseClient } from "@/lib/supabase/client";
import { Card, CardHeader } from "@/components/ui/Card";

type Tab = "pending" | "gamri" | "consult" | "none";
interface Summary { gamri: number; consult: number; none: number; pending: number }
interface Item {
  bid_no: string;
  bid_seq: string;
  title: string | null;
  order_org: string | null;
  biz_category?: string | null;
  classify?: { confidence?: number; reason?: string; needs_review?: boolean } | null;
  confidence?: number | null;
  reason?: string | null;
}
interface Payload { summary: Summary; items: Item[]; tab: Tab }

async function authHeader() {
  const {
    data: { session },
  } = await getSupabaseClient().auth.getSession();
  return { Authorization: `Bearer ${session?.access_token ?? ""}`, "Content-Type": "application/json" };
}

const TABS: { key: Tab; label: (s: Summary) => string }[] = [
  { key: "pending", label: (s) => `보류 검수 ${s.pending}` },
  { key: "gamri", label: (s) => `감리 ${s.gamri}` },
  { key: "consult", label: (s) => `컨설팅 ${s.consult}` },
  { key: "none", label: (s) => `해당없음 ${s.none}` },
];

export function ClassifyReview() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>("pending");
  const [msg, setMsg] = useState<string | null>(null);

  const { data, isLoading } = useQuery<Payload>({
    queryKey: ["classify-review", tab],
    queryFn: async () => {
      const res = await fetch(`/api/classify/review?tab=${tab}`, { headers: await authHeader() });
      if (!res.ok) throw new Error(`조회 실패 (${res.status})`);
      return res.json();
    },
  });

  const act = useMutation({
    mutationFn: async (payload: Record<string, unknown>) => {
      const res = await fetch("/api/classify/review", { method: "POST", headers: await authHeader(), body: JSON.stringify(payload) });
      const j = await res.json();
      if (!res.ok) throw new Error(j?.error ?? `실패 (${res.status})`);
      return j;
    },
    onSuccess: (j, vars) => {
      if (vars.action === "archive_none") setMsg(`해당없음 ${j.archived}건 아카이브 완료`);
      qc.invalidateQueries({ queryKey: ["classify-review"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
    onError: (e: Error) => setMsg(e.message),
  });

  const s = data?.summary;
  const items = data?.items ?? [];

  return (
    <Card className="mb-4">
      <CardHeader
        title="AI 분류 검수"
        action={
          s ? (
            <span className="text-xs text-subtle">
              감리 {s.gamri} · 컨설팅 {s.consult} · 보류 {s.pending} · 해당없음 {s.none}
            </span>
          ) : null
        }
      />
      <div className="p-3">
        <p className="mb-3 text-xs text-subtle">
          수집 시 AI가 분류한 결과를 검토합니다. 보류(낮은 신뢰)는 확정/재분류하고, 오분류는 바로잡으며, 해당없음은
          아카이브로 자원을 회수합니다.
        </p>

        {/* 탭 */}
        <div className="mb-3 flex flex-wrap gap-1.5">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`rounded-full px-3 py-1 text-xs font-medium ring-1 transition ${
                tab === t.key ? "bg-primary text-white ring-primary" : "bg-bg text-subtle ring-border hover:text-text"
              }`}
            >
              {s ? t.label(s) : t.key}
            </button>
          ))}
        </div>

        {msg && <div className="mb-2 rounded-lg bg-bg px-3 py-1.5 text-xs text-text ring-1 ring-border">{msg}</div>}

        {/* 해당없음 일괄 아카이브 */}
        {tab === "none" && (s?.none ?? 0) > 0 && (
          <div className="mb-3 flex items-center justify-between rounded-lg bg-dday-urgent/5 px-3 py-2 ring-1 ring-dday-urgent/20">
            <span className="text-xs text-subtle">해당없음 {s?.none}건을 목록에서 숨겨 자원을 회수합니다(복원 가능).</span>
            <button
              onClick={() => {
                if (confirm(`해당없음 ${s?.none}건을 일괄 아카이브할까요? (복원 가능)`)) act.mutate({ action: "archive_none" });
              }}
              disabled={act.isPending}
              className="shrink-0 rounded-lg bg-dday-urgent px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-40"
            >
              해당없음 일괄 아카이브
            </button>
          </div>
        )}

        {isLoading ? (
          <div className="h-24 animate-pulse rounded-card bg-border/40" />
        ) : items.length === 0 ? (
          <p className="py-6 text-center text-xs text-subtle">항목이 없습니다.</p>
        ) : (
          <ul className="divide-y divide-border">
            {items.map((it) => {
              const conf = it.classify?.confidence ?? it.confidence;
              const reason = it.classify?.reason ?? it.reason;
              return (
                <li key={`${it.bid_no}-${it.bid_seq}`} className="flex flex-wrap items-center gap-2 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-text" title={it.title ?? ""}>
                      {it.biz_category && (
                        <span className="mr-1 rounded bg-primary/10 px-1 text-[10px] font-semibold text-primary">{it.biz_category}</span>
                      )}
                      {it.title ?? "제목 없음"}
                    </p>
                    <p className="truncate text-[11px] text-subtle">
                      {it.order_org ?? "-"}
                      {conf != null && ` · conf ${Number(conf).toFixed(2)}`}
                      {reason && ` · ${reason}`}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    {tab === "pending" && (
                      <>
                        <Act label="확정" tone="success" onClick={() => act.mutate({ action: "confirm", bid_no: it.bid_no, bid_seq: it.bid_seq })} busy={act.isPending} />
                        <Act label="감리" onClick={() => act.mutate({ action: "감리", bid_no: it.bid_no, bid_seq: it.bid_seq })} busy={act.isPending} />
                        <Act label="컨설팅" onClick={() => act.mutate({ action: "컨설팅", bid_no: it.bid_no, bid_seq: it.bid_seq })} busy={act.isPending} />
                        <Act label="제외" tone="danger" onClick={() => act.mutate({ action: "reject", bid_no: it.bid_no, bid_seq: it.bid_seq })} busy={act.isPending} />
                      </>
                    )}
                    {(tab === "gamri" || tab === "consult") && (
                      <>
                        <Act
                          label={tab === "gamri" ? "→컨설팅" : "→감리"}
                          onClick={() => act.mutate({ action: tab === "gamri" ? "컨설팅" : "감리", bid_no: it.bid_no, bid_seq: it.bid_seq })}
                          busy={act.isPending}
                        />
                        <Act label="제외" tone="danger" onClick={() => act.mutate({ action: "reject", bid_no: it.bid_no, bid_seq: it.bid_seq })} busy={act.isPending} />
                      </>
                    )}
                    {tab === "none" && (
                      <>
                        <Act label="감리로" onClick={() => act.mutate({ action: "감리", bid_no: it.bid_no, bid_seq: it.bid_seq })} busy={act.isPending} />
                        <Act label="컨설팅로" onClick={() => act.mutate({ action: "컨설팅", bid_no: it.bid_no, bid_seq: it.bid_seq })} busy={act.isPending} />
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Card>
  );
}

function Act({ label, onClick, busy, tone }: { label: string; onClick: () => void; busy: boolean; tone?: "success" | "danger" }) {
  const cls =
    tone === "success" ? "text-success ring-success/30 hover:bg-success/10"
    : tone === "danger" ? "text-dday-urgent ring-dday-urgent/30 hover:bg-dday-urgent/10"
    : "text-subtle ring-border hover:bg-bg hover:text-text";
  return (
    <button onClick={onClick} disabled={busy} className={`rounded px-2 py-1 text-[11px] font-medium ring-1 transition disabled:opacity-40 ${cls}`}>
      {label}
    </button>
  );
}
