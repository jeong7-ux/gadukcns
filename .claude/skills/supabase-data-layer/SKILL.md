---
name: supabase-data-layer
description: "나라장터 입찰정보시스템의 Supabase 데이터 계층을 설계·구현하는 스킬. PostgreSQL 15 스키마(users/bids/watchlist/member_table 등 12개 테이블), RLS 정책(exec/strategy/pm/admin 4역할), pgvector(1024차원) 임베딩 컬럼, 생성 컬럼(bids.status), 개인정보 해시/암호화를 작성한다. schema.sql, RLS, 마이그레이션, 권한 정책, pgvector 인덱스 작업 시 반드시 사용. data-architect 에이전트 전용."
---

# Supabase 데이터 계층 스킬

나라장터 입찰정보시스템의 데이터 계층을 작성한다. schema.sql 하나가 팀 전체의 계약이므로, 정확성과 계약 명세가 최우선이다.

## 작성 순서 (schema.sql)

1. **확장** — `create extension if not exists pgcrypto;`(gen_random_uuid, HMAC), `create extension if not exists vector;`(pgvector). pgsodium/Vault는 선택
2. **role 함수** — `app_current_role()`: `select role from public.users where user_id = auth.uid() and status = 'active'` (RLS 판정의 기준)
3. **테이블**(4.2~4.7 순서): users → keyword_groups → bids → bid_prices → bid_changes → bid_attachments → collect_cursor → rules → watchlist → member_table → app_settings → daily_brief
4. **인덱스**: idx_bids_notice(notice_dt desc), idx_bids_deadline, idx_bids_embed(ivfflat vector_cosine_ops lists=100), idx_att_bid, idx_watch_owner
5. **RLS**(4.8): 민감 테이블 enable + 역할별 정책

## 핵심 계약 규칙 (변경 시 팀 브로드캐스트)

| 항목 | 규칙 | 이유 |
|------|------|------|
| bids PK | `(bid_no, bid_seq)` | 수집 upsert 키. collector가 여기 의존 |
| bids.status | 생성 컬럼: deadline > today → `ongoing`, = today → `today`, else `closed` | FR-14 마감상태. 프론트가 pill로 렌더 |
| embedding | `vector(1024)` 고정 | bge-m3 차원. ai-engineer가 의존 |
| 개인정보 | email_hash/phone_hash (HMAC-SHA256), 평문 저장 금지 | 8장 보안 |
| app_settings.value_enc | `bytea`, AES-256-GCM 암호화 + masked_hint | FR-12 API 키 |
| 역할 CHECK | users.role in ('exec','strategy','pm','admin') | 6.1 권한 매트릭스 |
| 상태 흐름 | unverified→pending→active, rejected/suspended | 6.2, FR-01 |

## RLS 권한 매트릭스 (6.1)

- **bids/keyword_groups**: active면 read. watchlist write는 strategy/pm/admin
- **member_table**: read는 pm/admin, write는 admin (FR-09)
- **app_settings**: all admin only (FR-12)
- 원칙: `app_current_role() is not null` = active 사용자. 민감할수록 역할을 좁힌다

## 작업 원칙 (Why 중심)

- **계약을 먼저 고정하고 알린다** — 다른 팀원의 코드가 컬럼명/타입에 묶이므로, 확정 즉시 `_workspace/01_data-architect_contract.md`에 요약표를 남기고 SendMessage로 전파한다. 나중 변경일수록 비용이 크다.
- **기능정의서 SQL을 그대로 구현** — CHECK 제약·기본값·타입을 임의 재해석하지 않는다. pgvector/pgcrypto가 Supabase에서 비활성이면 대시보드 활성화 절차를 문서화한다.
- **RLS는 최종 방어선** — UI 게이팅과 무관하게 DB에서 강제되어야 한다. 정책 없는 민감 테이블은 사고다.

## 산출물

- `_workspace/01_data-architect_schema.sql` → 최종 `supabase/schema.sql`
- `_workspace/01_data-architect_contract.md` — 테이블/컬럼/타입/PK/RLS 요약표 (팀 계약 문서)

## 검증 체크리스트

- [ ] 12개 테이블 + CHECK 제약 모두 구현
- [ ] app_current_role() 정의, 민감 테이블 4개 RLS enable + 정책
- [ ] embedding vector(1024) + ivfflat 인덱스
- [ ] bids 생성 컬럼 status 로직이 FR-14와 일치
- [ ] 개인정보 컬럼이 *_hash / value_enc(bytea)로 저장
