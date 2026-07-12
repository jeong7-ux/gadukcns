"use client";

import { useSession } from "@/lib/auth/SessionProvider";
import { ROLE_LABEL } from "@/lib/auth/roles";
import { Pill } from "@/components/ui/Pill";
import { ThemeToggle } from "@/components/ui/ThemeToggle";

export function TopBar() {
  const { profile, role, signOut } = useSession();
  return (
    <header className="flex h-14 items-center justify-between border-b border-border bg-surface px-4">
      <div className="text-sm font-semibold text-text md:hidden">입찰정보시스템</div>
      <div className="hidden md:block" />
      <div className="flex items-center gap-3">
        {profile && (
          <div className="flex items-center gap-2 text-sm">
            <span className="font-medium text-text">{profile.name}</span>
            {role && <Pill tone="primary">{ROLE_LABEL[role]}</Pill>}
            <span className="text-xs text-subtle">{profile.dept}</span>
          </div>
        )}
        <ThemeToggle />
        <button
          onClick={() => signOut()}
          className="rounded-md px-2 py-1 text-xs text-subtle ring-1 ring-border hover:bg-bg"
        >
          로그아웃
        </button>
      </div>
    </header>
  );
}
