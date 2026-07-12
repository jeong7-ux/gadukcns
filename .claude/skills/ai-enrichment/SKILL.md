---
name: ai-enrichment
description: "입찰 데이터의 AI 보강 파이프라인을 구현하는 스킬. OpenRouter LLM으로 공고를 3~5줄 요약(FR-06), bge-m3(baai/bge-m3, 1024차원)로 임베딩, 규칙(rules)+코사인 유사도로 스코어링(FR-05), member_table과 인력 매칭(FR-10), daily_brief 다이제스트를 생성한다. ai.mjs, 임베딩, LLM 요약, 스코어링, 벡터 유사도, 인력 매칭 작업 시 반드시 사용. ai-engineer 에이전트 전용."
---

# AI 보강 파이프라인 스킬

수집된 입찰 데이터에 요약·점수·태그·매칭 인력을 부여하는 `scripts/ai.mjs`를 구현한다. 핵심 가치는 **멱등성(재처리 금지)·결정적 스코어링·환각 최소화**이다.

## 파이프라인 (수집 직후, 7.1)

1. 신규/변경된 bids 조회 (이미 처리된 row는 스킵 — 멱등)
2. 임베딩: 공고 메타 + extracted_text → bge-m3(/embeddings) → bids.embedding / bid_attachments.embedding (vector 1024)
3. 요약: LLM(/chat/completions)로 ai_summary 생성
4. 스코어링: rules + 코사인 유사도 → bids.score/ai_score/tags
5. 인력 매칭(FR-10): 공고 요건 ↔ member_table
6. daily_brief: 당일 top_bids + 다이제스트

## 스코어링 공식 (7.2)

```
score      = Σ(rule.weight for 매칭 rule)   -- rules 테이블(keyword/org/exclude/contract)
           + agency_bonus(관심 발주기관)
           − exclude_penalty(제외 조건 매칭)
ai_score   = round( cosine(bids.embedding, 관심조건 임베딩) × 100 )
알림대상   = (score ≥ THRESHOLD) or (ai_score ≥ AI_THRESHOLD)
```

- **규칙은 데이터로** — 가중치를 코드가 아닌 rules 테이블에서 로드한다. 동일 입력에 동일 점수(결정적 재현성). admin이 S-12에서 규칙을 바꾸면 재계산에 반영된다.

## AI 요약 (7.3, FR-06)

- 입력: 첨부 extracted_text(사업개요/과업범위/자격/일정/평가) + 공고 메타
- 출력: 3~5줄 요약 + 핵심 요건·자격·규모, Markdown → bids.ai_summary
- **환각 최소화** — "제공된 텍스트 범위 내에서만 요약하라"고 지시. 출력이 비거나 형식이 어긋나면 재시도 후 원문 일부로 폴백

## 인력 매칭 (FR-10)

- 공고 요건(기술등급/전문분야/자격)과 member_table(tech_grade/specialty_field/license_name/status)을 규칙 + 임베딩 유사도로 매칭
- 추천 인력 목록을 S-06 상세에서 렌더할 수 있는 shape으로 산출 (ai-engineer가 frontend에 형식 전달)

## 작업 원칙 (Why 중심)

- **재처리 금지** — 이미 요약·임베딩된 row를 다시 부르면 토큰/비용 낭비. 변경분만 처리.
- **차원 고정** — embedding은 1024. 불일치는 즉시 중단하고 data-architect에 알림.
- **키 보안** — OpenRouter 키는 app_settings(암호화) 또는 Secrets에서 로드, 로그에 남기지 않는다.

## 산출물

- `_workspace/03_ai_scripts.md`(ai.mjs 전문 + 스코어링 공식 + 프롬프트 템플릿)
- 최종: `scripts/ai.mjs`

## 검증 체크리스트

- [ ] 멱등: 처리 완료 row 재처리 안 함
- [ ] score/ai_score/tags/ai_summary 컬럼이 스키마 계약과 일치
- [ ] 스코어링이 rules 테이블 기반(결정적)
- [ ] LLM 실패 시 1회 재시도 + 폴백, 배치 계속
- [ ] 임베딩 1024차원 검증
