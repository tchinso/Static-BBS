-- Run once in Supabase Dashboard > SQL Editor after the existing migrations.
-- This keeps every post. Deleting a category with posts requires selecting a
-- replacement category, and the move + delete happens atomically.
begin;

create table if not exists public.community_categories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (
    name = btrim(name)
    and char_length(name) between 1 and 60
  ),
  sort_order integer not null unique check (sort_order >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.community_categories (name, sort_order)
select initial_categories.name, initial_categories.sort_order
from (values
  ('현생', 0),
  ('링크', 1),
  ('언어/검색어', 2),
  ('리소스/아이디어', 3),
  ('쥬우니/에카하나', 4)
) as initial_categories(name, sort_order)
where not exists (select 1 from public.community_categories);

alter table public.community_posts
  add column if not exists category_id uuid;

-- Existing deployed clients send only the legacy category text. Keep them
-- working during rollout by translating a changed legacy value to category_id.
create or replace function public.community_sync_legacy_category_id()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.category_id is null
    or (tg_op = 'UPDATE' and new.category is distinct from old.category) then
    select id
    into new.category_id
    from public.community_categories
    where name = new.category;
  end if;

  if new.category_id is null then
    raise exception 'A valid category is required.' using errcode = '23503';
  end if;
  return new;
end;
$$;

drop trigger if exists community_sync_legacy_category_id on public.community_posts;
create trigger community_sync_legacy_category_id
  before insert or update of category, category_id on public.community_posts
  for each row execute procedure public.community_sync_legacy_category_id();

-- Keep the legacy text column untouched for a reversible audit trail, but
-- make category_id the only authoritative value from this point forward.
update public.community_posts as post
set category_id = category.id
from public.community_categories as category
where post.category_id is null
  and post.category = category.name;

do $$
begin
  if exists (
    select 1
    from public.community_posts
    where category_id is null
  ) then
    raise exception 'Each existing post needs a category before category_id can be required.';
  end if;
end;
$$;

alter table public.community_posts
  alter column category_id set not null;

alter table public.community_posts
  drop constraint if exists community_posts_category_id_fkey;

alter table public.community_posts
  add constraint community_posts_category_id_fkey
  foreign key (category_id)
  references public.community_categories(id)
  on delete restrict;

alter table public.community_posts
  drop constraint if exists community_posts_category_check;

alter table public.community_posts
  alter column category drop default,
  alter column category drop not null;

create index if not exists community_posts_category_id_idx
  on public.community_posts(category_id);

alter table public.community_categories enable row level security;
revoke all on table public.community_categories from public, anon, authenticated;
grant select, insert, update, delete on table public.community_categories to service_role;

create or replace function public.community_create_category(category_name text)
returns public.community_categories
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  normalized_name text := btrim(coalesce(category_name, ''));
  created_category public.community_categories;
begin
  if char_length(normalized_name) not between 1 and 60 then
    raise exception '카테고리 이름은 1~60자로 입력해주세요.' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(74291, 2);
  insert into public.community_categories (name, sort_order)
  values (
    normalized_name,
    coalesce((select max(sort_order) + 1 from public.community_categories), 0)
  )
  returning * into created_category;
  return created_category;
exception
  when unique_violation then
    raise exception '같은 이름의 카테고리가 이미 있습니다.' using errcode = '23505';
end;
$$;

create or replace function public.community_rename_category(
  category_id_value uuid,
  category_name text
)
returns public.community_categories
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  normalized_name text := btrim(coalesce(category_name, ''));
  renamed_category public.community_categories;
begin
  if char_length(normalized_name) not between 1 and 60 then
    raise exception '카테고리 이름은 1~60자로 입력해주세요.' using errcode = '22023';
  end if;

  update public.community_categories
  set name = normalized_name,
      updated_at = now()
  where id = category_id_value
  returning * into renamed_category;

  if not found then
    raise exception '카테고리를 찾을 수 없습니다.' using errcode = 'P0002';
  end if;
  return renamed_category;
exception
  when unique_violation then
    raise exception '같은 이름의 카테고리가 이미 있습니다.' using errcode = '23505';
end;
$$;

create or replace function public.community_reorder_categories(category_ids_value uuid[])
returns setof public.community_categories
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(74291, 2);

  if category_ids_value is null
    or cardinality(category_ids_value) <> (select count(*) from public.community_categories) then
    raise exception '카테고리 목록을 다시 불러온 뒤 순서를 변경해주세요.' using errcode = '22023';
  end if;

  if (select count(*) from (select distinct id from unnest(category_ids_value) as item(id)) as unique_ids)
      <> cardinality(category_ids_value) then
    raise exception '카테고리 목록에 중복이 있습니다.' using errcode = '22023';
  end if;

  if exists (
    select 1
    from unnest(category_ids_value) as item(id)
    left join public.community_categories as category on category.id = item.id
    where category.id is null
  ) then
    raise exception '카테고리 목록을 다시 불러온 뒤 순서를 변경해주세요.' using errcode = '22023';
  end if;

  -- A two-pass update preserves the unique sort_order constraint while the
  -- requested order swaps adjacent rows.
  update public.community_categories
  set sort_order = sort_order + 1000000;

  with requested_order as (
    select id, (ordinal_position - 1)::integer as sort_order
    from unnest(category_ids_value) with ordinality as item(id, ordinal_position)
  )
  update public.community_categories as category
  set sort_order = requested_order.sort_order,
      updated_at = now()
  from requested_order
  where category.id = requested_order.id;

  return query
  select category.*
  from public.community_categories as category
  order by category.sort_order, category.name;
end;
$$;

create or replace function public.community_delete_category(
  category_id_value uuid,
  replacement_category_id_value uuid default null
)
returns table (deleted_category_id uuid, reassigned_post_count integer)
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  posts_to_move integer := 0;
  category_total integer := 0;
begin
  perform pg_catalog.pg_advisory_xact_lock(74291, 2);

  select count(*) into category_total from public.community_categories;
  if category_total <= 1 then
    raise exception '카테고리는 하나 이상 남겨야 합니다.' using errcode = 'P0001';
  end if;

  -- This lock also prevents a concurrent post from being attached to the
  -- category between its count check and deletion.
  perform 1
  from public.community_categories
  where id = category_id_value
  for update;
  if not found then
    raise exception '카테고리를 찾을 수 없습니다.' using errcode = 'P0002';
  end if;

  select count(*) into posts_to_move
  from public.community_posts
  where category_id = category_id_value;

  if posts_to_move > 0 then
    if replacement_category_id_value is null then
      raise exception '이 카테고리에는 게시글이 %개 있습니다. 이동할 카테고리를 선택해주세요.', posts_to_move
        using errcode = 'P0001';
    end if;
    if replacement_category_id_value = category_id_value then
      raise exception '다른 카테고리를 선택해주세요.' using errcode = '22023';
    end if;

    perform 1
    from public.community_categories
    where id = replacement_category_id_value
    for update;
    if not found then
      raise exception '이동할 카테고리를 찾을 수 없습니다.' using errcode = 'P0002';
    end if;

    update public.community_posts
    set category_id = replacement_category_id_value,
        updated_at = now()
    where category_id = category_id_value;
  end if;

  delete from public.community_categories
  where id = category_id_value;

  update public.community_categories
  set sort_order = sort_order + 1000000;

  with ordered_categories as (
    select id, (row_number() over (order by sort_order, name) - 1)::integer as sort_order
    from public.community_categories
  )
  update public.community_categories as category
  set sort_order = ordered_categories.sort_order,
      updated_at = now()
  from ordered_categories
  where category.id = ordered_categories.id;

  return query select category_id_value, posts_to_move;
end;
$$;

revoke all on function public.community_create_category(text) from public, anon, authenticated;
revoke all on function public.community_rename_category(uuid, text) from public, anon, authenticated;
revoke all on function public.community_reorder_categories(uuid[]) from public, anon, authenticated;
revoke all on function public.community_delete_category(uuid, uuid) from public, anon, authenticated;
revoke all on function public.community_sync_legacy_category_id() from public, anon, authenticated;
grant execute on function public.community_create_category(text) to service_role;
grant execute on function public.community_rename_category(uuid, text) to service_role;
grant execute on function public.community_reorder_categories(uuid[]) to service_role;
grant execute on function public.community_delete_category(uuid, uuid) to service_role;

commit;
