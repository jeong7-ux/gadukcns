"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ADMIN_MENU } from "./nav";
import type { Role } from "@/lib/supabase/types";

/** 관리자 전용 우측 퀵메뉴 — 관리 화면(S-14/09/11/12/13). 관리자가 아니면 렌더 안 함. */
export function AdminQuickMenu({ role }: { role: Role | null }) {
  const pathname = usePathname();
  if (role !== "admin") return null;

  return (
    <aside className="hidden w-48 shrink-0 border-l border-border bg-surface lg:block">
      <div className="sticky top-0 p-3">
        <p className="mb-2 px-1 text-[10px] font-semibold uppercase tracking-wide text-subtle">
          관리 · 관리자
        </p>
        <nav className="space-y-1">
          {ADMIN_MENU.map((item) => {
            const active = pathname === item.href || pathname.startsWith(item.href + "/");
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex items-center justify-between rounded-md px-2.5 py-2 text-xs transition ${
                  active ? "bg-primary font-semibold text-white" : "text-text hover:bg-bg"
                }`}
              >
                <span className="truncate">{item.label}</span>
                <span className={`ml-1 shrink-0 text-[9px] ${active ? "text-white/70" : "text-subtle"}`}>
                  {item.screen}
                </span>
              </Link>
            );
          })}
        </nav>
      </div>
    </aside>
  );
}
