-- Run once in the Supabase Dashboard > SQL Editor after the existing migrations.
-- This imports the five existing sidebar links and makes their order editable.
begin;

create table if not exists public.community_shortcuts (
  id uuid primary key default gen_random_uuid(),
  title text not null check (
    title = btrim(title)
    and char_length(title) between 1 and 100
  ),
  url text not null check (
    url = btrim(url)
    and char_length(url) between 8 and 4096
    and url ~* '^https?://[^[:space:]]+$'
  ),
  sort_order integer not null unique check (sort_order >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Seed only a previously empty shortcuts table. Deleted default links stay
-- deleted on later executions rather than being recreated.
insert into public.community_shortcuts (title, url, sort_order)
select initial_shortcuts.title, initial_shortcuts.url, initial_shortcuts.sort_order
from (values
  ('Favorites', 'https://fav.ju.mp', 0),
  ('업로드(ChannelTalk)', 'https://soleil.channel.io/home', 1),
  ('업로드(Mega)', 'https://mega.nz/filerequest/OMvCqk6eddY', 2),
  ('업로드(Koofr)', 'https://app.koofr.net/receive/690f58b6-4cc5-4b19-89f0-79b862198dba', 3),
  ('업로드(Pcloud)', 'https://2.h2h.workers.dev/#bn5=)0U80I*pYj6t[!u{{;b@+cn}V*qM~j&bYqOgXtEYjIpVXStR7*],sP;=]+qEE4^YeTLl8gk;9sUQkSxi&Q,(F2e8r*O:6._9gvMvF{}$_4B@saCFwoeLxiHvDpTlZe;-2Q|kwu^!Lx)/Y6NNuLYW', 4)
) as initial_shortcuts(title, url, sort_order)
where not exists (select 1 from public.community_shortcuts)
order by initial_shortcuts.sort_order;

alter table public.community_shortcuts enable row level security;
revoke all on table public.community_shortcuts from public, anon, authenticated;
grant select, insert, update, delete on table public.community_shortcuts to service_role;

-- Pages Functions call these with the service_role only after checking the
-- encrypted board session. The ordering operations use a transaction-scoped
-- advisory lock so concurrent edits cannot make duplicate sort_order values.
create or replace function public.community_create_shortcut(
  shortcut_title text,
  shortcut_url text
)
returns public.community_shortcuts
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  normalized_title text := btrim(coalesce(shortcut_title, ''));
  normalized_url text := btrim(coalesce(shortcut_url, ''));
  created_shortcut public.community_shortcuts;
begin
  if char_length(normalized_title) not between 1 and 100 then
    raise exception '바로가기 이름은 1~100자로 입력해주세요.' using errcode = '22023';
  end if;
  if char_length(normalized_url) not between 8 and 4096
    or normalized_url !~* '^https?://[^[:space:]]+$' then
    raise exception 'https:// 또는 http://로 시작하는 링크를 입력해주세요.' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(74291, 3);
  insert into public.community_shortcuts (title, url, sort_order)
  values (
    normalized_title,
    normalized_url,
    coalesce((select max(sort_order) + 1 from public.community_shortcuts), 0)
  )
  returning * into created_shortcut;
  return created_shortcut;
end;
$$;

create or replace function public.community_update_shortcut(
  shortcut_id_value uuid,
  shortcut_title text,
  shortcut_url text
)
returns public.community_shortcuts
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  normalized_title text := btrim(coalesce(shortcut_title, ''));
  normalized_url text := btrim(coalesce(shortcut_url, ''));
  updated_shortcut public.community_shortcuts;
begin
  if char_length(normalized_title) not between 1 and 100 then
    raise exception '바로가기 이름은 1~100자로 입력해주세요.' using errcode = '22023';
  end if;
  if char_length(normalized_url) not between 8 and 4096
    or normalized_url !~* '^https?://[^[:space:]]+$' then
    raise exception 'https:// 또는 http://로 시작하는 링크를 입력해주세요.' using errcode = '22023';
  end if;

  update public.community_shortcuts
  set title = normalized_title,
      url = normalized_url,
      updated_at = now()
  where id = shortcut_id_value
  returning * into updated_shortcut;

  if not found then
    raise exception '바로가기를 찾을 수 없습니다.' using errcode = 'P0002';
  end if;
  return updated_shortcut;
end;
$$;

create or replace function public.community_reorder_shortcuts(shortcut_ids_value uuid[])
returns setof public.community_shortcuts
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(74291, 3);

  if shortcut_ids_value is null
    or cardinality(shortcut_ids_value) <> (select count(*) from public.community_shortcuts) then
    raise exception '바로가기 목록을 다시 불러온 뒤 순서를 변경해주세요.' using errcode = '22023';
  end if;

  if (select count(*) from (select distinct id from unnest(shortcut_ids_value) as item(id)) as unique_ids)
      <> cardinality(shortcut_ids_value) then
    raise exception '바로가기 목록에 중복이 있습니다.' using errcode = '22023';
  end if;

  if exists (
    select 1
    from unnest(shortcut_ids_value) as item(id)
    left join public.community_shortcuts as shortcut on shortcut.id = item.id
    where shortcut.id is null
  ) then
    raise exception '바로가기 목록을 다시 불러온 뒤 순서를 변경해주세요.' using errcode = '22023';
  end if;

  -- A two-pass update preserves the unique sort_order constraint while the
  -- requested order swaps adjacent rows.
  update public.community_shortcuts
  set sort_order = sort_order + 1000000;

  with requested_order as (
    select id, (ordinal_position - 1)::integer as sort_order
    from unnest(shortcut_ids_value) with ordinality as item(id, ordinal_position)
  )
  update public.community_shortcuts as shortcut
  set sort_order = requested_order.sort_order,
      updated_at = now()
  from requested_order
  where shortcut.id = requested_order.id;

  return query
  select shortcut.*
  from public.community_shortcuts as shortcut
  order by shortcut.sort_order, shortcut.title;
end;
$$;

create or replace function public.community_delete_shortcut(shortcut_id_value uuid)
returns table (deleted_shortcut_id uuid)
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(74291, 3);

  perform 1
  from public.community_shortcuts
  where id = shortcut_id_value
  for update;
  if not found then
    raise exception '바로가기를 찾을 수 없습니다.' using errcode = 'P0002';
  end if;

  delete from public.community_shortcuts
  where id = shortcut_id_value;

  update public.community_shortcuts
  set sort_order = sort_order + 1000000;

  with ordered_shortcuts as (
    select id, (row_number() over (order by sort_order, title) - 1)::integer as sort_order
    from public.community_shortcuts
  )
  update public.community_shortcuts as shortcut
  set sort_order = ordered_shortcuts.sort_order,
      updated_at = now()
  from ordered_shortcuts
  where shortcut.id = ordered_shortcuts.id;

  return query select shortcut_id_value as deleted_shortcut_id;
end;
$$;

revoke all on function public.community_create_shortcut(text, text) from public, anon, authenticated;
revoke all on function public.community_update_shortcut(uuid, text, text) from public, anon, authenticated;
revoke all on function public.community_reorder_shortcuts(uuid[]) from public, anon, authenticated;
revoke all on function public.community_delete_shortcut(uuid) from public, anon, authenticated;
grant execute on function public.community_create_shortcut(text, text) to service_role;
grant execute on function public.community_update_shortcut(uuid, text, text) to service_role;
grant execute on function public.community_reorder_shortcuts(uuid[]) to service_role;
grant execute on function public.community_delete_shortcut(uuid) to service_role;

commit;
