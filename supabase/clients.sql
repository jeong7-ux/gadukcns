-- ============================================================================
-- 고객사 정보 수집·관리 (FR-16~20) — Supabase SQL Editor 에서 1회 실행 (schema.sql 이후)
--   테이블: clients
--   함수:   sync_client_org_rules()  — 우선 고객사 → rules(type='org') 동기화 (admin)
-- ============================================================================

create table if not exists clients (
  client_id   bigserial primary key,
  name        text not null unique,
  category    text not null check (category in
              ('중앙정부부처','지방자치단체','공공기관','의료기관','교육기관','금융기관','기타')),
  aliases     text[] default '{}',
  sector      text,
  region      text,
  is_priority boolean default true,
  weight      int default 10,
  contact_name text,
  contact_hash text,                 -- 담당자 연락처 HMAC(개인정보)
  memo        text,
  source_url  text,
  first_year  int,
  status      text default 'active' check (status in ('active','inactive')),
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);
create index if not exists idx_clients_category on clients(category);
create index if not exists idx_clients_priority on clients(is_priority);

-- RLS: active 전원 R, pm/admin W (기존 정책 패턴 준수)
alter table clients enable row level security;
drop policy if exists clients_read on clients;
create policy clients_read on clients for select
  using (app_current_role() is not null);
drop policy if exists clients_write on clients;
create policy clients_write on clients for all
  using (app_current_role() in ('pm','admin'))
  with check (app_current_role() in ('pm','admin'));

-- FR-20: 우선 고객사 → rules(type='org') 동기화. 이후 rescore_bids() 로 반영.
--   고객사명 기반 org 룰만 갱신(수동 org 룰은 보존). admin 전용.
create or replace function sync_client_org_rules() returns integer
language plpgsql
security definer
set search_path = public
as $$
declare affected integer;
begin
  if app_current_role() is distinct from 'admin' then
    raise exception 'admin 권한이 필요합니다';
  end if;
  -- 고객사명과 동일한 기존 org 룰 제거(리프레시) — 비고객 org 룰은 보존
  delete from rules where type = 'org' and pattern in (select name from clients);
  -- 활성 우선 고객사(및 별칭)를 org 룰로 재삽입
  insert into rules(type, pattern, weight, is_active)
    select 'org', name, weight, true
    from clients where is_priority and status = 'active';
  insert into rules(type, pattern, weight, is_active)
    select 'org', unnest(aliases), weight, true
    from clients where is_priority and status = 'active' and array_length(aliases,1) is not null;
  get diagnostics affected = row_count;
  return (select count(*) from rules where type = 'org' and is_active);
end $$;
