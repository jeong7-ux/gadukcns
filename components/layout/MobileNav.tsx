"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV, ADMIN_MENU, type NavItem } from "@/components/layout/nav";
import { has } from "@/lib/auth/roles";
import { useSession } from "@/lib/auth/SessionProvider";

/**
 * 모바일·태블릿 전역 네비게이션(슬라이드 드로어).
 *  - 햄버거 버튼은 md 미만에서만 노출(md:hidden). 데스크톱 레이아웃은 변경하지 않는다.
 *  - NAV(입찰) + 관리자면 ADMIN_MENU(관리)를 Sidebar/AdminQuickMenu와 동일한
 *    역할 필터(allowed===null || has(role, allowed))로 렌더.
 */
function isActive(pathname: string, href: string): boolean {
  if (pathname === href) return true;
  if (href === "/dashboard") return false; // /dashboard/stats 가 /dashboard 를 활성화하지 않도록
  return pathname.startsWith(href + "/");
}

export function MobileNav() {
  const { role } = useSession();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  // ESC 닫기 + 열렸을 때 body 스크롤 잠금
  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const isAdmin = role === "admin";
  const adminItems: NavItem[] = isAdmin
    ? ADMIN_MENU.filter((it) => it.allowed === null || has(role, it.allowed))
    : [];

  function renderItem(it: NavItem) {
    const active = isActive(pathname, it.href);
    return (
      <Link
        key={it.href}
        href={it.href}
        onClick={() => setOpen(false)}
        className={`flex items-center justify-between rounded-md px-2 py-2.5 text-sm transition-colors ${
          active
            ? "bg-primary/10 font-semibold text-primary"
            : "text-text hover:bg-bg"
        }`}
      >
        <span className="truncate">{it.label}</span>
        <span className={`ml-2 shrink-0 text-[10px] ${active ? "text-primary/70" : "text-subtle"}`}>
          {it.screen}
        </span>
      </Link>
    );
  }

  return (
    <>
      {/* 햄버거 — 모바일 전용 */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="메뉴 열기"
        aria-expanded={open}
        className="inline-flex items-center justify-center rounded-md p-1.5 text-text transition-colors hover:bg-bg md:hidden"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
          <line x1="3" y1="6" x2="21" y2="6" />
          <line x1="3" y1="12" x2="21" y2="12" />
          <line x1="3" y1="18" x2="21" y2="18" />
        </svg>
      </button>

      {/* 오버레이 드로어 — 열렸을 때만, md 미만에서만 */}
      {open && (
        <div
          className="fixed inset-0 z-50 md:hidden"
          role="dialog"
          aria-modal="true"
          aria-label="메뉴"
        >
          {/* backdrop */}
          <div
            className="absolute inset-0 bg-black/50"
            onClick={() => setOpen(false)}
            aria-hidden
          />
          {/* 좌측 슬라이드 패널 */}
          <div className="absolute inset-y-0 left-0 flex w-72 max-w-[80%] flex-col border-r border-border bg-surface shadow-card">
            <div className="flex h-14 shrink-0 items-center justify-between border-b border-border px-4">
              <span className="text-lg font-extrabold tracking-tight text-primary">
                가덕씨엔에스
              </span>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="메뉴 닫기"
                className="inline-flex items-center justify-center rounded-md p-1.5 text-subtle transition-colors hover:bg-bg hover:text-text"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                  <line x1="6" y1="6" x2="18" y2="18" />
                  <line x1="18" y1="6" x2="6" y2="18" />
                </svg>
              </button>
            </div>

            <nav className="min-h-0 flex-1 overflow-y-auto p-3">
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
                    {visible.map(renderItem)}
                  </div>
                );
              })}

              {adminItems.length > 0 && (
                <div className="mb-4">
                  <p className="mb-1 px-2 text-[11px] font-semibold uppercase tracking-wide text-subtle">
                    관리
                  </p>
                  {adminItems.map(renderItem)}
                </div>
              )}
            </nav>
          </div>
        </div>
      )}
    </>
  );
}
