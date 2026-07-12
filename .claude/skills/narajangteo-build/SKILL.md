---
name: narajangteo-build
description: "나라장터 입찰정보시스템의 에이전트 팀을 조율하는 오케스트레이터. 입찰정보시스템/나라장터 시스템 구축·개발·구현, 스키마/수집/AI/화면 생성 요청 시 사용. 후속 작업: 입찰 시스템 결과 수정, 특정 모듈(스키마·수집·AI·화면·QA)만 다시, 업데이트, 보완, 재실행, 이전 결과 개선, 화면 추가, FR 추가 구현 요청 시에도 반드시 이 스킬을 사용. 단순 질문은 직접 응답 가능."
---

# 나라장터 입찰정보시스템 Orchestrator

기능상세정의서(FR-01~15)와 UI/UX 스토리보드(S-01~13)를 근거로, 에이전트 팀을 조율하여 Supabase 데이터 계층 · 수집 파이프라인 · AI 보강 · Next.js SPA · 통합 QA를 생성하는 통합 스킬.

## 실행 모드: 에이전트 팀

풀스택 빌드는 스키마 shape·API 계약·AI 출력 형식을 계층 간 교차 공유해야 하므로, 팀원 간 직접 통신(SendMessage)과 공유 작업 목록이 품질을 높인다. 의존성은 파이프라인 구조(스키마 우선), 실행은 팬아웃(병렬)이다.

## 에이전트 구성

| 팀원 | 에이전트 타입 | 역할 | 스킬 | 출력 |
|------|-------------|------|------|------|
| data-architect | custom | Supabase 스키마·RLS·pgvector (FR-01, 4·6장) | supabase-data-layer | `01_data-architect_schema.sql`, `01_data-architect_contract.md` |
| collector-engineer | custom | 수집 배치·OpenAPI·첨부추출 (FR-02/03/04) | nara-collector | `02_collector_scripts.md` |
| ai-engineer | custom | 요약·임베딩·스코어링·매칭 (FR-05/06/10) | ai-enrichment | `03_ai_scripts.md` |
| frontend-engineer | custom | Next.js 13화면·토큰·실시간 (FR-07/08/11/13/14/15) | nextjs-screen-builder | `04_frontend_screens.md` |
| qa-engineer | general-purpose | 경계면 교차 검증·RLS 테스트 | integration-qa | `05_qa_report.md` |

> QA는 검증 스크립트 실행이 필요하므로 `general-purpose`(읽기 전용 Explore 아님). 모든 Agent/TeamCreate 호출에 `model: "opus"` 명시.

## 워크플로우

### Phase 0: 컨텍스트 확인 (후속 작업 지원)

1. `_workspace/` 디렉토리 존재 여부 확인
2. 실행 모드 결정:
   - **미존재** → 초기 실행. Phase 1로
   - **존재 + 부분 수정 요청**(예: "화면만 다시", "스코어링 규칙 보완") → 부분 재실행. 해당 에이전트만 재호출, 기존 산출물 중 대상만 덮어쓰기. 프롬프트에 이전 산출물 경로 포함
   - **존재 + 새 입력/전면 재구축** → 새 실행. 기존 `_workspace/`를 `_workspace_{YYYYMMDD_HHMMSS}/`로 이동 후 Phase 1
3. 부분 재실행 시 의존 관계 확인: 스키마 변경이면 collector/ai/frontend에 파급되므로 계약 재전파 필요

### Phase 1: 준비

1. 입력 분석 — 기능상세정의서·UI/UX 스토리보드 PDF 확인 (프로젝트 루트 또는 사용자 제공)
2. `_workspace/` 생성 (새 실행이면 기존 것 타임스탬프 이동 후)
3. 스펙 텍스트를 `_workspace/00_input/`에 저장 (PDF는 pdftotext -layout로 추출)

### Phase 2: 팀 구성

```
TeamCreate(
  team_name: "narajangteo-team",
  members: [
    { name: "data-architect",      agent_type: "data-architect",      model: "opus", prompt: "supabase-data-layer 스킬로 schema.sql·RLS·계약 문서를 먼저 확정하라. 확정 즉시 계약을 팀에 브로드캐스트." },
    { name: "collector-engineer",  agent_type: "collector-engineer",  model: "opus", prompt: "nara-collector 스킬로 collect.mjs/attachments.mjs/collect.yml 구현. data-architect 계약에 upsert 정렬." },
    { name: "ai-engineer",         agent_type: "ai-engineer",         model: "opus", prompt: "ai-enrichment 스킬로 ai.mjs 구현. 스코어링/요약/매칭. AI 컬럼 계약 준수." },
    { name: "frontend-engineer",   agent_type: "frontend-engineer",   model: "opus", prompt: "nextjs-screen-builder 스킬로 13개 화면 구현. 디자인 토큰·RLS 게이팅·계약 준수." },
    { name: "qa-engineer",         agent_type: "general-purpose",     model: "opus", prompt: "integration-qa 스킬로 각 모듈 완성 직후 경계면 교차 검증·RLS 테스트를 점진적으로 수행." }
  ]
)
```

작업 등록 (의존성 = 파이프라인):
```
TaskCreate(tasks: [
  { title: "스키마·RLS·계약 확정",       assignee: "data-architect" },
  { title: "수집 파이프라인 구현",         assignee: "collector-engineer", depends_on: ["스키마·RLS·계약 확정"] },
  { title: "AI 보강 파이프라인 구현",      assignee: "ai-engineer",        depends_on: ["스키마·RLS·계약 확정"] },
  { title: "13개 화면 구현",              assignee: "frontend-engineer",  depends_on: ["스키마·RLS·계약 확정"] },
  { title: "스키마 검증(경계·RLS)",        assignee: "qa-engineer",        depends_on: ["스키마·RLS·계약 확정"] },
  { title: "수집·AI·화면 통합 검증",       assignee: "qa-engineer",        depends_on: ["수집 파이프라인 구현","AI 보강 파이프라인 구현","13개 화면 구현"] }
])
```

### Phase 3: 병렬 빌드 (팀 자체 조율)

**실행 방식:** data-architect가 계약을 먼저 고정 → 나머지 3명이 병렬 빌드 → qa가 각 모듈 완성 직후 검증.

**팀원 간 통신 규칙:**
- data-architect: 계약 확정 즉시 collector/ai/frontend에 컬럼·RLS·차원(1024) 브로드캐스트
- collector-engineer ↔ ai-engineer: 수집 완료 시점·워크플로우 스텝 연결(collect→ai) 협의
- ai-engineer → frontend-engineer: ai_summary/tags/매칭 shape 전달 (S-06 렌더용)
- qa-engineer → 각 생산 측: 경계 불일치 발견 시 즉시 SendMessage로 수정 지시
- 계약과 어긋나는 요구가 생기면 data-architect에게 조정 요청 (스키마가 계약 원천)

**산출물 저장:**
| 팀원 | 출력 경로 |
|------|----------|
| data-architect | `_workspace/01_data-architect_schema.sql`, `_workspace/01_data-architect_contract.md` |
| collector-engineer | `_workspace/02_collector_scripts.md` |
| ai-engineer | `_workspace/03_ai_scripts.md` |
| frontend-engineer | `_workspace/04_frontend_screens.md` |
| qa-engineer | `_workspace/05_qa_report.md` |

**리더 모니터링:** 유휴 알림 수신, 막힌 팀원에 SendMessage/재할당, TaskGet으로 진행률 확인.

### Phase 4: 통합 및 코드 배치

1. 모든 작업 완료 대기 (TaskGet)
2. 각 산출물 Read → 최종 코드 배치:
   - `supabase/schema.sql`
   - `scripts/collect.mjs`, `scripts/attachments.mjs`
   - `scripts/ai.mjs`
   - `.github/workflows/collect.yml`
   - `app/` (Next.js 라우트·컴포넌트), `package.json`
3. qa_report의 미해결 FIX 항목이 있으면 해당 팀원 재호출로 반영
4. 사용자에게 산출물 요약 + 남은 설정(Secrets, Supabase 확장 활성화) 안내

### Phase 5: 정리

1. 팀원 종료 요청 (SendMessage)
2. 팀 정리 (TeamDelete)
3. `_workspace/` 보존 (사후 검증·감사 추적용)
4. 결과 요약 보고 + 피드백 요청

## 데이터 흐름

```
[리더] → TeamCreate → data-architect ─(계약 브로드캐스트)→ collector / ai / frontend
                            │                                    │      │      │
                       schema.sql/contract              02_*.md 03_*.md 04_*.md
                            └──────────── qa-engineer(경계 교차 검증) ──────┘
                                              │
                                        05_qa_report.md
                                              ↓
                                   [리더: 코드 배치 + 통합]
                                              ↓
                            supabase/ · scripts/ · app/ · .github/
```

## 에러 핸들링

| 상황 | 전략 |
|------|------|
| data-architect 지연 | 나머지는 골격(수집 매핑·프롬프트·화면 레이아웃) 선작업, 계약 확정 후 데이터 바인딩 완성 |
| 팀원 1명 실패/중지 | 리더 감지 → SendMessage 상태 확인 → 재시작 또는 대체 |
| 팀원 과반 실패 | 사용자에게 알리고 진행 여부 확인 |
| 경계 결함 2회 수정 후 미해결 | qa가 리더에 에스컬레이션, 리포트에 명시하고 진행 |
| 계약 충돌(팀원 간 해석 차) | qa가 `01_..._contract.md` 기준으로 판정, data-architect가 계약 갱신·재전파 |
| 타임아웃 | 현재까지 산출물로 진행, 미완료 영역을 리포트에 명시 |

## 테스트 시나리오

### 정상 흐름
1. 사용자가 "나라장터 입찰정보시스템 구축해줘" 요청
2. Phase 0: `_workspace/` 미존재 → 초기 실행
3. Phase 1: 두 PDF 스펙을 `_workspace/00_input/`에 추출
4. Phase 2: 5명 팀 구성 + 6개 작업(파이프라인 의존성) 등록
5. Phase 3: data-architect 계약 확정 → 3명 병렬 빌드 → qa 점진 검증
6. Phase 4: 산출물을 supabase/·scripts/·app/·.github/에 배치
7. Phase 5: 팀 정리, `_workspace/` 보존
8. 예상 결과: 실행 가능한 프로젝트 골격 + Secrets/확장 활성화 안내

### 에러 흐름
1. Phase 3에서 collector-engineer가 OpenAPI 매핑 중 중지
2. 리더가 유휴 알림 수신 → SendMessage 상태 확인 → 재시작
3. 재시작 실패 시 수집 작업을 부분 산출물로 마감하고 리포트에 "FR-02~04 일부 미완" 명시
4. 나머지(스키마·AI·화면·QA)로 Phase 4 진행
5. 최종 보고서에 미완 영역과 재실행 방법 안내
