"use client";

// S-10 통계 대시보드 — FR-11. "나라장터 입찰공고 실시간 모니터링" 3열 구성.
// 설계 원천: 화면 캡처 2026-07-15 231022.png (다크 모니터링 대시보드 구성)
//   좌: 오늘의 주요 공고 요약(2×2 KPI) + 입찰 진행 현황(도넛)
//   중앙: 최신 입찰 공고 실시간 피드(테이블) + 최신 입찰 공고 추이(라인)
//   우: 지역별 입찰 공고 분포(히트바)
// 데이터 적응: 유찰/낙찰은 미수집 → 주력·고객사로 대체. 지도는 지역 히트바로 대체.
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
  PieChart,
  Pie,
  Cell,
} from "recharts";
import { getSupabaseClient } from "@/lib/supabase/client";
import { useSession } from "@/lib/auth/SessionProvider";
import { has, CAN_WATCH_WRITE } from "@/lib/auth/roles";
import { fetchDashboardData, type DashBid, type DashboardData } from "@/lib/queries/stats";
import { useRealtimeInvalidate } from "@/lib/hooks/useRealtimeInvalidate";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardHeader } from "@/components/ui/Card";
import { CollectButton } from "@/components/dashboard/CollectButton";
import { ddayInfo, type DdayBucket } from "@/lib/design/dday";
import { InfoCells, InfoHeaders } from "@/components/bids/InfoRowCells";

const DAY = 86400000;
const norm = (s: string | null) => (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();

function color(name: string, fb: string) {
  if (typeof window === "undefined") return fb;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fb;
}

// ── 행 데이터 타입 ────────────────────────────────────────────
type Row = DashBid & {
  clientName: string | null;
  demandClient: string | null; // 수요기관이 고객사면 그 고객사명(⭐·깜빡임 표시용)
  dd: number | null;
  ddLabel: string;
  ddBucket: DdayBucket;
  cat: "감리" | "컨설팅";
};

type FeedTab = "전체" | "감리" | "컨설팅";

export default function StatsPage() {
  const supabase = getSupabaseClient();
  const { role } = useSession();
  const canWatch = has(role, CAN_WATCH_WRITE);
  useRealtimeInvalidate("bids", ["dashboard"]);
  const { data, isLoading } = useQuery({
    queryKey: ["dashboard"],
    queryFn: () => fetchDashboardData(supabase),
  });

  const [q, setQ] = useState("");
  const m = useMemo(() => (data ? compute(data) : null), [data]);

  if (isLoading || !m) return <DashboardSkeleton />;

  const query = norm(q);
  const feed = query
    ? m.feed.filter((b) =>
        norm(`${b.title ?? ""} ${b.order_org ?? ""} ${b.demand_org ?? ""} ${b.bid_no}`).includes(query)
      )
    : m.feed;

  return (
    <div>
      <PageHeader
        title="나라장터 입찰공고 실시간 모니터링"
        screen="S-10"
        desc="오늘의 주요 사업(감리, 컨설팅) 공고 요약 · 실시간 피드를 한눈에 모니터링합니다."
        action={<CollectButton fallbackTime={m.lastCollect} />}
      />

      {/* 검색 바 */}
      <div className="mb-4">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="공고명 · 발주기관 · 공고번호 검색"
          className="w-full rounded-lg bg-surface px-3 py-2 text-sm text-text ring-1 ring-border placeholder:text-subtle focus:outline-none focus:ring-2 focus:ring-primary"
        />
      </div>

      {/* 상단: 좌(요약·도넛, 고정폭) · 피드(나머지 최대폭) */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[560px_minmax(0,1fr)]">
        {/* ── 좌 컬럼 ── */}
        <div className="space-y-4">
          <SummaryKpis m={m} canWatch={canWatch} />
          <ProgressDonut m={m} />
        </div>

        {/* ── 피드: 좌측(요약+입찰 마감 현황) 높이에 맞춰 하단 정렬 ──
             absolute로 행 높이 계산에서 제외 → 그리드 행은 좌측 컬럼 높이로 고정, 목록은 그 안에서 스크롤 */}
        <div className="relative min-h-0">
          <div className="absolute inset-0 flex flex-col">
            <FeedTable rows={feed} />
          </div>
        </div>
      </div>

      {/* 하단: 분류별 추이 (감리 / 컨설팅) */}
      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <TrendChart title="최근 감리 입찰 공고 추이" data={m.trendGamri} colorVar="--color-primary" fb="#1F497D" />
        <TrendChart title="최근 컨설팅 입찰 공고 추이" data={m.trendConsult} colorVar="--color-accent" fb="#2563EB" />
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// 좌. 오늘의 주요 공고 요약 (2×2 KPI)
// ═══════════════════════════════════════════════════════════════
// KPI 클릭 → S-04 입찰 목록으로 이동(해당 조건 쿼리 파라미터 전달).
function SummaryKpis({ m, canWatch }: { m: Metrics; canWatch: boolean }) {
  return (
    <Card>
      <CardHeader
        title="입찰 공고 요약"
        action={
          canWatch && (
            <Link
              href="/watchlist"
              title="관심 목록으로 이동"
              className="inline-flex items-center gap-1.5 rounded-lg bg-dday-soon px-4 py-2 text-base font-bold text-white shadow-card transition hover:opacity-90"
            >
              <span className="text-lg">⭐</span> 관심 등록 {m.kpi.watch}
            </Link>
          )
        }
      />
      <div className="grid grid-cols-2 gap-4 p-5">
        <KpiTile label="당일신규" value={m.kpi.todayNew} tone="text-success" href="/dashboard?new=today" />
        <KpiTile label="감리" value={m.kpi.gamri} tone="text-primary" href="/dashboard?cat=감리" />
        <KpiTile label="컨설팅" value={m.kpi.consult} tone="text-accent" href="/dashboard?cat=컨설팅" />
        <KpiTile label="전체공고" value={m.kpi.total} tone="text-text" href="/dashboard?view=all" />
      </div>
    </Card>
  );
}

function KpiTile({ label, value, tone, href }: { label: string; value: number; tone: string; href?: string }) {
  const body = (
    <div className="rounded-card bg-bg p-6 ring-1 ring-border">
      <p className="truncate text-sm text-subtle">{label}</p>
      <p className={`mt-3 text-5xl font-bold leading-none ${tone}`}>{value.toLocaleString()}</p>
    </div>
  );
  return href ? (
    <Link href={href} className="block transition-transform hover:-translate-y-0.5">
      {body}
    </Link>
  ) : (
    body
  );
}

// ═══════════════════════════════════════════════════════════════
// 좌. 입찰 진행 현황 (도넛 — 마감 임박도 분포)
// ═══════════════════════════════════════════════════════════════
function ProgressDonut({ m }: { m: Metrics }) {
  const colors = m.donut.map((d) => color(d.colorVar, d.fb));
  const total = m.donut.reduce((s, d) => s + d.value, 0);
  return (
    <Card>
      <CardHeader title="입찰 마감 현황" action={<span className="text-xs text-subtle">노출 {total}건</span>} />
      <div className="p-4">
        {total === 0 ? (
          <p className="py-10 text-center text-sm text-subtle">데이터 없음</p>
        ) : (
          <div className="flex items-center gap-6">
            <div className="relative h-60 w-60 shrink-0">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={m.donut}
                    dataKey="value"
                    nameKey="label"
                    innerRadius={76}
                    outerRadius={112}
                    paddingAngle={2}
                    isAnimationActive={false}
                    stroke="none"
                  >
                    {m.donut.map((_, i) => (
                      <Cell key={i} fill={colors[i]} />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={{
                      background: "var(--color-surface)",
                      border: "1px solid var(--color-border)",
                      borderRadius: 8,
                      color: "var(--color-text)",
                      fontSize: 12,
                    }}
                  />
                </PieChart>
              </ResponsiveContainer>
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                <span className="text-5xl font-bold text-text">{total}</span>
                <span className="text-sm text-subtle">건</span>
              </div>
            </div>
            <ul className="min-w-0 flex-1 space-y-3">
              {m.donut.map((d, i) => (
                <li key={d.key} className="flex items-center gap-2.5 text-[15px]">
                  <span className="h-3 w-3 shrink-0 rounded-sm" style={{ background: colors[i] }} />
                  <span className="min-w-0 flex-1 truncate text-subtle">{d.label}</span>
                  <span className="font-semibold text-text">{d.value}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Card>
  );
}

// ═══════════════════════════════════════════════════════════════
// 중앙. 최신 입찰 공고 실시간 피드 (테이블)
// ═══════════════════════════════════════════════════════════════
function FeedTable({ rows }: { rows: Row[] }) {
  const [tab, setTab] = useState<FeedTab>("전체");
  const counts = {
    전체: rows.length,
    감리: rows.filter((b) => b.cat === "감리").length,
    컨설팅: rows.filter((b) => b.cat === "컨설팅").length,
  };
  const filtered = tab === "전체" ? rows : rows.filter((b) => b.cat === tab);
  const view = filtered; // 전체 렌더(보드 내부 스크롤)
  return (
    <Card className="flex min-h-0 flex-1 flex-col">
      <CardHeader title="입찰 정보 목록" action={<span className="text-xs text-subtle">수집일 최신순</span>} />
      {/* 탭: 전체 / 감리 / 컨설팅 */}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-3 py-2">
        {(["전체", "감리", "컨설팅"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`rounded-full px-3 py-1 text-xs font-medium ring-1 transition ${
              tab === t ? "bg-primary text-white ring-primary" : "bg-bg text-subtle ring-border hover:text-text"
            }`}
          >
            {t} <span className="opacity-70">{counts[t]}</span>
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full min-w-[560px] text-left text-xs">
          <thead className="sticky top-0 z-10 border-b border-border bg-surface text-subtle">
            <tr>
              <InfoHeaders />
            </tr>
          </thead>
          <tbody>
            {view.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-subtle">
                  {tab === "전체" ? "표시할 공고가 없습니다." : `${tab} 공고가 없습니다.`}
                </td>
              </tr>
            ) : (
              view.map((b) => (
                <tr
                  key={`${b.bid_no}-${b.bid_seq}`}
                  className={`border-b border-border/60 hover:bg-bg ${b.clientName ? "bg-success/5" : ""}`}
                >
                  <InfoCells
                    bidNo={b.bid_no}
                    title={b.title}
                    orderOrg={b.order_org}
                    demandOrg={b.demand_org}
                    noticeDt={b.notice_dt}
                    deadlineDt={b.deadline_dt}
                    estPrice={b.est_price}
                    needsReview={b.needs_review}
                    demandClient={b.demandClient}
                  />
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ═══════════════════════════════════════════════════════════════
// 중앙. 최신 입찰 공고 추이 (라인차트 — 일별 신규 등록)
// ═══════════════════════════════════════════════════════════════
function TrendChart({
  title,
  data,
  colorVar,
  fb,
}: {
  title: string;
  data: { date: string; count: number }[];
  colorVar: string;
  fb: string;
}) {
  const cSubtle = color("--color-text-subtle", "#64748b");
  const cLine = color(colorVar, fb);
  return (
    <Card>
      <CardHeader title={title} action={<span className="text-xs text-subtle">일별 신규 등록 · 21일</span>} />
      <div className="h-56 p-4">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
            <XAxis dataKey="date" tick={{ fontSize: 10, fill: cSubtle }} interval={3} />
            <YAxis tick={{ fontSize: 11, fill: cSubtle }} allowDecimals={false} width={24} />
            <Tooltip
              contentStyle={{
                background: "var(--color-surface)",
                border: "1px solid var(--color-border)",
                borderRadius: 8,
                color: "var(--color-text)",
                fontSize: 12,
              }}
              labelStyle={{ color: "var(--color-text)", fontWeight: 600 }}
            />
            <Line
              isAnimationActive={false}
              type="monotone"
              dataKey="count"
              name="신규 등록"
              stroke={cLine}
              strokeWidth={2}
              dot={{ r: 2 }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}

// ═══════════════════════════════════════════════════════════════
// 집계 로직
// ═══════════════════════════════════════════════════════════════
type Metrics = ReturnType<typeof compute>;

function compute(d: DashboardData) {
  // 고객사 매칭
  const clients = d.clients.map((c) => ({
    name: c.name,
    keys: [c.name, ...(c.aliases ?? [])].map(norm).filter(Boolean),
  }));
  const matchClient = (b: DashBid) => {
    const hay = norm(`${b.order_org ?? ""} ${b.demand_org ?? ""}`);
    return clients.find((c) => c.keys.some((k) => hay.includes(k)))?.name ?? null;
  };
  // 단일 기관 문자열이 고객사인지 판정(수요기관 ⭐ 표시용)
  const matchOrgClient = (org: string | null) => {
    const hay = norm(org ?? "");
    if (!hay) return null;
    return clients.find((c) => c.keys.some((k) => hay.includes(k)))?.name ?? null;
  };

  // 분류(감리/컨설팅): keyword_groups title 매칭. 감리 그룹 우선.
  const lc = (s: string | null | undefined) => (s ?? "").toLowerCase();
  const gamriGroups = d.groups.filter((g) => g.name.includes("감리"));
  const classify = (title: string | null): "감리" | "컨설팅" => {
    const t = lc(title);
    const isGamri = gamriGroups.some(
      (g) =>
        (g.keywords ?? []).some((k) => k && t.includes(lc(k))) &&
        !(g.exclude ?? []).some((ex) => ex && t.includes(lc(ex)))
    );
    return isGamri ? "감리" : "컨설팅";
  };

  const rows: Row[] = d.bids.map((b) => {
    const info = ddayInfo(b.deadline_dt);
    return {
      ...b,
      clientName: matchClient(b),
      demandClient: matchOrgClient(b.demand_org),
      dd: info.days,
      ddLabel: info.label,
      ddBucket: info.bucket,
      // 수집 시 AI 분류(biz_category)를 권위값으로. 없으면 키워드 분류 폴백.
      cat: b.biz_category ?? classify(b.title),
    };
  });

  // ── 오늘의 주요 공고 요약 (2×2): 당일신규 · 감리 · 컨설팅 · 전체공고 ──
  const todayD = new Date();
  const isToday = (b: Row) => (b.notice_dt ? sameDay(new Date(b.notice_dt), todayD) : false);
  const kpi = {
    todayNew: rows.filter(isToday).length,
    gamri: rows.filter((b) => b.cat === "감리").length,
    consult: rows.filter((b) => b.cat === "컨설팅").length,
    total: rows.length,
    watch: d.watch.length, // 관심 등록(watchlist) 건수
  };

  // ── 입찰 진행 현황 (도넛 — 마감 임박도) ──
  const donut = [
    { key: "today", label: "오늘 마감", value: rows.filter((b) => b.dd === 0).length, colorVar: "--color-dday-urgent", fb: "#dc2626" },
    { key: "soon", label: "임박 (1~3일)", value: rows.filter((b) => b.dd !== null && b.dd >= 1 && b.dd <= 3).length, colorVar: "--color-dday-soon", fb: "#f97316" },
    { key: "week", label: "이번주 (4~7일)", value: rows.filter((b) => b.dd !== null && b.dd >= 4 && b.dd <= 7).length, colorVar: "--color-dday-near", fb: "#eab308" },
    { key: "far", label: "여유 (8일+)", value: rows.filter((b) => b.dd !== null && b.dd >= 8).length, colorVar: "--color-success", fb: "#16a34a" },
    { key: "none", label: "마감 미정", value: rows.filter((b) => b.dd === null).length, colorVar: "--color-text-subtle", fb: "#94a3b8" },
  ].filter((x) => x.value > 0);

  // ── 입찰 목록 (수집일=공고 등록일 기준 최신순). 탭(전체/감리/컨설팅)은 FeedTable에서 분기 ──
  const feed = [...rows].sort((a, b) => {
    const ta = a.notice_dt ? new Date(a.notice_dt).getTime() : 0;
    const tb = b.notice_dt ? new Date(b.notice_dt).getTime() : 0;
    return tb - ta; // 수집일 최신순
  });

  // ── 분류별 입찰 공고 추이 (일별 신규 등록, 21일) — 감리 / 컨설팅 ──
  //   마감 무관: 노출(마감전)이 아니라 전체 감리/컨설팅(d.trendBids)에서 공고일 기준 집계.
  const days = lastNDays(21);
  const trendFor = (cat: "감리" | "컨설팅") =>
    days.map((d0) => ({
      date: fmtMD(d0),
      count: d.trendBids.filter((b) => b.biz_category === cat && b.notice_dt && sameDay(new Date(b.notice_dt), d0)).length,
    }));
  const trendGamri = trendFor("감리");
  const trendConsult = trendFor("컨설팅");

  // 최근 업데이트 일자: 수집 커서(last_reg_dt) 우선, 없으면 최신 공고 등록일로 폴백.
  const maxNotice = rows.reduce<string | null>(
    (mx, b) => (b.notice_dt && (!mx || b.notice_dt > mx) ? b.notice_dt : mx),
    null
  );

  return {
    kpi,
    donut,
    feed,
    trendGamri,
    trendConsult,
    lastCollect: d.lastCollect ?? maxNotice,
  };
}

// ── 유틸 ─────────────────────────────────────
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

// ── 로딩 스켈레톤 ─────────────────────────────
function DashboardSkeleton() {
  const Block = ({ className = "" }: { className?: string }) => (
    <div className={`animate-pulse rounded-card bg-border/40 ${className}`} />
  );
  return (
    <div>
      <PageHeader
        title="나라장터 입찰공고 실시간 모니터링"
        screen="S-10"
        desc="실시간 모니터링 데이터를 불러오는 중…"
      />
      <Block className="mb-4 h-10" />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[560px_minmax(0,1fr)]">
        <div className="space-y-4">
          <Block className="h-52" />
          <Block className="h-72" />
        </div>
        <div className="space-y-4">
          <Block className="h-[28rem]" />
        </div>
      </div>
      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Block className="h-64" />
        <Block className="h-64" />
      </div>
    </div>
  );
}
