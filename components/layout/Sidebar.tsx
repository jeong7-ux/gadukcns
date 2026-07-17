"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV } from "./nav";
import { has } from "@/lib/auth/roles";
import type { Role } from "@/lib/supabase/types";

export function Sidebar({ role }: { role: Role | null }) {
  const pathname = usePathname();

  return (
    <aside className="hidden w-60 shrink-0 border-r border-border bg-surface md:block">
      <div className="flex h-14 items-center gap-2 border-b border-border px-4">
        <Link
          href="/dashboard/stats"
          title="메인 페이지"
          className="text-lg font-extrabold tracking-tight text-primary transition hover:opacity-80"
        >
          가덕씨엔에스
        </Link>
      </div>
      <nav className="p-3">
        {NAV.map((group) => {
          const visible = group.items.filter(
            (it) => it.allowed === null || has(role, it.allowed)
          );
          if (visible.length === 0) return null;
          return (
            <div key={group.section} className="mb-4">
              <p className="mb-1 px-2 text-[11px] font-semibold uppercase tracking-wide text-subtle">
                {group.section}
              </p>
              {visible.map((it) => {
                const active =
                  pathname === it.href ||
                  (it.href !== "/dashboard" && pathname.startsWith(it.href));
                return (
                  <Link
                    key={it.href}
                    href={it.href}
                    className={`flex items-center justify-between rounded-md px-2 py-2 text-sm transition-colors ${
                      active
                        ? "bg-primary/10 font-semibold text-primary"
                        : "text-text hover:bg-bg"
                    }`}
                  >
                    <span>{it.label}</span>
                    <span className="text-[10px] text-subtle">{it.screen}</span>
                  </Link>
                );
              })}
            </div>
          );
        })}
      </nav>
    </aside>
  );
}
