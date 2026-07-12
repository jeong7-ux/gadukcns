"use client";

// S-11 사용자 승인 관리 — FR-01. admin 전용.
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getSupabaseClient } from "@/lib/supabase/client";
import { ADMIN_ONLY, ROLE_LABEL } from "@/lib/auth/roles";
import { RoleGuard } from "@/components/layout/RoleGuard";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { fmtDate } from "@/lib/utils/format";
import type { UserRow, UserStatus } from "@/lib/supabase/types";

type AdminUserRow = Pick<UserRow, "user_id" | "name" | "dept" | "role" | "status" | "created_at"> & {
  email: string;
};

export default function UsersPage() {
  return (
    <RoleGuard allow={ADMIN_ONLY}>
      <UsersInner />
    </RoleGuard>
  );
}

const STATUS_TONE: Record<UserStatus, "muted" | "accent" | "success" | "danger"> = {
  unverified: "muted",
  pending: "accent",
  active: "success",
  rejected: "danger",
  suspended: "danger",
};
const STATUS_LABEL: Record<UserStatus, string> = {
  unverified: "미인증",
  pending: "승인대기",
  active: "활성",
  rejected: "반려",
  suspended: "정지",
};

function UsersInner() {
  const supabase = getSupabaseClient();
  const qc = useQueryClient();
  const [tab, setTab] = useState<"pending" | "all">("pending");

  const q = useQuery({
    queryKey: ["admin-users", "v2-email"],
    queryFn: async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const res = await fetch("/api/admin/users", {
        headers: { Authorization: `Bearer ${session?.access_token ?? ""}` },
      });
      if (!res.ok) throw new Error("사용자 목록을 불러오지 못했습니다.");
      const j = (await res.json()) as { rows: AdminUserRow[] };
      return j.rows ?? [];
    },
  });

  const rows = useMemo(() => {
    const list = q.data ?? [];
    return tab === "pending"
      ? list.filter((u) => u.status === "pending" || u.status === "unverified")
      : list;
  }, [q.data, tab]);

  async function setStatus(u: AdminUserRow, status: UserStatus) {
    await supabase.from("users").update({ status }).eq("user_id", u.user_id);
    qc.invalidateQueries({ queryKey: ["admin-users", "v2-email"] });
  }

  return (
    <div>
      <PageHeader
        title="사용자 승인 관리"
        screen="S-11"
        desc="가입 요청을 승인/반려하고 계정 상태를 관리합니다."
      />

      <div className="mb-3 flex gap-1">
        {(
          [
            ["pending", "승인 대기"],
            ["all", "전체 사용자"],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={`rounded-md px-3 py-1.5 text-xs font-medium ${
              tab === k
                ? "bg-primary text-white"
                : "text-subtle ring-1 ring-border hover:bg-bg"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {q.isLoading ? (
        <p className="text-sm text-subtle">불러오는 중…</p>
      ) : rows.length === 0 ? (
        <EmptyState title="표시할 사용자가 없습니다" />
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-subtle">
                <th className="px-4 py-2.5 font-medium">아이디</th>
                <th className="px-4 py-2.5 font-medium">이름</th>
                <th className="px-4 py-2.5 font-medium">부서</th>
                <th className="px-4 py-2.5 font-medium">역할</th>
                <th className="px-4 py-2.5 font-medium">상태</th>
                <th className="px-4 py-2.5 font-medium">가입일</th>
                <th className="px-4 py-2.5 font-medium">처리</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((u) => (
                <tr key={u.user_id} className="hover:bg-bg">
                  <td className="px-4 py-2.5 text-xs text-text">{u.email}</td>
                  <td className="px-4 py-2.5 font-medium text-text">{u.name}</td>
                  <td className="px-4 py-2.5 text-xs">{u.dept}</td>
                  <td className="px-4 py-2.5 text-xs">{ROLE_LABEL[u.role]}</td>
                  <td className="px-4 py-2.5">
                    <Pill tone={STATUS_TONE[u.status]}>
                      {STATUS_LABEL[u.status]}
                    </Pill>
                  </td>
                  <td className="px-4 py-2.5 text-xs text-subtle">
                    {fmtDate(u.created_at)}
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex gap-1">
                      {u.status !== "active" && (
                        <Button
                          variant="primary"
                          className="px-2 py-1 text-xs"
                          onClick={() => setStatus(u, "active")}
                        >
                          승인
                        </Button>
                      )}
                      {(u.status === "pending" || u.status === "unverified") && (
                        <Button
                          variant="danger"
                          className="px-2 py-1 text-xs"
                          onClick={() => setStatus(u, "rejected")}
                        >
                          반려
                        </Button>
                      )}
                      {u.status === "active" && (
                        <Button
                          variant="ghost"
                          className="px-2 py-1 text-xs"
                          onClick={() => setStatus(u, "suspended")}
                        >
                          정지
                        </Button>
                      )}
                    </div>
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
