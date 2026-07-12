# 기능설계서 — 룰 기준 공고 정리 (DB Cleanup by Scoring Rules)

> 작성일: 2026-07-12 · 대상 화면: S-04(입찰 목록) · 근거 규칙: S-12(스코어링 규칙) · 상태: **설계(미구현)**

## 1. 개요 / 목적

S-12에서 관리하는 스코어링 규칙(정보시스템 감리·컨설팅 주력분야) 기준으로, **주력사업과 무관한 공고(룰 점수 미달)를 DB에서 정리**한다. 목록·통계·스토리지를 주력 공고 중심으로 유지해 가독성·성능·품질을 높인다.

## 2. 배경 / 문제

- 백필은 룰 매칭(score>0) 공고만 적재하지만, **규칙을 좁히거나 재스코어링하면 기존 적재분 다수가 score 0**이 된다.
- 현재 상태: `bids` 2,858건 중 관련(score>0) **168건**, 나머지 **≈2,690건은 score 0**(현 규칙 미달) → 목록·통계 오염, 스토리지·조회 부하.
- 재스코어링([[rescore_bids]])은 점수만 갱신할 뿐 **행을 제거하지 않는다** → 정리 기능이 별도로 필요.

## 3. 트리거 / 위치 / 권한

| 항목 | 내용 |
|------|------|
| 위치 | S-04 입찰 목록 상단 "관리" 영역(필터바 옆) |
| 노출 | **admin 전용** (`RoleGuard allow={ADMIN_ONLY}`) — 파괴적 작업 |
| 진입 | [DB 정리] 버튼 → 정리 모달 |

## 4. 동작 흐름 (3단계 — 미리보기 필수)

```
1) 기준 설정      : 점수 임계값(기본 THRESHOLD=1 → score ≤ 0 대상) + 보호 옵션
        ↓
2) 미리보기(dry-run): 삭제 대상 건수 + 샘플 10건 표시 (실제 삭제 없음)
        ↓
3) 확인 → 실행    : "N건 정리(아카이브/삭제)합니다" confirm → RPC 실행 → 결과 건수
        ↓
   목록·통계 자동 갱신(react-query invalidate)
```

## 5. 정리 정책 — 무엇을 지우나

**대상:** 현재 활성 규칙으로 `score < THRESHOLD` (기본 1 → **score 0 이하**) 공고.

**보호(정리 제외) — 안전 최우선:**
| 보호 대상 | 사유 | 강제/옵션 |
|-----------|------|-----------|
| watchlist 등록 공고 | 사용자가 관심 표시함 | **강제**(항상 제외) |
| AI 요약·임베딩 완료(`ai_flags.summary_ok`) | 비용 투입 산출물 보존 | 옵션(기본 ON) |
| 최근 N일 내 등록 공고 | 신규는 룰 재조정 여지 | 옵션(기본 7일) |

## 6. 정리 방식 — 소프트 아카이브 권장

| 방식 | 설명 | 복구 | 권장 |
|------|------|------|------|
| **소프트 아카이브** | `bids.archived_at` 세팅, 목록/통계 쿼리에서 `archived_at is null` 필터 | 가능(복구 함수) | ✅ 기본 |
| 하드 삭제 | bids + 연관(prices/changes/attachments) row 실제 삭제, 스토리지 회수 | 재수집 필요 | 옵션(명시 선택 시) |

> 되돌릴 수 없는 손실을 피하려 **소프트 아카이브를 기본**으로, "영구 삭제"는 별도 명시 선택 + 2차 확인.

## 7. 안전장치

1. **재스코어링 선행 권장** — 정리 전 "점수 최신 여부"(마지막 `rescored_at`) 표시. 옛 점수로 정리 시 경고.
2. **dry-run 필수** — 미리보기 없이 실행 불가.
3. **확인 게이트** — 대상 건수 명시 + confirm. 영구삭제는 문구 입력 등 2차 확인.
4. **watchlist 보호 강제** — 옵션으로도 해제 불가.
5. **감사 로그** — `cleanup_log(actor, threshold, mode, affected, at)` 기록.
6. **트랜잭션** — 부분 실패 없이 원자적 처리.

## 8. 기술 설계

### 8-1. DB 함수 (브라우저 anon은 RLS로 bids 삭제 불가 → definer 함수 필수, rescore_bids와 동일 패턴)

```sql
-- 미리보기/실행 겸용. dry_run=true면 count만, false면 정리 후 count 반환.
create or replace function cleanup_bids(
  p_threshold int default 1,
  p_protect_enriched boolean default true,
  p_protect_recent_days int default 7,
  p_mode text default 'archive',   -- 'archive' | 'delete'
  p_dry_run boolean default true
) returns integer
language plpgsql security definer set search_path = public
as $$
declare affected integer;
begin
  if app_current_role() <> 'admin' then raise exception 'admin 권한 필요'; end if;

  -- 대상 조건(공통): score < threshold, watchlist 미등록, (옵션) 비보강, (옵션) 최근 제외
  -- create temp view / CTE 로 대상 선정
  --   and not exists (select 1 from watchlist w where w.bid_no=b.bid_no and w.bid_seq=b.bid_seq)
  --   and (not p_protect_enriched or coalesce((b.ai_flags->>'summary_ok')::bool,false)=false)
  --   and (b.notice_dt is null or b.notice_dt < now() - (p_protect_recent_days||' days')::interval)

  if p_dry_run then
    select count(*) into affected from bids b where <대상조건>;
    return affected;
  end if;

  if p_mode = 'archive' then
    update bids b set archived_at = now() where <대상조건> and archived_at is null;
  else  -- delete: 연관 테이블 먼저 정리
    delete from bid_attachments a using bids b where a.bid_no=b.bid_no and <대상조건>;
    delete from bid_prices  p using bids b where p.bid_no=b.bid_no and <대상조건>;
    delete from bid_changes c using bids b where c.bid_no=b.bid_no and <대상조건>;
    delete from bids b where <대상조건>;
  end if;
  get diagnostics affected = row_count;
  insert into cleanup_log(actor, threshold, mode, affected, at)
    values (auth.uid(), p_threshold, p_mode, affected, now());
  return affected;
end $$;
```

### 8-2. 스키마 변경 (소프트 아카이브 채택 시)
```sql
alter table bids add column if not exists archived_at timestamptz;
create index if not exists idx_bids_archived on bids(archived_at);
create table if not exists cleanup_log (
  id bigserial primary key, actor uuid, threshold int, mode text,
  affected int, at timestamptz default now()
);
```
- 목록/통계/캘린더 쿼리에 `.is('archived_at', null)` 추가 (아카이브분 자동 숨김).

### 8-3. 프론트 (S-04)
- admin 영역 [DB 정리] → 모달:
  - 기준: 점수 임계값(기본 1), 체크박스(AI보강 제외·최근7일 제외 / watchlist 제외는 고정)
  - [미리보기] → `rpc('cleanup_bids', {…, p_dry_run:true})` → "대상 N건" + 샘플
  - 방식: (기본)아카이브 / (2차확인)영구삭제 → `p_dry_run:false` 실행
  - 결과 토스트 + `invalidateQueries(['bids'|'stats-*'])`

## 9. 데이터 흐름 / 연관 영향

```
S-12 규칙 → rescore_bids()(점수 최신화) → S-04 [DB 정리] → cleanup_bids(dry-run→실행)
   → bids.archived_at(또는 삭제) → 목록/통계/캘린더에서 자동 제외 → cleanup_log 기록
```
- 연관 테이블: 하드 삭제 시 attachments→prices→changes→bids 순(FK 없음, 함수가 처리).
- watchlist: 삭제 대상에서 강제 제외(참조 무결성·사용자 의도 보호).

## 10. 엣지 케이스

| 케이스 | 처리 |
|--------|------|
| 관심목록 공고가 score 0 | 보호되어 유지(목록에 남음). 필요 시 "관심이지만 룰 미달" 배지 표기(선택) |
| 재스코어링 미실행 상태 정리 | 경고 표시("점수가 최신이 아닐 수 있음"), 정리 전 재스코어링 권유 |
| 규칙을 다시 넓힘(정리 후) | 아카이브는 복구 함수로 되살리기 가능 / 하드삭제는 재수집 필요 |
| 대량(수천 건) 정리 성능 | 인덱스(`idx_bids_archived`, `idx_bids_status`) + 단일 UPDATE/DELETE 문 |
| 함수 미배포 | 프론트에서 "cleanup_bids 함수 미배포" 안내(rescore 버튼과 동일 패턴) |

## 11. 테스트 시나리오

1. **정상(아카이브):** rescore → 미리보기(대상 2,690) → 아카이브 → 목록 168건, 아카이브 2,690.
2. **보호:** watchlist 3건이 score 0 → 대상서 제외(2,687) 확인.
3. **복구:** 아카이브분 복구 함수 → 다시 목록 노출.
4. **권한:** 비admin RPC 호출 → `admin 권한 필요` 예외.
5. **영구삭제:** 2차 확인 후 delete → 연관 테이블까지 정리, cleanup_log 1행.

## 12. 구현 산출물(예정 목록)
- `supabase/cleanup_bids.sql` (함수 + archived_at/cleanup_log DDL) — SQL Editor 1회 적용
- `app/(app)/dashboard/page.tsx`(S-04) 정리 모달 + admin 버튼
- 목록/통계/캘린더 쿼리에 `archived_at is null` 필터 추가
- (선택) 아카이브 복구 함수 `restore_bids()` + 관리 UI

## 13. 권고

- **1차: 소프트 아카이브**로 도입(무손실·복구가능). 운영 안정화 후 필요 시 영구삭제 옵션.
- 정리 버튼은 **재스코어링 직후** 사용하도록 UI에서 유도(최신 점수 기준 보장).
- watchlist·AI보강분 보호를 기본값으로 고정해 실수 손실 방지.
