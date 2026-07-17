"use client";

// S-11 사용자 승인 관리 — FR-01. admin 전용.
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getSupabaseClient } from "@/lib/supabase/client";
import { ADMIN_ONLY, ROLE_LABEL } from "@/lib/auth/roles";
import { RoleGuard } from "@/components/layout/RoleGuard";
import { useSession } from "@/lib/auth/SessionProvider";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { fmtDate } from "@/lib/utils/format";
import type { UserRow, UserStatus, Role } from "@/lib/supabase/types";

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
  const { profile } = useSession();
  const [tab, setTab] = useState<"pending" | "all">("pending");
  const [busy, setBusy] = useState<string | null>(null);

  async function authHeader() {
    const { data: { session } } = await supabase.auth.getSession();
    return { Authorization: `Bearer ${session?.access_token ?? ""}`, "Content-Type": "application/json" };
  }

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

  // 승인/반려/정지 — 서버(service key)로 처리(RLS 무관하게 확실히)
  async function setStatus(u: AdminUserRow, status: UserStatus) {
    setBusy(u.user_id);
    try {
      const res = await fetch("/api/admin/users", {
        method: "PATCH",
        headers: await authHeader(),
        body: JSON.stringify({ user_id: u.user_id, status }),
      });
      if (!res.ok) {
        alert((await res.json().catch(() => ({})))?.error ?? "상태 변경 실패");
        return;
      }
      qc.invalidateQueries({ queryKey: ["admin-users", "v2-email"] });
    } finally {
      setBusy(null);
    }
  }

  // 역할 변경(경영진/전략기획/사업관리/관리자) — 서버 처리
  async function setRole(u: AdminUserRow, role: Role) {
    if (role === u.role) return;
    if (role === "admin" && !confirm(`${u.name} 님을 '관리자'로 지정할까요? 관리자 전용 기능에 접근할 수 있습니다.`)) return;
    setBusy(u.user_id);
    try {
      const res = await fetch("/api/admin/users", {
        method: "PATCH",
        headers: await authHeader(),
        body: JSON.stringify({ user_id: u.user_id, role }),
      });
      if (!res.ok) {
        alert((await res.json().catch(() => ({})))?.error ?? "역할 변경 실패");
        return;
      }
      qc.invalidateQueries({ queryKey: ["admin-users", "v2-email"] });
    } finally {
      setBusy(null);
    }
  }

  // 계정 삭제(프로필+Auth). 되돌릴 수 없음.
  async function deleteUser(u: AdminUserRow) {
    if (!confirm(`${u.name}(${u.email}) 계정을 완전히 삭제할까요?\n되돌릴 수 없습니다.`)) return;
    setBusy(u.user_id);
    try {
      const res = await fetch(`/api/admin/users?user_id=${encodeURIComponent(u.user_id)}`, {
        method: "DELETE",
        headers: await authHeader(),
      });
      if (!res.ok) {
        alert((await res.json().catch(() => ({})))?.error ?? "삭제 실패");
        return;
      }
      qc.invalidateQueries({ queryKey: ["admin-users", "v2-email"] });
    } finally {
      setBusy(null);
    }
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
                  <td className="px-4 py-2.5">
                    {u.user_id === profile?.user_id ? (
                      <span className="text-xs text-text">{ROLE_LABEL[u.role]} (본인)</span>
                    ) : (
                      <select
                        value={u.role}
                        disabled={busy === u.user_id}
                        onChange={(e) => setRole(u, e.target.value as Role)}
                        className="rounded-md border border-border bg-surface px-2 py-1 text-xs text-text outline-none focus:border-accent disabled:opacity-40"
                      >
                        {(["exec", "strategy", "pm", "admin"] as const).map((r) => (
                          <option key={r} value={r}>
                            {ROLE_LABEL[r]}
                          </option>
                        ))}
                      </select>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    <Pill tone={STATUS_TONE[u.status]}>
                      {STATUS_LABEL[u.status]}
                    </Pill>
                  </td>
                  <td className="px-4 py-2.5 text-xs text-subtle">
                    {fmtDate(u.created_at)}
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex flex-wrap gap-1">
                      {u.status !== "active" && (
                        <Button
                          variant="primary"
                          className="px-2 py-1 text-xs"
                          disabled={busy === u.user_id}
                          onClick={() => setStatus(u, "active")}
                        >
                          승인
                        </Button>
                      )}
                      {(u.status === "pending" || u.status === "unverified") && (
                        <Button
                          variant="danger"
                          className="px-2 py-1 text-xs"
                          disabled={busy === u.user_id}
                          onClick={() => setStatus(u, "rejected")}
                        >
                          반려
                        </Button>
                      )}
                      {u.status === "active" && (
                        <Button
                          variant="ghost"
                          className="px-2 py-1 text-xs"
                          disabled={busy === u.user_id}
                          onClick={() => setStatus(u, "suspended")}
                        >
                          정지
                        </Button>
                      )}
                      {/* 삭제 — 본인 계정 제외 */}
                      {u.user_id !== profile?.user_id && (
                        <button
                          onClick={() => deleteUser(u)}
                          disabled={busy === u.user_id}
                          className="rounded-md px-2 py-1 text-xs font-medium text-danger ring-1 ring-danger/40 transition hover:bg-danger/10 disabled:opacity-40"
                        >
                          삭제
                        </button>
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
