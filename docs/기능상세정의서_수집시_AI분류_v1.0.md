# 수집 시 AI(LLM) 사업분류 게이트 — 기능상세정의서 v1.1

> 작성일: 2026-07-17 · 대상 시스템: 나라장터 입찰정보시스템(확장) · 상태: **구현·DDL적용·라이브 검증 완료(백엔드)** — biz_category 영속·bid_classifications 로그·collect_runs.classify·캐시 실동작 확인 (작업이력 §47)
> 회사: **(주)가덕씨엔에스** — 정보시스템(IT) 감리·컨설팅·PMO·보안 전문
> 목적: 수집 단계에서 **감리/컨설팅 사업만 선별 적재**하여 DB·서버 자원 사용을 근본적으로 낮춘다.
> **범위(v1.1):** 수집은 **수동("바로수집") 전용**. **자동(GitHub Actions cron) 수집은 전면 제외**한다 — 스케줄 배치를 없애고, 사용자가 필요할 때만 수집·분류·적재한다(자원·비용 통제).
>
> **개정 이력:** v1.0(2026-07-17 초안, 자동 cron 4회+수동) → **v1.1(2026-07-17, 자동수집 전면 삭제·수동 전용으로 전환)**.

이 문서는 나라장터에서 입찰공고를 수집할 때(**수동 "바로수집" 실행 시에만**), 공고를 **건당 조회 → AI(LLM)로 사업 유형(감리/컨설팅) 분류 → 해당 사업만 우리 DB(`bids`)에 저장**하는 기능을 상세화한다. 기존 파이프라인(`lib/collect/runner.ts`, `app/api/collect/run`, `ai.mjs`, `collect_runs`)과 스키마·RLS·OpenRouter 호출 패턴을 재사용한다. **정규 배치(`collect.yml` cron 07·12·17·22시)는 비활성화**하며, `collect.mjs`는 스케줄 수집이 아닌 **소급 분류 백필(FR-27) 전용**으로만 남긴다.

---

## 1. 개요 / 목적

- **현행 문제:** 수집기(FR-02)는 나라장터 **용역공고 전량**을 `bids`에 upsert한다(3개월 스캔 52,928건). 관련 없는 공고까지 모두 적재·인덱싱·스코어링·임베딩 대상이 되어 **DB 용량·쿼리·AI 배치 비용**이 불필요하게 커진다.
- **목표:** 수집 시점에 **감리/컨설팅에 해당하는 공고만** `bids`에 남기고, 해당 없는 공고는 **적재하지 않는다**(경량 결정 로그만 보존). → 저장 데이터가 **한 자릿수 %로 축소**되어 이후 모든 계층(스코어링·요약·임베딩·대시보드)의 자원이 함께 절감된다.
- **분류 주체:** 규칙(rules/keyword_groups)만으로는 애매한 경계(예: '감리'가 건설감리인지 정보시스템 감리인지, '컨설팅'이 IT 전략인지 일반 경영컨설팅인지)를 **LLM이 문맥으로 판정**한다.

## 2. 배경 / 현황 (자원 문제의 정량화)

| 항목 | 실측(기존 이력 기준) |
|------|------|
| 3개월 용역공고 스캔 | **52,928건** |
| 룰 관련(사전선별 통과) | 약 **6.8% ≈ 2,858건** |
| 최종 주력(주력점수≥4, 노출) | 약 **45건**(감리 3 + 컨설팅 42, §41/§44) |
| 현재 `bids` 적재 | 2,858건(관련만 백필) — 그러나 **정규 수집은 전량 적재 구조** |

> 즉 **가치 있는 공고는 스캔량의 0.1% 미만**인데, 전량 적재 구조라 나머지가 자원을 잠식한다. 이 기능은 그 구조를 "**선별 후 적재**"로 전환한다.

### 2.1 ⚠️ 핵심 설계 판단 — "전량 건당 LLM"은 금지

요구사항을 문자 그대로 "**수집한 모든 공고를 건당 LLM 분류**"로 구현하면, 수동 1회 실행에도 수백~수천 건 × 매 공고 LLM 호출이 되어 **LLM API 비용·수집 지연이 폭증**한다(자동 배치라면 더 심각). 이는 "서버 자원 문제 해소"라는 **목적과 정반대**다. (v1.1에서 자동수집을 없앤 것도 같은 자원통제 취지다 — 수집 자체를 사용자가 필요할 때만 돌린다.)

따라서 본 정의서는 **2단계 게이트**로 설계한다 — 사용자의 목표(자원 절감)와 요구(LLM 분류·선별 적재)를 동시에 만족한다:

1. **저비용 사전선별(Stage 1, LLM 없음):** 명백한 무관 공고(건설/물품/타분야)를 **rules·keyword_groups로 즉시 컷** → 스캔의 ~93%를 LLM 호출 없이 제거.
2. **LLM 정밀분류(Stage 2, 후보에만):** 사전선별을 통과한 **후보(하루 수십 건 수준)만 건당 LLM** 호출 → 감리/컨설팅/해당없음 판정.

이렇게 하면 LLM 호출이 **스캔량의 수 % 이하**로 줄어, 요구하신 "건당 LLM 분류"를 **자원 절감 목적을 지키며** 실현한다.

## 3. 설계 원칙 — 3-스테이지 선별 게이트

```
[나라장터 목록 API]  건당 raw 공고
        │
 ┌──────▼───────────────────────────────────────────────┐
 │ Stage 0  하드 필터 (LLM·DB 접근 0)                     │
 │  · 용역 유형 확인, 명백 제외어(건설·건축·토목·소방·전기  │
 │    감리 / 물품 / 단순 일반용역) → 즉시 드롭             │
 └──────┬───────────────────────────────────────────────┘
        │ 통과
 ┌──────▼───────────────────────────────────────────────┐
 │ Stage 1  저비용 사전선별 (rules/keyword_groups)        │
 │  · scoreBid base(주력 키워드 매칭) 계산                │
 │  · base ≥ CLASSIFY_MIN_PREFILTER → LLM 후보           │
 │  · 그 외 → 드롭(reject 로그)                            │
 └──────┬───────────────────────────────────────────────┘
        │ 후보(하루 수십 건)
 ┌──────▼───────────────────────────────────────────────┐
 │ Stage 2  LLM 정밀분류 (건당, 캐시 우선)                │
 │  · bid_classifications 캐시 hit → LLM 생략             │
 │  · miss → OpenRouter chat(JSON) → 감리/컨설팅/해당없음  │
 │    + confidence + reason                               │
 └──────┬───────────────────────────────────────────────┘
        │ 판정
 ┌──────▼───────────────────────────────────────────────┐
 │ Stage 3  적재 결정                                     │
 │  · 감리/컨설팅 & conf≥KEEP → bids upsert(biz_category) │
 │  · 애매(DROP<conf<KEEP) → 보류 적재(needs_review=true) │
 │  · 해당없음 & conf≥DROP → 미적재(reject 로그)           │
 │  · LLM 실패 → 보류 적재(fail-open, 다음 배치 재분류)    │
 └───────────────────────────────────────────────────────┘
```

**원칙:**
- **자원 절감:** LLM은 사전선별 통과분에만. 해당없음은 `bids` 미적재.
- **놓침 방지(fail-open):** 애매·LLM오류는 **드롭하지 않고 보류 적재 + 검수 플래그** → 기회 유실 0.
- **멱등·캐시:** 동일 공고 재수집 시 `bid_classifications` 캐시로 **LLM 재호출 없음**(변경공고는 재판정).
- **가역성:** 드롭 판정도 경량 로그(`collect_rejects`)로 남겨 임계값 튜닝·소급 복구 가능.

## 4. 데이터 모델 (기존 스키마에 추가)

### 4.1 `bids` 컬럼 추가 — 분류 결과(적재분만)
```sql
alter table bids add column if not exists biz_category text
  check (biz_category in ('감리','컨설팅'));          -- 적재된 공고는 반드시 둘 중 하나(보류 포함 시 nullable 유지)
alter table bids add column if not exists classify jsonb;  -- {method,confidence,reason,model,at,needs_review}
create index if not exists idx_bids_bizcat on bids(biz_category);
```
- `biz_category`: 감리 / 컨설팅. **보류(needs_review) 공고는 LLM 제안값**을 넣되 `classify.needs_review=true`로 표시.
- `classify` jsonb 예: `{ "method":"llm", "confidence":0.86, "reason":"정보시스템 감리대가 산정·감리원 배치 명시", "model":"anthropic/claude-haiku-4.5", "at":"2026-07-17T...", "needs_review":false }`

### 4.2 `bid_classifications` — 분류 결정 캐시/감사 (신규, 경량)
적재분·드롭분 **모든 결정**을 한 행씩 남긴다. raw payload는 저장하지 않아 가볍다. 재수집 시 LLM 재호출을 막는 캐시이자, 임계값 튜닝용 감사 로그.
```sql
create table if not exists bid_classifications (
  bid_no      text not null,
  bid_seq     text not null default '00',
  category    text not null check (category in ('감리','컨설팅','해당없음','보류','오류')),
  confidence  numeric(4,3),                 -- 0.000~1.000
  reason      text,
  method      text not null default 'llm'   -- llm | rule | manual
              check (method in ('llm','rule','manual')),
  model       text,
  title       text,                         -- 튜닝 편의(짧은 메타만)
  order_org   text,
  prefilter_base int,                       -- Stage1 base 점수(튜닝)
  decided_at  timestamptz not null default now(),
  primary key (bid_no, bid_seq)
);
create index if not exists idx_bidcls_category on bid_classifications(category);
create index if not exists idx_bidcls_decided on bid_classifications(decided_at desc);
```

### 4.3 RLS (기존 패턴 준수)
```sql
alter table bid_classifications enable row level security;
create policy bidcls_read on bid_classifications for select
  using (app_current_role() is not null);          -- active 전원 R(검수·튜닝)
-- write는 service key 전용(수집기/배치) → write 정책 없음(anon default-deny)
```
- `bids`는 기존 RLS 그대로. `collect_runs`(이미 존재) 카운터만 확장(§9).

## 5. 기능 요구사항 (FR-21 ~ FR-27 — 기존 FR-20 다음)

### FR-21 수집 하드 필터 (Stage 0)
- **개요**: 용역 유형·명백 제외(건설/건축/토목/소방/전기 감리, 물품, 일반 청소·경비 등)를 **LLM·DB 없이** 즉시 드롭.
- **처리**: 제목·계약방법 정규화 후 `keyword_groups.exclude` + 전역 제외어 세트로 판정. CLAUDE.md 도메인 규칙(건설감리 구분) 준수.
- **관련**: keyword_groups, collect_rejects(로그).

### FR-22 저비용 사전선별 (Stage 1)
- **개요**: `scoreBid`의 **base(주력 키워드·계약 매칭)** 를 계산해 **base ≥ CLASSIFY_MIN_PREFILTER**(기본 4 = 주력 키워드 최소가중치)인 공고만 LLM 후보로 통과. 나머지 드롭.
- **처리**: 기존 `ai.mjs.scoreBid`의 base 산식 재사용(발주/고객사 가산 제외 = 순수 주력 적합도). exclude 감점 반영.
- **효과**: 스캔의 ~93% 제거(실측 6.8%만 통과). **LLM 호출 수 = 후보 수**.
- **관련**: rules, keyword_groups.

### FR-23 LLM 사업분류 (Stage 2)
- **개요**: 후보 공고를 **건당 LLM 호출**하여 `감리 | 컨설팅 | 해당없음` + `confidence(0~1)` + `reason`으로 분류.
- **입력**: 공고 메타만(제목·발주/수요기관·계약방법·추정가·요지). **첨부 본문은 미사용**(수집 시점엔 미추출 + 비용↓). 
- **출력**: **엄격 JSON**(§7.2). 파싱 실패·비JSON은 재시도 1회 후 '오류' 처리.
- **캐시**: `bid_classifications`에 (bid_no,bid_seq) 결정이 있고 **변경공고가 아니면 LLM 생략**(캐시 hit).
- **모델**: `anthropic/claude-haiku-4.5`(기존 `ai.mjs`와 동일, 저비용). `CLASSIFY_MODEL`로 override.
- **관련**: OpenRouter, bid_classifications.

### FR-24 적재 결정 & 보류 검수 (Stage 3)
- **개요**: 분류·신뢰도에 따라 **적재 / 보류적재 / 미적재**를 결정(§7.3 판정표).
- **처리**:
  - 감리·컨설팅 & `conf ≥ KEEP` → `bids` upsert + `biz_category` 지정.
  - `DROP < conf < KEEP`(애매) 또는 LLM 오류 → **보류 적재**(`biz_category`=제안값, `classify.needs_review=true`).
  - 해당없음 & `conf ≥ DROP` → **미적재**(bid_classifications='해당없음'만 기록).
- **놓침 방지**: 애매·오류는 절대 드롭하지 않음 → 검수 큐(S-12/전용 화면)에서 사람이 확정.
- **관련**: bids, bid_classifications.

### FR-25 수동 수집 전용 적용 (자동수집 제외)
- **개요**: 수집은 **수동 "바로수집"** 경로(`lib/collect/runner.ts` + `app/api/collect/run`)에서만 분류 게이트 `lib/collect/classify.ts`를 호출한다. **자동(cron) 수집은 없다.**
- **처리**: 수동 바운드 수집 루프에서 페이지 단위로 후보를 모아 게이트 통과분만 upsert. 페이지 상한(바운드) + LLM 상한 `CLASSIFY_MAX_LLM_PER_RUN` 동시 적용(서버리스 타임아웃·비용 통제).
- **자동수집 폐지**: `.github/workflows/collect.yml`의 스케줄(cron `0 22,3,8,13 * * *`)을 **제거/비활성**한다. `workflow_dispatch`(수동 실행)만 필요 시 유지 가능하나 기본은 인앱 "바로수집" 사용.
- **관련**: lib/collect/runner.ts, app/api/collect/run, collect.yml(cron 제거).

### FR-26 자원 통제 (상한·서킷브레이커·비용)
- **개요**: 1회 실행당 LLM 호출 상한, 캐시, 비용 추정으로 자원 폭주를 원천 차단.
- **처리**: `CLASSIFY_MAX_LLM_PER_RUN` 초과분은 **보류(미분류)** 로 남겨 다음 실행에서 처리. `collect_runs`에 llm_calls·kept·dropped·pending·est_cost 기록.
- **관련**: collect_runs.

### FR-27 소급 분류(백필) & 정리
- **개요**: 기존 적재분(`bids`)을 소급 분류하여 `biz_category` 채우고 **해당없음은 아카이브/삭제**.
- **처리**: `scripts/classify_backfill.mjs` — Stage 1~3을 기존 bids에 적용(캐시 활용). 해당없음은 기존 `cleanup_bids()`(소프트 아카이브)로 처리(가역).
- **관련**: bids, bid_classifications, cleanup_bids.

## 6. 처리 흐름 상세 (수동 수집 모듈)

`lib/collect/classify.ts` (신규) — 순수 함수 + 서비스클라이언트 주입. 수동 "바로수집"(`runner.ts`)에서 호출:
```
classifyAndFilter(bids[], { sb, rules, groups, limits }) →
  { keep: RowWithCategory[], rejects: RejectLog[], stats }
```
1. **Stage 0/1** 로 `keep-candidate` 선별(동기, LLM 0).
2. 후보를 **캐시 조회**(`bid_classifications` in-query) → miss만 LLM.
3. miss에 대해 **동시성 제한 병렬**(예 4~6)로 `chat()` 호출, JSON 파싱.
4. 판정표 적용 → keep/보류/드롭 분기, 캐시·reject 로그 기록.
5. keep(+보류)만 상위 수집기가 `bids.upsert`.

## 7. LLM 분류 상세 (FR-23)

### 7.1 프롬프트(시스템) — 도메인 고정
```
너는 '정보시스템(IT) 감리·컨설팅 전문회사'의 입찰 사업분류 분석가다.
주어진 공공 입찰공고가 아래 중 무엇인지 판정한다.
- 감리: 정보시스템 감리(정보시스템감리사/감리원 배치·감리대가 산정),
        정보화사업의 제3자 감리·PMO 감리. ※ 건설/건축/토목/소방/전기 '감리'는 감리 아님(해당없음).
- 컨설팅: ISP/ISMP·정보화전략계획, EA, 정보화 성과평가, 정보보안 컨설팅,
          PMO, 데이터/AI 컨설팅 등 IT 자문·설계 용역.
- 해당없음: 위에 속하지 않는 모든 공고(SI 구축만·단순 유지보수·물품·건설·일반용역 등).
반드시 제공된 정보 범위 내에서 판단하고, 애매하면 confidence를 낮게 준다.
출력은 아래 JSON 하나만. 설명 텍스트 금지.
```
사용자 메시지: 공고명 / 발주기관 / 수요기관 / 계약방법 / 추정가 / 공고요지(있으면).

### 7.2 출력 스키마(엄격 JSON)
```json
{ "category": "감리|컨설팅|해당없음", "confidence": 0.0, "reason": "한 줄 근거" }
```
- 파싱 실패/스키마 위반 → 1회 재시도 → 실패 시 `category='오류'`, 보류 적재.

### 7.3 판정표 (임계값)
| LLM category | confidence | 결정 | bids 적재 | biz_category |
|---|---|---|---|---|
| 감리/컨설팅 | ≥ KEEP(0.60) | **적재** | ✅ | 해당 값 |
| 감리/컨설팅 | DROP(0.40) ~ KEEP | **보류 적재**(검수) | ✅(needs_review) | 해당 값 |
| 해당없음 | ≥ DROP | **미적재** | ❌ | — |
| 해당없음 | < DROP(애매) | **보류 적재**(검수) | ✅(needs_review) | 낮은 쪽 제안 or null |
| 오류/타임아웃 | — | **보류 적재**(fail-open) | ✅(needs_review) | null |
> 임계값(KEEP/DROP)은 `app_settings` 또는 env로 조정. 초기 0.60/0.40 권장, 검수 결과로 튜닝.

## 8. 자원 통제 / 비용 추정 (FR-26)

- **호출 수 = 사전선별 통과분** ≈ 스캔의 6.8% (신규분은 하루 수십 건 수준).
- **캐시**로 재수집분 LLM 0. 변경공고만 재판정.
- **상한**: `CLASSIFY_MAX_LLM_PER_RUN`(기본 300) 초과 시 나머지 보류 → 서킷브레이커.
- **비용(개략)**: 메타만 입력(~500토큰) × haiku-4.5. 3개월 백필 후보 ~2,858건 × 1회 ≈ **일회성 소액**. 수동 운영은 **실행당 후보 수십 건**(사용자가 필요할 때만) → **비용 무시 가능 수준**. 정확 비용은 `collect_runs.est_cost`로 관측.

## 9. 기존 시스템 통합

| 대상 | 변경 |
|------|------|
| `lib/collect/runner.ts` (**수동 유일 경로**) | 페이지 upsert 전 `classifyAndFilter` 호출 → keep만 upsert. 바운드 + LLM 상한. 멱등·부분실패 격리 유지 |
| `.github/workflows/collect.yml` | **스케줄 cron 제거/비활성**(자동수집 폐지). `collect.mjs`는 스케줄에서 분리 |
| `scripts/collect.mjs` | 스케줄 배치 폐기 → **소급 분류 백필(FR-27) 전용**으로만 잔존(수동 실행) |
| `scripts/ai.mjs` (FR-05/06) | 대상이 이미 감리/컨설팅뿐 → 스코어링·요약·임베딩 **부하 자동 감소**. `scoreBid` base 로직을 `classify.ts`와 공유(리팩터) |
| `collect_runs` (모니터) | 카운터 확장: `candidates, llm_calls, kept_감리, kept_컨설팅, dropped, pending_review, llm_errors, est_cost`. checks에 `classify_ok` 추가 |
| S-10 대시보드 `classify()` | 프론트 키워드 매칭 대신 **`bids.biz_category`(권위값)** 사용으로 대체 |
| OpenRouter `chat()` | `ai.mjs`의 호출 헬퍼를 공용 모듈로 추출해 수집기에서도 사용 |

### 9.1 스코어링 규칙(FR-05) 역할 재정의 — **삭제하지 않음**

분류 게이트가 생기면 스코어링 규칙(rules·keyword_groups·`scoreBid`·rescore·S-12)이 중복되어 삭제 가능한지 검토했으나, **삭제 불가·비권장**이다. 분류와 스코어링은 **역할이 다르며**, 오히려 분류 게이트가 스코어링을 **재사용**한다.

**핵심 구분:**
- **분류(Classification) = "이게 감리/컨설팅인가?"** → 적재 여부(Yes/No 게이트). 이분법.
- **스코어링(Scoring) = "이게 얼마나 중요/주력/고객사인가?"** → 저장된 공고들의 **우선순위·정렬·강도**. 연속값.

분류가 끝나도 감리/컨설팅 공고가 다수 남고, **그중 무엇을 위에 보여줄지**(고객사 우선, 주력 강도순)는 스코어링이 정한다. 특히 S-04·S-10의 **"고객사 순 정렬"은 org 룰(스코어링)에 직접 의존**한다.

**결정적 이유 — 분류 게이트가 스코어링을 부품으로 사용:**
- 본 정의서 **Stage 1(FR-22 저비용 사전선별)** 이 곧 `scoreBid`의 **base** 산식이다. 스캔의 ~93%를 **LLM 없이** 컷하는 자원절감 장치다.
- 따라서 **스코어링을 삭제하면 사전선별이 사라져 "전량 건당 LLM"이 되고, 해결하려던 서버 자원 문제가 그대로 재발**한다. rules는 분류 게이트가 동작하기 위한 **필수 부품**이다.

**대체 관계 요약:**
| 스코어링의 역할 | 분류 게이트가 대체? | 처리 |
|---|---|---|
| A. 관련 여부 필터(score>0/≥4) | ✅ 부분 대체 | 적재분이 이미 감리/컨설팅뿐 → 화면의 **관련 여부 필터는 `biz_category` 기준으로 단순화** |
| B. 우선순위·주력 강도 | ❌ 대체 못 함 | **유지** — 정렬·주력점수(coreScore) 그대로 |
| C. 고객사 가산·정렬(org 룰) | ❌ 대체 못 함 | **유지** — 고객사 우선정렬의 근간 |
| Stage1 사전선별(base) | — (재사용) | **유지·강화** — 분류 게이트의 필수 사전선별 |

**역할 이동:** 스코어링의 무게중심을 **"관련 여부 판정" → "우선순위·고객사·강도 랭킹 + 분류 사전선별"** 로 이동한다. "관련 여부" 판정은 LLM 분류(FR-23)가 인계받는다.

**삭제 시 잃는 것(참고):** 고객사 우선 정렬, 주력 강도순 정렬, 무료·결정론적·튜닝 가능한 랭킹, 그리고 분류 게이트의 사전선별(→ LLM 비용 폭증, 목적 역행).

**결론:** 스코어링은 분류와 겹치는 기능이 아니라 **분류 다음 단계(랭킹)이자 분류의 사전선별**이다. 삭제 대신 **관련-필터 역할만 축소**하고 **우선순위·고객사·사전선별 역할은 유지**한다.

## 10. 화면 연계

| 화면 | 추가 |
|------|------|
| S-04/S-05 목록·검색 | `biz_category` 배지(감리/컨설팅) + 필터, `needs_review` 표식 |
| S-06 상세 | 분류 결과·confidence·reason 표시(투명성) |
| S-10 통계(수집 모니터) | 분류 통계(감리/컨설팅/보류/드롭 건수), "바로수집" 결과에 분류 요약 |
| S-12 스코어링 규칙 | **분류 설정**(모델·임계값 KEEP/DROP·사전선별 base·LLM 상한) + **검수 큐**(보류 목록 승인/재분류/삭제) |

## 11. 설정 파라미터 (env / app_settings)

| 키 | 기본 | 의미 |
|----|------|------|
| `CLASSIFY_ENABLED` | true | 분류 게이트 on/off(off 시 기존 전량 적재로 폴백) |
| `CLASSIFY_MODEL` | anthropic/claude-haiku-4.5 | 분류 LLM |
| `CLASSIFY_MIN_PREFILTER` | 4 | Stage1 통과 base 하한 |
| `CLASSIFY_KEEP_THRESHOLD` | 0.60 | 적재 신뢰도 하한 |
| `CLASSIFY_DROP_THRESHOLD` | 0.40 | 드롭 신뢰도 하한(미만은 보류) |
| `CLASSIFY_MAX_LLM_PER_RUN` | 300 | 1회 실행 LLM 상한(서킷브레이커) |
| `CLASSIFY_CONCURRENCY` | 4 | LLM 동시 호출 수 |

## 12. 예외 / 실패 처리

- **LLM 오류·타임아웃·JSON 파싱 실패** → 1회 재시도 → 실패 시 **보류 적재(fail-open)**, `bid_classifications='오류'`. 다음 실행에서 캐시가 '오류'면 **재분류 시도**.
- **OpenRouter 키 없음/전체 실패** → 분류 게이트 **일시 비활성**(안전) + `collect_runs.checks.classify_ok=false` 경고. 이 실행분은 보류 적재(놓침 방지) 또는 기존 방식 폴백(설정).
- **상한 초과** → 나머지 후보 보류, 다음 실행 처리(누락 아님).
- **오분류 정정** → 검수 큐에서 사람이 `biz_category` 수정 → `method='manual'` 캐시 갱신(이후 재분류 안 함).

## 13. 마이그레이션 (FR-27)

1. 스키마 적용: `alter bids` + `bid_classifications` (SQL Editor).
2. `scripts/classify_backfill.mjs` 실행 → 기존 `bids` 소급 분류(캐시 채움).
3. 해당없음 판정분 → `cleanup_bids()`로 **소프트 아카이브**(가역). 검수 후 영구삭제 결정.
4. 결과 리포트: 적재 유지 N / 아카이브 M / 보류 K.

## 14. 보안 / 정확도 리스크

- **개인정보**: 분류 입력은 공고 메타(공개정보)만. 첨부 본문·개인정보 미투입. LLM에 회사 내부정보 미전송.
- **오분류 리스크**: LLM 환각·경계 오판 → **보류/검수 큐 + confidence 노출 + 캐시 수동정정**으로 통제. 임계값은 데이터로 보정.
- **놓침 리스크(가장 중요)**: 잘못 드롭 시 영업기회 유실 → **fail-open + reject 로그 보존 + 임계값 하향 여지 + 소급 재분류**로 복구 가능.
- **도메인 규칙 준수**: 건설감리 제외(CLAUDE.md) 프롬프트·제외어 이중 반영.

## 15. 테스트 시나리오

1. **정상-감리**: '○○정보시스템 구축 감리 용역'(정보시스템감리사 배치) → 감리·conf 높음 → 적재, biz_category='감리'.
2. **정상-컨설팅**: 'ISP 수립'·'정보화전략계획'·'정보보안 컨설팅' → 컨설팅 적재.
3. **함정-건설감리**: '△△청사 건설공사 감리' → Stage0/LLM 모두 해당없음 → **미적재**.
4. **함정-일반컨설팅**: '조직진단 경영컨설팅' → 해당없음 → 미적재.
5. **애매**: 'SI 구축 및 사업관리(PMO)' → 보류 적재·검수 큐 노출.
6. **캐시**: 동일 공고 재수집 → LLM 미호출(캐시 hit) 확인.
7. **상한**: 후보 > MAX_LLM_PER_RUN → 초과분 보류, 다음 실행 처리.
8. **오류**: LLM 강제 실패 → 보류 적재(누락 0) + collect_runs 경고.
9. **자원**: 게이트 on 전/후 `bids` 증가량·AI 배치 시간 비교(대폭 감소 확인).

## 16. 산출물 (구현 시)

```
supabase/classify.sql               # bids 컬럼 추가 + bid_classifications + RLS
lib/collect/classify.ts             # 3-스테이지 게이트(수동 수집 전용)
lib/ai/openrouter.ts                # chat()/JSON 파서 공용 추출(ai.mjs와 공유)
lib/collect/runner.ts               # 게이트 통합(수동 "바로수집") + LLM 상한
app/api/collect/run/route.ts        # 수동 트리거(기존, 분류 결과 반영)
.github/workflows/collect.yml       # 스케줄 cron 제거(자동수집 폐지)
scripts/classify_backfill.mjs       # FR-27 소급 분류(수동 실행)
scripts/collect.mjs                 # 백필 전용 잔존(스케줄 배치 폐기)
app/(app)/admin/rules/page.tsx      # S-12 분류 설정 + 검수 큐
components/bids/BidCard.tsx         # biz_category 배지·needs_review
lib/queries/{bids,stats}.ts         # biz_category 필터·집계
app/(app)/dashboard/stats/page.tsx  # S-10 분류 통계(classify() → biz_category 대체)
```

## 17. 단계별 적용 절차

1. **스키마**: `classify.sql`(bids 컬럼 + bid_classifications + RLS) SQL Editor 적용.
2. **모듈**: `classify.ts` + OpenRouter 공용 헬퍼 구현, `scoreBid` base 공유.
3. **수집 통합**: `runner.ts`(수동 "바로수집")에 게이트 삽입(설정 `CLASSIFY_ENABLED`로 안전 토글). **`collect.yml` 스케줄 cron 제거**(자동수집 폐지).
4. **모니터**: collect_runs 카운터·checks 확장, S-10에 분류 통계.
5. **백필**: `classify_backfill.mjs`로 기존 bids 소급 → 해당없음 아카이브.
6. **화면**: S-12 설정·검수 큐, S-04/06 배지, 대시보드 biz_category 전환.
7. **튜닝**: 검수 결과로 KEEP/DROP·프롬프트·제외어 보정.

---

### 부록. 요구사항 대비 구현 매핑

| 사용자 요구 | 본 정의서 반영 |
|-------------|----------------|
| 수동 수집 시 적용(자동 제외) | FR-25 (runner.ts + app/api/collect/run, cron 폐지) |
| 건당 조회해서 LLM 분류 | FR-23 (후보 건당 LLM, 캐시) |
| 감리/컨설팅 분류 | FR-23 판정(감리·컨설팅·해당없음) + biz_category |
| 해당 사업만 DB 저장 | FR-24 (감리/컨설팅만 bids 적재, 해당없음 미적재) |
| 서버 자원 문제 해소 | §2.1 2단계 게이트 + FR-22 사전선별 + FR-26 상한/캐시 (LLM·저장 동시 절감) |
