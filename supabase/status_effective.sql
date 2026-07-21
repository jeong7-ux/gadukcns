-- ---------------------------------------------------------------------
-- bids.status 기준을 "유효 마감"으로 정정 — coalesce(deadline_dt, open_dt)
--
-- 배경: 나라장터는 협상에 의한 계약 등 일부 공고에 bidClseDt를 **빈 문자열**로 준다
--   (실측: 마감 null 30건 전부 빈값, 키 누락·파싱 실패 0). 그러면 deadline_dt가 null이라
--   기존 refresh_bids_status()가 status를 **null**로 남겨,
--   서버측 .eq('status','ongoing') 필터에서 해당 공고가 통째로 누락된다.
--   같은 원본에 opengDt(개찰일시)는 항상 채워져 있으므로(30/30) 이를 폴백 기준으로 쓴다.
--
-- 앱과의 정합: lib/queries/deadline.ts 의 notClosedOr()/effectiveDeadline() 과 **동일 기준**
--   (목록 노출 필터·D-day·정렬·도넛이 모두 이 기준을 쓴다. 커밋 57471d9 / f3ce7b2).
--
-- 적용: Supabase SQL Editor에서 이 파일 전체 실행(멱등 — 재실행 안전).
-- ---------------------------------------------------------------------

create or replace function refresh_bids_status() returns void
language sql
as $$
  update bids set status =
    case when coalesce(deadline_dt, open_dt) is null then null
         when coalesce(deadline_dt, open_dt)::date > current_date then 'ongoing'
         when coalesce(deadline_dt, open_dt)::date = current_date then 'today'
         else 'closed' end
  where status is distinct from
    (case when coalesce(deadline_dt, open_dt) is null then null
          when coalesce(deadline_dt, open_dt)::date > current_date then 'ongoing'
          when coalesce(deadline_dt, open_dt)::date = current_date then 'today'
          else 'closed' end);
$$;

-- 즉시 1회 재계산(수집 실행 시에도 자동 호출된다 — lib/collect/runner.ts)
select refresh_bids_status();

-- ── 검증: 아래 3개 쿼리 결과를 확인 ────────────────────────────────
-- ① 노출(미아카이브 + 유효마감 미래) 중 status가 null인 행 = 0이어야 한다
select count(*) as should_be_zero
from bids
where archived_at is null
  and coalesce(deadline_dt, open_dt) >= current_date
  and status is null;

-- ② 마감일이 없어 개찰일로 판정된 공고의 status 분포(= ongoing/today 이어야 한다)
select status, count(*)
from bids
where archived_at is null and deadline_dt is null and open_dt is not null
group by status order by 2 desc;

-- ③ status와 유효마감의 정합성 위반 = 0이어야 한다
select count(*) as should_be_zero
from bids
where status is distinct from
  (case when coalesce(deadline_dt, open_dt) is null then null
        when coalesce(deadline_dt, open_dt)::date > current_date then 'ongoing'
        when coalesce(deadline_dt, open_dt)::date = current_date then 'today'
        else 'closed' end);
