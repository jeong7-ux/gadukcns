"use client";

// S-05 키워드그룹 검색 — FR-13. 접근: strategy/pm/admin.
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getSupabaseClient } from "@/lib/supabase/client";
import { fetchBids, fetchKeywordGroups } from "@/lib/queries/bids";
import { useSession } from "@/lib/auth/SessionProvider";
import { CAN_SEARCH } from "@/lib/auth/roles";
import { RoleGuard } from "@/components/layout/RoleGuard";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
import { BidCard } from "@/components/bids/BidCard";
import { EmptyState } from "@/components/ui/EmptyState";
import { EMPTY_FILTERS } from "@/components/bids/FilterBar";
import type { MatchLogic } from "@/lib/supabase/types";

export default function SearchPage() {
  return (
    <RoleGuard allow={CAN_SEARCH}>
      <SearchInner />
    </RoleGuard>
  );
}

function SearchInner() {
  const supabase = getSupabaseClient();
  const { session } = useSession();

  const groupsQ = useQuery({
    queryKey: ["keyword_groups"],
    queryFn: () => fetchKeywordGroups(supabase),
  });

  const [selected, setSelected] = useState<number | null>(null);
  const group = useMemo(
    () => groupsQ.data?.find((g) => g.group_id === selected) ?? null,
    [groupsQ.data, selected]
  );

  const resultsQ = useQuery({
    queryKey: ["search-bids", selected],
    queryFn: () => fetchBids(supabase, EMPTY_FILTERS, group),
    enabled: selected !== null,
  });

  // 새 그룹 생성 폼 (keyword chips + AND/OR)
  const [name, setName] = useState("");
  const [chips, setChips] = useState<string[]>([]);
  const [chipInput, setChipInput] = useState("");
  const [logic, setLogic] = useState<MatchLogic>("OR");
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  function addChip() {
    const v = chipInput.trim();
    if (v && !chips.includes(v)) setChips([...chips, v]);
    setChipInput("");
  }

  async function saveGroup() {
    setSaveMsg(null);
    if (!name || chips.length === 0) {
      setSaveMsg("그룹명과 최소 1개의 키워드가 필요합니다.");
      return;
    }
    const { error } = await supabase.from("keyword_groups").insert({
      name,
      keywords: chips,
      match_logic: logic,
      owner: session?.user.id ?? null,
    });
    if (error) {
      // 계약 §5: keyword_groups write 정책 미정 → RLS로 차단될 수 있음.
      setSaveMsg(
        "저장 권한이 없거나 정책이 설정되지 않았습니다(RLS). 관리자에게 문의하세요."
      );
      return;
    }
    setSaveMsg("저장되었습니다.");
    setName("");
    setChips([]);
    groupsQ.refetch();
  }

  return (
    <div>
      <PageHeader
        title="키워드그룹 검색"
        screen="S-05"
        desc="키워드 조합(AND/OR)으로 관심 공고를 검색합니다."
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[320px_1fr]">
        {/* 좌: 그룹 관리 */}
        <div className="space-y-4">
          <Card>
            <CardHeader title="키워드 그룹" />
            <div className="p-3">
              {(groupsQ.data ?? []).length === 0 ? (
                <p className="px-1 py-4 text-xs text-subtle">
                  그룹이 없습니다. 아래에서 새로 만드세요.
                </p>
              ) : (
                <ul className="space-y-1">
                  {groupsQ.data!.map((g) => (
                    <li key={g.group_id}>
                      <button
                        onClick={() => setSelected(g.group_id)}
                        className={`flex w-full items-center justify-between rounded-md px-2 py-2 text-left text-sm ${
                          selected === g.group_id
                            ? "bg-primary/10 font-semibold text-primary"
                            : "hover:bg-bg"
                        }`}
                      >
                        <span>{g.name}</span>
                        <Pill tone="accent">{g.match_logic}</Pill>
                      </button>
                      <div className="flex flex-wrap gap-1 px-2 pb-1">
                        {g.keywords.map((k) => (
                          <span
                            key={k}
                            className="rounded bg-bg px-1.5 py-0.5 text-[10px] text-subtle ring-1 ring-border"
                          >
                            {k}
                          </span>
                        ))}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Card>

          <Card>
            <CardHeader title="새 그룹 만들기" />
            <div className="space-y-2 p-3">
              <input
                placeholder="그룹명 (예: SI 통합)"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full rounded-md border border-border px-2.5 py-1.5 text-xs outline-none focus:border-accent"
              />
              <div className="flex gap-1">
                <input
                  placeholder="키워드 입력 후 추가"
                  value={chipInput}
                  onChange={(e) => setChipInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addChip();
                    }
                  }}
                  className="flex-1 rounded-md border border-border px-2.5 py-1.5 text-xs outline-none focus:border-accent"
                />
                <Button variant="ghost" type="button" onClick={addChip}>
                  추가
                </Button>
              </div>
              <div className="flex flex-wrap gap-1">
                {chips.map((c) => (
                  <button
                    key={c}
                    onClick={() => setChips(chips.filter((x) => x !== c))}
                    className="rounded bg-primary/10 px-1.5 py-0.5 text-[11px] text-primary"
                  >
                    {c} ✕
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-subtle">매칭</span>
                <div className="flex overflow-hidden rounded-md ring-1 ring-border">
                  {(["AND", "OR"] as MatchLogic[]).map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setLogic(m)}
                      className={`px-2.5 py-1 text-xs font-medium ${
                        logic === m
                          ? "bg-primary text-white"
                          : "text-subtle hover:bg-bg"
                      }`}
                    >
                      {m}
                    </button>
                  ))}
                </div>
              </div>
              {saveMsg && <p className="text-xs text-danger">{saveMsg}</p>}
              <Button type="button" onClick={saveGroup} className="w-full">
                그룹 저장
              </Button>
            </div>
          </Card>
        </div>

        {/* 우: 검색 결과 */}
        <div>
          {selected === null ? (
            <EmptyState
              title="그룹을 선택하세요"
              hint="좌측에서 키워드 그룹을 선택하면 매칭 공고가 표시됩니다."
            />
          ) : resultsQ.isLoading ? (
            <p className="text-sm text-subtle">검색 중…</p>
          ) : (resultsQ.data?.length ?? 0) === 0 ? (
            <EmptyState title="매칭 공고가 없습니다" />
          ) : (
            <>
              <p className="mb-2 text-xs text-subtle">
                {group?.name} · {group?.match_logic} · {resultsQ.data!.length}건
              </p>
              <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
                {resultsQ.data!.map((b) => (
                  <BidCard key={`${b.bid_no}-${b.bid_seq}`} bid={b} />
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
