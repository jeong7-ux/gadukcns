"use client";

// S-10 통계 대시보드 v3 — FR-11. 3축(마감순위·고객사·주력점수 4~9)으로 재구성.
// 설계 원천: docs/기능상세정의서_통계대시보드_v3.md · docs/UIUX설계서_통계대시보드_v3.md
import { useMemo, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts";
import { getSupabaseClient } from "@/lib/supabase/client";
import {
  fetchDashboardData,
  type DashBid,
  type DashboardData,
} from "@/lib/queries/stats";
import { useRealtimeInvalidate } from "@/lib/hooks/useRealtimeInvalidate";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardHeader } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { fmtDate } from "@/lib/utils/format";
import {
  ddayInfo,
  ddayBucket,
  DDAY_PILL_CLASS,
  type DdayBucket,
} from "@/lib/design/dday";

const DAY = 86400000;
const norm = (s: string | null) => (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();

// 고객사 카테고리(clients.category) → 칩 축약 라벨.
const CAT_LABEL: Record<string, string> = {
  중앙정부부처: "중앙부처",
  지방자치단체: "지자체",
  공공기관: "공공",
  의료기관: "의료",
  교육기관: "교육",
  금융기관: "금융",
  기타: "기타",
};

// D-day 구간 → 솔리드 막대색(캘린더 미니). Tailwind JIT가 리터럴 클래스를 잡도록 정적 맵.
const DDAY_BAR: Record<DdayBucket, string> = {
  urgent: "bg-dday-urgent",
  soon: "bg-dday-soon",
  near: "bg-dday-near",
  far: "bg-dday-far",
  past: "bg-dday-far",
};

// 추정가 축약(억/만).
const eok = (v: number | null | undefined): string => {
  if (v == null || v <= 0) return "";
  if (v >= 1e8) return `${(v / 1e8).toFixed(1)}억`;
  if (v >= 1e4) return `${Math.round(v / 1e4).toLocaleString()}만`;
  return `${v}`;
};

function color(name: string, fb: string) {
  if (typeof window === "undefined") return fb;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fb;
}

// ── 행 데이터 타입 ────────────────────────────────────────────
type Row = DashBid & {
  clientName: string | null;
  clientCat: string | null;
  dd: number | null;
  ddLabel: string;
  ddBucket: DdayBucket;
};

export default function StatsPage() {
  const supabase = getSupabaseClient();
  useRealtimeInvalidate("bids", ["dashboard"]);
  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ["dashboard"],
    queryFn: () => fetchDashboardData(supabase),
  });

  const m = useMemo(() => (data ? compute(data) : null), [data]);

  if (isLoading || !m) return <DashboardSkeleton />;

  return (
    <div>
      <PageHeader
        title="통계 대시보드"
        screen="S-10"
        desc="마감순위 · 고객사 · 주력점수(4~9) 3축으로 오늘 잡을 공고를 짚습니다. (미아카이브 · 마감전 · 주력점수 base−exclude 기준)"
        action={
          <div className="flex items-center gap-3 text-xs text-subtle">
            <span>마지막 수집 {m.lastCollect ? fmtDate(m.lastCollect) : "-"}</span>
            <span className="inline-flex items-center gap-1">
              <span className="h-2 w-2 rounded-full bg-success" aria-hidden /> 실시간
            </span>
            <button
              onClick={() => refetch()}
              disabled={isFetching}
              className="rounded px-2 py-1 ring-1 ring-border hover:bg-bg disabled:opacity-50"
            >
              새로고침
            </button>
          </div>
        }
      />

      {/* A. KPI 밴드 (6타일) */}
      <div className="mb-4 grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
        <Kpi label="주력 공고 (≥4)" value={m.kpi.core} tone="text-primary" href="/dashboard" />
        <Kpi label="우량 (5~9)" value={m.kpi.good} tone="text-primary" href="/dashboard" />
        <Kpi label="고객사 공고" value={m.kpi.client} tone="text-accent" href="/dashboard" />
        <Kpi label="임박 D0~3" value={m.kpi.imminent} tone="text-dday-urgent" href="/dashboard" />
        <Kpi label="총 추정가(억)" value={m.kpi.eok} tone="text-text" decimal />
        <Kpi
          label="AI 커버리지"
          value={m.kpi.aiCov}
          suffix="%"
          tone={m.kpi.aiCov >= 70 ? "text-success" : "text-subtle"}
        />
      </div>

      {/* 메인 2열: B 마감순위(3) · C 고객사(2) */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[3fr_2fr]">
        <ActionBoard m={m} />
        <ClientTrack m={m} />
      </div>

      {/* 서브 2열: D 스코어링 · E 캘린더 */}
      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ScoringPanel m={m} />
        <MiniCalendar m={m} />
      </div>

      {/* F. 보조 (접이식) */}
      <SecondaryPanel m={m} />
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// B. 마감순위 액션 보드
// ═══════════════════════════════════════════════════════════════
function ActionBoard({ m }: { m: Metrics }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  return (
    <Card>
      <CardHeader
        title="마감순위 액션 보드"
        action={<span className="text-xs text-subtle">주력 {m.kpi.core}건 · 마감 임박순</span>}
      />
      <div className="p-4">
        {m.board.length === 0 ? (
          <p className="text-sm text-subtle">마감전 주력 공고가 없습니다.</p>
        ) : (
          m.board.map((g) => {
            const isOpen = open[g.key] ?? g.defaultOpen;
            return (
              <div key={g.key} className="mb-1.5 last:mb-0">
                <button
                  onClick={() => setOpen((s) => ({ ...s, [g.key]: !isOpen }))}
                  aria-expanded={isOpen}
                  className="flex w-full items-center gap-1.5 py-1 text-left"
                >
                  <span className="text-subtle">{isOpen ? "▾" : "▸"}</span>
                  <span className="text-xs font-semibold uppercase text-subtle">{g.label}</span>
                  <span className="text-xs text-subtle">· {g.rows.length}건</span>
                </button>
                {isOpen && (
                  <div className="mb-1">
                    {g.rows.slice(0, 20).map((b) => (
                      <BoardRow key={`${b.bid_no}-${b.bid_seq}`} b={b} showPrice />
                    ))}
                    {g.rows.length > 20 && (
                      <Link
                        href="/dashboard"
                        className="mt-0.5 block px-1 text-[11px] text-accent hover:underline"
                      >
                        외 {g.rows.length - 20}건 전체 보기 →
                      </Link>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
        {/* 하단 배지 줄 */}
        <div className="mt-3 flex flex-wrap gap-2 border-t border-border pt-3 text-xs">
          <Pill tone="danger">오늘 마감 {m.todayClose}</Pill>
          <Link href="/watchlist">
            <Pill tone="accent">관심 {m.watchCount}</Pill>
          </Link>
          <Pill tone="muted">마감 미정 {m.undated}</Pill>
        </div>
      </div>
    </Card>
  );
}

// 행 템플릿(R4): [D-day pill] (발주기관) 사업명 ⭐ [주N] 추정가
function BoardRow({ b, showPrice }: { b: Row; showPrice?: boolean }) {
  return (
    <Link
      href={`/bids/${encodeURIComponent(b.bid_no)}`}
      className="flex h-9 items-center gap-2 rounded px-1 hover:bg-bg"
    >
      {b.dd === null ? (
        <span
          className={`inline-flex h-5 w-12 shrink-0 items-center justify-center rounded text-[11px] font-semibold ${DDAY_PILL_CLASS.far}`}
        >
          미정
        </span>
      ) : (
        <span
          className={`inline-flex h-5 w-12 shrink-0 items-center justify-center rounded text-[11px] font-semibold ${DDAY_PILL_CLASS[b.ddBucket]}`}
        >
          {b.ddLabel}
        </span>
      )}
      <span className="hidden max-w-[120px] shrink-0 truncate text-xs text-subtle sm:inline">
        ({b.order_org ?? "발주기관 미상"})
      </span>
      <span className="min-w-0 flex-1 truncate text-sm text-text">{b.title ?? "제목 없음"}</span>
      {b.clientName && (
        <span aria-label="고객사 공고" className="shrink-0 text-accent">
          ⭐
        </span>
      )}
      <span className="shrink-0 rounded bg-primary/10 px-1.5 text-[11px] font-semibold text-primary">
        주{b.coreScore}
      </span>
      {showPrice && (
        <span className="hidden w-14 shrink-0 text-right text-[11px] text-subtle md:inline">
          {eok(b.est_price)}
        </span>
      )}
    </Link>
  );
}

// ═══════════════════════════════════════════════════════════════
// C. 고객사 트랙
// ═══════════════════════════════════════════════════════════════
function ClientTrack({ m }: { m: Metrics }) {
  return (
    <Card>
      <CardHeader
        title="고객사 트랙"
        action={<span className="text-xs text-subtle">{m.kpi.client}건 · 점수 무관</span>}
      />
      <div className="p-4">
        {/* 카테고리 칩 스트립 */}
        {m.clientChips.length > 0 && (
          <div className="mb-3 flex flex-wrap gap-1.5">
            {m.clientChips.map((c) => (
              <Link
                key={c.cat}
                href="/dashboard"
                className="rounded-full bg-bg px-2.5 py-1 text-xs text-text ring-1 ring-border hover:ring-accent"
              >
                {c.label} <span className="font-semibold text-accent">{c.n}</span>
              </Link>
            ))}
          </div>
        )}
        {/* 고객사 그룹핑 리스트 (마감순, 최대 10행) */}
        {m.clientGroups.length === 0 ? (
          <p className="text-sm text-subtle">고객사 매칭 공고가 없습니다.</p>
        ) : (
          <div className="space-y-2">
            {m.clientGroups.map((g) => (
              <div key={g.name}>
                <div className="flex items-center gap-1.5 py-0.5">
                  <span className="truncate text-sm font-medium text-accent">{g.name}</span>
                  {g.rows.length > 1 && (
                    <span className="text-xs text-subtle">×{g.rows.length}</span>
                  )}
                </div>
                {g.rows.map((b) => (
                  <Link
                    key={`${b.bid_no}-${b.bid_seq}`}
                    href={`/bids/${encodeURIComponent(b.bid_no)}`}
                    className="flex h-9 items-center gap-2 rounded pl-3 pr-1 hover:bg-bg"
                  >
                    <span className="min-w-0 flex-1 truncate text-sm text-text">
                      {b.title ?? "제목 없음"}
                    </span>
                    {b.coreScore >= 4 && (
                      <span className="shrink-0 rounded bg-primary/10 px-1.5 text-[11px] font-semibold text-primary">
                        주{b.coreScore}
                      </span>
                    )}
                    {b.dd === null ? (
                      <span
                        className={`inline-flex h-5 w-12 shrink-0 items-center justify-center rounded text-[11px] font-semibold ${DDAY_PILL_CLASS.far}`}
                      >
                        미정
                      </span>
                    ) : (
                      <span
                        className={`inline-flex h-5 w-12 shrink-0 items-center justify-center rounded text-[11px] font-semibold ${DDAY_PILL_CLASS[b.ddBucket]}`}
                      >
                        {b.ddLabel}
                      </span>
                    )}
                  </Link>
                ))}
              </div>
            ))}
            {m.clientMore > 0 && (
              <Link href="/dashboard" className="block text-xs text-accent hover:underline">
                전체 보기 → (외 {m.clientMore}건)
              </Link>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

// ═══════════════════════════════════════════════════════════════
// D. 스코어링 현황 (2밴드 + 우량 Top 8 + AI 게이지)
// ═══════════════════════════════════════════════════════════════
function ScoringPanel({ m }: { m: Metrics }) {
  const { band4, band59, band10, coreTotal } = m.score;
  const pct = (n: number) => (coreTotal ? `${(n / coreTotal) * 100}%` : "0%");
  return (
    <Card>
      <CardHeader title="스코어링 현황 (주력점수)" />
      <div className="p-4">
        {/* 2밴드 스택바 */}
        <div className="flex items-center justify-between text-xs">
          <span className="text-subtle">
            관심(4) <b className="text-text">{band4}</b>
          </span>
          <span className="text-subtle">
            <b className="text-text">{band59}</b> 우량(5~9)
            {band10 > 0 && (
              <>
                {" · "}
                <b className="text-text">{band10}</b> 10+
              </>
            )}
          </span>
        </div>
        <div className="mt-1 flex h-5 w-full overflow-hidden rounded ring-1 ring-border">
          <div className="bg-primary/40" style={{ width: pct(band4) }} />
          <div className="bg-primary" style={{ width: pct(band59) }} />
          {band10 > 0 && <div className="bg-accent" style={{ width: pct(band10) }} />}
        </div>

        {/* 우량 Top 8 */}
        <p className="mb-1 mt-4 text-xs font-semibold text-subtle">우량 Top 8</p>
        {m.goodTop.length === 0 ? (
          <p className="text-sm text-subtle">해당 공고가 없습니다.</p>
        ) : (
          <div>
            {m.goodTop.map((b) => (
              <BoardRow key={`${b.bid_no}-${b.bid_seq}`} b={b} />
            ))}
          </div>
        )}

        {/* AI 커버리지 게이지 */}
        <div className="mt-4">
          <div className="flex items-center justify-between text-xs">
            <span className="text-subtle">AI 요약 커버리지</span>
            <span className={m.kpi.aiCov >= 70 ? "font-semibold text-success" : "font-semibold text-subtle"}>
              {m.kpi.aiCov}%
            </span>
          </div>
          <div className="mt-1 h-2 w-full overflow-hidden rounded bg-bg ring-1 ring-border">
            <div
              className={m.kpi.aiCov >= 70 ? "h-full bg-success" : "h-full bg-primary/50"}
              style={{ width: `${m.kpi.aiCov}%` }}
            />
          </div>
          {m.kpi.unsummarized > 0 && (
            <Link
              href="/dashboard"
              className="mt-2 inline-block rounded px-2 py-0.5 text-xs text-subtle ring-1 ring-border hover:bg-bg"
            >
              미요약 {m.kpi.unsummarized}건
            </Link>
          )}
        </div>
      </div>
    </Card>
  );
}

// ═══════════════════════════════════════════════════════════════
// E. 마감 캘린더 미니 (14일)
// ═══════════════════════════════════════════════════════════════
function MiniCalendar({ m }: { m: Metrics }) {
  const maxC = Math.max(1, ...m.cal.map((x) => x.count));
  return (
    <Card>
      <CardHeader title="마감 캘린더 (14일)" />
      <div className="p-4">
        {m.calTotal === 0 ? (
          <p className="text-sm text-subtle">14일 내 마감 없음 · 미정 {m.undated}건</p>
        ) : (
          <>
            <div className="flex h-16 items-end gap-1">
              {m.cal.map((x) => (
                <div key={x.i} className="flex flex-1 flex-col items-center justify-end">
                  <div
                    className={`w-full rounded-t ${x.count > 0 ? DDAY_BAR[x.bucket] : "bg-border"} ${x.i === 0 ? "ring-1 ring-inset ring-text/30" : ""}`}
                    style={{ height: x.count > 0 ? `${Math.max((x.count / maxC) * 100, 12)}%` : "2px" }}
                    title={`${x.label} · ${x.count}건`}
                  />
                </div>
              ))}
            </div>
            <div className="mt-1 flex text-[10px] text-subtle">
              {m.cal.map((x) => (
                <span key={x.i} className="flex-1 text-center">
                  {x.i === 0 || x.i === 4 || x.i === 8 || x.i === 13 ? x.label : ""}
                </span>
              ))}
            </div>
            <p className="mt-2 text-[11px] text-subtle">
              막대색 = 마감 임박도(3구간) · 미정 {m.undated}건은 제외
            </p>
          </>
        )}
      </div>
    </Card>
  );
}

// ═══════════════════════════════════════════════════════════════
// F. 보조 영역 (접이식): 유입 추세 · 발주기관 Top 5 · AI 브리핑 · 데이터 상태
// ═══════════════════════════════════════════════════════════════
function SecondaryPanel({ m }: { m: Metrics }) {
  const cSubtle = color("--color-text-subtle", "#64748b");
  const cAccent = color("--color-accent", "#2563EB");
  const cBorder = color("--color-border", "#e2e8f0");
  const tt = {
    contentStyle: {
      background: "var(--color-surface)",
      border: "1px solid var(--color-border)",
      borderRadius: 8,
      color: "var(--color-text)",
      fontSize: 12,
      boxShadow: "0 4px 12px rgba(0,0,0,0.18)",
    },
    labelStyle: { color: "var(--color-text)", fontWeight: 600 },
    itemStyle: { color: "var(--color-text)" },
    cursor: { fill: cBorder, fillOpacity: 0.25, stroke: cBorder },
  };
  const maxOrg = Math.max(1, ...m.byOrg.map((o) => o.count));

  return (
    <details open className="mt-4">
      <summary className="cursor-pointer select-none py-2 text-sm font-semibold text-subtle">
        보조 통계 (유입 추세 · 발주기관 · AI 브리핑 · 데이터 상태)
      </summary>
      <div className="mt-2 grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* 유입 추세 21일 */}
        <Card>
          <CardHeader title="유입 추세 (주력 · 21일)" />
          <div className="h-52 p-4">
            <ResponsiveContainer width="100%" height={180}>
              <LineChart data={m.newByDay}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                <XAxis dataKey="date" tick={{ fontSize: 10, fill: cSubtle }} interval={4} />
                <YAxis tick={{ fontSize: 11, fill: cSubtle }} allowDecimals={false} width={24} />
                <Tooltip {...tt} />
                <Line
                  isAnimationActive={false}
                  type="monotone"
                  dataKey="count"
                  stroke={cAccent}
                  strokeWidth={2}
                  dot={{ r: 2 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Card>

        {/* 발주기관 Top 5 (div 가로바) */}
        <Card>
          <CardHeader title="발주기관 Top 5 (주력)" />
          <div className="space-y-2 p-4">
            {m.byOrg.length === 0 ? (
              <p className="text-sm text-subtle">데이터 없음</p>
            ) : (
              m.byOrg.map((o) => (
                <div key={o.name} className="flex items-center gap-2 text-xs">
                  <span className="w-28 shrink-0 truncate text-subtle" title={o.name}>
                    {o.name}
                  </span>
                  <div className="h-3 flex-1 overflow-hidden rounded bg-bg ring-1 ring-border">
                    <div
                      className="h-full rounded bg-primary"
                      style={{ width: `${(o.count / maxOrg) * 100}%` }}
                    />
                  </div>
                  <span className="w-5 shrink-0 text-right font-medium text-text">{o.count}</span>
                </div>
              ))
            )}
          </div>
        </Card>

        {/* AI 데일리 브리핑 */}
        <Card>
          <CardHeader title={`AI 데일리 브리핑 ${m.brief?.date ? `(${m.brief.date})` : ""}`} />
          <div className="p-4 text-sm text-text">
            {m.brief?.summary ? (
              <p className="whitespace-pre-wrap leading-relaxed">{m.brief.summary}</p>
            ) : (
              <p className="text-subtle">브리핑이 아직 생성되지 않았습니다.</p>
            )}
          </div>
        </Card>

        {/* 데이터 상태 */}
        <Card>
          <CardHeader title="데이터 · 파이프라인 상태" />
          <div className="grid grid-cols-2 gap-x-6 gap-y-2 p-4 text-sm">
            <Meta label="마지막 수집" value={m.lastCollect ? fmtDate(m.lastCollect) : "-"} />
            <Meta label="마지막 재스코어링" value={m.lastRescore ? fmtDate(m.lastRescore) : "-"} />
            <Meta label="노출 공고 / 아카이브" value={`${m.totalBids} / ${m.archivedBids}`} />
            <Meta label="첨부 정규화 공고" value={`${m.attBidCount}`} />
            <Meta label="활성 스코어링 룰" value={`${m.rulesActive}`} />
            <Meta label="고객사" value={`${m.clientsCount}`} />
          </div>
        </Card>
      </div>
    </details>
  );
}

// ═══════════════════════════════════════════════════════════════
// 집계 로직
// ═══════════════════════════════════════════════════════════════
type Metrics = ReturnType<typeof compute>;

function compute(d: DashboardData) {
  const clients = d.clients.map((c) => ({
    name: c.name,
    category: c.category,
    keys: [c.name, ...(c.aliases ?? [])].map(norm).filter(Boolean),
  }));
  const matchClient = (b: DashBid) => {
    const hay = norm(`${b.order_org ?? ""} ${b.demand_org ?? ""}`);
    return clients.find((c) => c.keys.some((k) => hay.includes(k))) ?? null;
  };

  const rows: Row[] = d.bids.map((b) => {
    const c = matchClient(b);
    const info = ddayInfo(b.deadline_dt);
    return {
      ...b,
      clientName: c?.name ?? null,
      clientCat: c?.category ?? null,
      dd: info.days,
      ddLabel: info.label,
      ddBucket: info.bucket,
    };
  });

  // 모수: 주력(주력점수≥4) / 고객사(점수 무관)
  const core = rows.filter((b) => b.coreScore >= 4);
  const clientRows = rows.filter((b) => b.clientName);

  // ── A. KPI ─────────────────────────────────
  const totalEst = core.reduce((s, b) => s + (b.est_price ?? 0), 0);
  const kpi = {
    core: core.length,
    good: core.filter((b) => b.coreScore >= 5 && b.coreScore <= 9).length,
    client: clientRows.length,
    imminent: core.filter((b) => b.dd !== null && b.dd >= 0 && b.dd <= 3).length,
    eok: Math.round((totalEst / 1e8) * 10) / 10,
    aiCov: core.length ? Math.round((core.filter((b) => b.has_summary).length / core.length) * 100) : 0,
    unsummarized: core.filter((b) => !b.has_summary).length,
  };

  // ── B. 마감순위 보드 ────────────────────────
  // 정렬: ① dd ASC(미정 뒤로) → ② 고객사 → ③ 주력점수 DESC
  const boardSorted = [...core].sort((a, b) => {
    const da = a.dd ?? 99999;
    const db = b.dd ?? 99999;
    if (da !== db) return da - db;
    const ca = a.clientName ? 1 : 0;
    const cb = b.clientName ? 1 : 0;
    if (cb !== ca) return cb - ca;
    return b.coreScore - a.coreScore;
  });
  const GROUP_DEFS: { key: string; label: string; test: (dd: number | null) => boolean; defaultOpen: boolean }[] = [
    { key: "d03", label: "D0~3", test: (dd) => dd !== null && dd <= 3, defaultOpen: true },
    { key: "d47", label: "D4~7", test: (dd) => dd !== null && dd >= 4 && dd <= 7, defaultOpen: true },
    { key: "d814", label: "D8~14", test: (dd) => dd !== null && dd >= 8 && dd <= 14, defaultOpen: false },
    { key: "d15", label: "D15+", test: (dd) => dd !== null && dd >= 15, defaultOpen: false },
    { key: "none", label: "마감 미정", test: (dd) => dd === null, defaultOpen: false },
  ];
  const board = GROUP_DEFS.map((g) => ({ ...g, rows: boardSorted.filter((b) => g.test(b.dd)) })).filter(
    (g) => g.rows.length > 0
  );
  const todayClose = core.filter((b) => b.dd === 0).length;
  const undated = core.filter((b) => b.dd === null).length;

  // ── C. 고객사 트랙 ──────────────────────────
  const catCount = new Map<string, number>();
  for (const b of clientRows) {
    const cat = b.clientCat ?? "기타";
    catCount.set(cat, (catCount.get(cat) ?? 0) + 1);
  }
  const clientChips = [...catCount.entries()]
    .map(([cat, n]) => ({ cat, label: CAT_LABEL[cat] ?? cat, n }))
    .sort((a, b) => b.n - a.n);

  const deadlineKey = (b: Row) => b.deadline_dt ?? "9999-12-31";
  const groupMap = new Map<string, Row[]>();
  for (const b of [...clientRows].sort((a, b) => deadlineKey(a).localeCompare(deadlineKey(b)))) {
    const arr = groupMap.get(b.clientName!) ?? [];
    arr.push(b);
    groupMap.set(b.clientName!, arr);
  }
  const allClientGroups = [...groupMap.entries()]
    .map(([name, gr]) => ({ name, rows: gr }))
    .sort((a, b) => deadlineKey(a.rows[0]).localeCompare(deadlineKey(b.rows[0])));
  // 최대 10행 노출(그룹 단위 누적)
  const clientGroups: { name: string; rows: Row[] }[] = [];
  let shown = 0;
  for (const g of allClientGroups) {
    if (shown >= 10) break;
    const take = g.rows.slice(0, 10 - shown);
    clientGroups.push({ name: g.name, rows: take });
    shown += take.length;
  }
  const clientMore = clientRows.length - shown;

  // ── D. 스코어링 현황 ────────────────────────
  const band4 = core.filter((b) => b.coreScore === 4).length;
  const band59 = core.filter((b) => b.coreScore >= 5 && b.coreScore <= 9).length;
  const band10 = core.filter((b) => b.coreScore >= 10).length; // 데이터 있을 때만 표시
  const goodTop = [...core]
    .sort((a, b) => b.coreScore - a.coreScore || (a.dd ?? 99999) - (b.dd ?? 99999))
    .slice(0, 8);

  // ── E. 마감 캘린더 미니 (14일) ──────────────
  const cal = Array.from({ length: 14 }, (_, i) => {
    const d0 = new Date(Date.now() + i * DAY);
    return {
      i,
      count: core.filter((b) => b.dd === i).length,
      bucket: ddayBucket(i),
      label: fmtMD(d0),
    };
  });
  const calTotal = cal.reduce((s, x) => s + x.count, 0);

  // ── F. 보조 ─────────────────────────────────
  const newByDay = lastNDays(21).map((d0) => ({
    date: fmtMD(d0),
    count: core.filter((b) => b.notice_dt && sameDay(new Date(b.notice_dt), d0)).length,
  }));
  const byOrg = agg(core.map((b) => b.order_org ?? "미지정"))
    .slice(0, 5)
    .map(([name, count]) => ({ name, count }));
  const lastRescore = rows.reduce<string | null>(
    (mx, b) => (b.rescored_at && (!mx || b.rescored_at > mx) ? b.rescored_at : mx),
    null
  );

  return {
    kpi,
    board,
    todayClose,
    undated,
    watchCount: d.watch.length,
    clientChips,
    clientGroups,
    clientMore,
    score: { band4, band59, band10, coreTotal: core.length },
    goodTop,
    cal,
    calTotal,
    newByDay,
    byOrg,
    brief: d.brief ? { date: d.brief.brief_date, summary: d.brief.summary } : null,
    lastCollect: d.lastCollect,
    lastRescore,
    totalBids: d.totalBids,
    archivedBids: d.archivedBids,
    attBidCount: d.attBidCount,
    rulesActive: d.rulesActive,
    clientsCount: d.clientsCount,
  };
}

// ── 유틸 ─────────────────────────────────────
function agg(arr: string[]): [string, number][] {
  const map = new Map<string, number>();
  for (const x of arr) map.set(x, (map.get(x) ?? 0) + 1);
  return [...map.entries()].sort((a, b) => b[1] - a[1]);
}
function lastNDays(n: number) {
  const now = new Date();
  const t0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Array.from({ length: n }, (_, i) => new Date(t0.getTime() - (n - 1 - i) * DAY));
}
function sameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
function fmtMD(d0: Date) {
  return `${String(d0.getMonth() + 1).padStart(2, "0")}.${String(d0.getDate()).padStart(2, "0")}`;
}

// ── 프리미티브 ───────────────────────────────
function Kpi({
  label,
  value,
  tone,
  href,
  decimal,
  suffix,
}: {
  label: string;
  value: number;
  tone: string;
  href?: string;
  decimal?: boolean;
  suffix?: string;
}) {
  const body = (
    <Card className="p-3">
      <p className="truncate text-[11px] text-subtle">{label}</p>
      <p className={`mt-0.5 text-2xl font-bold ${tone}`}>
        {decimal ? value.toLocaleString(undefined, { minimumFractionDigits: 0 }) : value.toLocaleString()}
        {suffix && <span className="text-sm">{suffix}</span>}
      </p>
    </Card>
  );
  return href ? (
    <Link href={href} className="block transition-transform hover:-translate-y-0.5">
      {body}
    </Link>
  ) : (
    body
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

// 위젯별 로딩 스켈레톤
function DashboardSkeleton() {
  const Block = ({ className = "" }: { className?: string }) => (
    <div className={`animate-pulse rounded-card bg-border/40 ${className}`} />
  );
  return (
    <div>
      <PageHeader title="통계 대시보드" screen="S-10" desc="주력·고객사·마감순위 현황을 불러오는 중…" />
      <div className="mb-4 grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <Block key={i} className="h-16" />
        ))}
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[3fr_2fr]">
        <Block className="h-96" />
        <Block className="h-96" />
      </div>
      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Block className="h-64" />
        <Block className="h-64" />
      </div>
    </div>
  );
}
