// S-11 사용자 승인 관리: 프로필(users) + 이메일(auth.users) 병합 조회 — admin 전용.
//   이메일 평문은 users에 없고 Supabase Auth에만 있어 서버(service key)에서 합쳐 내려준다.
import { NextRequest, NextResponse } from "next/server";
import { getRequester, serviceClient } from "@/lib/server/auth";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
  const me = await getRequester(token);
  if (!me || me.role !== "admin") {
    return NextResponse.json({ error: "관리자 권한이 필요합니다." }, { status: 403 });
  }

  const svc = serviceClient();
  const { data: profiles, error } = await svc
    .from("users")
    .select("user_id,name,dept,role,status,created_at")
    .order("created_at", { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Auth 사용자 이메일 매핑(user_id → email). 페이지네이션 순회.
  const emailById = new Map<string, string>();
  for (let page = 1; page <= 20; page++) {
    const { data } = await svc.auth.admin.listUsers({ page, perPage: 200 });
    const users = data?.users ?? [];
    for (const u of users) if (u.email) emailById.set(u.id, u.email);
    if (users.length < 200) break;
  }

  const rows = (profiles ?? []).map((p) => ({
    ...p,
    email: emailById.get(p.user_id) ?? "—",
  }));
  return NextResponse.json({ rows });
}
