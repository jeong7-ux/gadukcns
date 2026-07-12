"use client";

// S-02 회원가입(가입요청) (FR-01) — public.
//   이메일 인증(OTP) 없이 단순 가입요청 → 관리자 승인(S-11) 시 즉시 로그인 가능.
import { useState } from "react";
import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";

const DEPTS = ["경영진", "전략기획", "사업관리", "경영지원"] as const;

export default function RegisterPage() {
  const [form, setForm] = useState({
    name: "",
    email: "",
    password: "",
    password2: "",
    dept: "" as (typeof DEPTS)[number] | "",
  });
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (form.password.length < 8) {
      setError("비밀번호는 8자 이상이어야 합니다.");
      return;
    }
    if (form.password !== form.password2) {
      setError("비밀번호가 일치하지 않습니다.");
      return;
    }
    setLoading(true);
    const res = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: form.name,
        email: form.email,
        password: form.password,
        dept: form.dept,
      }),
    });
    setLoading(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError(j?.error ?? "가입 요청에 실패했습니다.");
      return;
    }
    setDone(true);
  }

  if (done) {
    return (
      <Card className="p-6 text-center">
        <h2 className="text-base font-bold text-text">가입 요청이 접수되었습니다</h2>
        <p className="mx-auto mt-2 max-w-xs text-xs leading-relaxed text-subtle">
          관리자 승인 후 로그인하여 서비스를 이용할 수 있습니다.
          <br />
          승인 결과는 별도 안내됩니다.
        </p>
        <div className="mt-5">
          <Link href="/login" className="text-sm text-accent hover:underline">
            로그인 화면으로 이동
          </Link>
        </div>
      </Card>
    );
  }

  return (
    <Card className="p-6">
      <div className="mb-4">
        <h2 className="text-base font-bold text-text">회원가입</h2>
        <p className="mt-1 text-xs text-subtle">
          가입 요청 후 관리자 승인이 완료되면 이용할 수 있습니다.
        </p>
      </div>

      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <Field label="이름">
          <input
            required
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            className={inputCls}
          />
        </Field>
        <Field label="이메일(아이디)">
          <input
            type="email"
            required
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            placeholder="name@company.com"
            className={inputCls}
          />
        </Field>
        <Field label="비밀번호 (8자 이상)">
          <input
            type="password"
            required
            minLength={8}
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            className={inputCls}
          />
        </Field>
        <Field label="비밀번호 확인">
          <input
            type="password"
            required
            minLength={8}
            value={form.password2}
            onChange={(e) => setForm({ ...form, password2: e.target.value })}
            className={inputCls}
          />
          {form.password2.length > 0 && form.password !== form.password2 && (
            <p className="mt-1 text-xs text-danger">비밀번호가 일치하지 않습니다.</p>
          )}
        </Field>
        <Field label="부서">
          <select
            required
            value={form.dept}
            onChange={(e) =>
              setForm({ ...form, dept: e.target.value as typeof form.dept })
            }
            className={inputCls}
          >
            <option value="">선택</option>
            {DEPTS.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </Field>
        {error && <p className="text-xs text-danger">{error}</p>}
        <Button type="submit" disabled={loading}>
          {loading ? "요청 중…" : "가입 요청"}
        </Button>
      </form>

      <div className="mt-4 text-center text-xs text-subtle">
        <Link href="/login" className="text-accent hover:underline">
          로그인으로 돌아가기
        </Link>
      </div>
    </Card>
  );
}

const inputCls =
  "w-full rounded-md border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-accent focus:ring-1 focus:ring-accent";

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-subtle">{label}</label>
      {children}
    </div>
  );
}
