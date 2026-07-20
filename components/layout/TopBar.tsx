"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
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

/** 상세는 어느 목록에서 들어왔는지 알 수 없으므로(S-04·S-07 공용) 직전 목록 화면을 기억해 둔다. */
const ORIGIN_KEY = "nav:lastList";
interface Origin {
  href: string;
  label: string;
  screen: string;
}

export function TopBar() {
  const { profile, role, signOut } = useSession();
  const pathname = usePathname();
  const router = useRouter();
  const loc = currentPage(pathname);
  const atHome = !loc || loc.href === HOME;
  const isDetail = pathname.startsWith("/bids/");
  const [origin, setOrigin] = useState<Origin | null>(null);

  // 목록 화면을 방문할 때마다 진입 경로로 기록 → 상세에서 그 목록으로 되돌아갈 수 있게 한다.
  // sessionStorage는 클라이언트 전용이라 effect에서만 접근(하이드레이션 불일치 방지).
  // 의존성은 반드시 원시값으로 — loc은 매 렌더 새 객체라 넣으면 무한 렌더가 된다.
  const locHref = loc?.href ?? null;
  const locLabel = loc?.label ?? null;
  const locScreen = loc?.screen ?? null;
  useEffect(() => {
    if (isDetail) {
      try {
        const raw = sessionStorage.getItem(ORIGIN_KEY);
        setOrigin(raw ? (JSON.parse(raw) as Origin) : null);
      } catch {
        setOrigin(null);
      }
      return;
    }
    if (!locHref || !locLabel || !locScreen || locHref === HOME) return;
    const o: Origin = { href: locHref, label: locLabel, screen: locScreen };
    sessionStorage.setItem(ORIGIN_KEY, JSON.stringify(o));
    setOrigin(o);
  }, [isDetail, locHref, locLabel, locScreen]);

  // 뒤로: 앱 내 이력이 있으면 브라우저 뒤로, 없으면(직접 진입·새 탭) 기억된 목록 → 홈 순으로 폴백.
  const goBack = () => {
    if (window.history.length > 1) router.back();
    else router.push(origin?.href ?? HOME);
  };

  return (
    <header className="flex h-14 items-center justify-between gap-3 border-b border-border bg-surface px-4">
      {/* 왼쪽: 모바일 드로어(햄버거) + S-10 홈 기준 네비게이션(브레드크럼) */}
      <div className="flex min-w-0 items-center gap-1.5 text-sm">
        <MobileNav />
        {!atHome && (
          <button
            onClick={goBack}
            title="이전 화면으로"
            aria-label="이전 화면으로"
            className="shrink-0 rounded-md px-1.5 py-1 text-subtle ring-1 ring-border hover:bg-bg hover:text-text"
          >
            ←
          </button>
        )}
        <Link href={HOME} className="flex shrink-0 items-center gap-1 font-bold text-primary hover:opacity-80">
          <span aria-hidden>🏠</span>
          <span className="hidden truncate sm:inline">나라장터 입찰공고 실시간 모니터링</span>
          <span className="sm:hidden">홈</span>
        </Link>
        {/* 상세는 진입한 목록(S-04·S-07 등)을 중간 크럼으로 노출해 되돌아갈 수 있게 한다. */}
        {isDetail && origin && (
          <>
            <span className="shrink-0 text-subtle">›</span>
            <Link
              href={origin.href}
              className="truncate font-semibold text-primary hover:underline"
            >
              {origin.label}
            </Link>
          </>
        )}
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
