// FR-22: AI 분석 결과 HTML을 Supabase Storage(analysis-reports 버킷)에 저장 + analysis_reports 메타 upsert.
//   서버리스(Netlify/Vercel) 호환 — 로컬 디스크 미사용.
import { NextRequest, NextResponse } from "next/server";
import { getRequester, serviceClient } from "@/lib/server/auth";
import { uploadBlob } from "@/lib/storage/blob";
import { contentType } from "@/lib/storage/local";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
  const me = await getRequester(token);
  if (!me || me.role !== "admin") {
    return NextResponse.json({ error: "관리자 권한이 필요합니다." }, { status: 403 });
  }
  try {
    const form = await req.formData();
    const file = form.get("file") as File | null;
    const bidNo = String(form.get("bid_no") ?? "");
    const bidSeq = String(form.get("bid_seq") ?? "");
    const docType = String(form.get("doc_type") ?? "");
    const fileName = String(form.get("file_name") ?? "");
    const storagePath = String(form.get("storage_path") ?? ""); // analysis-reports/{bid}_{seq}/{date}_{slug}.html
    if (!file || !bidNo || !docType || !storagePath) {
      return NextResponse.json({ error: "필수 항목 누락" }, { status: 400 });
    }
    const buf = Buffer.from(await file.arrayBuffer());
    await uploadBlob(storagePath, buf, contentType(storagePath)); // Supabase Storage

    const svc = serviceClient();
    const { error } = await svc.from("analysis_reports").upsert(
      {
        bid_no: bidNo,
        bid_seq: bidSeq,
        doc_type: docType,
        file_name: fileName,
        storage_path: storagePath,
        size_bytes: buf.length,
        uploaded_by: me.userId,
        uploaded_at: new Date().toISOString(),
      },
      { onConflict: "bid_no,bid_seq,doc_type" }
    );
    if (error) return NextResponse.json({ error: `메타 저장 실패: ${error.message}` }, { status: 500 });
    return NextResponse.json({ storage_path: storagePath, saved: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
