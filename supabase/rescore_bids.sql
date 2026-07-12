-- S-12 '재스코어링' 버튼이 호출하는 DB 함수 (admin 전용, SECURITY DEFINER).
-- Supabase Dashboard > SQL Editor 에서 1회 실행하면 버튼이 동작한다.
-- (동일 함수가 schema.sql 에도 포함됨 — 이 파일은 함수만 개별 적용용)

create or replace function rescore_bids() returns integer
language plpgsql
security definer
set search_path = public
as $$
declare affected integer;
begin
  if app_current_role() is distinct from 'admin' then
    raise exception 'admin 권한이 필요합니다';
  end if;

  with b as (
    select bid_no, bid_seq,
      regexp_replace(lower(concat_ws(' ', coalesce(title,''), coalesce(order_org,''), coalesce(demand_org,''), coalesce(contract_method,''))), '\s+', ' ', 'g') as hay_all,
      regexp_replace(lower(coalesce(contract_method,'')), '\s+', ' ', 'g') as hay_ct,
      regexp_replace(lower(concat_ws(' ', coalesce(order_org,''), coalesce(demand_org,''))), '\s+', ' ', 'g') as hay_org
    from bids
  ),
  m as (
    select b.bid_no, b.bid_seq, r.type, r.pattern, r.weight
    from b
    join rules r on r.is_active and (
      (r.type in ('keyword','exclude') and position(regexp_replace(lower(r.pattern), '\s+', ' ', 'g') in b.hay_all) > 0) or
      (r.type = 'contract' and position(regexp_replace(lower(r.pattern), '\s+', ' ', 'g') in b.hay_ct) > 0) or
      (r.type = 'org'      and position(regexp_replace(lower(r.pattern), '\s+', ' ', 'g') in b.hay_org) > 0)
    )
  ),
  scored as (
    select b.bid_no, b.bid_seq,
      coalesce(sum(case when m.type = 'exclude' then -m.weight else m.weight end), 0)::int as score,
      coalesce(array_agg(distinct m.pattern) filter (where m.type <> 'exclude'), '{}') as tags
    from b left join m on m.bid_no = b.bid_no and m.bid_seq = b.bid_seq
    group by b.bid_no, b.bid_seq
  )
  update bids t
    set score = s.score,
        tags = s.tags,
        ai_flags = coalesce(t.ai_flags, '{}'::jsonb) || jsonb_build_object('rescored_at', now()),
        updated_at = now()
  from scored s
  where t.bid_no = s.bid_no and t.bid_seq = s.bid_seq;

  get diagnostics affected = row_count;
  perform refresh_bids_status();
  return affected;
end $$;
