"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "@/lib/auth/SessionProvider";
import { TopBar } from "@/components/layout/TopBar";
import { AdminQuickMenu } from "@/components/layout/AdminQuickMenu";

/**
 * 인증 셸. 게이팅 순서:
 *  - 세션 없음 → /login
 *  - status != active → /pending (승인 대기/반려/정지 통합 안내)
 *  - active → 셸(사이드바+탑바) 렌더
 */
export default function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const { loading, session, status, role } = useSession();

  useEffect(() => {
    if (loading) return;
    if (!session) {
      router.replace("/login");
      return;
    }
    if (status !== "active") {
      router.replace("/pending");
    }
  }, [loading, session, status, router]);

  if (loading || !session || status !== "active") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg">
        <p className="text-sm text-subtle">불러오는 중…</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen bg-bg">
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <main className="min-w-0 flex-1 p-4 md:p-6">{children}</main>
      </div>
      <AdminQuickMenu role={role} />
    </div>
  );
}
