-- ============================================================================
-- 룰 기준 공고 정리 (DB Cleanup by Scoring Rules) — S-04 admin 기능용
-- Supabase Dashboard > SQL Editor 에서 1회 실행. (schema.sql 적용 이후)
--   추가: bids.archived_at 컬럼, cleanup_log 테이블
--   함수: cleanup_bids(...)  — 미리보기(dry_run) 겸 실행(archive/delete)
--         restore_bids()     — 아카이브 전체 복구
-- 모두 admin 전용(SECURITY DEFINER, app_current_role() 가드).
-- ============================================================================

-- 1) 소프트 아카이브 컬럼 + 인덱스
alter table bids add column if not exists archived_at timestamptz;
create index if not exists idx_bids_archived on bids(archived_at);

-- 2) 감사 로그
create table if not exists cleanup_log (
  id       bigserial primary key,
  actor    uuid,
  threshold int,
  mode     text,
  affected int,
  at       timestamptz default now()
);
alter table cleanup_log enable row level security;
drop policy if exists cleanup_log_admin on cleanup_log;
create policy cleanup_log_admin on cleanup_log for select
  using (app_current_role() = 'admin');

-- 3) 정리 함수 — dry_run=true면 대상 건수만, false면 정리 후 처리 건수 반환
create or replace function cleanup_bids(
  p_threshold int default 1,               -- score < threshold 가 정리 대상 (기본 1 → score 0 이하)
  p_protect_enriched boolean default true, -- AI 요약 완료분(ai_flags.summary_ok) 보호
  p_protect_recent_days int default 7,     -- 최근 N일 등록 공고 보호(0이면 미보호)
  p_mode text default 'archive',           -- 'archive' | 'delete'
  p_dry_run boolean default true
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare affected integer;
begin
  if app_current_role() is distinct from 'admin' then
    raise exception 'admin 권한이 필요합니다';
  end if;
  if p_mode not in ('archive','delete') then
    raise exception 'mode 는 archive 또는 delete 여야 합니다';
  end if;

  -- 미리보기
  if p_dry_run then
    select count(*) into affected
    from bids b
    where b.score < p_threshold
      and b.archived_at is null
      and not exists (select 1 from watchlist w where w.bid_no = b.bid_no and w.bid_seq = b.bid_seq)
      and (not p_protect_enriched or coalesce((b.ai_flags->>'summary_ok')::boolean, false) = false)
      and (p_protect_recent_days <= 0 or b.notice_dt is null
           or b.notice_dt < now() - make_interval(days => p_protect_recent_days));
    return affected;
  end if;

  -- 실행: 소프트 아카이브
  if p_mode = 'archive' then
    update bids b set archived_at = now(), updated_at = now()
    where b.score < p_threshold
      and b.archived_at is null
      and not exists (select 1 from watchlist w where w.bid_no = b.bid_no and w.bid_seq = b.bid_seq)
      and (not p_protect_enriched or coalesce((b.ai_flags->>'summary_ok')::boolean, false) = false)
      and (p_protect_recent_days <= 0 or b.notice_dt is null
           or b.notice_dt < now() - make_interval(days => p_protect_recent_days));
    get diagnostics affected = row_count;

  -- 실행: 영구 삭제 (연관 테이블 → bids)
  else
    with tgt as (
      select b.bid_no, b.bid_seq
      from bids b
      where b.score < p_threshold
        and not exists (select 1 from watchlist w where w.bid_no = b.bid_no and w.bid_seq = b.bid_seq)
        and (not p_protect_enriched or coalesce((b.ai_flags->>'summary_ok')::boolean, false) = false)
        and (p_protect_recent_days <= 0 or b.notice_dt is null
             or b.notice_dt < now() - make_interval(days => p_protect_recent_days))
    ),
    d_att as (delete from bid_attachments a using tgt t where a.bid_no = t.bid_no and a.bid_seq = t.bid_seq returning 1),
    d_pr  as (delete from bid_prices  p using tgt t where p.bid_no = t.bid_no returning 1),
    d_ch  as (delete from bid_changes c using tgt t where c.bid_no = t.bid_no returning 1),
    d_bd  as (delete from bids        b using tgt t where b.bid_no = t.bid_no and b.bid_seq = t.bid_seq returning 1)
    select count(*) into affected from d_bd;
  end if;

  insert into cleanup_log(actor, threshold, mode, affected, at)
    values (auth.uid(), p_threshold, p_mode, affected, now());
  return affected;
end $$;

-- 4) 복구 함수 — 아카이브(archived_at 세팅)된 공고를 전체 복구
create or replace function restore_bids() returns integer
language plpgsql
security definer
set search_path = public
as $$
declare affected integer;
begin
  if app_current_role() is distinct from 'admin' then
    raise exception 'admin 권한이 필요합니다';
  end if;
  update bids set archived_at = null, updated_at = now() where archived_at is not null;
  get diagnostics affected = row_count;
  return affected;
end $$;
