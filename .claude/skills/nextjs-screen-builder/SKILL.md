---
name: nextjs-screen-builder
description: "나라장터 입찰정보시스템의 Next.js SPA 화면을 구현하는 스킬. 13개 화면(S-01~S-13: 로그인/회원가입/입찰목록/상세/관심목록/캘린더/인력/대시보드/관리자)을 React+TypeScript+Tailwind+Supabase JS로 만든다. 디자인 토큰(#1F497D 등), D-day 3구간 색상, 상태 pill, RLS-aware 쿼리, Realtime, FullCalendar, recharts를 적용한다. 화면/UI/컴포넌트/라우팅/Supabase 클라이언트 작업 시 반드시 사용. frontend-engineer 에이전트 전용."
---

# Next.js 화면 빌더 스킬

UI/UX 스토리보드의 13개 화면을 구현한다. 핵심 가치는 **디자인 토큰 중앙화·RLS 기반 게이팅·계약 준수(데이터 shape 추측 금지)**이다.

## 화면 지도 (S-01~S-13)

| ID | 화면 | FR | 라우트 | 접근 |
|----|------|-----|--------|------|
| S-01 | 로그인 | FR-01 | `app/(auth)/login` | public |
| S-02 | 회원가입(이메일 인증) | FR-01 | `app/(auth)/register` | public |
| S-03 | 승인 대기 | FR-01 | `app/(auth)/pending` | pending |
| S-04 | 입찰 목록(메인) | FR-07/13/14 | `app/dashboard` | active |
| S-05 | 키워드그룹 검색 | FR-13 | `app/search` | strategy/pm/admin |
| S-06 | 입찰 상세 + AI 브리핑 | FR-03/04/06/10 | `app/bids/[id]` | active |
| S-07 | 관심 목록 | FR-08 | `app/watchlist` | strategy/pm/admin |
| S-08 | 캘린더 | FR-15 | `app/calendar` | active |
| S-09 | 인력 관리 | FR-09 | `app/admin/members` | pm/admin |
| S-10 | 통계 대시보드 | FR-11 | `app/dashboard/stats` | active |
| S-11 | 사용자 승인 관리 | FR-01 | `app/admin/users` | admin |
| S-12 | 스코어링 규칙 | FR-05 | `app/admin/rules` | admin |
| S-13 | API 키 설정 | FR-12 | `app/admin/settings` | admin |

## 디자인 토큰 (2장) — Tailwind config/CSS 변수로 중앙화

| 토큰 | 값 |
|------|-----|
| Primary | #1F497D |
| Accent | #2563EB |
| Success | #16A34A |
| Danger | #DC2626 |
| Muted | #64748B |
| BG / Surface | #F8FAFC / #FFFFFF |
| Text | #0F172A / #64748B |
| 폰트 | Pretendard → Noto Sans KR (제목 700, 본문 400~500) |

**D-day 3구간 색상(마감 임박도):** D0~3 #DC2626 · D4~6 #EA580C · D7~9 #EAB308 · D10+ #64748B → pill로 렌더

**상태 pill(bids.status):** ongoing 녹색(#16A34A) · today 빨강(#DC2626) · closed 회색

## 데이터 접근 규칙 (Why 중심)

- **RLS를 신뢰하되 UI에서도 게이팅** — 서버 RLS가 최종 방어선이지만, 역할에 없는 메뉴/버튼은 UI에서 숨겨 혼란을 없앤다. active 아닌 사용자는 S-03로 라우팅.
- **컬럼명/타입은 계약에서** — data-architect의 `01_..._contract.md`, AI 결과 형식은 ai-engineer 계약을 참조. 필드를 추측하면 경계 버그가 생긴다.
- **토큰 하드코딩 금지** — 색/폰트/간격은 토큰으로. 스토리보드 변경 시 한 곳만 고친다.

## 화면별 핵심 요소

- **S-04**: 상단 필터(발주기관/유형/키워드그룹 AND·OR/기간) + 카드/리스트(공고명·기관·마감·점수·상태 pill·D-day). Realtime 구독(FR-07)
- **S-06**: 공고 메타 + D-day pill, 가격/변경이력 탭, "AI 브리핑" 카드([AI 요약]·핵심요건), 매칭 인력(FR-10)
- **S-07**: 관심목록 테이블 — 분석상태/제안상태 pill, D-day 정렬, 결정(review/join/drop)
- **S-08**: FullCalendar — 공고일(#2563EB)/마감일(#DC2626), D-day
- **S-10**: KPI 4종 + recharts 차트(hover 툴팁)
- **S-11~13**: admin 전용 — 사용자 승인, rules CRUD, API 키(masked_hint 표시 + "키 변경")

## 산출물

- `_workspace/04_frontend_screens.md`(화면별 컴포넌트/라우팅/쿼리/토큰)
- 최종: `app/` 하위 Next.js 라우트·컴포넌트, Tailwind 토큰 설정, supabase 클라이언트

## 검증 체크리스트

- [ ] 13개 화면 라우트 + 역할 게이팅
- [ ] 디자인 토큰 중앙화, 하드코딩 색상 없음
- [ ] D-day 3구간·상태 pill 색상이 스토리보드와 일치
- [ ] Supabase 쿼리 필드가 스키마 계약과 일치(경계 검증)
- [ ] Realtime(FR-07)·FullCalendar(FR-15)·recharts(FR-11) 연결
