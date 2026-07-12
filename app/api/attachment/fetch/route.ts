// 입찰 첨부 저장: bid_attachments.file_url(나라장터) 다운로드 → Supabase Storage(attachments 버킷) → 메타 갱신.
//   서버리스(Netlify/Vercel) 호환 — 로컬 디스크 미사용. 배치(attachments.mjs)와 동일 버킷 사용.
import { NextRequest, NextResponse } from "next/server";
import { getRequester, serviceClient } from "@/lib/server/auth";
import { uploadBlob, asciiKey } from "@/lib/storage/blob";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
  const me = await getRequester(token);
  if (!me) return NextResponse.json({ error: "인증이 필요합니다." }, { status: 401 });

  try {
    const { id } = await req.json();
    if (!id) return NextResponse.json({ error: "id 필요" }, { status: 400 });

    const svc = serviceClient();
    const { data: att } = await svc
      .from("bid_attachments")
      .select("id,bid_no,bid_seq,seq,doc_type,file_name,file_url")
      .eq("id", id)
      .maybeSingle();
    if (!att) return NextResponse.json({ error: "첨부를 찾을 수 없습니다." }, { status: 404 });
    if (!att.file_url) return NextResponse.json({ error: "다운로드 URL이 없습니다." }, { status: 400 });

    // 나라장터 원본 다운로드
    const r = await fetch(att.file_url, { redirect: "follow" });
    if (!r.ok) return NextResponse.json({ error: `원본 다운로드 실패(${r.status})` }, { status: 502 });
    const buf = Buffer.from(await r.arrayBuffer());

    // Storage 키는 ASCII만(한글 표시명은 DB file_name 유지). 버킷 프리픽스 포함 storage_path.
    const name = asciiKey(att.file_name || `${att.seq}`);
    const rel = `attachments/${att.bid_no}/${att.bid_seq}/${att.seq}_${name}`;
    const ct = r.headers.get("content-type") || "application/octet-stream";
    await uploadBlob(rel, buf, ct);

    const { error } = await svc
      .from("bid_attachments")
      .update({ storage_path: rel, downloaded: true, fetched_at: new Date().toISOString() })
      .eq("id", id);
    if (error) return NextResponse.json({ error: `메타 갱신 실패: ${error.message}` }, { status: 500 });

    return NextResponse.json({ storage_path: rel, size: buf.length, saved: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
