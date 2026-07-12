# AI 분석 워크플로우 & 결과파일 업로드 — 기능상세정의서 v1.0

> 작성일: 2026-07-12 · 대상 화면: **S-07 관심 목록**(진행단계 확장) + 신규 업로드 UI · 상태: 정의(구현 전)
> 범위: 관심 공고의 "분석" 진행단계를 **분석요청 → (관리자 AI 분석 결과파일 업로드) → 분석완료** 워크플로우로 확장. 관리자 AI 분석 결과파일(7종 HTML) 업로드·열람 기능 포함.

---

## 1. 개요 / 목적

현행 S-07의 분석 진행단계는 단순 상태값(미착수/진행중/완료)이다. 이를 **실제 업무 흐름**에 맞춘 워크플로우로 확장한다:

1. 전략기획/사업관리가 관심 공고에 **분석을 요청**한다(분석요청).
2. 관리자가 AI 분석을 수행하고 **결과 산출물(7종 HTML)을 업로드**한다.
3. 업로드 완료 시 진행단계가 **분석완료**로 자동 전환되고, 팀원이 결과를 열람한다.

이로써 "AI 분석 요청 → 산출물 관리 → 열람"이 한 화면에서 추적된다.

## 2. 현행 & 배경

- `watchlist.analysis_status` = `none`(미착수) / `in_progress`(분석중) / `done`(완료). 단순 수동 토글.
- 분석 산출물(보고서·요약·인포그래픽 등)은 시스템 밖에서 관리 → 추적·공유 어려움.
- 회사는 정보시스템 감리·컨설팅 전문 → 공고별 **감리계획·논리구조·제안서 초안** 등 정형 산출물이 존재.

## 3. 진행단계(분석) 상태 재정의

| 상태값 | 라벨 | 의미 | 전환 주체 |
|--------|------|------|-----------|
| `none` | 미요청 | 분석 미요청(기본) | - |
| `requested` | **분석요청** | 사용자가 분석 요청함 | 전략기획/사업관리 |
| `in_progress` | AI분석중 | 관리자가 분석 진행중(선택적 표시) | 관리자 |
| `done` | **분석완료** | AI 분석 결과파일 업로드 완료 | 시스템(업로드 시 자동) |

**상태 전이:**
```
none ──[분석 요청]──▶ requested ──[관리자 접수/작업]──▶ in_progress
                          │                                  │
                          └──────[AI 결과파일 업로드 완료]────┴──▶ done (분석완료)
```
- `requested`/`in_progress` 상태에서 **필수 산출물 업로드가 완료되면 자동으로 `done`** 으로 전환.

## 4. 데이터 모델

### 4.1 `watchlist` 확장
```sql
alter table watchlist
  add column if not exists analysis_requested_at timestamptz,
  add column if not exists analysis_requested_by uuid references users(user_id),
  add column if not exists analysis_done_at timestamptz;
-- analysis_status CHECK 확장: 'none','requested','in_progress','done'
--   (기존 in_progress 값 호환 유지)
```

### 4.2 `analysis_reports` — AI 분석 결과파일 메타 (신규)
```sql
create table if not exists analysis_reports (
  id          bigserial primary key,
  bid_no      text not null,
  bid_seq     text not null default '00',
  doc_type    text not null check (doc_type in
              ('분석보고서','1페이지상세요약','1페이지인포그래픽','PT요약보고서',
               '영역별감리계획','논리구조서','통합감리제안서초안')),
  file_name   text not null,                 -- 날짜_사업명_종류.html
  storage_path text not null,                -- analysis-reports 버킷 내 경로
  size_bytes  bigint,
  uploaded_by uuid references users(user_id),
  uploaded_at timestamptz default now(),
  unique (bid_no, bid_seq, doc_type)          -- 종류별 최신 1건(재업로드 시 교체)
);
create index if not exists idx_anrep_bid on analysis_reports(bid_no, bid_seq);
```

### 4.3 Supabase Storage
- **버킷:** `analysis-reports` (private).
- **경로 규칙:** `{bid_no}_{bid_seq}/{YYYYMMDD}_{사업명}_{종류}.html`
- HTML 산출물 저장. 열람은 **서명 URL(createSignedUrl)** 로 제공.

### 4.4 RLS
```sql
alter table analysis_reports enable row level security;
create policy anrep_read  on analysis_reports for select using (app_current_role() is not null);        -- active 전원 R
create policy anrep_write on analysis_reports for all    using (app_current_role() = 'admin')            -- admin 업로드/삭제
                                          with check (app_current_role() = 'admin');
-- Storage 정책(analysis-reports 버킷): active read(서명URL), admin insert/update/delete
```

## 5. 기능 요구사항 (FR-21 ~ FR-24)

### FR-21 분석 요청 (S-07)
- **개요**: 관심 공고에 "분석 요청" → `analysis_status='requested'`, `analysis_requested_at/by` 기록.
- **권한**: strategy/pm/admin. **UI**: S-07 진행단계 셀의 [분석 요청] 버튼(미요청 상태일 때).
- **처리**: watchlist update. (선택) 관리자에게 알림 표시(요청 건수 배지).

### FR-22 관리자 AI 분석 결과파일 업로드
- **개요**: 관리자가 공고별 **AI 분석 결과 7종 HTML**을 업로드.
- **권한**: **admin 전용**.
- **처리**:
  1. S-07/S-06에서 [분석 결과 업로드] → 업로드 모달.
  2. 7종 각각 HTML 파일 선택(또는 일괄 드래그드롭, 파일명으로 종류 자동 매핑).
  3. Supabase Storage(`analysis-reports`)에 업로드 → `analysis_reports` upsert(종류별 교체).
  4. 파일명 규칙 검증: `YYYYMMDD_사업명_종류.html`.
- **관련**: analysis_reports, Storage, watchlist.

### FR-23 진행단계 자동 전환 (요청 → 완료)
- **개요**: **필수 산출물 업로드 완료 시 `analysis_status`를 자동 `done`(분석완료)** 으로 전환.
- **필수 산출물 기준(설정 가능)**: 최소 `분석보고서` 업로드 시 done, 또는 7종 전체 완료 시 done(권장: 관리자가 "분석완료 확정" 버튼으로 명시 전환 + 업로드 진행률 표시).
- **처리**: 업로드 후 조건 충족 시 watchlist update(`analysis_status='done'`, `analysis_done_at`).

### FR-24 분석 결과 열람 / 다운로드
- **개요**: 팀원이 업로드된 7종 산출물을 열람·다운로드.
- **권한**: active 전원 R.
- **UI**: S-07 행 확장 or S-06 상세에 "AI 분석 결과" 섹션 — 종류별 파일 목록 + [열기](서명URL, 새 탭 HTML 렌더) / [다운로드].

## 6. AI 분석 결과파일 7종 정의

| # | 종류(doc_type) | 파일명 예시 | 설명 |
|---|----------------|-------------|------|
| 1 | 분석보고서 | `20260712_생물다양성정보시스템감리_분석보고서.html` | 공고 종합 분석 |
| 2 | 1페이지상세요약 | `..._1페이지상세요약.html` | 1p 상세 요약 |
| 3 | 1페이지인포그래픽 | `..._1페이지인포그래픽.html` | 1p 시각 인포그래픽 |
| 4 | PT요약보고서 | `..._PT요약보고서.html` | 발표용 요약 |
| 5 | 영역별감리계획 | `..._영역별감리계획.html` | 감리 영역별 계획 |
| 6 | 논리구조서 | `..._논리구조서.html` | 사업 논리구조 |
| 7 | 통합감리제안서초안 | `..._통합감리_제안서_초안.html` | 제안서 초안 |

- **파일명 규칙:** `{YYYYMMDD}_{사업명}_{종류}.html`. 업로드 시 파일명 끝의 종류 토큰으로 doc_type 자동 매핑, 불일치 시 관리자가 수동 지정.

## 7. 화면

### S-07 관심 목록 (확장)
- **진행단계 셀**을 상태별로 분기:
  - `미요청` → **[분석 요청]** 버튼(strategy/pm/admin)
  - `분석요청` → "분석요청" pill + (admin) **[결과 업로드]** 버튼
  - `AI분석중` → "AI분석중" pill + 업로드 진행률
  - `분석완료` → "분석완료" pill + **[결과 보기](7종)**
- 행 확장(accordion) 시 업로드된 산출물 목록 표시(종류·업로드일시·[열기]/[다운로드]).

### 업로드 모달 (admin)
- 7종 슬롯(각 파일 선택/드래그) + 업로드 진행률 + [분석완료 확정].
- 파일명 규칙 안내·검증, 재업로드 시 교체.

### S-06 상세 (선택 연계)
- "AI 분석 결과" 섹션에 동일 목록·열람 제공.

## 8. 업로드 방식 / 보안

- **업로드**: 관리자 **세션(anon key + Storage RLS)** 으로 Supabase Storage에 직접 업로드(대용량·다중 파일 적합). 서버 API 불필요. metadata는 `analysis_reports` insert(RLS admin).
- **열람**: private 버킷 → `createSignedUrl`(만료 URL). HTML은 새 탭 렌더 또는 iframe.
- **보안**: HTML 산출물의 스크립트/외부요청 리스크 → 신뢰된 관리자 업로드만 허용(admin). 필요 시 `sandbox` iframe 렌더 권장. 개인정보 포함 가능성 있으므로 private + active 전원 read.

## 9. 프로젝트 적용성 (현재 스택에 적용 가능)

| 재사용 자산 | 적용 |
|-------------|------|
| RLS·함수 패턴 | `analysis_reports` RLS + watchlist 확장(기존 정책 스타일) |
| Supabase Storage | 첨부(bid_attachments)에서 이미 Storage 사용 계획 → 동일 패턴 |
| S-07 UI | 기존 진행단계 pill/select 확장, Card/Pill 재사용 |
| 업로드 | 브라우저 Storage 직접 업로드(서버 부담 없음) |
| 파일 열람 | 서명URL + 새 탭/iframe |

- **신규 DDL:** `analysis_reports` 테이블 + `watchlist` 컬럼 3개 + Storage 버킷/정책. 나머지 프론트.

## 10. 상태·데이터 흐름

```
[S-07] 분석 요청(strategy/pm) → watchlist.analysis_status=requested
   → (알림) [S-07/업로드모달] 관리자 7종 HTML 업로드
        → Storage(analysis-reports) + analysis_reports(insert)
        → 필수 산출물 충족/확정 → analysis_status=done(분석완료)
   → [S-07/S-06] 팀원 결과 열람(서명URL)
```

## 11. 산출물 (구현 시 예상)
```
supabase/analysis_reports.sql   # 테이블+RLS + watchlist 컬럼 + Storage 버킷/정책
app/(app)/watchlist/page.tsx    # S-07 진행단계 워크플로우 + 업로드/열람
components/watch/AnalysisUpload.tsx  # 업로드 모달(7종)
components/watch/AnalysisReports.tsx # 결과 목록/열람
lib/queries/analysis.ts         # 업로드·조회·서명URL
app/(app)/bids/[id]/page.tsx    # (선택) S-06 결과 섹션
```

## 12. 테스트 시나리오

1. **정상**: 미요청 → [분석 요청](requested) → 관리자 7종 업로드 → 자동 분석완료(done) → 팀원 [결과 보기]로 7종 열람.
2. **파일명 규칙**: `20260712_사업명_분석보고서.html` 업로드 → doc_type=분석보고서 자동 매핑. 규칙 위반 시 수동 지정.
3. **재업로드**: 동일 종류 재업로드 → 기존 교체(unique 제약).
4. **권한**: 비admin은 업로드 불가(RLS), active 전원 열람 가능.
5. **부분 업로드**: 7종 중 일부만 업로드 → 진행률 표시, "분석완료 확정" 전까지 requested/in_progress 유지(정책에 따라).
```
