// S-11 사용자 승인 관리 — admin 전용. 프로필(users)+이메일(auth) 병합 조회 · 상태변경 · 계정삭제.
//   상태변경/삭제는 서버(service key)로 처리해 RLS와 무관하게 확실히 동작한다.
import { NextRequest, NextResponse } from "next/server";
import { getRequester, serviceClient } from "@/lib/server/auth";

export const runtime = "nodejs";

async function requireAdmin(req: NextRequest) {
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
  const me = await getRequester(token);
  if (!me || me.role !== "admin") return null;
  return me;
}

export async function GET(req: NextRequest) {
  const me = await requireAdmin(req);
  if (!me) return NextResponse.json({ error: "관리자 권한이 필요합니다." }, { status: 403 });

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

  const rows = (profiles ?? []).map((p) => ({ ...p, email: emailById.get(p.user_id) ?? "—" }));
  return NextResponse.json({ rows });
}

// 상태 변경(승인/반려/정지/대기) · 역할 변경(경영진/전략기획/사업관리/관리자)
const VALID_STATUS = ["active", "rejected", "suspended", "pending"];
const VALID_ROLE = ["exec", "strategy", "pm", "admin"];
export async function PATCH(req: NextRequest) {
  const me = await requireAdmin(req);
  if (!me) return NextResponse.json({ error: "관리자 권한이 필요합니다." }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const userId: string | undefined = body?.user_id;
  if (!userId) return NextResponse.json({ error: "user_id가 필요합니다." }, { status: 400 });

  const patch: { status?: string; role?: string } = {};
  if (body?.status !== undefined) {
    if (!VALID_STATUS.includes(body.status)) return NextResponse.json({ error: "유효한 status가 아닙니다." }, { status: 400 });
    if (userId === me.userId && body.status !== "active") {
      return NextResponse.json({ error: "본인 계정 상태는 변경할 수 없습니다." }, { status: 400 });
    }
    patch.status = body.status;
  }
  if (body?.role !== undefined) {
    if (!VALID_ROLE.includes(body.role)) return NextResponse.json({ error: "유효한 role이 아닙니다." }, { status: 400 });
    if (userId === me.userId) {
      return NextResponse.json({ error: "본인 역할은 변경할 수 없습니다(자기 권한 잠금 방지)." }, { status: 400 });
    }
    patch.role = body.role;
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "변경할 값(status/role)이 없습니다." }, { status: 400 });
  }

  const svc = serviceClient();
  const { error } = await svc.from("users").update(patch).eq("user_id", userId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

// 계정 삭제(프로필 + Auth 계정). 되돌릴 수 없음.
export async function DELETE(req: NextRequest) {
  const me = await requireAdmin(req);
  if (!me) return NextResponse.json({ error: "관리자 권한이 필요합니다." }, { status: 403 });

  const userId = req.nextUrl.searchParams.get("user_id");
  if (!userId) return NextResponse.json({ error: "user_id가 필요합니다." }, { status: 400 });
  if (userId === me.userId) {
    return NextResponse.json({ error: "본인 계정은 삭제할 수 없습니다." }, { status: 400 });
  }

  const svc = serviceClient();
  // 참조(관심목록·키워드그룹 owner) 정리 후 프로필 삭제 → Auth 계정 삭제
  await svc.from("watchlist").update({ owner: null }).eq("owner", userId);
  await svc.from("keyword_groups").update({ owner: null }).eq("owner", userId);
  const { error: pErr } = await svc.from("users").delete().eq("user_id", userId);
  if (pErr) return NextResponse.json({ error: `프로필 삭제 실패: ${pErr.message}` }, { status: 500 });
  const { error: aErr } = await svc.auth.admin.deleteUser(userId);
  if (aErr) return NextResponse.json({ error: `Auth 계정 삭제 실패: ${aErr.message}` }, { status: 500 });
  return NextResponse.json({ ok: true });
}
