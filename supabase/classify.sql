-- =====================================================================
-- supabase/classify.sql — 수집 시 AI 사업분류 게이트 (기능상세정의서 v1.1)
--   · bids 에 분류 결과 컬럼(biz_category, classify)
--   · bid_classifications 결정 캐시/감사 테이블 + RLS
--   · collect_runs 에 분류 통계 jsonb(classify) 확장
--
-- 적용: Supabase SQL Editor 실행(멱등). 미적용 시에도 수집기는 동작하되
--   분류결과 컬럼/캐시 기록은 생략된다(러너가 스키마 존재 여부를 감지·폴백).
-- =====================================================================

-- 4.1 bids 분류 컬럼 --------------------------------------------------
alter table bids add column if not exists biz_category text
  check (biz_category in ('감리','컨설팅'));         -- 적재 공고의 확정 분류(보류는 제안값+needs_review)
alter table bids add column if not exists classify jsonb;  -- {method,confidence,reason,model,at,needs_review}
create index if not exists idx_bids_bizcat on bids(biz_category);
create index if not exists idx_bids_needs_review on bids((classify->>'needs_review'));

-- 4.2 bid_classifications 결정 캐시/감사(경량, raw 미저장) --------------
create table if not exists bid_classifications (
  bid_no      text not null,
  bid_seq     text not null default '00',
  category    text not null check (category in ('감리','컨설팅','해당없음','보류','오류')),
  confidence  numeric(4,3),
  reason      text,
  method      text not null default 'llm' check (method in ('llm','rule','manual')),
  model       text,
  title       text,
  order_org   text,
  prefilter_base int,
  decided_at  timestamptz not null default now(),
  primary key (bid_no, bid_seq)
);
create index if not exists idx_bidcls_category on bid_classifications(category);
create index if not exists idx_bidcls_decided on bid_classifications(decided_at desc);

-- 4.3 RLS: active read-only, write=service key 전용 ------------------
alter table bid_classifications enable row level security;
drop policy if exists bidcls_read on bid_classifications;
create policy bidcls_read on bid_classifications for select
  using (app_current_role() is not null);

-- 9. collect_runs 분류 통계 확장 -------------------------------------
--   {candidates,llm_calls,kept_감리,kept_컨설팅,pending_review,dropped,llm_errors,est_cost}
--   collect_runs(수집 모니터, supabase/collect_runs.sql)가 선행이지만, classify.sql 단독
--   실행에서도 실패하지 않도록 없으면 안전 생성(멱등)한 뒤 컬럼을 추가한다.
create table if not exists collect_runs (
  id           bigserial primary key,
  source       text not null default 'nara',
  trigger      text not null default 'cron' check (trigger in ('cron','manual')),
  status       text not null default 'running' check (status in ('running','success','partial','failed')),
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  duration_ms  integer,
  window_bgn   text,
  window_end   text,
  pages        integer not null default 0,
  scanned      integer not null default 0,
  bids_upserted    integer not null default 0,
  prices_upserted  integer not null default 0,
  changes_appended integer not null default 0,
  cursor_advanced  boolean not null default false,
  error_count  integer not null default 0,
  errors       jsonb not null default '[]'::jsonb,
  checks       jsonb not null default '{}'::jsonb,
  triggered_by uuid,
  created_at   timestamptz not null default now()
);
create index if not exists idx_collect_runs_started on collect_runs(started_at desc);
alter table collect_runs enable row level security;
drop policy if exists collect_runs_read on collect_runs;
create policy collect_runs_read on collect_runs for select
  using (app_current_role() is not null);

alter table collect_runs add column if not exists classify jsonb not null default '{}'::jsonb;
