"use client";

// S-06 입찰 상세 + AI 브리핑 — FR-03/04/06/10. active 전체.
import { useState } from "react";
import { useParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getSupabaseClient } from "@/lib/supabase/client";
import { useSession } from "@/lib/auth/SessionProvider";
import { signedUrl } from "@/lib/queries/analysis";
import type {
  Bid,
  BidPrice,
  BidChange,
  BidAttachment,
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

const BID_COLS =
  "bid_no,bid_seq,title,order_org,demand_org,contract_method,notice_dt,deadline_dt,open_dt,est_price,status,score,tags,ai_summary,ai_score,ai_flags,updated_at";

export default function BidDetailPage() {
  const params = useParams<{ id: string }>();
  const bidNo = decodeURIComponent(params.id);
  const supabase = getSupabaseClient();
  const qc = useQueryClient();
  const { role } = useSession();
  const isAdmin = role === "admin";
  const [tab, setTab] = useState<"price" | "changes">("price");

  // 첨부 로컬 저장(나라장터 원본 다운로드 → storage/bid-attachments) + 로컬 열람
  async function fetchAttachmentLocal(id: number) {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const res = await fetch("/api/attachment/fetch", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token ?? ""}` },
      body: JSON.stringify({ id }),
    });
    if (res.ok) qc.invalidateQueries({ queryKey: ["bid_attachments", bidNo] });
    else alert("로컬 저장 실패: " + ((await res.json().catch(() => ({})))?.error ?? ""));
  }
  async function openLocal(path: string) {
    const url = await signedUrl(supabase, path);
    if (url) window.open(url, "_blank", "noopener");
  }
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
        .order("bid_seq", { ascending: true })
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
                              <span className="truncate text-sm text-text">
                                {a.file_name ?? "(파일명 없음)"}
                              </span>
                              {a.extracted_text && (
                                <Pill tone="success">본문 추출됨</Pill>
                              )}
                            </div>
                            <div className="flex shrink-0 items-center gap-2">
                              {a.downloaded && a.storage_path && (
                                <button
                                  onClick={() => openLocal(a.storage_path!)}
                                  className="text-xs font-medium text-success hover:underline"
                                >
                                  열기(로컬) ↗
                                </button>
                              )}
                              {isAdmin && a.file_url && !a.downloaded && (
                                <button
                                  onClick={() => fetchAttachmentLocal(a.id)}
                                  className="rounded px-1.5 py-0.5 text-xs text-accent ring-1 ring-border hover:bg-bg"
                                >
                                  로컬 저장
                                </button>
                              )}
                              {a.file_url ? (
                                <a
                                  href={a.file_url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-xs text-subtle hover:underline"
                                >
                                  원본 ↗
                                </a>
                              ) : (
                                !a.downloaded && (
                                  <span className="text-xs text-subtle">URL 없음</span>
                                )
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
