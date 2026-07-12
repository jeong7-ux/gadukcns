---
name: integration-qa
description: "나라장터 입찰정보시스템의 통합 정합성을 검증하는 스킬. 존재 확인이 아니라 경계면 교차 비교로 검증한다 — schema.sql 컬럼↔collect.mjs upsert, Supabase 쿼리 shape↔프론트 훅, ai.mjs 출력↔S-06 렌더, OpenAPI 응답↔수집 매핑을 나란히 대조한다. RLS 정책을 역할별로 강제 테스트하고, 각 모듈 완성 직후 점진적으로 검증한다. QA/검증/정합성/경계 버그/RLS 테스트 작업 시 반드시 사용. qa-engineer 에이전트 전용."
---

# 통합 QA 스킬

시스템의 정합성을 검증한다. QA의 핵심은 "파일이 존재하는가"가 아니라 **"경계면에서 데이터 shape이 양쪽에서 일치하는가"**이다. 경계 버그는 각 파일만 보면 안 보이고, 두 파일을 나란히 놓아야 드러난다.

## 검증 방법: 경계면 교차 비교

한쪽만 읽고 판단하지 않는다. 항상 **생산 측 ↔ 소비 측**을 동시에 열고 필드 단위로 대조한다.

| 경계 | 생산 측 | 소비 측 | 흔한 버그 |
|------|--------|--------|----------|
| DB↔수집 | schema.sql 컬럼/타입 | collect.mjs upsert 페이로드 | 컬럼 누락, 카멜/스네이크 불일치, 타입 불일치 |
| API↔수집 | OpenAPI 응답 필드 | 수집 스크립트 매핑 | 필드명 오타, null 미처리 |
| DB↔AI | schema.sql AI 컬럼 | ai.mjs 출력 | embedding 차원, score 타입, tags 배열 형식 |
| AI↔프론트 | ai.mjs 산출 shape | S-06 렌더 코드 | ai_summary 형식, 매칭 인력 필드명 |
| DB↔프론트 | 쿼리 결과 컬럼 | 컴포넌트 참조 필드 | 존재하지 않는 필드 참조, status 값 매핑 |

**절차:** ① 계약 문서(`01_data-architect_contract.md`)를 기준으로 삼는다 → ② 각 경계의 두 파일을 Read → ③ 필드 대조표 작성 → ④ 불일치를 구체적으로 기록.

## RLS 강제 검증 (6.1 권한 매트릭스)

역할별(exec/strategy/pm/admin)로 R/W가 매트릭스대로 허용/차단되는지 실제로 확인:

- bids/keyword_groups: active면 read 가능
- watchlist write: strategy/pm/admin만
- member_table: read pm/admin, write admin
- app_settings: admin only
- active 아닌 사용자(pending/suspended): 데이터 접근 차단

가능하면 검증 스크립트(스키마 파싱 후 컬럼셋 비교, 역할별 샘플 쿼리)를 작성·실행한다.

## 점진적 QA (Why 중심)

- **전체 완성 후 1회가 아니라 모듈 완성 직후마다** — 스키마 완성 → 즉시 검증, 수집 완성 → 즉시 스키마와 대조, AI 완성 → 즉시 컬럼 대조, 화면 완성 → 즉시 쿼리 대조. 늦게 발견할수록 수정 비용이 크다.
- **재현 가능한 결함 보고** — "어느 파일 어느 필드가, 반대편 어느 코드와, 어떻게 어긋나는가"를 라인 단위로.

## 결함 보고 형식

```
## [경계] schema ↔ collect.mjs
- 판정: PASS | FIX
- 불일치: bids.demand_org(스키마) ↔ collect.mjs에 demandOrg 미매핑(L42)
- 수정 지시: collect.mjs upsert에 demand_org 매핑 추가
- 통보 대상: collector-engineer(생산), 필요 시 소비 측에도 공유
```

## 산출물

- `_workspace/05_qa_report.md` — 모듈별 PASS/FIX, 경계 불일치 목록, RLS 결과, 수정 지시

## 검증 체크리스트

- [ ] 5개 경계 모두 필드 단위 대조 완료
- [ ] RLS를 역할별로 실제 테스트(허용/차단)
- [ ] 각 모듈 완성 직후 검증(점진적) 수행
- [ ] 발견 결함을 생산 측 팀원에게 SendMessage로 통보
- [ ] 이전 리포트 대비 회귀 여부 확인
