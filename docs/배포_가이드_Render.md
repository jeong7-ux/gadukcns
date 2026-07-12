# 배포 가이드 — GitHub + Render (나라장터 입찰정보시스템)

로컬 개발 상태를 GitHub 저장 후 **Render(지속 서버 + 영구 디스크)** 로 호스팅하는 절차.
로컬 파일저장(`storage/`)을 그대로 유지하는 구성이다.

## 아키텍처 요약
```
GitHub(private repo)
 ├─ Render Web Service (Next.js, next start)  ──  영구 디스크 /var/data (= storage/)
 │     └─ HTTPS 자동, 환경변수 주입
 └─ GitHub Actions (collect.yml, 매일 07:00 KST)  ──  Supabase(DB + Storage), OpenRouter
Supabase (PostgreSQL + pgvector + RLS + Auth + Storage)  ← 이미 클라우드 운영중
```

## 0. 사전: 키 재발급(필수)
개발 중 노출된 키를 **모두 재발급**한다.
- Supabase: Project Settings → API → **service_role / anon 키 회전**
- 나라장터: 공공데이터포털 → **서비스키 재발급**
- OpenRouter: **API 키 재발급**
- `HMAC_KEY`, `APP_MASTER_KEY`: 새 랜덤값 생성(`openssl rand -hex 32`)
  - ⚠️ `HMAC_KEY` 변경 시 기존 `users.email_hash` 와 불일치 → 신규 가입분부터 적용(기존 계정 로그인은 영향 없음. auth는 이메일 기준).

## 1. GitHub 업로드
```bash
git init
git add .
git commit -m "init: 나라장터 입찰정보시스템"
git branch -M main
git remote add origin https://github.com/<계정>/<repo>.git   # private 권장
git push -u origin main
```
- `.gitignore` 가 `.env.local`, `storage/`, `node_modules/`, `.next/` 를 제외함(비밀·실물파일 안전).
- 확인: `git status` 에 `.env.local` / `storage/` 가 **안 보여야** 정상.

## 2. GitHub Actions Secrets (수집 배치용)
GitHub → repo → Settings → Secrets and variables → Actions → New secret, 5종 등록:
`NARA_SERVICE_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `OPENROUTER_API_KEY`, `APP_MASTER_KEY`
- 등록 후 Actions 탭 → collect → **Run workflow** 로 수동 1회 검증.

## 3. Render 웹 서비스 배포
1. render.com 가입 → **New → Blueprint** → GitHub repo 연결 → `render.yaml` 자동 인식.
   - (또는 New → Web Service 수동 생성: Build `npm ci && npm run build`, Start `npm run start`)
2. **Disk 확인**: `storage`(5GB)가 `/var/data` 에 마운트, `STORAGE_DIR=/var/data` 자동 설정됨.
   - plan은 **starter 이상**(무료 플랜은 영구 디스크 미지원).
3. **Environment** 에 값 입력(재발급된 키):
   `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_URL`,
   `SUPABASE_SERVICE_KEY`, `OPENROUTER_API_KEY`, `HMAC_KEY`, `APP_MASTER_KEY`
4. Deploy → 완료 시 `https://<앱>.onrender.com` (HTTPS 자동).

## 4. 배포 후 설정
- **Supabase Auth → URL Configuration**: Site URL / Redirect URL 을 Render 도메인으로 지정.
- **로그인 테스트**: 관리자 계정으로 로그인 → 대시보드 확인.
- **파일 기능 테스트**: 관심목록 분석결과 업로드 / 첨부 로컬저장 → `/var/data` 에 저장·서빙되는지 확인.
- 커스텀 도메인 사용 시 Render → Settings → Custom Domain(자동 TLS).

## 5. 운영 주의
- **크론 중복 금지**: 수집 배치는 GitHub Actions **또는** Render 크론 중 **하나만**. (기본: GitHub Actions)
- **영구 디스크 백업**: `/var/data`(입찰 첨부·분석결과)는 Render 디스크에만 존재 → 주기 백업 권장.
  - 장기적으로는 Supabase Storage 일원화도 검토 가능(현재 배치 첨부는 이미 Supabase Storage 사용).
- **비용**: Render starter(웹) 월정액 + 디스크 용량 과금.

## 참고: 왜 Vercel이 아니라 Render인가
웹의 파일저장(`app/api/analysis/upload`, `attachment/fetch`, `files/[...path]` → `lib/storage/local.ts`)이
Node `fs` 로 디스크에 쓴다. 서버리스(Vercel)는 파일시스템이 임시라 유실됨 → **영구 디스크가 있는 Render** 선택.
Vercel로 가려면 이 3개 라우트를 Supabase Storage로 되돌리는 수정이 필요하다.
