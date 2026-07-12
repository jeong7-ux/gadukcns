"use client";

// S-14 고객사 관리 — FR-16/19/20. pm/admin. clients CRUD + 우선순위 반영(org 룰 동기화+재스코어링).
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getSupabaseClient } from "@/lib/supabase/client";
import { CAN_MEMBER } from "@/lib/auth/roles";
import { RoleGuard } from "@/components/layout/RoleGuard";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardHeader } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import type { Client, ClientCategory } from "@/lib/supabase/types";

const CATEGORIES: ClientCategory[] = [
  "중앙정부부처",
  "지방자치단체",
  "공공기관",
  "의료기관",
  "교육기관",
  "금융기관",
  "기타",
];

export default function ClientsPage() {
  return (
    <RoleGuard allow={CAN_MEMBER}>
      <ClientsInner />
    </RoleGuard>
  );
}

function ClientsInner() {
  const supabase = getSupabaseClient();
  const qc = useQueryClient();
  const [cat, setCat] = useState<ClientCategory | "전체">("전체");
  const [form, setForm] = useState<{ name: string; category: ClientCategory; weight: number }>({
    name: "",
    category: "중앙정부부처",
    weight: 10,
  });
  const [msg, setMsg] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ["clients"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("clients")
        .select("*")
        .order("category", { ascending: true })
        .order("name", { ascending: true });
      if (error) throw error;
      return (data as Client[]) ?? [];
    },
  });

  const list = useMemo(
    () => (q.data ?? []).filter((c) => cat === "전체" || c.category === cat),
    [q.data, cat]
  );
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of q.data ?? []) m.set(c.category, (m.get(c.category) ?? 0) + 1);
    return m;
  }, [q.data]);

  async function addClient() {
    setMsg(null);
    if (!form.name.trim()) return setMsg("기관명을 입력하세요.");
    const { error } = await supabase.from("clients").upsert(
      { name: form.name.trim(), category: form.category, weight: form.weight, is_priority: true },
      { onConflict: "name" }
    );
    if (error) return setMsg("저장 실패: 권한(pm/admin) 또는 정책을 확인하세요.");
    setForm({ name: "", category: form.category, weight: 10 });
    qc.invalidateQueries({ queryKey: ["clients"] });
  }
  async function togglePriority(c: Client) {
    await supabase.from("clients").update({ is_priority: !c.is_priority }).eq("client_id", c.client_id);
    qc.invalidateQueries({ queryKey: ["clients"] });
  }
  async function remove(c: Client) {
    if (!confirm(`고객사 '${c.name}'을(를) 삭제할까요?`)) return;
    await supabase.from("clients").delete().eq("client_id", c.client_id);
    qc.invalidateQueries({ queryKey: ["clients"] });
  }

  // FR-20: 우선 고객사 → org 룰 동기화 후 재스코어링
  async function applyPriority() {
    if (!confirm("우선 고객사를 스코어링 규칙(org)에 반영하고 전체 재스코어링합니다. 진행할까요?")) return;
    setSyncMsg(null);
    setSyncing(true);
    const r1 = await supabase.rpc("sync_client_org_rules");
    if (r1.error) {
      setSyncing(false);
      setSyncMsg(
        /sync_client_org_rules|function|schema cache|PGRST202/i.test(r1.error.message)
          ? "sync_client_org_rules() 함수가 없습니다. supabase/clients.sql 을 SQL Editor에서 실행하세요."
          : `실패: ${r1.error.message}`
      );
      return;
    }
    const r2 = await supabase.rpc("rescore_bids");
    setSyncing(false);
    if (r2.error) return setSyncMsg(`org 룰 동기화 완료(org ${r2.error ? "?" : ""}). 재스코어링 실패: ${r2.error.message}`);
    setSyncMsg(`반영 완료 — org 룰 ${Number(r1.data)}개, 재스코어링 ${Number(r2.data).toLocaleString()}건.`);
    qc.invalidateQueries({ queryKey: ["bids"] });
  }

  return (
    <div>
      <PageHeader
        title="고객사 관리"
        screen="S-14"
        desc="회사 고객사(발주·수요기관)를 관리합니다. 우선 고객사는 입찰 목록에서 상단 정렬·강조됩니다(FR-16/18/20)."
      />

      {/* 우선순위 반영 */}
      <Card className="mb-4">
        <div className="flex flex-wrap items-center justify-between gap-2 p-3">
          <div>
            <p className="text-sm font-semibold text-text">우선순위 반영 (org 룰 동기화 + 재스코어링)</p>
            <p className="mt-0.5 text-xs text-subtle">
              우선 고객사를 발주기관 룰(가중치)로 반영하고 전체 공고를 재계산합니다. 자동 수집은
              <code className="mx-1 rounded bg-bg px-1">scripts/collect_clients.mjs</code>(배치).
            </p>
          </div>
          <div className="flex items-center gap-2">
            {syncMsg && (
              <span className={`text-xs ${syncMsg.includes("완료") ? "text-success" : "text-danger"}`}>
                {syncMsg}
              </span>
            )}
            <Button onClick={applyPriority} disabled={syncing}>
              {syncing ? "반영 중…" : "우선순위 반영"}
            </Button>
          </div>
        </div>
      </Card>

      {/* 추가 */}
      <Card className="mb-4">
        <CardHeader title="고객사 추가" />
        <div className="flex flex-wrap items-end gap-2 p-3">
          <div className="flex-1 min-w-[180px]">
            <label className="mb-1 block text-xs text-subtle">기관명</label>
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="예: 국립보건연구원"
              className="w-full rounded-md border border-border px-2.5 py-1.5 text-xs outline-none focus:border-accent"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-subtle">카테고리</label>
            <select
              value={form.category}
              onChange={(e) => setForm({ ...form, category: e.target.value as ClientCategory })}
              className="rounded-md border border-border px-2.5 py-1.5 text-xs outline-none focus:border-accent"
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <div className="w-24">
            <label className="mb-1 block text-xs text-subtle">가중치</label>
            <input
              type="number"
              value={form.weight}
              onChange={(e) => setForm({ ...form, weight: Number(e.target.value) })}
              className="w-full rounded-md border border-border px-2.5 py-1.5 text-xs outline-none focus:border-accent"
            />
          </div>
          <Button onClick={addClient}>추가</Button>
          {msg && <span className="text-xs text-danger">{msg}</span>}
        </div>
      </Card>

      {/* 카테고리 필터 */}
      <div className="mb-3 flex flex-wrap gap-1.5">
        {(["전체", ...CATEGORIES] as const).map((c) => (
          <button
            key={c}
            onClick={() => setCat(c)}
            className={`rounded-full px-2.5 py-1 text-xs ring-1 transition-colors ${
              cat === c
                ? "bg-primary/10 font-semibold text-primary ring-primary/30"
                : "text-subtle ring-border hover:bg-bg"
            }`}
          >
            {c}
            {c !== "전체" && counts.get(c) ? ` ${counts.get(c)}` : ""}
          </button>
        ))}
      </div>

      {q.isLoading ? (
        <p className="text-sm text-subtle">불러오는 중…</p>
      ) : q.isError ? (
        <EmptyState
          title="고객사를 불러올 수 없습니다"
          hint="clients 테이블이 없으면 supabase/clients.sql 을 SQL Editor에서 실행하세요."
        />
      ) : list.length === 0 ? (
        <EmptyState title="등록된 고객사가 없습니다" />
      ) : (
        <Card className="overflow-x-auto">
          <p className="px-4 pt-3 text-xs text-subtle">총 {list.length}곳</p>
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-subtle">
                <th className="px-4 py-2.5 font-medium">기관명</th>
                <th className="px-4 py-2.5 font-medium">카테고리</th>
                <th className="px-4 py-2.5 font-medium">가중치</th>
                <th className="px-4 py-2.5 font-medium">우선</th>
                <th className="px-4 py-2.5 font-medium">관리</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {list.map((c) => (
                <tr key={c.client_id} className="hover:bg-bg">
                  <td className="px-4 py-2.5 font-medium text-text">{c.name}</td>
                  <td className="px-4 py-2.5">
                    <Pill tone="primary">{c.category}</Pill>
                  </td>
                  <td className="px-4 py-2.5">{c.weight}</td>
                  <td className="px-4 py-2.5">
                    <button onClick={() => togglePriority(c)}>
                      <Pill tone={c.is_priority ? "success" : "muted"}>
                        {c.is_priority ? "우선" : "일반"}
                      </Pill>
                    </button>
                  </td>
                  <td className="px-4 py-2.5">
                    <button
                      onClick={() => remove(c)}
                      className="text-xs text-danger hover:underline"
                    >
                      삭제
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
