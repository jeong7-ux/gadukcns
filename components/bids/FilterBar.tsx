"use client";

import type { BidStatus, KeywordGroup, MatchLogic } from "@/lib/supabase/types";

export interface BidFilters {
  org: string;
  contractMethod: string;
  status: BidStatus | "";
  groupId: number | null;
  matchLogic: MatchLogic;
  from: string;
  to: string;
}

export const EMPTY_FILTERS: BidFilters = {
  org: "",
  contractMethod: "",
  status: "",
  groupId: null,
  matchLogic: "OR",
  from: "",
  to: "",
};

/** S-04 상단 필터: 발주기관/계약유형/상태/키워드그룹(AND·OR)/기간 */
export function FilterBar({
  value,
  onChange,
  groups,
}: {
  value: BidFilters;
  onChange: (f: BidFilters) => void;
  groups: KeywordGroup[];
}) {
  const set = (patch: Partial<BidFilters>) => onChange({ ...value, ...patch });
  const cls =
    "rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs outline-none focus:border-accent focus:ring-1 focus:ring-accent";

  return (
    <div className="mb-4 flex flex-wrap items-center gap-2 rounded-card border border-border bg-surface p-3">
      <input
        placeholder="발주기관"
        value={value.org}
        onChange={(e) => set({ org: e.target.value })}
        className={cls}
      />
      <input
        placeholder="계약방법"
        value={value.contractMethod}
        onChange={(e) => set({ contractMethod: e.target.value })}
        className={cls}
      />
      <select
        value={value.status}
        onChange={(e) => set({ status: e.target.value as BidStatus | "" })}
        className={cls}
      >
        <option value="">상태 전체</option>
        <option value="ongoing">진행중</option>
        <option value="today">오늘마감</option>
      </select>

      <div className="flex items-center gap-1">
        <select
          value={value.groupId ?? ""}
          onChange={(e) =>
            set({ groupId: e.target.value ? Number(e.target.value) : null })
          }
          className={cls}
        >
          <option value="">키워드그룹</option>
          {groups.map((g) => (
            <option key={g.group_id} value={g.group_id}>
              {g.name}
            </option>
          ))}
        </select>
        <div className="flex overflow-hidden rounded-md ring-1 ring-border">
          {(["AND", "OR"] as MatchLogic[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => set({ matchLogic: m })}
              className={`px-2 py-1.5 text-xs font-medium ${
                value.matchLogic === m
                  ? "bg-primary text-white"
                  : "bg-surface text-subtle hover:bg-bg"
              }`}
            >
              {m}
            </button>
          ))}
        </div>
      </div>

      <input
        type="date"
        value={value.from}
        onChange={(e) => set({ from: e.target.value })}
        className={cls}
      />
      <span className="text-xs text-subtle">~</span>
      <input
        type="date"
        value={value.to}
        onChange={(e) => set({ to: e.target.value })}
        className={cls}
      />

      <button
        type="button"
        onClick={() => onChange(EMPTY_FILTERS)}
        className="ml-auto rounded-md px-2 py-1.5 text-xs text-subtle ring-1 ring-border hover:bg-bg"
      >
        초기화
      </button>
    </div>
  );
}
