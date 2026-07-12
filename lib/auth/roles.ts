import type { Role } from "@/lib/supabase/types";

/**
 * 화면지도(SKILL) 접근 규칙을 코드로 중앙화.
 * RLS(§5)가 최종 방어선이지만, 역할에 없는 메뉴/버튼은 UI에서 숨긴다.
 */
export const ROLE_LABEL: Record<Role, string> = {
  exec: "경영진",
  strategy: "전략기획",
  pm: "사업관리",
  admin: "관리자",
};

/** 관심목록 write / 키워드검색 = strategy/pm/admin (§5) */
export const CAN_WATCH_WRITE: Role[] = ["strategy", "pm", "admin"];
export const CAN_SEARCH: Role[] = ["strategy", "pm", "admin"];
/** member_table read = pm/admin (§5) */
export const CAN_MEMBER: Role[] = ["pm", "admin"];
/** admin 전용 화면(승인/룰/설정) */
export const ADMIN_ONLY: Role[] = ["admin"];

export function has(role: Role | null, allowed: Role[]): boolean {
  return role !== null && allowed.includes(role);
}
