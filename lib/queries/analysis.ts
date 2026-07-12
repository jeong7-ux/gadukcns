import type { SupabaseClient } from "@supabase/supabase-js";
import type { AnalysisReport, AnalysisDocType } from "@/lib/supabase/types";

/** FR-21: 분석 요청 */
export async function requestAnalysis(
  supabase: SupabaseClient,
  bidNo: string,
  bidSeq: string
) {
  const { data: u } = await supabase.auth.getUser();
  const { error } = await supabase
    .from("watchlist")
    .update({
      analysis_status: "requested",
      analysis_requested_at: new Date().toISOString(),
      analysis_requested_by: u?.user?.id ?? null,
    })
    .eq("bid_no", bidNo)
    .eq("bid_seq", bidSeq);
  if (error) throw error;
}

/** FR-24: 공고별 분석 결과파일 목록 */
export async function fetchAnalysisReports(
  supabase: SupabaseClient,
  bidNo: string,
  bidSeq: string
): Promise<AnalysisReport[]> {
  const { data, error } = await supabase
    .from("analysis_reports")
    .select("*")
    .eq("bid_no", bidNo)
    .eq("bid_seq", bidSeq);
  if (error) throw error;
  return (data as AnalysisReport[]) ?? [];
}

const yyyymmdd = () => new Date().toISOString().slice(0, 10).replace(/-/g, "");
const safe = (s: string) => s.replace(/[\/\\?%*:|"<>]/g, "").replace(/\s+/g, "").slice(0, 40);

// Storage 객체 키는 ASCII만 허용(한글 불가) → doc_type을 ASCII 슬러그로.
const DOC_SLUG: Record<AnalysisDocType, string> = {
  분석보고서: "analysis_report",
  "1페이지상세요약": "summary_1p",
  "1페이지인포그래픽": "infographic_1p",
  PT요약보고서: "pt_summary",
  영역별감리계획: "audit_plan",
  논리구조서: "logic_structure",
  통합감리제안서초안: "proposal_draft",
};

/** FR-22 (로컬 저장): 파일은 서버 API가 storage/analysis-reports 에 저장, 메타는 analysis_reports */
export async function uploadAnalysisFile(
  supabase: SupabaseClient,
  opts: { bidNo: string; bidSeq: string; title: string | null; docType: AnalysisDocType; file: File }
) {
  const { bidNo, bidSeq, title, docType, file } = opts;
  const fileName = `${yyyymmdd()}_${safe(title ?? bidNo)}_${docType}.html`; // 표시용(한글 유지)
  const storagePath = `analysis-reports/${bidNo}_${bidSeq}/${yyyymmdd()}_${DOC_SLUG[docType]}.html`; // 로컬 경로(ASCII)
  const { data: { session } } = await supabase.auth.getSession();
  const fd = new FormData();
  fd.append("file", file);
  fd.append("bid_no", bidNo);
  fd.append("bid_seq", bidSeq);
  fd.append("doc_type", docType);
  fd.append("file_name", fileName);
  fd.append("storage_path", storagePath);
  const res = await fetch("/api/analysis/upload", {
    method: "POST",
    headers: { Authorization: `Bearer ${session?.access_token ?? ""}` },
    body: fd,
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error(j?.error ?? "업로드 실패");
  }
}

/** FR-23: 분석완료 확정 */
export async function markAnalysisDone(
  supabase: SupabaseClient,
  bidNo: string,
  bidSeq: string
) {
  const { error } = await supabase
    .from("watchlist")
    .update({ analysis_status: "done", analysis_done_at: new Date().toISOString() })
    .eq("bid_no", bidNo)
    .eq("bid_seq", bidSeq);
  if (error) throw error;
}

/** FR-24: 로컬 파일 서빙 URL(세션 토큰 포함). window.open 용. */
export async function signedUrl(
  supabase: SupabaseClient,
  storagePath: string,
  download = false
): Promise<string | null> {
  const { data: { session } } = await supabase.auth.getSession();
  const enc = storagePath.split("/").map(encodeURIComponent).join("/");
  return `/api/files/${enc}?token=${encodeURIComponent(session?.access_token ?? "")}${download ? "&download=1" : ""}`;
}
