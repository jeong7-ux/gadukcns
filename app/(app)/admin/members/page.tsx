"use client";

// S-09 인력 관리 — FR-09. read=pm/admin, write=admin (§5).
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getSupabaseClient } from "@/lib/supabase/client";
import { useSession } from "@/lib/auth/SessionProvider";
import { CAN_MEMBER, has, ADMIN_ONLY } from "@/lib/auth/roles";
import { RoleGuard } from "@/components/layout/RoleGuard";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { fmtDate } from "@/lib/utils/format";
import type { Member } from "@/lib/supabase/types";

export default function MembersPage() {
  return (
    <RoleGuard allow={CAN_MEMBER}>
      <MembersInner />
    </RoleGuard>
  );
}

const STATUS_TONE = { 재직: "success", 휴직: "accent", 퇴직: "muted" } as const;

function MembersInner() {
  const supabase = getSupabaseClient();
  const { role } = useSession();
  const canEdit = has(role, ADMIN_ONLY);
  const [kw, setKw] = useState("");
  const [grade, setGrade] = useState("");

  const q = useQuery({
    queryKey: ["members"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("member_table")
        .select(
          "member_id,name,work_type,tech_grade,license_name,association_no,status,specialty_field,career_years,license_expiry,reg_date,updated_at"
        )
        .order("member_id", { ascending: true });
      if (error) throw error;
      return (data as Member[]) ?? [];
    },
  });

  const rows = useMemo(() => {
    return (q.data ?? []).filter((m) => {
      if (grade && m.tech_grade !== grade) return false;
      if (kw) {
        const s = `${m.name} ${m.specialty_field ?? ""} ${
          m.license_name ?? ""
        }`.toLowerCase();
        if (!s.includes(kw.toLowerCase())) return false;
      }
      return true;
    });
  }, [q.data, kw, grade]);

  return (
    <div>
      <PageHeader
        title="인력 관리"
        screen="S-09"
        desc="기술인력 명부(FR-09). 개인정보는 해시 저장되어 화면에 노출되지 않습니다."
        action={
          canEdit ? (
            <Button variant="primary">인력 추가</Button>
          ) : (
            <Pill tone="muted">읽기 전용(pm)</Pill>
          )
        }
      />

      <div className="mb-3 flex flex-wrap gap-2">
        <input
          placeholder="이름/전문분야/자격 검색"
          value={kw}
          onChange={(e) => setKw(e.target.value)}
          className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs outline-none focus:border-accent"
        />
        <select
          value={grade}
          onChange={(e) => setGrade(e.target.value)}
          className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs outline-none focus:border-accent"
        >
          <option value="">기술등급 전체</option>
          {["초급", "중급", "고급", "특급"].map((g) => (
            <option key={g} value={g}>
              {g}
            </option>
          ))}
        </select>
      </div>

      {q.isLoading ? (
        <p className="text-sm text-subtle">불러오는 중…</p>
      ) : q.isError ? (
        <EmptyState
          title="인력 정보를 볼 수 없습니다"
          hint="이 화면은 pm/admin 역할에게만 제공됩니다(RLS)."
        />
      ) : rows.length === 0 ? (
        <EmptyState title="조건에 맞는 인력이 없습니다" />
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-subtle">
                <th className="px-4 py-2.5 font-medium">사번</th>
                <th className="px-4 py-2.5 font-medium">이름</th>
                <th className="px-4 py-2.5 font-medium">근무</th>
                <th className="px-4 py-2.5 font-medium">등급</th>
                <th className="px-4 py-2.5 font-medium">전문분야</th>
                <th className="px-4 py-2.5 font-medium">자격/면허</th>
                <th className="px-4 py-2.5 font-medium">경력</th>
                <th className="px-4 py-2.5 font-medium">상태</th>
                <th className="px-4 py-2.5 font-medium">만료일</th>
                {canEdit && <th className="px-4 py-2.5 font-medium">관리</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((m) => (
                <tr key={m.member_id} className="hover:bg-bg">
                  <td className="px-4 py-2.5 text-xs text-subtle">
                    {m.member_id}
                  </td>
                  <td className="px-4 py-2.5 font-medium text-text">{m.name}</td>
                  <td className="px-4 py-2.5 text-xs">{m.work_type}</td>
                  <td className="px-4 py-2.5">
                    <Pill tone="primary">{m.tech_grade}</Pill>
                  </td>
                  <td className="px-4 py-2.5 text-xs">
                    {m.specialty_field ?? "-"}
                  </td>
                  <td className="px-4 py-2.5 text-xs">{m.license_name ?? "-"}</td>
                  <td className="px-4 py-2.5 text-xs">
                    {m.career_years ?? "-"}년
                  </td>
                  <td className="px-4 py-2.5">
                    <Pill tone={STATUS_TONE[m.status]}>{m.status}</Pill>
                  </td>
                  <td className="px-4 py-2.5 text-xs text-subtle">
                    {fmtDate(m.license_expiry)}
                  </td>
                  {canEdit && (
                    <td className="px-4 py-2.5">
                      <button className="text-xs text-accent hover:underline">
                        수정
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
