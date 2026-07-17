export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-bg px-4">
      <div className="w-full max-w-[360px]">
        <div className="mb-6 text-center">
          <h1 className="text-lg font-bold text-primary">나라장터 입찰정보 관리시스템</h1>
          <p className="mt-1 text-xs text-subtle">(주)가덕씨엔에스</p>
        </div>
        {children}
      </div>
    </div>
  );
}
