import { redirect } from "next/navigation";

// 루트 → 통계 대시보드(랜딩). 미인증 시 (app) 셸이 /login 으로 재라우팅한다.
export default function RootPage() {
  redirect("/dashboard/stats");
}
