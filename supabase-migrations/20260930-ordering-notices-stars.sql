-- Repair ordering RPCs without disabling safe-update protection.
begin;
do $$
declare target record;
begin
  for target in select oid from pg_proc
    where pronamespace = 'public'::regnamespace
    and proname in ('community_reorder_categories', 'community_delete_category', 'community_reorder_shortcuts', 'community_delete_shortcut')
  loop
    execute replace(pg_get_functiondef(target.oid),
      'set sort_order = sort_order + 1000000;',
      'set sort_order = sort_order + 1000000 where id is not null;');
  end loop;
end;
$$;

-- Existing is_pinned values become stars; keep the API column for compatibility.
drop trigger if exists community_enforce_pinned_post_limit on public.community_posts;
drop trigger if exists community_enforce_notice_limit on public.community_posts;
alter table public.community_posts drop constraint if exists community_posts_pin_slot_check;
drop index if exists public.community_posts_pinned_slot_idx;
drop index if exists public.community_posts_notice_slot_idx;
update public.community_posts set pin_slot = null where pin_slot is not null;

-- Serialize notice promotion and enforce two slots at the database level.
alter table public.community_posts add column if not exists notice_slot smallint;
with ranked_notices as (
  select id, row_number() over (order by created_at desc, id) as slot
  from public.community_posts where is_notice
)
update public.community_posts as post
set is_notice = ranked_notices.slot <= 2,
    notice_slot = case when ranked_notices.slot <= 2 then ranked_notices.slot::smallint else null end
from ranked_notices where post.id = ranked_notices.id;

create or replace function public.community_enforce_notice_limit()
returns trigger language plpgsql security definer set search_path = pg_catalog
as $$
declare available_slot smallint;
begin
  if new.is_notice is distinct from coalesce(case when tg_op = 'UPDATE' then old.is_notice end, false)
    or (tg_op = 'UPDATE' and new.is_pinned is distinct from old.is_pinned)
    or (tg_op = 'INSERT' and new.is_pinned) then
    if coalesce(auth.role(), '') <> 'service_role'
      and not public.community_has_board_role(array['admin']) then
      raise exception 'Only administrators can change notices or stars.' using errcode = '42501';
    end if;
  end if;
  if not new.is_notice then
    new.notice_slot := null;
  elsif tg_op = 'INSERT' or not old.is_notice then
    perform pg_catalog.pg_advisory_xact_lock(74291, 1);
    select candidate.slot::smallint into available_slot
    from (values (1), (2)) as candidate(slot)
    where not exists (select 1 from public.community_posts p where p.notice_slot = candidate.slot)
    order by candidate.slot limit 1;
    if not found then
      raise exception 'At most two notices are allowed.' using errcode = '23514';
    end if;
    new.notice_slot := available_slot;
  elsif new.notice_slot is distinct from old.notice_slot then
    raise exception 'Notice slots are managed by the database.' using errcode = '42501';
  end if;
  new.pin_slot := null;
  return new;
end;
$$;
revoke all on function public.community_enforce_notice_limit() from public, anon, authenticated;
drop trigger if exists community_enforce_notice_limit on public.community_posts;
create trigger community_enforce_notice_limit
before insert or update of is_notice, notice_slot, is_pinned, pin_slot on public.community_posts
for each row execute function public.community_enforce_notice_limit();
alter table public.community_posts drop constraint if exists community_posts_notice_slot_check;
alter table public.community_posts add constraint community_posts_notice_slot_check
check (is_notice = (notice_slot is not null) and (notice_slot is null or notice_slot between 1 and 2));
create unique index if not exists community_posts_notice_slot_idx on public.community_posts(notice_slot) where is_notice;
commit;
