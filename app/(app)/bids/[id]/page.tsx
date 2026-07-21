"use client";

// S-06 입찰 상세 + AI 브리핑 — FR-03/04/06/10. active 전체.
import { useState } from "react";
import { useParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getSupabaseClient } from "@/lib/supabase/client";
import type {
  Bid,
  BidPrice,
  BidChange,
  BidAttachment,
  BidAnalysisKpi,
  MatchedMember,
} from "@/lib/supabase/types";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardHeader } from "@/components/ui/Card";
import { StatusPill } from "@/components/ui/StatusPill";
import { DdayPill } from "@/components/ui/DdayPill";
import { Pill } from "@/components/ui/Pill";
import { Markdown } from "@/components/ui/Markdown";
import { EmptyState } from "@/components/ui/EmptyState";
import { WatchToggle } from "@/components/bids/WatchToggle";
import { deriveStatus } from "@/lib/design/dday";
import { fmtDate, fmtDateTime, fmtWon } from "@/lib/utils/format";
import {
  GO_LABEL,
  GO_TONE,
  fmtRange,
  hasLabel,
  kpiUnit,
  severityText,
} from "@/lib/analysis/kpi-format";

const BID_COLS =
  "bid_no,bid_seq,title,order_org,demand_org,contract_method,notice_dt,deadline_dt,open_dt,est_price,status,score,tags,ai_summary,ai_score,ai_flags,raw,updated_at";

export default function BidDetailPage() {
  const params = useParams<{ id: string }>();
  const bidNo = decodeURIComponent(params.id);
  const supabase = getSupabaseClient();
  const qc = useQueryClient();
  const [tab, setTab] = useState<"price" | "changes">("price");

  // 첨부는 로컬 저장 없이 나라장터(g2b) 원본 URL로 바로 다운로드한다.
  const [gen, setGen] = useState<{ loading: boolean; error: string | null }>({
    loading: false,
    error: null,
  });

  // FR-06 온디맨드: 요약이 없을 때 실시간 생성(서버 API) → 저장 → 재조회
  async function generateSummary() {
    setGen({ loading: true, error: null });
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const res = await fetch("/api/ai-summary", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session?.access_token ?? ""}`,
        },
        body: JSON.stringify({ bid_no: bidNo }),
      });
      const j = await res.json();
      if (!res.ok) {
        setGen({ loading: false, error: j?.error ?? "요약 생성에 실패했습니다." });
        return;
      }
      setGen({ loading: false, error: null });
      qc.invalidateQueries({ queryKey: ["bid", bidNo] }); // 저장된 요약으로 갱신
    } catch (e) {
      setGen({ loading: false, error: (e as Error).message });
    }
  }

  const bidQ = useQuery({
    queryKey: ["bid", bidNo],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("bids")
        .select(BID_COLS)
        .eq("bid_no", bidNo)
        // 정정·변경공고는 같은 공고번호의 새 차수로 발급된다 → 최신 차수가 유효 내용
        // (목록도 keepLatestSeq로 최신 차수만 노출하므로 기준 일치. 첨부 쿼리도 desc)
        .order("bid_seq", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data as Bid | null;
    },
  });

  // 가격/변경이력 — 계약 §5상 RLS 미적용(백엔드) 테이블. anon 노출 안 될 수 있어
  // 실패 시 조용히 빈 값 처리(플레이스홀더).
  const priceQ = useQuery({
    queryKey: ["bid_price", bidNo],
    queryFn: async () => {
      const { data } = await supabase
        .from("bid_prices")
        .select("*")
        .eq("bid_no", bidNo)
        .maybeSingle();
      return (data as BidPrice) ?? null;
    },
  });
  const changesQ = useQuery({
    queryKey: ["bid_changes", bidNo],
    queryFn: async () => {
      const { data } = await supabase
        .from("bid_changes")
        .select("*")
        .eq("bid_no", bidNo)
        .order("changed_dt", { ascending: false });
      return (data as BidChange[]) ?? [];
    },
  });
  // 첨부파일 (A.5) — bid_attachments. file_url 로 다운로드, extracted_text 있으면 추출됨 표시.
  const attachmentsQ = useQuery({
    queryKey: ["bid_attachments", bidNo],
    queryFn: async () => {
      const { data } = await supabase
        .from("bid_attachments")
        .select("*")
        .eq("bid_no", bidNo)
        .order("bid_seq", { ascending: false }) // 최신 차수 우선
        .order("seq", { ascending: true });
      return (data as BidAttachment[]) ?? [];
    },
  });
  // 분석 KPI — 1페이지상세요약 업로드 시 자동 파싱된 지표. 없으면 카드 자체를 숨긴다.
  const kpiQ = useQuery({
    queryKey: ["bid_analysis_kpi", bidNo],
    queryFn: async () => {
      const { data } = await supabase
        .from("bid_analysis_kpi")
        .select("*")
        .eq("bid_no", bidNo)
        .maybeSingle();
      return (data as BidAnalysisKpi | null) ?? null;
    },
  });

  if (bidQ.isLoading) return <p className="text-sm text-subtle">불러오는 중…</p>;
  if (bidQ.isError || !bidQ.data)
    return (
      <EmptyState
        title="공고를 찾을 수 없습니다"
        hint="삭제되었거나 접근 권한이 없습니다."
      />
    );

  const bid = bidQ.data;
  // ai_flags.matches = 추천 인력(FR-10, 03_ai_scripts.md §3.4). 없으면 플레이스홀더.
  const matched: MatchedMember[] = bid.ai_flags?.matches ?? [];

  // 나라장터 공고상세 원본 링크 (raw.bidNtceDtlUrl / bidNtceUrl)
  const raw = (bid.raw ?? {}) as Record<string, unknown>;
  const naraUrl = (raw.bidNtceDtlUrl || raw.bidNtceUrl) as string | undefined;

  // 첨부: 차수(bid_seq)별 그룹 (attachmentsQ가 bid_seq desc 정렬 → 최신 차수 우선)
  const attGroups: { seq: string; items: BidAttachment[] }[] = [];
  const attIdx = new Map<string, number>();
  for (const a of attachmentsQ.data ?? []) {
    if (!attIdx.has(a.bid_seq)) {
      attIdx.set(a.bid_seq, attGroups.length);
      attGroups.push({ seq: a.bid_seq, items: [] });
    }
    attGroups[attIdx.get(a.bid_seq)!].items.push(a);
  }
  const attTotal = attachmentsQ.data?.length ?? 0;
  const attMultiSeq = attGroups.length > 1;
  const kpi = kpiQ.data ?? null;

  return (
    <div>
      <PageHeader
        title={bid.title ?? "(제목 없음)"}
        screen="S-06"
        action={<WatchToggle bidNo={bid.bid_no} bidSeq={bid.bid_seq} bid={bid} />}
      />

      {/* 메타 + D-day/상태 */}
      <Card className="mb-4 p-4">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {/* 상태 pill: deadline_dt에서 실시간 파생(우선), 서버 status는 폴백 */}
          <StatusPill status={deriveStatus(bid.deadline_dt) ?? bid.status} />
          <DdayPill deadline={bid.deadline_dt} />
          <Pill tone="primary">점수 {bid.score}</Pill>
          {bid.ai_score !== null && <Pill tone="accent">AI {bid.ai_score}</Pill>}
        </div>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm md:grid-cols-3">
          <Meta label="공고번호" value={`${bid.bid_no}-${bid.bid_seq}`} />
          <Meta label="발주기관" value={bid.order_org ?? "-"} />
          <Meta label="수요기관" value={bid.demand_org ?? "-"} />
          <Meta label="계약방법" value={bid.contract_method ?? "-"} />
          <Meta label="공고일시" value={fmtDateTime(bid.notice_dt)} />
          <Meta label="마감일시" value={fmtDateTime(bid.deadline_dt)} />
          <Meta label="개찰일시" value={fmtDateTime(bid.open_dt)} />
          <Meta label="추정가격" value={fmtWon(bid.est_price)} />
        </dl>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_360px]">
        <div className="space-y-4">
          {/* 분석 KPI — 1페이지상세요약 파싱 결과(있을 때만).
              다른 보드와 구분되도록 강조 틴트(bg-priority, BidCard와 동일 관용구) 적용. */}
          {kpi && (
            <div className="rounded-card border border-accent bg-priority shadow-card">
              {/* 투명도 수정자(accent/40)는 토큰이 var() 색이라 적용되지 않으므로 실색상 사용 */}
              <CardHeader
                title={
                  <span className="flex flex-wrap items-center gap-2">
                    분석 KPI
                    {kpi.go_decision && (
                      <Pill tone={GO_TONE[kpi.go_decision]}>
                        {GO_LABEL[kpi.go_decision]}
                      </Pill>
                    )}
                    {kpi.go_reason && (
                      <span className="text-xs font-normal text-subtle">
                        {kpi.go_reason}
                      </span>
                    )}
                  </span>
                }
              />
              <div className="p-4">
                {/* 고정 타일은 원문에 그 라벨이 있을 때만 — 파일마다 라벨이 달라(사업금액·배점구조 등)
                    없는 항목을 "-"로 비워두지 않고 숨긴다. 실제 값은 아래 가변 슬롯에 표시된다. */}
                <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
                  {hasLabel(kpi, "감리예산") && (
                    <KpiTile
                      label="감리예산"
                      value={fmtWon(kpi.audit_budget_krw)}
                      sub={kpiUnit(kpi, "감리예산")}
                    />
                  )}
                  {hasLabel(kpi, "감리비율") && (
                    <KpiTile
                      label="감리비율"
                      value={fmtRange(kpi.audit_ratio_pct_min, kpi.audit_ratio_pct_max, "%") ?? "-"}
                      sub={kpiUnit(kpi, "감리비율")}
                    />
                  )}
                  {hasLabel(kpi, "투입공수") && (
                    <KpiTile
                      label="투입공수"
                      value={fmtRange(kpi.effort_md_min, kpi.effort_md_max, " MD") ?? "-"}
                      sub={kpiUnit(kpi, "투입공수")}
                    />
                  )}
                  {hasLabel(kpi, "대상사업") && (
                    <KpiTile
                      label="대상사업"
                      value={fmtWon(kpi.target_budget_krw)}
                      sub={kpiUnit(kpi, "대상사업")}
                    />
                  )}
                  {hasLabel(kpi, "독소조항") && (
                    <KpiTile
                      label="독소조항"
                      value={kpi.toxic_total !== null ? `${kpi.toxic_total}건` : "-"}
                      sub={severityText(kpi) ?? kpiUnit(kpi, "독소조항")}
                      tone={kpi.toxic_total && kpi.toxic_total > 0 ? "danger" : undefined}
                    />
                  )}
                  {/* 라벨이 가변인 슬롯(요구사항·MD단가 등)은 원문 그대로 노출 */}
                  {(kpi.extra_kpis ?? []).map((e) => (
                    <KpiTile
                      key={e.label}
                      label={e.label}
                      value={e.value ?? "-"}
                      sub={e.unit}
                    />
                  ))}
                </div>
                {(kpi.parse_warnings?.length ?? 0) > 0 && (
                  <ul className="mt-3 space-y-1 rounded-md bg-surface p-2.5 ring-1 ring-border">
                    {kpi.parse_warnings!.map((w, i) => (
                      <li key={i} className="text-xs text-subtle">
                        ⚠ {w}
                      </li>
                    ))}
                  </ul>
                )}
                <p className="mt-3 text-[11px] text-subtle">
                  출처: {kpi.source_doc_type}
                  {kpi.parsed_at && ` · 파싱 ${fmtDateTime(kpi.parsed_at)}`}
                  {kpi.parser_version && ` · ${kpi.parser_version}`}
                </p>
              </div>
            </div>
          )}

          {/* AI 브리핑 카드 */}
          <Card>
            <CardHeader
              title={
                <span className="flex items-center gap-2">
                  AI 브리핑
                  <Pill tone="accent">AI 요약</Pill>
                </span>
              }
            />
            <div className="p-4">
              {bid.ai_summary ? (
                <Markdown text={bid.ai_summary} />
              ) : (
                <div className="flex flex-col items-start gap-2">
                  <p className="text-sm text-subtle">
                    AI 요약이 아직 생성되지 않았습니다. 아래 버튼으로 지금 생성할 수
                    있습니다(생성 후 자동 저장).
                  </p>
                  <button
                    onClick={generateSummary}
                    disabled={gen.loading}
                    className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
                  >
                    {gen.loading ? "AI 요약 생성 중…" : "⚡ AI 요약 생성 (실시간)"}
                  </button>
                  {gen.error && (
                    <span className="text-xs text-danger">{gen.error}</span>
                  )}
                </div>
              )}
              {(bid.tags ?? []).length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {bid.tags!.map((t) => (
                    <span
                      key={t}
                      className="rounded bg-accent/10 px-2 py-0.5 text-xs text-accent"
                    >
                      #{t}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </Card>

          {/* 가격 / 변경이력 탭 */}
          <Card>
            <div className="flex border-b border-border">
              {(
                [
                  ["price", "가격 정보 (FR-03)"],
                  ["changes", "변경 이력 (FR-04)"],
                ] as const
              ).map(([k, label]) => (
                <button
                  key={k}
                  onClick={() => setTab(k)}
                  className={`px-4 py-2.5 text-sm font-medium ${
                    tab === k
                      ? "border-b-2 border-primary text-primary"
                      : "text-subtle hover:text-text"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="p-4">
              {tab === "price" ? (
                priceQ.data ? (
                  <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
                    <Meta label="기초금액" value={fmtWon(priceQ.data.base_amount)} />
                    <Meta label="추정가격" value={fmtWon(priceQ.data.est_price)} />
                    <Meta
                      label="평가기준금액"
                      value={fmtWon(priceQ.data.eval_base_amount)}
                    />
                    <Meta
                      label="예비가격 범위"
                      value={priceQ.data.preprice_range ?? "-"}
                    />
                    <Meta
                      label="공개일시"
                      value={fmtDateTime(priceQ.data.public_dt)}
                    />
                  </dl>
                ) : (
                  <p className="text-sm text-subtle">가격 정보가 없습니다.</p>
                )
              ) : (changesQ.data?.length ?? 0) > 0 ? (
                <ul className="divide-y divide-border">
                  {changesQ.data!.map((c) => (
                    <li key={c.id} className="flex items-start gap-3 py-2 text-sm">
                      <span className="w-28 shrink-0 text-xs text-subtle">
                        {fmtDate(c.changed_dt)}
                      </span>
                      <span className="font-medium text-text">
                        {c.change_item}
                      </span>
                      <span className="text-subtle">
                        {c.before_val} → {c.after_val}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-subtle">변경 이력이 없습니다.</p>
              )}
            </div>
          </Card>

          {/* 첨부파일 (A.5) — 차수별 그룹, 최신 차수 우선 */}
          <Card>
            <CardHeader
              title={
                <span className="flex items-center gap-2">
                  첨부파일
                  {attTotal > 0 && <Pill tone="muted">{attTotal}</Pill>}
                  {attMultiSeq && (
                    <span className="text-xs font-normal text-subtle">
                      · {attGroups.length}개 차수
                    </span>
                  )}
                </span>
              }
              action={
                naraUrl && (
                  <a
                    href={naraUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="나라장터 공고 상세(원본) 새 창"
                    className="inline-flex shrink-0 items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-xs font-semibold text-white shadow-card transition hover:opacity-90"
                  >
                    나라장터 입찰공고상세 <span aria-hidden>↗</span>
                  </a>
                )
              }
            />
            <div className="p-4">
              {attTotal > 0 ? (
                <div className="space-y-4">
                  {attGroups.map((g, gi) => (
                    <div key={g.seq}>
                      {attMultiSeq && (
                        <div className="mb-1.5 flex items-center gap-2">
                          <span className="text-xs font-semibold text-primary">
                            차수 {g.seq}
                          </span>
                          {gi === 0 && <Pill tone="accent">최신</Pill>}
                        </div>
                      )}
                      <ul className="divide-y divide-border">
                        {g.items.map((a) => (
                          <li
                            key={a.id}
                            className="flex items-center justify-between gap-3 py-2"
                          >
                            <div className="flex min-w-0 items-center gap-2">
                              <span className="shrink-0 rounded bg-bg px-1.5 py-0.5 text-[11px] text-subtle ring-1 ring-border">
                                {a.doc_type ?? "첨부"}
                              </span>
                              {a.file_url ? (
                                <a
                                  href={a.file_url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  title={`나라장터에서 다운로드: ${a.file_name ?? ""}`}
                                  className="truncate text-sm text-text hover:text-primary hover:underline"
                                >
                                  {a.file_name ?? "(파일명 없음)"}
                                </a>
                              ) : (
                                <span className="truncate text-sm text-text">
                                  {a.file_name ?? "(파일명 없음)"}
                                </span>
                              )}
                            </div>
                            <div className="flex shrink-0 items-center gap-2">
                              {a.file_url ? (
                                <a
                                  href={a.file_url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  title="나라장터(g2b) 원본 파일 다운로드"
                                  className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium text-primary ring-1 ring-border hover:bg-bg"
                                >
                                  다운로드 <span aria-hidden>↓</span>
                                </a>
                              ) : (
                                <span className="text-xs text-subtle">URL 없음</span>
                              )}
                            </div>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-subtle">첨부파일이 없습니다.</p>
              )}
            </div>
          </Card>
        </div>

        {/* 매칭 인력 (FR-10) */}
        <Card className="h-fit">
          <CardHeader title="매칭 인력 (FR-10)" />
          <div className="p-4">
            {matched.length > 0 ? (
              <ul className="space-y-2">
                {matched.map((m) => (
                  <li
                    key={m.member_id}
                    className="rounded-md bg-bg px-3 py-2"
                    title={m.reasons?.length ? m.reasons.join(" · ") : undefined}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <p className="text-sm font-medium text-text">
                          {m.name}
                          <span className="ml-1.5 text-xs font-normal text-subtle">
                            {m.work_type}
                          </span>
                        </p>
                        <p className="text-xs text-subtle">
                          {m.tech_grade}
                          {m.specialty_field ? ` · ${m.specialty_field}` : ""}
                          {m.career_years !== null && m.career_years !== undefined
                            ? ` · 경력 ${m.career_years}년`
                            : ""}
                        </p>
                        {m.license_name && (
                          <p className="text-xs text-subtle">
                            자격: {m.license_name}
                          </p>
                        )}
                      </div>
                      {m.match_score !== undefined && (
                        <Pill tone="success">{m.match_score}</Pill>
                      )}
                    </div>
                    {m.reasons && m.reasons.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {m.reasons.map((r) => (
                          <span
                            key={r}
                            className="rounded bg-success/10 px-1.5 py-0.5 text-[11px] text-success"
                          >
                            {r}
                          </span>
                        ))}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-subtle">
                매칭된 인력이 없습니다. AI 파이프라인(FR-10)이 요건-인력 매칭을
                생성하면 여기에 표시됩니다.
              </p>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-subtle">{label}</dt>
      <dd className="font-medium text-text">{value}</dd>
    </div>
  );
}

/* ── 분석 KPI 표시 헬퍼 ─────────────────────────────────────────── */

function KpiTile({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string | null;
  tone?: "danger";
}) {
  return (
    <div className="rounded-md bg-surface p-3 ring-1 ring-border">
      <div className="text-xs text-subtle">{label}</div>
      <div
        className={`mt-0.5 text-lg font-bold ${tone === "danger" ? "text-danger" : "text-text"}`}
      >
        {value}
      </div>
      {sub && <div className="mt-0.5 truncate text-[11px] text-subtle" title={sub}>{sub}</div>}
    </div>
  );
}
