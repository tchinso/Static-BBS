-- Supabase Dashboard > SQL Editor에서 이 파일 전체를 한 번 실행하세요.
-- 이메일 허용 목록과 service_role 키는 이 파일이나 브라우저 코드에 넣지 마세요.

create extension if not exists pgcrypto;

-- 원문 이메일은 Cloudflare Pages Secret에만 두고, DB에는 SHA-256 값만 private schema에 보관합니다.
create schema if not exists private;
revoke all on schema private from public;

create table if not exists private.community_allowed_email_hashes (
  email_hash text primary key check (email_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now()
);

alter table private.community_allowed_email_hashes enable row level security;
revoke all on table private.community_allowed_email_hashes from public, anon, authenticated;

-- The Auth Hook runs as this narrowly-granted database role.  Keeping the
-- hook as a security-invoker function avoids giving it the database owner's
-- broad SECURITY DEFINER privileges.
grant usage on schema private to supabase_auth_admin;
grant usage on schema extensions to supabase_auth_admin;
grant select on table private.community_allowed_email_hashes to supabase_auth_admin;
drop policy if exists "community auth admin reads email hashes" on private.community_allowed_email_hashes;
create policy "community auth admin reads email hashes" on private.community_allowed_email_hashes
  for select to supabase_auth_admin
  using (true);

-- 허용 hash가 나중에 추가되어도 기존 승인 계정은 자동으로 admin 역할을 받습니다.
create or replace function private.community_promote_allowed_profiles()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, auth, extensions
as $$
begin
  update public.community_profiles as profile
  set role = 'admin'
  from auth.users as user_record
  where profile.id = user_record.id
    and encode(digest(lower(trim(user_record.email)), 'sha256'), 'hex') = new.email_hash;
  return new;
end;
$$;

drop trigger if exists community_promote_allowed_profiles on private.community_allowed_email_hashes;
create trigger community_promote_allowed_profiles
  after insert or update of email_hash on private.community_allowed_email_hashes
  for each row execute procedure private.community_promote_allowed_profiles();

create or replace function public.community_email_is_allowed()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, private, extensions
as $$
  select auth.uid() is not null
    and exists (
      select 1
      from private.community_allowed_email_hashes
      where email_hash = encode(
        digest(lower(trim(coalesce(auth.jwt() ->> 'email', ''))), 'sha256'),
        'hex'
      )
    );
$$;

-- Supabase Auth의 Before User Created hook으로 선택할 함수입니다.
-- 허용 hash가 없는 이메일은 사용자 레코드가 생기기 전 거절됩니다.
create or replace function public.community_before_user_created(event jsonb)
returns jsonb
language plpgsql
set search_path = pg_catalog, private, extensions
as $$
declare
  normalized_email text := lower(trim(coalesce(event -> 'user' ->> 'email', '')));
begin
  if normalized_email = '' or not exists (
    select 1
    from private.community_allowed_email_hashes
    where email_hash = encode(digest(normalized_email, 'sha256'), 'hex')
  ) then
    return jsonb_build_object(
      'error',
      jsonb_build_object(
        'http_code', 403,
        'message', 'This email is not approved for this board.'
      )
    );
  end if;

  return '{}'::jsonb;
end;
$$;

grant usage on schema public to supabase_auth_admin;
grant execute on function public.community_before_user_created(jsonb) to supabase_auth_admin;
revoke all on function public.community_before_user_created(jsonb) from public, anon, authenticated;
revoke all on function public.community_email_is_allowed() from public, anon;
grant execute on function public.community_email_is_allowed() to authenticated;

create table if not exists public.community_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '회원',
  role text not null default 'admin' check (role in ('member', 'editor', 'admin')),
  created_at timestamptz not null default now()
);

create table if not exists public.community_posts (
  id uuid primary key default gen_random_uuid(),
  category text not null default '현생' check (category in ('현생', '링크', '언어/검색어', '리소스/아이디어', '쥬우니/에카하나')),
  title text not null check (char_length(title) between 1 and 100),
  tags text[] not null default '{}',
  image_urls text[] not null default '{}',
  content text not null check (char_length(content) between 1 and 10000),
  author_id uuid not null references auth.users(id) on delete cascade,
  author_name text not null check (char_length(author_name) between 1 and 20),
  is_notice boolean not null default false,
  is_pinned boolean not null default false,
  pin_slot smallint,
  view_count integer not null default 0 check (view_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- create table if not exists 는 기존 테이블에 새 열을 추가하지 않으므로 별도 migration을 둡니다.
alter table public.community_profiles
  alter column role set default 'admin';

do $$
begin
  if exists (
    select 1
    from public.community_posts
    where category not in ('현생', '링크', '언어/검색어', '리소스/아이디어', '쥬우니/에카하나')
  ) then
    raise exception 'Legacy post categories need an explicit migration before the new category constraint can be applied.';
  end if;
end $$;

alter table public.community_posts
  alter column category set default '현생';

alter table public.community_posts
  drop constraint if exists community_posts_category_check;

alter table public.community_posts
  add constraint community_posts_category_check
  check (category in ('현생', '링크', '언어/검색어', '리소스/아이디어', '쥬우니/에카하나'));

alter table public.community_posts
  add column if not exists is_pinned boolean;

alter table public.community_posts
  add column if not exists pin_slot smallint;

update public.community_posts
set is_pinned = false
where is_pinned is null;

alter table public.community_posts
  alter column is_pinned set default false,
  alter column is_pinned set not null;

create index if not exists community_posts_created_at_idx on public.community_posts(created_at desc);
create index if not exists community_posts_category_idx on public.community_posts(category);
-- 인증 전 허용 목록 검사가 별도로 설정되어 있다는 전제에서, 새 사용자 프로필은 관리자입니다.
-- 기존 프로필은 대량 승격하지 않습니다. 허용 목록을 관리하는 서버 측 절차로 승격하세요.
create or replace function public.community_handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  insert into public.community_profiles (id, display_name, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'display_name', split_part(new.email, '@', 1), '회원'),
    'admin'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists community_on_auth_user_created on auth.users;
create trigger community_on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.community_handle_new_user();

create or replace function public.community_has_board_role(allowed_roles text[])
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select public.community_email_is_allowed()
    and exists (
    select 1
    from public.community_profiles
    where id = auth.uid() and role = any(allowed_roles)
  );
$$;

create or replace function public.community_increment_post_views(post_id_value uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if auth.uid() is null
    or not public.community_has_board_role(array['admin']) then
    raise exception 'An administrator session is required.' using errcode = '42501';
  end if;

  update public.community_posts
  set view_count = view_count + 1
  where id = post_id_value;
end;
$$;

-- pin_slot은 내부 슬롯입니다. 두 값만 허용하는 check + unique partial index가 최대 두 건을 DB에서 보장합니다.
create or replace function public.community_enforce_pinned_post_limit()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  pin_state_changed boolean;
  pin_slot_changed boolean;
  available_slot smallint;
begin
  -- unpinned 행에는 슬롯 값을 남기지 않습니다.
  if not new.is_pinned then
    new.pin_slot := null;
  end if;

  if tg_op = 'INSERT' then
    pin_state_changed := new.is_pinned;
    pin_slot_changed := false;
  else
    pin_state_changed := new.is_pinned is distinct from old.is_pinned;
    pin_slot_changed := new.pin_slot is distinct from old.pin_slot;
  end if;

  if pin_state_changed or pin_slot_changed then
    if coalesce(auth.role(), '') <> 'service_role'
      and (
        auth.uid() is null
        or not public.community_has_board_role(array['admin'])
      ) then
      raise exception 'Only administrators can change a post pin.' using errcode = '42501';
    end if;
  end if;

  if pin_state_changed then
    -- 슬롯 선택을 직렬화해 정상적인 동시 요청도 가능한 한 충돌 없이 처리합니다.
    perform pg_catalog.pg_advisory_xact_lock(74291, 1);

    if new.is_pinned then
      select candidate.slot::smallint
      into available_slot
      from (values (1), (2)) as candidate(slot)
      where not exists (
        select 1
        from public.community_posts as existing_post
        where existing_post.is_pinned
          and existing_post.pin_slot = candidate.slot
      )
      order by candidate.slot
      limit 1;

      if not found then
        raise exception 'At most two posts may be pinned.' using errcode = '23514';
      end if;

      new.pin_slot := available_slot;
    end if;
  elsif pin_slot_changed and new.is_pinned then
    -- slot은 trigger가 정하며, 이미 고정된 글의 slot을 직접 바꾸지 못하게 합니다.
    raise exception 'Pinned slots are managed by the database.' using errcode = '42501';
  end if;

  return new;
end;
$$;

-- 기존에 이 열을 직접 추가한 배포본의 데이터는 자동으로 고정 해제하지 않습니다.
do $$
begin
  if (select count(*) from public.community_posts where is_pinned) > 2 then
    raise exception 'community_posts already contains more than two pinned posts; unpin extras before applying this migration.';
  end if;
end;
$$;

-- 기존 데이터에는 재실행해도 같은 순서로 slot을 채웁니다.
with ranked_pins as (
  select id, cast(row_number() over (order by created_at desc, id) as smallint) as slot
  from public.community_posts
  where is_pinned
)
update public.community_posts as post
set pin_slot = ranked_pins.slot
from ranked_pins
where post.id = ranked_pins.id;

update public.community_posts
set pin_slot = null
where not is_pinned
  and pin_slot is not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.community_posts'::regclass
      and conname = 'community_posts_pin_slot_check'
  ) then
    alter table public.community_posts
      add constraint community_posts_pin_slot_check
      check (
        is_pinned = (pin_slot is not null)
        and (pin_slot is null or pin_slot between 1 and 2)
      );
  end if;
end;
$$;

create unique index if not exists community_posts_pinned_slot_idx
  on public.community_posts(pin_slot)
  where is_pinned;

create index if not exists community_posts_pinned_created_at_idx
  on public.community_posts(created_at desc)
  where is_pinned;

drop trigger if exists community_enforce_pinned_post_limit on public.community_posts;
create trigger community_enforce_pinned_post_limit
  before insert or update of is_pinned, pin_slot on public.community_posts
  for each row execute procedure public.community_enforce_pinned_post_limit();

-- Storage and Postgres are separate systems. Keep a durable queue in the same
-- transaction as a post/image-reference change, then let Pages delete the
-- corresponding Storage objects and acknowledge the queue entry afterwards.
create table if not exists public.community_image_cleanup_queue (
  object_path text primary key check (char_length(object_path) between 1 and 512),
  not_before timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists community_image_cleanup_queue_not_before_idx
  on public.community_image_cleanup_queue(not_before asc);

create or replace function public.community_queue_image_cleanup()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  -- A newly referenced image must never remain scheduled for cleanup.
  if tg_op <> 'DELETE' then
    delete from public.community_image_cleanup_queue
    where object_path = any(coalesce(new.image_urls, array[]::text[]));
  end if;

  -- Queue paths that the changed/deleted post no longer references, but only
  -- after confirming no other post still references the same object.
  if tg_op = 'UPDATE' or tg_op = 'DELETE' then
    insert into public.community_image_cleanup_queue (object_path, not_before)
    select distinct source.previous_path, now()
    from unnest(coalesce(old.image_urls, array[]::text[])) as source(previous_path)
    where source.previous_path <> ''
      and (tg_op = 'DELETE' or not (source.previous_path = any(coalesce(new.image_urls, array[]::text[]))))
      and not exists (
        select 1
        from public.community_posts as existing_post
        where source.previous_path = any(coalesce(existing_post.image_urls, array[]::text[]))
      )
    on conflict (object_path) do update
      set not_before = excluded.not_before;
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists community_queue_post_images_on_insert on public.community_posts;
drop trigger if exists community_queue_post_images_on_update on public.community_posts;
drop trigger if exists community_queue_post_images_on_delete on public.community_posts;

create trigger community_queue_post_images_on_insert
  after insert on public.community_posts
  for each row execute procedure public.community_queue_image_cleanup();

create trigger community_queue_post_images_on_update
  after update of image_urls on public.community_posts
  for each row execute procedure public.community_queue_image_cleanup();

create trigger community_queue_post_images_on_delete
  after delete on public.community_posts
  for each row execute procedure public.community_queue_image_cleanup();

alter table public.community_profiles enable row level security;
alter table public.community_posts enable row level security;
alter table public.community_image_cleanup_queue enable row level security;

revoke all on table public.community_image_cleanup_queue from public, anon, authenticated;
grant select, insert, update, delete on table public.community_image_cleanup_queue to service_role;

-- 정책을 교체해 재실행 가능하게 만들고, 기존 공개 읽기를 인증된 사용자 읽기로 바꿉니다.
drop policy if exists "community profiles public read" on public.community_profiles;
drop policy if exists "community profiles authenticated read" on public.community_profiles;
drop policy if exists "community members create own profile" on public.community_profiles;

create policy "community profiles authenticated read" on public.community_profiles
  for select to authenticated
  using (
    auth.uid() is not null
    and public.community_has_board_role(array['admin'])
  );

-- 프로필 생성은 auth.users trigger가 담당합니다. 이 정책은 과거 계정의 안전한 복구 경로만 남깁니다.
create policy "community members create own profile" on public.community_profiles
  for insert to authenticated
  with check (id = auth.uid() and role = 'member');

-- 브라우저 사용자는 profile role을 직접 변경할 수 없습니다.

drop policy if exists "community posts public read" on public.community_posts;
drop policy if exists "community posts authenticated read" on public.community_posts;
drop policy if exists "community signed members create posts" on public.community_posts;
drop policy if exists "community admins create posts" on public.community_posts;
drop policy if exists "community authors and editors update posts" on public.community_posts;
drop policy if exists "community admins update posts" on public.community_posts;
drop policy if exists "community authors and admins delete posts" on public.community_posts;
drop policy if exists "community admins delete posts" on public.community_posts;

create policy "community posts authenticated read" on public.community_posts
  for select to authenticated
  using (
    auth.uid() is not null
    and public.community_has_board_role(array['admin'])
  );

create policy "community admins create posts" on public.community_posts
  for insert to authenticated
  with check (
    author_id = auth.uid()
    and public.community_has_board_role(array['admin'])
  );

create policy "community admins update posts" on public.community_posts
  for update to authenticated
  using (public.community_has_board_role(array['admin']))
  with check (public.community_has_board_role(array['admin']));

create policy "community admins delete posts" on public.community_posts
  for delete to authenticated
  using (public.community_has_board_role(array['admin']));

-- SECURITY DEFINER 함수는 기본 PUBLIC execute 권한을 제거하고 필요한 역할에만 부여합니다.
revoke all on function public.community_handle_new_user() from public, anon, authenticated;
revoke all on function public.community_email_is_allowed() from public, anon;
revoke all on function public.community_has_board_role(text[]) from public, anon;
revoke all on function public.community_increment_post_views(uuid) from public, anon;
revoke all on function public.community_enforce_pinned_post_limit() from public, anon, authenticated;
revoke all on function public.community_queue_image_cleanup() from public, anon, authenticated;

grant execute on function public.community_has_board_role(text[]) to authenticated;
grant execute on function public.community_email_is_allowed() to authenticated;
grant execute on function public.community_increment_post_views(uuid) to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'community-images',
  'community-images',
  false,
  26214400,
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "community images public read" on storage.objects;
drop policy if exists "community images authenticated read" on storage.objects;
drop policy if exists "community images authenticated upload" on storage.objects;

create policy "community images authenticated read" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'community-images'
    and public.community_has_board_role(array['admin'])
  );

create policy "community images authenticated upload" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'community-images'
    and (storage.foldername(name))[1] = auth.uid()::text
    and public.community_has_board_role(array['admin'])
  );

-- private bucket 파일은 Cloudflare Pages의 인증된 이미지 프록시를 통해 읽습니다.
