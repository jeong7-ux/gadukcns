"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession } from "@/lib/auth/SessionProvider";
import { NAV, ADMIN_MENU } from "@/components/layout/nav";
import { MobileNav } from "@/components/layout/MobileNav";
import { Pill } from "@/components/ui/Pill";
import { ThemeToggle } from "@/components/ui/ThemeToggle";

// 홈(랜딩) = S-10 나라장터 입찰공고 실시간 모니터링
const HOME = "/dashboard/stats";

// 현재 경로 → 페이지 정보(라벨·화면코드). NAV(입찰)+ADMIN_MENU(관리)+상세 폴백.
function currentPage(pathname: string) {
  const all = [...NAV.flatMap((s) => s.items), ...ADMIN_MENU];
  const hit = [...all]
    .sort((a, b) => b.href.length - a.href.length) // 최장 접두 우선
    .find((i) => pathname === i.href || pathname.startsWith(i.href + "/"));
  if (hit) return { href: hit.href, label: hit.label, screen: hit.screen };
  if (pathname.startsWith("/bids/")) return { href: "/bids", label: "입찰 상세", screen: "S-06" };
  return null;
}

export function TopBar() {
  const { profile, role, signOut } = useSession();
  const pathname = usePathname();
  const loc = currentPage(pathname);
  const atHome = !loc || loc.href === HOME;

  return (
    <header className="flex h-14 items-center justify-between gap-3 border-b border-border bg-surface px-4">
      {/* 왼쪽: 모바일 드로어(햄버거) + S-10 홈 기준 네비게이션(브레드크럼) */}
      <div className="flex min-w-0 items-center gap-1.5 text-sm">
        <MobileNav />
        <Link href={HOME} className="flex shrink-0 items-center gap-1 font-bold text-primary hover:opacity-80">
          <span aria-hidden>🏠</span>
          <span className="hidden truncate sm:inline">나라장터 입찰공고 실시간 모니터링</span>
          <span className="sm:hidden">홈</span>
        </Link>
        {!atHome && loc && (
          <>
            <span className="shrink-0 text-subtle">›</span>
            <span className="truncate font-semibold text-text">{loc.label}</span>
            <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
              {loc.screen}
            </span>
          </>
        )}
      </div>

      {/* 오른쪽: 역할 · 테마 · 로그아웃 */}
      <div className="flex shrink-0 items-center gap-3">
        {profile && <Pill tone="primary">{role === "admin" ? "관리자" : "사용자"}</Pill>}
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
