-- =====================================================================
-- supabase/collect_runs.sql — 수집 실행 로그 + 검증 단계 기록 (S-10 수집 모니터)
--
-- 목적: 자동(cron 4회/일)·수동("바로 수집하기") 수집 1회당 1행을 남겨
--   상태(성공/부분/실패)·건수·소요·검증 단계(checks)·오류를 시각화 대상으로 적재한다.
--   collect.mjs(배치)와 lib/collect/runner.ts(인앱)가 공통 스키마로 기록한다.
--
-- 적용: Supabase SQL Editor에 그대로 실행(멱등 — 재실행 안전).
--   schema.sql에도 동일 정의를 canonical로 반영했다(신규 배포 시 자동 생성).
-- =====================================================================

create table if not exists collect_runs (
  id           bigserial primary key,
  source       text not null default 'nara',
  trigger      text not null default 'cron'                 -- 실행 방식
               check (trigger in ('cron','manual')),
  status       text not null default 'running'              -- 실행 상태
               check (status in ('running','success','partial','failed')),
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  duration_ms  integer,
  window_bgn   text,                                        -- 조회 범위 시작(KST yyyyMMddHHmm)
  window_end   text,                                        -- 조회 범위 끝
  pages        integer not null default 0,                  -- 조회 페이지 수(스캔량)
  scanned      integer not null default 0,                  -- 조회 아이템 수
  bids_upserted    integer not null default 0,
  prices_upserted  integer not null default 0,
  changes_appended integer not null default 0,
  cursor_advanced  boolean not null default false,          -- 증분 커서 전진 여부
  error_count  integer not null default 0,
  errors       jsonb not null default '[]'::jsonb,          -- 오류 메시지 배열(앞부분만)
  checks       jsonb not null default '{}'::jsonb,          -- 검증 단계 결과(env_ok/api_reachable/upsert_ok/status_refreshed)
  triggered_by uuid,                                        -- 수동 실행자(users.user_id)
  created_at   timestamptz not null default now()
);

create index if not exists idx_collect_runs_started on collect_runs(started_at desc);

-- ---------------------------------------------------------------------
-- RLS: active 사용자 read-only. write 정책 없음 → service key(RLS 우회)만 기록.
--   수집기/API 라우트는 service key로 upsert하므로 정책 영향 없음.
--   (프론트 S-10은 서버 API(service key)를 경유해 조회하지만, 향후 직접/실시간
--    조회를 대비해 read 정책을 둔다. anon read/write는 default-deny.)
-- ---------------------------------------------------------------------
alter table collect_runs enable row level security;

drop policy if exists collect_runs_read on collect_runs;
create policy collect_runs_read on collect_runs for select
  using (app_current_role() is not null);
