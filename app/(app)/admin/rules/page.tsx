"use client";

// S-12 스코어링 규칙 — FR-05. admin 전용. rules CRUD.
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getSupabaseClient } from "@/lib/supabase/client";
import { ADMIN_ONLY } from "@/lib/auth/roles";
import { RoleGuard } from "@/components/layout/RoleGuard";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardHeader } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import type { Rule } from "@/lib/supabase/types";

export default function RulesPage() {
  return (
    <RoleGuard allow={ADMIN_ONLY}>
      <RulesInner />
    </RoleGuard>
  );
}

const TYPES = ["keyword", "org", "exclude", "contract"] as const;
const TYPE_LABEL: Record<Rule["type"], string> = {
  keyword: "키워드",
  org: "발주기관",
  exclude: "제외",
  contract: "계약방법",
};

function RulesInner() {
  const supabase = getSupabaseClient();
  const qc = useQueryClient();

  const q = useQuery({
    queryKey: ["rules"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("rules")
        .select("*")
        .order("id", { ascending: true });
      if (error) throw error;
      return (data as Rule[]) ?? [];
    },
  });

  const [form, setForm] = useState<{
    type: Rule["type"];
    pattern: string;
    weight: number;
  }>({ type: "keyword", pattern: "", weight: 1 });
  const [msg, setMsg] = useState<string | null>(null);
  const [rescoring, setRescoring] = useState(false);
  const [rescoreMsg, setRescoreMsg] = useState<string | null>(null);

  // 현재 규칙으로 기존 공고 전체를 재계산. DB 함수 rescore_bids()(SECURITY DEFINER) RPC 호출.
  async function rescore() {
    if (!confirm("현재 규칙으로 전체 공고의 점수·태그를 다시 계산합니다. 진행할까요?")) return;
    setRescoreMsg(null);
    setRescoring(true);
    const { data, error } = await supabase.rpc("rescore_bids");
    setRescoring(false);
    if (error) {
      // 함수 미배포(42883/PGRST202) 안내
      const notFound = /rescore_bids|function|schema cache|PGRST202/i.test(error.message);
      setRescoreMsg(
        notFound
          ? "rescore_bids() 함수가 아직 DB에 없습니다. supabase/schema.sql의 rescore_bids 함수를 SQL Editor에서 실행한 뒤 다시 시도하세요."
          : `재스코어링 실패: ${error.message}`
      );
      return;
    }
    setRescoreMsg(`재스코어링 완료 — ${Number(data).toLocaleString()}건 갱신됨.`);
    qc.invalidateQueries({ queryKey: ["rules"] });
  }

  async function addRule() {
    setMsg(null);
    if (!form.pattern.trim()) {
      setMsg("패턴을 입력하세요.");
      return;
    }
    const { error } = await supabase.from("rules").insert({
      type: form.type,
      pattern: form.pattern.trim(),
      weight: form.weight,
      is_active: true,
    });
    if (error) {
      setMsg("저장 실패: 권한 또는 정책을 확인하세요.");
      return;
    }
    setForm({ type: "keyword", pattern: "", weight: 1 });
    qc.invalidateQueries({ queryKey: ["rules"] });
  }

  async function toggleActive(r: Rule) {
    await supabase
      .from("rules")
      .update({ is_active: !r.is_active })
      .eq("id", r.id);
    qc.invalidateQueries({ queryKey: ["rules"] });
  }

  async function remove(r: Rule) {
    await supabase.from("rules").delete().eq("id", r.id);
    qc.invalidateQueries({ queryKey: ["rules"] });
  }

  return (
    <div>
      <PageHeader
        title="스코어링 규칙"
        screen="S-12"
        desc="룰(가중치)은 데이터로 관리됩니다. 규칙 변경 후 '재스코어링'을 눌러야 기존 공고 점수에 반영됩니다(FR-05)."
      />

      {/* 재스코어링 — 규칙 변경을 기존 공고에 적용 */}
      <Card className="mb-4">
        <div className="flex flex-wrap items-center justify-between gap-2 p-3">
          <div>
            <p className="text-sm font-semibold text-text">규칙 반영 (재스코어링)</p>
            <p className="mt-0.5 text-xs text-subtle">
              현재 활성 규칙으로 전체 공고의 점수·태그를 다시 계산합니다. LLM 없이 즉시 반영됩니다.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {rescoreMsg && (
              <span
                className={`text-xs ${
                  rescoreMsg.includes("완료") ? "text-success" : "text-danger"
                }`}
              >
                {rescoreMsg}
              </span>
            )}
            <Button onClick={rescore} disabled={rescoring}>
              {rescoring ? "재계산 중…" : "재스코어링"}
            </Button>
          </div>
        </div>
      </Card>

      <Card className="mb-4">
        <CardHeader title="규칙 추가" />
        <div className="flex flex-wrap items-end gap-2 p-3">
          <div>
            <label className="mb-1 block text-xs text-subtle">유형</label>
            <select
              value={form.type}
              onChange={(e) =>
                setForm({ ...form, type: e.target.value as Rule["type"] })
              }
              className="rounded-md border border-border px-2.5 py-1.5 text-xs outline-none focus:border-accent"
            >
              {TYPES.map((t) => (
                <option key={t} value={t}>
                  {TYPE_LABEL[t]}
                </option>
              ))}
            </select>
          </div>
          <div className="flex-1 min-w-[180px]">
            <label className="mb-1 block text-xs text-subtle">패턴</label>
            <input
              value={form.pattern}
              onChange={(e) => setForm({ ...form, pattern: e.target.value })}
              placeholder="예: 정보화전략, ISP, 조달청"
              className="w-full rounded-md border border-border px-2.5 py-1.5 text-xs outline-none focus:border-accent"
            />
          </div>
          <div className="w-24">
            <label className="mb-1 block text-xs text-subtle">가중치</label>
            <input
              type="number"
              value={form.weight}
              onChange={(e) =>
                setForm({ ...form, weight: Number(e.target.value) })
              }
              className="w-full rounded-md border border-border px-2.5 py-1.5 text-xs outline-none focus:border-accent"
            />
          </div>
          <Button onClick={addRule}>추가</Button>
          {msg && <span className="text-xs text-danger">{msg}</span>}
        </div>
      </Card>

      {q.isLoading ? (
        <p className="text-sm text-subtle">불러오는 중…</p>
      ) : (q.data?.length ?? 0) === 0 ? (
        <EmptyState title="등록된 규칙이 없습니다" />
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-subtle">
                <th className="px-4 py-2.5 font-medium">유형</th>
                <th className="px-4 py-2.5 font-medium">패턴</th>
                <th className="px-4 py-2.5 font-medium">가중치</th>
                <th className="px-4 py-2.5 font-medium">활성</th>
                <th className="px-4 py-2.5 font-medium">관리</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {q.data!.map((r) => (
                <tr key={r.id} className="hover:bg-bg">
                  <td className="px-4 py-2.5">
                    <Pill tone="primary">{TYPE_LABEL[r.type]}</Pill>
                  </td>
                  <td className="px-4 py-2.5 font-medium text-text">
                    {r.pattern}
                  </td>
                  <td className="px-4 py-2.5">{r.weight}</td>
                  <td className="px-4 py-2.5">
                    <button onClick={() => toggleActive(r)}>
                      <Pill tone={r.is_active ? "success" : "muted"}>
                        {r.is_active ? "활성" : "비활성"}
                      </Pill>
                    </button>
                  </td>
                  <td className="px-4 py-2.5">
                    <button
                      onClick={() => remove(r)}
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
