"use client";

// S-01 로그인 (FR-01) — public
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { getSupabaseClient } from "@/lib/supabase/client";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";

export default function LoginPage() {
  const router = useRouter();
  const supabase = getSupabaseClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    setLoading(false);
    if (error) {
      // pending/suspended 등은 로그인 후 프로필 status로 판정 → 라우팅에서 안내
      setError("로그인에 실패했습니다. 이메일/비밀번호를 확인하세요.");
      return;
    }
    // 프로필 status에 따라 셸 레이아웃이 pending 화면으로 라우팅한다.
    if (data.session) router.replace("/dashboard/stats");
  }

  return (
    <Card className="p-6">
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <div>
          <label className="mb-1 block text-xs font-medium text-subtle">
            이메일(아이디)
          </label>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="name@company.com"
            className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-accent focus:ring-1 focus:ring-accent"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-subtle">
            비밀번호
          </label>
          <input
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-accent focus:ring-1 focus:ring-accent"
          />
        </div>

        {error && <p className="text-xs text-danger">{error}</p>}

        <Button type="submit" disabled={loading}>
          {loading ? "로그인 중…" : "로그인"}
        </Button>

        <div className="flex items-center justify-between text-xs text-subtle">
          <Link href="/register" className="text-accent hover:underline">
            회원가입
          </Link>
          <span>관리자 승인 후 이용 가능합니다</span>
        </div>
      </form>
    </Card>
  );
}
