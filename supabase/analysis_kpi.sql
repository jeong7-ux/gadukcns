-- ============================================================================
-- 1페이지상세요약 KPI 파싱 결과 저장 (FR-28 안) — SQL Editor에서 1회 실행
--   analysis_reports(1페이지상세요약) HTML의 hdr-kpi/go 블록 → 정형 지표
--   설계 원칙: ① 원문(kpi_raw) 무손실 보존 ② 정규화 실패는 null+warning(드롭 금지)
--              ③ 공고 연결은 (bid_no,bid_seq) — bids 하드삭제와 무관하게 생존
-- ============================================================================

create table if not exists bid_analysis_kpi (
  bid_no   text not null,
  bid_seq  text not null default '00',

  -- 출처 파일(재업로드 시 교체·삭제 시 함께 정리)
  report_id       bigint references analysis_reports(id) on delete cascade,
  source_doc_type text not null default '1페이지상세요약',

  -- 정규화 지표 (파싱 실패 시 null — kpi_raw로 사람이 확인)
  audit_budget_krw    bigint,        -- 감리예산(원, 부가세 포함 표기 그대로)
  audit_ratio_pct_min numeric(6,2),  -- 감리비율(%) 하한 (단일값이면 min=max)
  audit_ratio_pct_max numeric(6,2),
  effort_md_min       numeric(7,1),  -- 투입공수(MD) 하한 (단일값이면 min=max)
  effort_md_max       numeric(7,1),
  target_budget_krw   bigint,        -- 대상사업 구축비(원)
  toxic_total         int,           -- 독소조항 건수
  toxic_high          int,
  toxic_mid           int,
  toxic_low           int,
  go_decision text check (go_decision in ('go','conditional_go','no_go','unknown')),
  go_reason   text,                  -- 예: "조건부 수주 권고"

  -- 무손실 원문 + 감사
  kpi_raw        jsonb not null,     -- [{label,value,unit}, ...] 화면 표기 그대로
  extra_kpis     jsonb,              -- 라벨 가변 슬롯(요구사항·MD단가 등)
  parse_warnings text[],             -- 정규화 실패/모호 항목
  parser_version text,
  parsed_at      timestamptz default now(),

  primary key (bid_no, bid_seq)      -- 공고당 1행(재업로드 시 upsert 교체)
);
create index if not exists idx_ankpi_report on bid_analysis_kpi(report_id);
create index if not exists idx_ankpi_go on bid_analysis_kpi(go_decision);

alter table bid_analysis_kpi enable row level security;
drop policy if exists ankpi_read on bid_analysis_kpi;
create policy ankpi_read on bid_analysis_kpi for select
  using (app_current_role() is not null);            -- active 전원 열람
drop policy if exists ankpi_write on bid_analysis_kpi;
create policy ankpi_write on bid_analysis_kpi for all
  using (app_current_role() = 'admin')               -- 파싱/수정은 admin(서버)
  with check (app_current_role() = 'admin');

-- 편의 뷰: 공고 + KPI 조인 (S-07/S-06 표시용)
create or replace view v_bid_analysis_kpi as
  select k.*,
         b.title, b.order_org, b.demand_org, b.est_price, b.deadline_dt, b.biz_category,
         -- 검증신호: 감리예산 ÷ 추정가격 (부가세 포함 표기면 ≈1.10)
         case when b.est_price > 0
              then round(k.audit_budget_krw::numeric / b.est_price, 4) end as budget_vs_est_ratio
  from bid_analysis_kpi k
  left join bids b on b.bid_no = k.bid_no and b.bid_seq = k.bid_seq;
