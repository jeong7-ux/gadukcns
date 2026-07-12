"use client";

// S-03 승인 대기 (FR-01) — status=pending. rejected 안내 포함.
import Link from "next/link";
import { useSession } from "@/lib/auth/SessionProvider";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";

export default function PendingPage() {
  const { profile, status, signOut, refresh } = useSession();
  const rejected = status === "rejected";
  const suspended = status === "suspended";

  return (
    <Card className="p-6 text-center">
      <div className="mb-3 flex justify-center">
        {rejected || suspended ? (
          <Pill tone="danger">
            {rejected ? "가입 반려(rejected)" : "정지(suspended)"}
          </Pill>
        ) : (
          <Pill tone="accent">승인 대기(pending)</Pill>
        )}
      </div>

      <h2 className="text-base font-bold text-text">
        {rejected
          ? "가입이 반려되었습니다"
          : suspended
            ? "계정이 정지되었습니다"
            : "관리자 승인을 기다리고 있습니다"}
      </h2>

      <p className="mx-auto mt-2 max-w-xs text-xs leading-relaxed text-subtle">
        {rejected
          ? "관리자에게 문의해 사유를 확인하세요."
          : suspended
            ? "이용이 제한된 상태입니다. 관리자에게 문의하세요."
            : "가입 요청이 접수되었습니다. 관리자가 승인하면 서비스를 이용할 수 있습니다."}
      </p>

      {profile && (
        <div className="mx-auto mt-4 w-full max-w-xs rounded-md bg-bg p-3 text-left text-xs text-subtle">
          <div className="flex justify-between py-0.5">
            <span>이름</span>
            <span className="font-medium text-text">{profile.name}</span>
          </div>
          <div className="flex justify-between py-0.5">
            <span>부서</span>
            <span className="font-medium text-text">{profile.dept}</span>
          </div>
        </div>
      )}

      <div className="mt-5 flex flex-col gap-2">
        <Button variant="ghost" onClick={() => refresh()}>
          승인 상태 새로고침
        </Button>
        <button
          onClick={() => signOut()}
          className="text-xs text-subtle hover:underline"
        >
          로그아웃
        </button>
      </div>

      <div className="mt-3 text-xs text-subtle">
        <Link href="/login" className="text-accent hover:underline">
          다른 계정으로 로그인
        </Link>
      </div>
    </Card>
  );
}
