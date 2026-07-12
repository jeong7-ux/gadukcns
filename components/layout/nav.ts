import type { Role } from "@/lib/supabase/types";
import { ADMIN_ONLY, CAN_MEMBER, CAN_SEARCH } from "@/lib/auth/roles";

export interface NavItem {
  href: string;
  label: string;
  screen: string;
  /** null = active 전체 접근. 배열이면 해당 역할만. */
  allowed: Role[] | null;
}

/** 화면지도(SKILL) 그대로 — 라우트/역할 게이팅 단일 원천 */
export const NAV: { section: string; items: NavItem[] }[] = [
  {
    section: "입찰",
    items: [
      { href: "/dashboard/stats", label: "통계 대시보드", screen: "S-10", allowed: null },
      { href: "/dashboard", label: "입찰 목록", screen: "S-04", allowed: null },
      { href: "/search", label: "키워드그룹 검색", screen: "S-05", allowed: CAN_SEARCH },
      { href: "/watchlist", label: "관심 목록", screen: "S-07", allowed: CAN_SEARCH },
      { href: "/calendar", label: "캘린더", screen: "S-08", allowed: null },
    ],
  },
  {
    section: "관리",
    items: [
      { href: "/admin/clients", label: "고객사 관리", screen: "S-14", allowed: CAN_MEMBER },
      { href: "/admin/members", label: "인력 관리", screen: "S-09", allowed: CAN_MEMBER },
      { href: "/admin/users", label: "사용자 승인", screen: "S-11", allowed: ADMIN_ONLY },
      { href: "/admin/rules", label: "스코어링 규칙", screen: "S-12", allowed: ADMIN_ONLY },
      { href: "/admin/settings", label: "API 키 설정", screen: "S-13", allowed: ADMIN_ONLY },
    ],
  },
];
