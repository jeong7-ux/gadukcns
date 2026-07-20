// FR-22: AI 분석 결과 HTML을 Supabase Storage(analysis-reports 버킷)에 저장 + analysis_reports 메타 upsert.
//   서버리스(Netlify/Vercel) 호환 — 로컬 디스크 미사용.
import { NextRequest, NextResponse } from "next/server";
import { getRequester, serviceClient } from "@/lib/server/auth";
import { uploadBlob } from "@/lib/storage/blob";
import { contentType } from "@/lib/storage/local";
import { parse1pSummary } from "@/lib/analysis/parse-1p";

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
    const { data: rep, error } = await svc
      .from("analysis_reports")
      .upsert(
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
      )
      .select("id")
      .maybeSingle();
    if (error) return NextResponse.json({ error: `메타 저장 실패: ${error.message}` }, { status: 500 });

    // 1페이지상세요약이면 KPI 파싱 → bid_analysis_kpi upsert.
    // 파싱/저장 실패가 업로드를 되돌리지 않도록 전 구간 fail-open(경고만 반환).
    let kpi: Record<string, unknown> | null = null;
    if (docType === "1페이지상세요약") {
      try {
        const parsed = parse1pSummary(buf.toString("utf8"));
        const { error: kErr } = await svc.from("bid_analysis_kpi").upsert(
          {
            bid_no: bidNo,
            bid_seq: bidSeq,
            report_id: rep?.id ?? null,
            source_doc_type: docType,
            ...parsed,
            parsed_at: new Date().toISOString(),
          },
          { onConflict: "bid_no,bid_seq" }
        );
        kpi = kErr
          ? {
              saved: false,
              // 42P01 = 테이블 미배포 환경 → 업로드는 정상, KPI만 생략
              skipped: kErr.code === "42P01",
              error: kErr.message,
            }
          : {
              saved: true,
              go_decision: parsed.go_decision,
              audit_budget_krw: parsed.audit_budget_krw,
              kpi_count: parsed.kpi_raw.length,
              warnings: parsed.parse_warnings,
            };
      } catch (e) {
        kpi = { saved: false, error: (e as Error).message };
      }
    }
    return NextResponse.json({ storage_path: storagePath, saved: true, kpi });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
