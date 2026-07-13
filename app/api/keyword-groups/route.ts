// S-05 키워드그룹 삭제 — service key 서버 라우트.
//   시드 그룹(owner=null)은 keyword_groups_write RLS(owner=auth.uid())로 클라이언트 삭제가 막히므로
//   세션 검증 후 service key로 삭제한다. 권한: strategy/pm/admin(그룹 관리 권한).
import { NextRequest, NextResponse } from "next/server";
import { getRequester, serviceClient } from "@/lib/server/auth";

export const runtime = "nodejs";

const CAN_MANAGE = ["strategy", "pm", "admin"];

export async function DELETE(req: NextRequest) {
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
  const me = await getRequester(token);
  if (!me || !CAN_MANAGE.includes(me.role)) {
    return NextResponse.json({ error: "그룹 삭제 권한이 없습니다." }, { status: 403 });
  }

  const id = req.nextUrl.searchParams.get("id");
  const groupId = Number(id);
  if (!id || Number.isNaN(groupId)) {
    return NextResponse.json({ error: "유효한 group id가 필요합니다." }, { status: 400 });
  }

  const svc = serviceClient();
  const { error } = await svc.from("keyword_groups").delete().eq("group_id", groupId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, deleted: groupId });
}
