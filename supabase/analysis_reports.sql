-- ============================================================================
-- AI 분석 워크플로우 & 결과파일 업로드 (FR-21~24) — SQL Editor에서 1회 실행
--   watchlist 확장 + analysis_reports 테이블 + Storage 버킷/정책
-- ============================================================================

-- 1) watchlist 확장 (분석요청 상태 + 타임스탬프)
alter table watchlist add column if not exists analysis_requested_at timestamptz;
alter table watchlist add column if not exists analysis_requested_by uuid references users(user_id);
alter table watchlist add column if not exists analysis_done_at timestamptz;

-- analysis_status CHECK 에 'requested' 추가 ('none','requested','in_progress','done')
alter table watchlist drop constraint if exists watchlist_analysis_status_check;
alter table watchlist add constraint watchlist_analysis_status_check
  check (analysis_status in ('none','requested','in_progress','done'));

-- 2) analysis_reports — AI 분석 결과파일 메타
create table if not exists analysis_reports (
  id           bigserial primary key,
  bid_no       text not null,
  bid_seq      text not null default '00',
  doc_type     text not null check (doc_type in
               ('분석보고서','1페이지상세요약','1페이지인포그래픽','PT요약보고서',
                '영역별감리계획','논리구조서','통합감리제안서초안')),
  file_name    text not null,
  storage_path text not null,
  size_bytes   bigint,
  uploaded_by  uuid references users(user_id),
  uploaded_at  timestamptz default now(),
  unique (bid_no, bid_seq, doc_type)  -- 종류별 1건(재업로드 시 교체)
);
create index if not exists idx_anrep_bid on analysis_reports(bid_no, bid_seq);

alter table analysis_reports enable row level security;
drop policy if exists anrep_read on analysis_reports;
create policy anrep_read on analysis_reports for select
  using (app_current_role() is not null);              -- active 전원 열람
drop policy if exists anrep_write on analysis_reports;
create policy anrep_write on analysis_reports for all
  using (app_current_role() = 'admin')                 -- admin 업로드/삭제
  with check (app_current_role() = 'admin');

-- 3) Storage 버킷(private) + 정책
insert into storage.buckets (id, name, public)
  values ('analysis-reports', 'analysis-reports', false)
  on conflict (id) do nothing;

-- active 전원 read(서명URL), admin write
drop policy if exists "anrep_obj_read" on storage.objects;
create policy "anrep_obj_read" on storage.objects for select
  using (bucket_id = 'analysis-reports' and app_current_role() is not null);
drop policy if exists "anrep_obj_write" on storage.objects;
create policy "anrep_obj_write" on storage.objects for insert
  with check (bucket_id = 'analysis-reports' and app_current_role() = 'admin');
drop policy if exists "anrep_obj_update" on storage.objects;
create policy "anrep_obj_update" on storage.objects for update
  using (bucket_id = 'analysis-reports' and app_current_role() = 'admin');
drop policy if exists "anrep_obj_delete" on storage.objects;
create policy "anrep_obj_delete" on storage.objects for delete
  using (bucket_id = 'analysis-reports' and app_current_role() = 'admin');
