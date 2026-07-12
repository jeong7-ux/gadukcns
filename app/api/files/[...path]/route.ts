// 로컬 파일 서빙 — 세션 검증 후 storage/ 파일 스트리밍. (window.open용 ?token= 사용)
import { NextRequest } from "next/server";
import { getRequester } from "@/lib/server/auth";
import { readLocal, contentType } from "@/lib/storage/local";

export const runtime = "nodejs";

export async function GET(
  req: NextRequest,
  { params }: { params: { path: string[] } }
) {
  const token = req.nextUrl.searchParams.get("token");
  const me = await getRequester(token);
  if (!me) return new Response("인증이 필요합니다.", { status: 401 });

  const rel = params.path.map((s) => decodeURIComponent(s)).join("/");
  try {
    const buf = await readLocal(rel);
    const dl = req.nextUrl.searchParams.get("download") === "1";
    const name = rel.split("/").pop() ?? "file";
    return new Response(new Uint8Array(buf), {
      headers: {
        "Content-Type": contentType(rel),
        "Content-Disposition": `${dl ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(name)}`,
        // HTML 산출물의 XSS 완화(내부 관리자 업로드지만 방어적)
        "Content-Security-Policy": "sandbox allow-downloads;",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return new Response("파일을 찾을 수 없습니다.", { status: 404 });
  }
}
