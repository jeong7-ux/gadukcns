---
name: nara-collector
description: "나라장터 OpenAPI 데이터 수집 파이프라인을 구현하는 스킬. GitHub Actions cron(0 22 * * * = 07:00 KST)으로 입찰공고(getBidPblancListInfoServcPPSSrch)·가격·변경이력·첨부파일을 호출하고, 커서 기반 증분 수집으로 Supabase에 멱등 upsert하며, kordoc으로 HWP/HWPX/PDF를 Markdown 추출한다. collect.mjs, attachments.mjs, collect.yml, 나라장터 API, 수집 배치 작업 시 반드시 사용. collector-engineer 에이전트 전용."
---

# 나라장터 수집 파이프라인 스킬

매일 07:00(KST) 실행되는 수집 배치를 구현한다. 핵심 가치는 **멱등성·부분 실패 격리·증분 수집**이다.

## OpenAPI 매핑 (라이브 실측 확정 — base `apis.data.go.kr/1230000/ad/BidPublicInfoService`)

| API | 용도 | 주요 파라미터 | 적재 대상 |
|-----|------|--------------|----------|
| getBidPblancListInfoServc (용역) / Cnstwk(공사) / Thng(물품) | 공고 목록(증분) | inqryDiv=1, inqryBgnDt/EndDt(YYYYMMDDHHMM), pageNo, numOfRows, type=json | bids (FR-02) |
| getBidPblancListInfoServcBsisAmount | 기초금액/평가기준 | inqryDiv=2, bidNtceNo | bid_prices (FR-03) |
| — (전용 op 없음: `...ChgHstry`는 API not found) | 변경이력 | 목록 응답 `ntceKindNm='변경공고'`+chgDt/chgNtceRsn/befBidBbancNo 파생 | bid_changes (FR-04) |
| — (전용 op 없음: 목록 응답 내장) | 첨부 | 목록 `ntceSpecDocUrl1~10`+`ntceSpecFileNm1~10`(+stdNtceDocUrl) | bid_attachments (A.5) |

인증: 쿼리파라미터 `serviceKey`(env `NARA_SERVICE_KEY`), base override `NARA_API_BASE`, 유형선택 `NARA_BID_TYPES`. 응답 `response.header.resultCode='00'`, `response.body.items[]`. 필드는 스키마 컬럼으로 정규화(카멜→스네이크). 상세 매핑표: `_workspace/00_input/API_실측매핑.md`.

> 스펙(정의서 9.1)의 `getBidPblancListInfoServcPPSSrch`·변경이력/첨부 별도 op는 실 서비스에 존재하지 않는다. 위 실측표를 기준으로 삼는다.

## 수집 순서 (7.1)

1. 커서(collect_cursor.last_reg_dt) 읽기 → inqryBgnDt로 사용 (증분)
2. 공고 목록 페이지네이션 수집 → bids upsert(bid_no+bid_seq)
3. 가격/변경이력 수집 → bid_prices/bid_changes
4. **전체 성공 후에만** collect_cursor 갱신 (실패 시 미갱신으로 다음 실행 자연 재시도)
5. 첨부는 watchlist 대상 우선으로 다운로드 → Storage 저장 → kordoc 추출 → extracted_text

## 멱등성·안정성 규칙 (Why 중심)

- **upsert 키를 엄격히** — bids는 (bid_no, bid_seq), bid_prices는 bid_no. 재실행 시 중복이 생기면 점수·통계가 오염된다.
- **부분 실패를 격리** — API 페이지 하나 실패가 배치 전체를 죽이면 안 된다. 실패 항목은 로그로 남기고 계속, 커서는 전체 성공 시에만 전진.
- **레이트 리밋 대응** — 호출 간 백오프 + 1회 재시도. numOfRows/pageNo로 페이지네이션.
- **Secrets는 환경변수로만** — 서비스키/서비스롤키를 코드/로그에 남기지 않는다.

## kordoc 첨부 추출 (A.5/A.6)

- Node 20, kordoc으로 HWP/HWPX/PDF → Markdown. pdfjs-dist 보조
- 대상: watchlist에 담긴 공고 우선 (전량 추출은 비용 과다)
- 변환 실패 시 downloaded=true, extracted_text는 비우고 로그. 배치는 계속

## GitHub Actions (collect.yml)

- 트리거: `schedule: cron('0 22 * * *')`(=07:00 KST) + `workflow_dispatch`(수동)
- 스텝: checkout → setup-node@20 → npm ci → `node scripts/collect.mjs` → (연결) `node scripts/ai.mjs`
- env: NARA_SERVICE_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY (Secrets 주입)

## 산출물

- `_workspace/02_collector_scripts.md`(API 매핑표 + 스크립트 전문)
- 최종: `scripts/collect.mjs`, `scripts/attachments.mjs`, `.github/workflows/collect.yml`

## 검증 체크리스트

- [ ] upsert 키가 스키마 PK와 일치 (data-architect 계약 대조)
- [ ] 커서 증분 로직 + 전체 성공 시에만 갱신
- [ ] 부분 실패 시 배치 계속 + 실패 로깅
- [ ] cron이 07:00 KST(UTC 22:00) + workflow_dispatch
- [ ] Secrets가 환경변수로만 참조됨
