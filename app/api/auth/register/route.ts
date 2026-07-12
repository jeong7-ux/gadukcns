// FR-01 가입요청: 이메일 인증(OTP) 없이 서버에서 계정 생성 → users.status='pending'.
//   · admin.createUser(email_confirm:true) → 이메일 확인 절차 생략(관리자 승인만으로 이용).
//   · public.users insert(status='pending') → 관리자 승인(S-11)에서 active 전환 시 즉시 로그인 가능.
import { NextRequest, NextResponse } from "next/server";
import { createHmac } from "crypto";
import { serviceClient } from "@/lib/server/auth";

export const runtime = "nodejs";

const DEPTS = ["경영진", "전략기획", "사업관리", "경영지원"] as const;
// 부서 → 권한 역할 매핑(자가 가입은 admin 미부여: 관리자 계정은 별도 발급).
const DEPT_ROLE: Record<(typeof DEPTS)[number], string> = {
  경영진: "exec",
  전략기획: "strategy",
  사업관리: "pm",
  경영지원: "pm",
};

const emailHash = (email: string) =>
  createHmac("sha256", process.env.HMAC_KEY!).update(email.trim().toLowerCase()).digest("hex");

export async function POST(req: NextRequest) {
  let body: { name?: string; email?: string; password?: string; dept?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "잘못된 요청입니다." }, { status: 400 });
  }

  const name = (body.name ?? "").trim();
  const email = (body.email ?? "").trim().toLowerCase();
  const password = body.password ?? "";
  const dept = body.dept ?? "";

  // 검증
  if (!name) return NextResponse.json({ error: "이름을 입력하세요." }, { status: 400 });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return NextResponse.json({ error: "이메일 형식이 올바르지 않습니다." }, { status: 400 });
  if (password.length < 8)
    return NextResponse.json({ error: "비밀번호는 8자 이상이어야 합니다." }, { status: 400 });
  if (!DEPTS.includes(dept as (typeof DEPTS)[number]))
    return NextResponse.json({ error: "부서를 선택하세요." }, { status: 400 });

  const svc = serviceClient();

  // 1) Auth 계정 생성 (이메일 확인 완료 처리 → 별도 인증메일 불필요)
  const { data: created, error: cErr } = await svc.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { name, dept },
  });
  if (cErr || !created?.user) {
    const dup = /already|registered|exist/i.test(cErr?.message ?? "");
    return NextResponse.json(
      { error: dup ? "이미 가입된 이메일입니다." : "가입 요청에 실패했습니다." },
      { status: dup ? 409 : 500 }
    );
  }

  // 2) 프로필 생성 (승인대기). 실패 시 Auth 계정 롤백(고아 계정 방지).
  const { error: uErr } = await svc.from("users").insert({
    user_id: created.user.id,
    email_hash: emailHash(email),
    name,
    dept,
    role: DEPT_ROLE[dept as (typeof DEPTS)[number]],
    status: "pending",
  });
  if (uErr) {
    await svc.auth.admin.deleteUser(created.user.id).catch(() => {});
    const dup = /duplicate|unique/i.test(uErr.message);
    return NextResponse.json(
      { error: dup ? "이미 가입된 이메일입니다." : "프로필 생성에 실패했습니다." },
      { status: dup ? 409 : 500 }
    );
  }

  return NextResponse.json({ ok: true });
}
