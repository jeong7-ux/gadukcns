# CLAUDE.md

## 하네스: 나라장터 입찰정보시스템

**목표:** 나라장터 OpenAPI로 입찰공고를 매일 07:00(KST) 수집하여 Supabase(PostgreSQL+pgvector+RLS)에 적재하고, AI 요약·스코어링·인력매칭을 거쳐 Next.js SPA(13화면)로 제공하는 사내 B2B 시스템(FR-01~15)을 에이전트 팀으로 구축·유지보수한다.

**발주처 도메인(주력분야):** **정보시스템(정보화/IT) 감리 및 컨설팅** 전문 회사. 일반(건설/토목) 감리가 아님. 관심 분야 = 정보시스템 감리(정보시스템감리사), ISP/정보화전략컨설팅, 정보화 성과평가, 정보보안, SI/시스템통합, 유지보수·운영, AI/데이터. 수집(FR-02)은 나라장터 **용역공고 전체**를 가져오고, 분야 타겟팅은 **keyword_groups(FR-13) + rules 스코어링(FR-05)** 으로 적용한다. `감리`는 건설감리와 구분해야 하므로 keyword_groups.exclude / exclude 룰에 건설·건축·토목·소방·전기 감리를 제외어로 둔다.

**트리거:** 나라장터/입찰정보시스템 관련 구축·개발·구현·수정·모듈(스키마·수집·AI·화면·QA) 작업 요청 시 `narajangteo-build` 스킬을 사용하라. 단순 질문은 직접 응답 가능.

**입력 스펙:**
- `나라장터_입찰정보시스템_기능상세정의서_v1.0.pdf` (FR-01~15, 데이터 모델 4장, RLS 6장, API 9장)
- `나라장터_입찰정보시스템_UIUX_스토리보드_v1.0.pdf` (S-01~13, 디자인 토큰)

**변경 이력:**
| 날짜 | 변경 내용 | 대상 | 사유 |
|------|----------|------|------|
| 2026-07-11 | 초기 구성 (에이전트 5 + 스킬 6) | 전체 | 두 스펙 문서 기반 하네스 신규 구축 |
| 2026-07-11 | 첫 빌드 실행 + QA 2R 수정 | supabase/·scripts/·app/·.github/ | 시스템 골격 생성, RLS 5결함 수정 |
| 2026-07-11 | 실 API 실측 반영 | nara-collector, collector-engineer, scripts | 라이브 검증으로 op명/필드/변경·첨부 방식 정정 |
| 2026-07-11 | 스키마 배포 결함 2건 수정 | supabase/schema.sql | 함수 순서(42P01)·생성컬럼 immutable(42P17) → status 파생 전환 |
| 2026-07-11 | AI 라이브 E2E + 모델 ID 정정 | scripts/ai.mjs | OpenRouter 유효 모델(claude-haiku-4.5)로 수정, 요약·임베딩·brief 실동작 확인 |
| 2026-07-13 | 회원가입 OTP 제거·S-11 아이디 표시·차트 다크모드 | app/(auth)/register·api/{auth,admin}·dashboard/stats | 단순 가입요청(승인 즉시 사용), 이메일 병합 표시, recharts 토큰화 |
| 2026-07-13 | 배포: GitHub + Netlify, 파일저장 Supabase Storage 이전 | lib/storage/blob.ts·api 3라우트·netlify.toml·.gitignore | 서버리스 호환, https://dynamic-froyo-f8fc5d.netlify.app 라이브(자동배포) |
| 2026-07-13 | 주력점수 표준화(coreScore)·마감제외 전면화·S-04/05 정렬·그룹삭제·S-10 v3 재구현 | lib/queries/{score,bids,stats}.ts·app/(app) 4화면·api/keyword-groups·docs v3 2종 | 실측 기반 3축(마감순위·고객사·주력4~9) 대시보드, 검색 그룹 우선정렬·삭제 |
| 2026-07-17 | **S-10 "실시간 모니터링" 3열 전면 재구성**(요약·도넛/피드/추이) + 위젯 정리·분류별현황·한반도지도 등 반복 개편 (**로컬 전용·미배포**) | app/(app)/dashboard/stats/page.tsx·lib/queries/stats.ts·lib/design/korea-map.ts·docs 작업이력 §36~44 | 화면 목업(PPTX·캡처) 기반 재설계. 배포는 명시 "소스 반영" 지시 대기 |
| 2026-07-17 | **수집 자동 4회(07·12·17·22 KST)/수동 즉시 수집 개편 + S-10 수집 파이프라인 모니터**(검증단계·실행이력 시각화) (**로컬 전용·미배포**) | supabase/collect_runs.sql·schema.sql·collect.yml·scripts/collect.mjs·lib/collect/runner.ts·app/api/collect/run·components/dashboard/CollectMonitor.tsx·docs §45 | 운영 가시성 확보. collect_runs는 SQL Editor 적용 필요. 배포는 명시 지시 대기 |
| 2026-07-17 | **수집 시 AI 사업분류 게이트 구현·검증(정의서 v1.1)** — 자동수집 폐지·수동 전용, 3-스테이지(하드필터→룰 사전선별→LLM 감리/컨설팅 분류→선별 적재). 실증 100건→1건(99%↓) (**로컬 전용·미배포**) | supabase/classify.sql·schema.sql·lib/ai/openrouter.ts·lib/collect/{classify,runner}.ts·collect.yml(cron제거)·scripts/classify_backfill.mjs·components/dashboard/CollectButton.tsx·docs §46~47 | 서버 자원 절감. classify.sql SQL Editor 적용 후 영속·백필·검수 큐. 배포 명시 지시 대기 |
| 2026-07-17 | **분류 강화 + UI/네비 전면 개편 + 관리기능 + 소스 반영(배포 2회차)** — 분류 정밀화·무관사업 삭제, S-10/04/07/06 재구성·공용화(InfoRowCells)·홈 브레드크럼·관리자 우측 퀵메뉴, 재스코어링 API·S-11 승인/역할/삭제, S-05/08 삭제 | app/(app)/**·components/**·app/api/{rescore,admin/users}·docs §48~50·CLAUDE.md | **커밋 931aca1·fb09ec7·cac92d7 → origin/main → Netlify 라이브**. 운영DB collect_runs/classify.sql 적용 잔여 |
