"use client";

// S-10 통계 대시보드 v2 — FR-11 강화. 한눈 현황(KPI·액션·분야·고객사·품질·추세·기관·브리핑·상태).
import { useMemo } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  PieChart,
  Pie,
  Cell,
  LineChart,
  Line,
} from "recharts";
import { getSupabaseClient } from "@/lib/supabase/client";
import { fetchDashboardData, type DashBid } from "@/lib/queries/stats";
import { useRealtimeInvalidate } from "@/lib/hooks/useRealtimeInvalidate";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardHeader } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { fmtDate, fmtWon } from "@/lib/utils/format";

const FIELDS: { cat: string; patterns: string[] }[] = [
  { cat: "정보시스템 감리", patterns: ["정보시스템 감리", "정보화 감리", "정보시스템감리", "정보화감리", "상주감리"] },
  { cat: "ISP·정보화컨설팅", patterns: ["isp", "ismp", "정보화전략계획", "정보화 컨설팅", "정보전략계획", "bpr"] },
  { cat: "정보보안", patterns: ["정보보안", "보안 컨설팅", "isms", "취약점", "모의해킹"] },
  { cat: "SI·시스템구축", patterns: ["시스템통합", "정보시스템 구축", "차세대", "정보화사업"] },
  { cat: "정보화 성과평가", patterns: ["정보화 성과평가"] },
  { cat: "유지보수·운영", patterns: ["유지관리", "유지보수", "위탁운영"] },
  { cat: "AI·데이터", patterns: ["인공지능", "빅데이터", "데이터 구축"] },
];
const norm = (s: string | null) => (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
const DAY = 86400000;

function color(name: string, fb: string) {
  if (typeof window === "undefined") return fb;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fb;
}

export default function StatsPage() {
  const supabase = getSupabaseClient();
  useRealtimeInvalidate("bids", ["dashboard"]);
  const { data, isLoading } = useQuery({
    queryKey: ["dashboard"],
    queryFn: () => fetchDashboardData(supabase),
  });

  const m = useMemo(() => (data ? compute(data) : null), [data]);

  const cPrimary = color("--color-primary", "#1F497D");
  const cAccent = color("--color-accent", "#2563EB");
  const cSuccess = color("--color-success", "#16A34A");
  const cDanger = color("--color-danger", "#DC2626");
  const cMuted = color("--color-muted", "#64748B");
  const PALETTE = [cPrimary, cAccent, cSuccess, "#7C3AED", cDanger, "#EA580C", "#0891B2"];

  // 다크/화이트 공통: recharts 기본 흰색 Tooltip·연회색 cursor·축 라벨을 테마 토큰으로 치환.
  const cBorder = color("--color-border", "#e2e8f0");
  const cSubtle = color("--color-text-subtle", "#64748b");
  // Tooltip 본문은 HTML div → CSS 변수 직접 사용(테마 토글 즉시 반영). cursor는 SVG라 계산값 사용.
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

  if (isLoading || !m) {
    return (
      <div>
        <PageHeader title="통계 대시보드" screen="S-10" desc="입찰정보 현황을 한눈에 파악합니다." />
        <p className="text-sm text-subtle">불러오는 중…</p>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="통계 대시보드"
        screen="S-10"
        desc="주력사업·고객사 기반 입찰정보 현황(스코어링 가중치 4이상 룰 매칭 공고 기준)을 한눈에 파악합니다."
        action={
          <span className="text-xs text-subtle">
            마지막 수집 {m.lastCollect ? fmtDate(m.lastCollect) : "-"} · 실시간
          </span>
        }
      />

      {/* DFR-01 KPI 밴드 */}
      <div className="mb-4 grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-5">
        <Kpi label="관련 공고(점수≥4)" value={m.kpi.relevant} tone="text-primary" href="/dashboard" />
        <Kpi label="진행중" value={m.kpi.ongoing} tone="text-success" href="/dashboard" />
        <Kpi label="임박 마감(D0~3)" value={m.kpi.imminent} tone="text-danger" href="/dashboard" />
        <Kpi label="고득점(≥5)" value={m.kpi.high} tone="text-accent" href="/dashboard" />
        <Kpi label="고객사 공고" value={m.kpi.client} tone="text-primary" href="/dashboard" />
        <Kpi label="관심 목록" value={m.kpi.watch} tone="text-accent" href="/watchlist" />
        <Kpi label="신규 24h" value={m.kpi.new24h} tone="text-success" />
        <Kpi label="평균 점수" value={m.kpi.avgScore} tone="text-primary" decimal />
        <Kpi label="총 추정가(억)" value={m.kpi.totalEok} tone="text-primary" decimal />
        <Kpi label="AI 요약 커버리지" value={m.kpi.aiCoverage} tone="text-accent" suffix="%" />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* DFR-02 마감 임박 · 액션 */}
        <Card>
          <CardHeader title="마감 임박 · 액션 (D0~3)" />
          <div className="p-4">
            {m.imminent.length > 0 ? (
              <ul className="divide-y divide-border">
                {m.imminent.map((b) => (
                  <li key={`${b.bid_no}-${b.bid_seq}`}>
                    <Link href={`/bids/${encodeURIComponent(b.bid_no)}`} className="flex items-center justify-between gap-2 py-1.5 hover:bg-bg">
                      <span className="min-w-0 flex-1 truncate text-sm text-text">
                        {b.clientName && <span className="mr-1 text-accent">⭐</span>}
                        <span className="text-subtle">
                          ({b.order_org ?? "발주기관 미상"})
                        </span>{" "}
                        {b.title}
                      </span>
                      <span className="shrink-0 rounded bg-danger/10 px-1.5 py-0.5 text-[11px] font-semibold text-danger">
                        D-{b.dday}
                      </span>
                      <span className="shrink-0 text-[11px] text-subtle">점수 {b.score}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-subtle">임박 마감 공고가 없습니다.</p>
            )}
            <div className="mt-3 flex flex-wrap gap-2 border-t border-border pt-3 text-xs">
              <Pill tone="danger">오늘 마감 {m.todayClose}</Pill>
              <Pill tone="accent">관심 분석중 {m.watchStat.analysisInProgress}</Pill>
              <Pill tone="muted">관심 미착수 {m.watchStat.analysisNone}</Pill>
              <Pill tone="success">제안 작성중 {m.watchStat.proposalWriting}</Pill>
            </div>
          </div>
        </Card>

        {/* DFR-03 주력분야 현황 */}
        <Card>
          <CardHeader title="주력분야별 현황 (공고 수 / 평균점수)" />
          <div className="h-64 p-4">
            <ResponsiveContainer width="100%" height={210}>
              <BarChart data={m.byField} margin={{ left: 4, right: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                <XAxis dataKey="name" tick={{ fontSize: 10, fill: cSubtle }} interval={0} angle={-12} textAnchor="end" height={44} />
                <YAxis tick={{ fontSize: 11, fill: cSubtle }} allowDecimals={false} />
                <Tooltip {...tt} />
                <Bar isAnimationActive={false} dataKey="count" name="공고 수" radius={[4, 4, 0, 0]}>
                  {m.byField.map((_, i) => (
                    <Cell key={i} fill={PALETTE[i % PALETTE.length]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>

        {/* DFR-04 고객사 현황 */}
        <Card>
          <CardHeader
            title={
              <span className="flex items-center gap-2">
                고객사 현황
                <Pill tone="success">보건·의료 집중률 {m.healthRatio}%</Pill>
              </span>
            }
          />
          <div className="grid grid-cols-2 gap-2 p-4">
            <div className="h-56">
              <ResponsiveContainer width="100%" height={210}>
                <PieChart>
                  <Pie isAnimationActive={false} data={m.clientByCat} dataKey="value" nameKey="name" innerRadius={40} outerRadius={78} paddingAngle={2}>
                    {m.clientByCat.map((_, i) => (
                      <Cell key={i} fill={PALETTE[i % PALETTE.length]} />
                    ))}
                  </Pie>
                  <Tooltip {...tt} />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div className="h-56">
              <ResponsiveContainer width="100%" height={210}>
                <BarChart data={m.topClients} layout="vertical" margin={{ left: 8 }}>
                  <XAxis type="number" tick={{ fontSize: 10, fill: cSubtle }} />
                  <YAxis type="category" dataKey="name" width={80} tick={{ fontSize: 10, fill: cSubtle }} />
                  <Tooltip {...tt} />
                  <Bar isAnimationActive={false} dataKey="count" fill={cPrimary} radius={[0, 3, 3, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </Card>

        {/* DFR-05 스코어링·품질 */}
        <Card>
          <CardHeader title="스코어링 · 품질" />
          <div className="p-4">
            <div className="h-52">
              <ResponsiveContainer width="100%" height={210}>
                <BarChart data={m.scoreDist}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                  <XAxis dataKey="name" tick={{ fontSize: 11, fill: cSubtle }} />
                  <YAxis tick={{ fontSize: 11, fill: cSubtle }} allowDecimals={false} />
                  <Tooltip {...tt} />
                  <Bar isAnimationActive={false} dataKey="count" fill={cAccent} radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <p className="mt-3 mb-1 text-xs font-semibold text-subtle">고득점 Top 5</p>
            <ul className="divide-y divide-border">
              {m.topBids.map((b) => (
                <li key={`${b.bid_no}-${b.bid_seq}`}>
                  <Link href={`/bids/${encodeURIComponent(b.bid_no)}`} className="flex items-center justify-between gap-2 py-1 hover:bg-bg">
                    <span className="min-w-0 flex-1 truncate text-xs text-text">
                      {b.clientName && <span className="mr-0.5 text-accent">⭐</span>}
                      {b.title}
                    </span>
                    <span className="shrink-0 rounded bg-primary/10 px-1.5 text-[11px] font-semibold text-primary">
                      {b.score}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </Card>

        {/* DFR-06 시계열 추세 */}
        <Card className="lg:col-span-2">
          <CardHeader title="유입 · 마감 추세" />
          <div className="grid grid-cols-1 gap-2 p-4 lg:grid-cols-2">
            <div className="h-56">
              <p className="mb-1 text-xs text-subtle">일자별 신규 공고 (최근 21일)</p>
              <ResponsiveContainer width="100%" height={210}>
                <LineChart data={m.newByDay}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                  <XAxis dataKey="date" tick={{ fontSize: 10, fill: cSubtle }} />
                  <YAxis tick={{ fontSize: 11, fill: cSubtle }} allowDecimals={false} />
                  <Tooltip {...tt} />
                  <Line isAnimationActive={false} type="monotone" dataKey="count" stroke={cAccent} strokeWidth={2} dot={{ r: 2 }} />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <div className="h-56">
              <p className="mb-1 text-xs text-subtle">향후 마감 예정 (다음 14일)</p>
              <ResponsiveContainer width="100%" height={210}>
                <BarChart data={m.deadlineByDay}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                  <XAxis dataKey="date" tick={{ fontSize: 10, fill: cSubtle }} />
                  <YAxis tick={{ fontSize: 11, fill: cSubtle }} allowDecimals={false} />
                  <Tooltip {...tt} />
                  <Bar isAnimationActive={false} dataKey="count" fill={cDanger} radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </Card>

        {/* DFR-07 발주/수요기관 */}
        <Card>
          <CardHeader title="발주기관 Top 8" />
          <div className="h-64 p-4">
            <ResponsiveContainer width="100%" height={210}>
              <BarChart data={m.byOrg} layout="vertical" margin={{ left: 24 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                <XAxis type="number" tick={{ fontSize: 11, fill: cSubtle }} />
                <YAxis type="category" dataKey="name" width={92} tick={{ fontSize: 10, fill: cSubtle }} />
                <Tooltip {...tt} />
                <Bar isAnimationActive={false} dataKey="count" fill={cPrimary} radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card>
          <CardHeader
            title={
              <span className="flex items-center gap-2">
                수요기관 Top 8
                <Pill tone="accent">고객사 {m.clientVsGeneral[0].value} : 일반 {m.clientVsGeneral[1].value}</Pill>
              </span>
            }
          />
          <div className="h-64 p-4">
            <ResponsiveContainer width="100%" height={210}>
              <BarChart data={m.byDemand} layout="vertical" margin={{ left: 24 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                <XAxis type="number" tick={{ fontSize: 11, fill: cSubtle }} />
                <YAxis type="category" dataKey="name" width={92} tick={{ fontSize: 10, fill: cSubtle }} />
                <Tooltip {...tt} />
                <Bar isAnimationActive={false} dataKey="count" fill={cAccent} radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>

        {/* DFR-08 AI 데일리 브리핑 */}
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

        {/* DFR-09 데이터·파이프라인 상태 */}
        <Card>
          <CardHeader title="데이터 · 파이프라인 상태" />
          <div className="grid grid-cols-2 gap-x-6 gap-y-2 p-4 text-sm">
            <Meta label="마지막 수집" value={m.lastCollect ? fmtDate(m.lastCollect) : "-"} />
            <Meta label="마지막 재스코어링" value={m.lastRescore ? fmtDate(m.lastRescore) : "-"} />
            <Meta label="노출 공고 / 아카이브" value={`${m.kpi.relevantAll} / ${m.archivedBids}`} />
            <Meta label="첨부 정규화 공고" value={`${m.attBidCount}`} />
            <Meta label="활성 스코어링 룰" value={`${m.rulesActive}`} />
            <Meta label="고객사" value={`${m.clientsCount}`} />
          </div>
        </Card>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
function compute(d: import("@/lib/queries/stats").DashboardData) {
  const now = new Date();
  const today0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const clients = d.clients.map((c) => ({
    name: c.name,
    category: c.category,
    keys: [c.name, ...(c.aliases ?? [])].map(norm).filter(Boolean),
  }));
  const matchClient = (b: DashBid) => {
    const hay = norm(`${b.order_org ?? ""} ${b.demand_org ?? ""}`);
    return clients.find((c) => c.keys.some((k) => hay.includes(k))) ?? null;
  };
  const dday = (dl: string | null) =>
    dl ? Math.round((new Date(dl.slice(0, 10)).getTime() - today0) / DAY) : null;

  const enriched = d.bids.map((b) => {
    const c = matchClient(b);
    return { ...b, clientName: c?.name ?? null, clientCat: c?.category ?? null, dd: dday(b.deadline_dt) };
  });
  // 현황 기준: 스코어링 점수 ≥ 4 (가중치 4이상 룰 매칭). 대시보드 전 위젯의 '관련 공고' 집합.
  const REL_MIN = 4;
  const base = enriched.filter((b) => b.score >= REL_MIN);

  // KPI (base = score≥4 기준)
  const totalEst = base.reduce((s, b) => s + (b.est_price ?? 0), 0);
  const kpi = {
    relevant: base.length,
    relevantAll: d.totalBids,
    ongoing: base.filter((b) => b.status === "ongoing").length,
    imminent: base.filter((b) => b.dd !== null && b.dd >= 0 && b.dd <= 3).length,
    high: base.filter((b) => b.score >= 5).length,
    client: base.filter((b) => b.clientName).length,
    watch: d.watch.length,
    new24h: base.filter((b) => b.notice_dt && now.getTime() - new Date(b.notice_dt).getTime() <= DAY).length,
    avgScore: base.length ? Math.round((base.reduce((s, b) => s + b.score, 0) / base.length) * 10) / 10 : 0,
    totalEok: Math.round((totalEst / 1e8) * 10) / 10,
    aiCoverage: base.length ? Math.round((base.filter((b) => b.has_summary).length / base.length) * 100) : 0,
  };

  // 액션 (base 기준)
  const imminent = base
    .filter((b) => b.dd !== null && b.dd >= 0 && b.dd <= 3)
    .sort((a, b) => (a.dd ?? 0) - (b.dd ?? 0))
    .slice(0, 8)
    .map((b) => ({ ...b, dday: b.dd }));
  const todayClose = base.filter((b) => b.dd === 0).length;
  const watchStat = {
    analysisNone: d.watch.filter((w) => w.analysis_status === "none").length,
    analysisInProgress: d.watch.filter((w) => w.analysis_status === "in_progress").length,
    proposalWriting: d.watch.filter((w) => w.proposal_status === "writing").length,
  };

  // 주력분야 (base 기준)
  const byField = FIELDS.map(({ cat, patterns }) => {
    const set = new Set(patterns.map((p) => p.toLowerCase()));
    const hits = base.filter((b) => (b.tags ?? []).some((t) => set.has(String(t).toLowerCase())));
    return {
      name: cat,
      count: hits.length,
      avg: hits.length ? Math.round((hits.reduce((s, b) => s + b.score, 0) / hits.length) * 10) / 10 : 0,
    };
  }).filter((x) => x.count > 0).sort((a, b) => b.count - a.count);

  // 고객사 (base 기준)
  const clientBids = base.filter((b) => b.clientName);
  const clientByCat = agg(clientBids.map((b) => b.clientCat as string)).map(([name, value]) => ({ name, value }));
  const topClients = agg(clientBids.map((b) => b.clientName as string)).slice(0, 6).map(([name, count]) => ({ name, count }));
  const healthBids = clientBids.filter((b) => b.clientCat === "의료기관" || /보건|질병|복지|건강/.test(b.clientName ?? ""));
  const healthRatio = clientBids.length ? Math.round((healthBids.length / clientBids.length) * 100) : 0;

  // 품질 (base = score≥4 분포)
  const scoreDist = [
    { name: "4", count: base.filter((b) => b.score === 4).length },
    { name: "5~9", count: base.filter((b) => b.score >= 5 && b.score <= 9).length },
    { name: "10~14", count: base.filter((b) => b.score >= 10 && b.score <= 14).length },
    { name: "15~19", count: base.filter((b) => b.score >= 15 && b.score <= 19).length },
    { name: "20+", count: base.filter((b) => b.score >= 20).length },
  ];
  const topBids = [...base].sort((a, b) => b.score - a.score).slice(0, 5);

  // 추세 (base 기준)
  const newByDay = lastNDays(21).map((d0) => ({
    date: fmtMD(d0),
    count: base.filter((b) => b.notice_dt && sameDay(new Date(b.notice_dt), d0)).length,
  }));
  const deadlineByDay = nextNDays(14).map((d0) => ({
    date: fmtMD(d0),
    count: base.filter((b) => b.deadline_dt && sameDay(new Date(b.deadline_dt), d0)).length,
  }));

  // 기관 (base 기준)
  const byOrg = agg(base.map((b) => b.order_org ?? "미지정")).slice(0, 8).map(([name, count]) => ({ name, count }));
  const byDemand = agg(base.map((b) => b.demand_org ?? "미지정")).slice(0, 8).map(([name, count]) => ({ name, count }));
  const clientVsGeneral = [
    { name: "고객사", value: clientBids.length },
    { name: "일반", value: base.length - clientBids.length },
  ];

  const lastRescore = enriched.reduce<string | null>((mx, b) => (b.rescored_at && (!mx || b.rescored_at > mx) ? b.rescored_at : mx), null);

  return {
    kpi, imminent, todayClose, watchStat, byField,
    clientByCat, topClients, healthRatio,
    scoreDist, topBids, newByDay, deadlineByDay, byOrg, byDemand, clientVsGeneral,
    brief: d.brief ? { date: d.brief.brief_date, summary: d.brief.summary } : null,
    lastCollect: d.lastCollect, lastRescore, archivedBids: d.archivedBids,
    attBidCount: d.attBidCount, rulesActive: d.rulesActive, clientsCount: d.clientsCount,
  };
}

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
function nextNDays(n: number) {
  const now = new Date();
  const t0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Array.from({ length: n }, (_, i) => new Date(t0.getTime() + i * DAY));
}
function sameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
function fmtMD(d0: Date) {
  return `${String(d0.getMonth() + 1).padStart(2, "0")}.${String(d0.getDate()).padStart(2, "0")}`;
}

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
      <p className="text-[11px] text-subtle">{label}</p>
      <p className={`mt-0.5 text-xl font-bold ${tone}`}>
        {decimal ? value.toLocaleString(undefined, { minimumFractionDigits: 0 }) : value.toLocaleString()}
        {suffix ?? ""}
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
