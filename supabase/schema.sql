-- =====================================================================
-- 나라장터 입찰정보시스템 — Supabase(PostgreSQL 15) 스키마
-- Source: 기능상세정의서 v1.0 (PRD v2.5) — 4장(데이터 모델)/6장(RLS)/8장(보안)
-- Author: data-architect (팀 기반 계약 파일 — single source of truth)
--
-- 작성 순서: 확장 → 테이블(4.2~4.7) → 인덱스 → app_current_role() → RLS(4.8)
--
-- 주의: 원본 정의서의 한글 주석/일부 CHECK enum 값이 인코딩으로 깨져 있어,
--       의미를 복원(추정)하여 명확히 표기함. 복원 항목은 [복원] 표시.
-- Supabase 적용: SQL Editor에서 본 파일 실행. pgcrypto/vector 확장은
--       Supabase Dashboard > Database > Extensions 에서 활성화 가능(아래 자동 생성).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 4.1 확장 & 공용 함수
-- ---------------------------------------------------------------------
create extension if not exists pgcrypto;   -- gen_random_uuid(), HMAC 등 암호 함수
create extension if not exists vector;     -- pgvector (임베딩 vector 타입)
-- (선택) 키 보관: pgsodium / Supabase Vault — 운영 환경에서 별도 활성화

-- 참고: RLS 판정 함수 app_current_role() 은 public.users 를 참조하므로,
--   users 테이블 생성 이후(아래 4.8 RLS 섹션 직전)에 정의한다.
--   (SQL 언어 함수는 생성 시점에 본문을 검증하여, users 가 없으면 42P01 실패)

-- ---------------------------------------------------------------------
-- 4.2 users — 사용자/부서/역할/상태 (FR-01)
--   Supabase Auth와 1:1(user_id = auth.uid()). 개인정보는 해시로만 저장.
--   상태 흐름: unverified → pending → active / rejected / suspended (6.2)
-- ---------------------------------------------------------------------
create table if not exists users (
  user_id  uuid primary key default gen_random_uuid(),   -- = Supabase Auth uid
  email_hash text unique not null,                        -- 이메일 HMAC-SHA256 (평문 금지)
  name     text not null,
  dept     text not null
           check (dept in ('경영진','전략기획','사업관리','경영지원')), -- [복원] 부서 4종
  role     text not null
           check (role in ('exec','strategy','pm','admin')),           -- 권한 역할 (6.1)
  status   text not null default 'unverified'
           check (status in ('unverified','pending','active','rejected','suspended')),
  phone_hash text,                                        -- 전화번호 HMAC-SHA256(선택)
  subscribe_cond jsonb default '{}'::jsonb,               -- 개인 구독/알림 조건(키워드 등)
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ---------------------------------------------------------------------
-- 4.3 keyword_groups — 검색 키워드 그룹 (FR-13)
--   예: name='SI', keywords=ARRAY['SI','시스템통합'], match_logic AND/OR
-- ---------------------------------------------------------------------
create table if not exists keyword_groups (
  group_id bigserial primary key,
  name     text not null,                                 -- 그룹명 예: 'SI','정보화','유지보수'
  keywords text[] not null,                               -- 포함 키워드 배열
  match_logic text not null default 'OR'
              check (match_logic in ('AND','OR')),        -- 매칭 로직
  exclude  text[] default '{}',                           -- 제외 키워드
  owner    uuid references users(user_id),
  created_at timestamptz default now()
);

-- ---------------------------------------------------------------------
-- 4.4 bids — 입찰공고 (FR-02, AI 컬럼 포함)
--   PK=(bid_no, bid_seq) → 수집 upsert 키. status는 deadline 기준 생성 컬럼(FR-14).
-- ---------------------------------------------------------------------
create table if not exists bids (
  bid_no   text not null,                                 -- 공고번호
  bid_seq  text not null default '00',                    -- 공고 차수
  title    text,                                          -- 공고명
  order_org text,                                         -- 발주기관
  demand_org text,                                        -- 수요기관
  contract_method text,                                   -- 계약방법
  notice_dt timestamptz,                                  -- 공고일시 (FR-14/15 기준)
  deadline_dt timestamptz,                                -- 입찰/마감일시
  open_dt   timestamptz,                                  -- 개찰일시
  est_price bigint,                                       -- 추정가격
  -- FR-14 마감상태. 생성 컬럼 불가(식이 current_date에 의존 → not immutable, 42P17).
  -- 시간상대 값이므로 "읽는 시점 파생"이 정답:
  --   · 프론트: deadline_dt로 pill 실시간 파생(무staleness, D-day와 동일 소스)
  --   · 서버 필터(.eq('status',...)): 일 배치(07:00)에서 아래 컬럼을 재계산해 채움
  status   text check (status in ('ongoing','today','closed')),
  score    int default 0,                                 -- 룰 기반 점수 (FR-05)
  tags     text[],                                        -- 태그 배열
  ai_summary text,                                        -- AI 요약 (FR-06)
  ai_score int,                                           -- AI 적합도 점수(옵션 B)
  ai_flags jsonb,                                         -- AI 플래그/부가정보
  embedding vector(1024),                                 -- bge-m3 임베딩(옵션 B)
  raw      jsonb,                                         -- 원본 API 응답 보관
  updated_at timestamptz default now(),
  primary key (bid_no, bid_seq)
);
create index if not exists idx_bids_notice   on bids(notice_dt desc);
create index if not exists idx_bids_deadline on bids(deadline_dt);
create index if not exists idx_bids_status   on bids(status);
create index if not exists idx_bids_embed
  on bids using ivfflat (embedding vector_cosine_ops) with (lists = 100);

-- FR-14 마감상태 재계산 (수집 실행 시 RPC로 호출; 날짜 경계에서만 값 변동).
-- 일반 UPDATE라 immutability 제약과 무관. 서버측 .eq('status',...) 필터를 당일 기준으로 신선화.
--
-- 기준 = **유효 마감** coalesce(deadline_dt, open_dt).
--   나라장터는 협상계약류 공고에 bidClseDt를 빈 문자열로 주는 경우가 있어 deadline_dt가 null이 된다
--   (실측 30/30). 이때 opengDt(개찰일시)는 항상 있으므로 이를 폴백 기준으로 쓴다 —
--   앱의 노출 필터(lib/queries/deadline.ts notClosedOr)·D-day 표시와 **동일 기준**.
--   둘 다 없으면 판단 근거가 없으므로 null(fail-open).
create or replace function refresh_bids_status() returns void
language sql
as $$
  update bids set status =
    case when coalesce(deadline_dt, open_dt) is null then null
         when coalesce(deadline_dt, open_dt)::date > current_date then 'ongoing'
         when coalesce(deadline_dt, open_dt)::date = current_date then 'today'
         else 'closed' end
  where status is distinct from
    (case when coalesce(deadline_dt, open_dt) is null then null
          when coalesce(deadline_dt, open_dt)::date > current_date then 'ongoing'
          when coalesce(deadline_dt, open_dt)::date = current_date then 'today'
          else 'closed' end);
$$;

-- FR-05 재스코어링 — 현재 rules 로 전체 bids 의 score/tags 를 재계산.
--   S-12 '재스코어링' 버튼이 RPC 로 호출(admin 전용). SECURITY DEFINER 로 RLS 우회 업데이트.
--   매칭 로직은 scripts/ai.mjs scoreBid 와 동일: 소문자화 + 공백 정규화 후 substring 포함.
--   keyword/contract → +weight, org → +weight(가중), exclude → -weight. tags = 매칭 패턴(제외 제외).
create or replace function rescore_bids() returns integer
language plpgsql
security definer
set search_path = public
as $$
declare affected integer;
begin
  if app_current_role() is distinct from 'admin' then
    raise exception 'admin 권한이 필요합니다';
  end if;

  with b as (
    select bid_no, bid_seq,
      regexp_replace(lower(concat_ws(' ', coalesce(title,''), coalesce(order_org,''), coalesce(demand_org,''), coalesce(contract_method,''))), '\s+', ' ', 'g') as hay_all,
      regexp_replace(lower(coalesce(contract_method,'')), '\s+', ' ', 'g') as hay_ct,
      regexp_replace(lower(concat_ws(' ', coalesce(order_org,''), coalesce(demand_org,''))), '\s+', ' ', 'g') as hay_org
    from bids
  ),
  m as (  -- 매칭된 (bid, rule) 조합
    select b.bid_no, b.bid_seq, r.type, r.pattern, r.weight
    from b
    join rules r on r.is_active and (
      (r.type in ('keyword','exclude') and position(regexp_replace(lower(r.pattern), '\s+', ' ', 'g') in b.hay_all) > 0) or
      (r.type = 'contract' and position(regexp_replace(lower(r.pattern), '\s+', ' ', 'g') in b.hay_ct) > 0) or
      (r.type = 'org'      and position(regexp_replace(lower(r.pattern), '\s+', ' ', 'g') in b.hay_org) > 0)
    )
  ),
  scored as (
    select b.bid_no, b.bid_seq,
      coalesce(sum(case when m.type = 'exclude' then -m.weight else m.weight end), 0)::int as score,
      coalesce(array_agg(distinct m.pattern) filter (where m.type <> 'exclude'), '{}') as tags
    from b left join m on m.bid_no = b.bid_no and m.bid_seq = b.bid_seq
    group by b.bid_no, b.bid_seq
  )
  update bids t
    set score = s.score,
        tags = s.tags,
        ai_flags = coalesce(t.ai_flags, '{}'::jsonb) || jsonb_build_object('rescored_at', now()),
        updated_at = now()
  from scored s
  where t.bid_no = s.bid_no and t.bid_seq = s.bid_seq;

  get diagnostics affected = row_count;
  perform refresh_bids_status();
  return affected;
end $$;

-- ---------------------------------------------------------------------
-- 4.5 bid_prices / bid_changes / bid_attachments
-- ---------------------------------------------------------------------
-- 가격 정보 (FR-03) — upsert 키 = bid_no
create table if not exists bid_prices (
  bid_no    text primary key,
  base_amount bigint,                                     -- 기초금액
  est_price bigint,                                       -- 추정가격
  preprice_range text,                                    -- 예비가격 범위
  eval_base_amount bigint,                                -- 평가기준금액
  public_dt timestamptz                                   -- 공개일시
);

-- 변경 이력 (FR-04)
create table if not exists bid_changes (
  id       bigserial primary key,
  bid_no   text not null,
  change_item text,                                       -- 변경 항목
  before_val  text,                                       -- 변경 전 값
  after_val   text,                                       -- 변경 후 값
  changed_dt  timestamptz                                 -- 변경 일시
);

-- 첨부파일 (A.5) — kordoc 추출 텍스트/임베딩 포함
create table if not exists bid_attachments (
  id       bigserial primary key,
  bid_no   text not null,
  bid_seq  text not null default '00',
  seq      int,                                           -- 파일 순번
  doc_type text,                                          -- 문서 유형
  file_name text,
  file_url text,                                          -- 원본 다운로드 URL
  storage_path text,                                      -- Supabase Storage 경로
  extracted_text text,                                    -- kordoc Markdown 추출 텍스트
  embedding vector(1024),                                 -- 첨부 임베딩(bge-m3)
  downloaded boolean default false,
  fetched_at timestamptz default now()
);
create index if not exists idx_att_bid on bid_attachments(bid_no, bid_seq);

-- ---------------------------------------------------------------------
-- 4.6 collect_cursor / rules / watchlist
-- ---------------------------------------------------------------------
-- 수집 커서 — 소스별 마지막 등록일시(증분 수집 기준점)
create table if not exists collect_cursor (
  source   text primary key,
  last_reg_dt timestamptz,
  updated_at timestamptz default now()
);

-- 수집 실행 로그 — 자동(cron)·수동 수집 1회당 1행(상태·건수·검증단계·오류). S-10 수집 모니터.
-- (상세/apply 파일: supabase/collect_runs.sql)
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
-- 수집 시 AI 분류 통계(기능상세정의서 v1.1 · 상세 apply: supabase/classify.sql)
alter table collect_runs add column if not exists classify jsonb not null default '{}'::jsonb;

-- 수집 시 AI 사업분류 게이트 — bids 분류 컬럼 + 결정 캐시 (supabase/classify.sql)
alter table bids add column if not exists biz_category text check (biz_category in ('감리','컨설팅'));
alter table bids add column if not exists classify jsonb;
create index if not exists idx_bids_bizcat on bids(biz_category);

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

-- 스코어링 룰 (FR-05)
create table if not exists rules (
  id       bigserial primary key,
  type     text check (type in ('keyword','org','exclude','contract')),
  pattern  text not null,                                 -- 매칭 패턴
  weight   int default 1,                                 -- 가중치
  is_active boolean default true
);

-- 관심 입찰 (FR-08 / 5.4) — PK=(bid_no, bid_seq)
create table if not exists watchlist (
  bid_no   text not null,
  bid_seq  text not null default '00',
  owner    uuid references users(user_id),
  analysis_status text default 'none'
                  check (analysis_status in ('none','in_progress','done')),
  proposal_status text default 'none'
                  check (proposal_status in ('none','writing','done')),
  decision text default 'review'
           check (decision in ('review','join','drop')),
  notice_dt timestamptz,
  deadline_dt timestamptz,
  memo     text,
  updated_at timestamptz default now(),
  primary key (bid_no, bid_seq)
);
create index if not exists idx_watch_owner on watchlist(owner);

-- ---------------------------------------------------------------------
-- 4.7 member_table / app_settings / daily_brief
-- ---------------------------------------------------------------------
-- 기술인력 명부 (FR-09) — 개인정보는 해시 저장
create table if not exists member_table (
  member_id varchar primary key,                          -- 예: M2026-001
  name     varchar not null,
  work_type varchar not null
            check (work_type in ('상근','비상근')),        -- [복원] 근무형태 2종
  tech_grade varchar not null,                            -- 기술등급 초급/중급/고급/특급
  phone_hash text,                                        -- 전화 HMAC-SHA256
  email_hash text,                                        -- 이메일 HMAC-SHA256
  license_name varchar,                                   -- 보유 자격/면허명
  association_no varchar,                                  -- 협회 등록번호
  status   varchar default '재직'
           check (status in ('재직','휴직','퇴직')),       -- [복원] 재직상태 3종
  specialty_field varchar,                                -- 전문분야 예: 정보화전략/ISP/감리/PMO
  career_years int,                                       -- 경력 연수
  license_expiry date,                                    -- 자격 만료일
  reg_date timestamptz default now(),
  updated_at timestamptz default now()
);

-- 앱 설정/비밀 (FR-12) — 값은 AES-256-GCM 암호문(bytea)으로만 저장
create table if not exists app_settings (
  setting_key text primary key,                           -- narat_api / supabase_key / llm_key
  value_enc bytea,                                        -- AES-256-GCM 암호문(평문 금지)
  key_version int default 1,                              -- 키 회전 버전
  masked_hint text,                                       -- 마스킹 힌트 예: sk-****1234
  updated_by uuid references users(user_id),
  updated_at timestamptz default now()
);

-- AI 일일 브리핑 (옵션 B)
create table if not exists daily_brief (
  brief_date date primary key,
  summary  text,
  top_bids jsonb,
  created_at timestamptz default now()
);

-- =====================================================================
-- RLS 판정 함수 (모든 테이블 생성 이후 정의)
--   현재 로그인 사용자의 role 반환 (RLS 판정의 단일 기준).
--   active 상태 사용자만 role을 반환하며, 그 외에는 NULL → 접근 거부.
--
-- [FIX 5a 회귀 방지] SECURITY DEFINER 필수:
--   users 테이블에 RLS를 활성화(4.8)하면, 이 함수가 실행자(caller) 권한으로
--   public.users 를 select 할 때 자기 자신의 RLS 정책에 걸려 role 을 못 읽고,
--   결과적으로 app_current_role() 이 항상 NULL → 모든 RLS 정책이 무너져
--   active 사용자까지 전 테이블 접근이 차단되는 회귀가 발생한다.
--   SECURITY DEFINER(정의자=소유자 권한) 로 RLS 를 우회하여 자기 role 조회가
--   항상 성립하게 한다. search_path 고정으로 하이재킹 방지.
-- =====================================================================
create or replace function app_current_role() returns text
language sql stable
security definer
set search_path = public
as $$
  select role from public.users
  where user_id = auth.uid() and status = 'active'
$$;

-- =====================================================================
-- 4.8 RLS 정책 (Row Level Security)
--   민감/공유 테이블에 RLS 활성 + 역할별 정책. app_current_role() 기준.
--   NULL(=비active) 이면 모든 정책 통과 불가 → 접근 거부.
-- =====================================================================
alter table bids            enable row level security;
alter table watchlist       enable row level security;
alter table member_table    enable row level security;
alter table app_settings    enable row level security;
alter table keyword_groups  enable row level security;
-- [FIX 5a/5b/5d] 원천 결함 보강: 아래 테이블은 RLS 미활성 상태였으나
--   Supabase 기본 grant(anon/authenticated) 로 인해 anon key 만으로 읽기·쓰기가
--   모두 열려 있었다(권한 상승·PII 노출·데이터 변조 위험). RLS 활성 후 정책으로 잠근다.
alter table users           enable row level security;   -- FIX 5a
alter table rules           enable row level security;   -- FIX 5b
alter table bid_prices      enable row level security;   -- FIX 5d
alter table bid_changes     enable row level security;   -- FIX 5d
alter table bid_attachments enable row level security;   -- FIX 5d
alter table daily_brief     enable row level security;   -- FIX 5d(동반)
alter table collect_cursor  enable row level security;   -- FIX 5d(동반)
alter table collect_runs    enable row level security;   -- 수집 모니터(active read-only)
alter table bid_classifications enable row level security; -- 분류 결정 캐시(active read-only)

-- bids: active 사용자면 read (6.1 — exec/strategy/pm/admin 모두 R)
create policy bids_read on bids for select
  using (app_current_role() is not null);

-- keyword_groups: active 사용자면 read (6.1)
-- [복원] 4.8 원문에 RLS는 enable 되었으나 정책 텍스트가 누락/깨져 있어,
--        6.1 권한 매트릭스(active=read)에 따라 read 정책을 복원.
create policy keyword_groups_read on keyword_groups for select
  using (app_current_role() is not null);

-- watchlist: read는 active 전체, write는 strategy/pm/admin (6.1)
create policy watch_read on watchlist for select
  using (app_current_role() is not null);
create policy watch_write on watchlist for all
  using (app_current_role() in ('strategy','pm','admin'))
  with check (app_current_role() in ('strategy','pm','admin'));

-- member_table: read는 pm/admin, write는 admin (FR-09)
create policy member_read on member_table for select
  using (app_current_role() in ('pm','admin'));
create policy member_write on member_table for all
  using (app_current_role() = 'admin')
  with check (app_current_role() = 'admin');

-- app_settings: 모든 작업 admin 전용 (FR-12)
create policy settings_admin on app_settings for all
  using (app_current_role() = 'admin')
  with check (app_current_role() = 'admin');

-- ---------------------------------------------------------------------
-- [FIX 5a] users — 본인 read + admin read/write. status/role 자가변경 차단.
--   app_current_role() 는 SECURITY DEFINER 라 RLS 를 우회하므로, 아래 정책은
--   함수 동작을 막지 않는다. self_read 는 SessionProvider 의 본인 row 조회용.
--   일반 사용자는 self READ 만 가능(WRITE 정책 없음 → status/role 자가변경 불가).
--   승인/반려/정지 등 write 는 admin 전용. 가입 insert 는 서버 트리거/Auth 훅 처리.
-- ---------------------------------------------------------------------
create policy users_self_read on users for select
  using (user_id = auth.uid());
create policy users_admin_read on users for select
  using (app_current_role() = 'admin');
create policy users_admin_write on users for update
  using (app_current_role() = 'admin')
  with check (app_current_role() = 'admin');

-- ---------------------------------------------------------------------
-- [FIX 5b] rules — read 는 active 전체, write(CRUD) 는 admin 전용 (FR-05).
--   anon 이 스코어링 룰을 조작하면 전사 score/ai_score/alert 산정이 왜곡됨 → 차단.
-- ---------------------------------------------------------------------
create policy rules_read on rules for select
  using (app_current_role() is not null);
create policy rules_admin on rules for all
  using (app_current_role() = 'admin')
  with check (app_current_role() = 'admin');

-- ---------------------------------------------------------------------
-- [FIX 5c] keyword_groups write — 기존 read 정책 유지 + write 정책 추가 (FR-13).
--   RLS 활성 + read 정책만 있어 그룹 생성(insert)이 전원 default-deny 되던 결함 해소.
--   strategy/pm/admin 만, 그리고 owner = 본인(auth.uid()) 인 그룹만 생성/수정/삭제.
-- ---------------------------------------------------------------------
create policy keyword_groups_write on keyword_groups for all
  using (app_current_role() in ('strategy','pm','admin') and owner = auth.uid())
  with check (app_current_role() in ('strategy','pm','admin') and owner = auth.uid());

-- ---------------------------------------------------------------------
-- [FIX 5d] bid_prices / bid_changes / bid_attachments — read-only.
--   active read 허용, write 정책 없음 → anon write 는 default-deny(무결성 보호).
--   수집/AI 스크립트는 service key(RLS 우회)라 영향 없음.
--   daily_brief(S-04 대시보드 anon read) 동일 read-only. collect_cursor 는
--   프론트 미접근이라 read 정책 없이 RLS 활성만(anon read/write 전면 차단).
-- ---------------------------------------------------------------------
create policy bid_prices_read on bid_prices for select
  using (app_current_role() is not null);
create policy bid_changes_read on bid_changes for select
  using (app_current_role() is not null);
create policy bid_attachments_read on bid_attachments for select
  using (app_current_role() is not null);
create policy daily_brief_read on daily_brief for select
  using (app_current_role() is not null);

-- collect_runs: 수집 실행 로그 read-only(active). write는 service key 전용(정책 없음).
create policy collect_runs_read on collect_runs for select
  using (app_current_role() is not null);

-- bid_classifications: 분류 결정 캐시 read-only(active). write는 service key 전용.
create policy bidcls_read on bid_classifications for select
  using (app_current_role() is not null);
