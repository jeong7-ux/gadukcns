"use client";

import type { ReactNode } from "react";
import { useSession } from "@/lib/auth/SessionProvider";
import { has } from "@/lib/auth/roles";
import type { Role } from "@/lib/supabase/types";
import { EmptyState } from "@/components/ui/EmptyState";

/**
 * 화면 단위 역할 게이팅. RLS가 최종 방어선이지만 UI에서도 차단해
 * 권한 없는 사용자에게 빈 상태/안내를 보여준다(에러 노출 최소화).
 */
export function RoleGuard({
  allow,
  children,
}: {
  allow: Role[];
  children: ReactNode;
}) {
  const { role } = useSession();
  if (!has(role, allow)) {
    return (
      <EmptyState
        title="접근 권한이 없습니다"
        hint="이 화면은 지정된 역할에게만 제공됩니다. 필요 시 관리자에게 문의하세요."
      />
    );
  }
  return <>{children}</>;
}
