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

create table if not exists public.community_posts (
  id uuid primary key default gen_random_uuid(),
  category_id uuid not null references public.community_categories(id) on delete restrict,
  title text not null check (char_length(title) between 1 and 100),
  tags text[] not null default '{}',
  image_urls text[] not null default '{}',
  content text not null check (char_length(content) between 1 and 10000),
  author_id uuid not null references auth.users(id) on delete cascade,
  author_name text not null check (char_length(author_name) between 1 and 20),
  is_notice boolean not null default false,
  is_confidential boolean not null default false,
  is_pinned boolean not null default false,
  pin_slot smallint,
  view_count integer not null default 0 check (view_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- create table if not exists 는 기존 테이블에 새 열을 추가하지 않으므로 별도 migration을 둡니다.
alter table public.community_profiles
  alter column role set default 'admin';

alter table public.community_posts
  add column if not exists is_confidential boolean;

update public.community_posts
set is_confidential = false
where is_confidential is null;

alter table public.community_posts
  alter column is_confidential set default false,
  alter column is_confidential set not null;

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
create index if not exists community_posts_category_id_idx on public.community_posts(category_id);
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

-- Storage and Postgres are separate systems. Keep a durable queue in the same
-- transaction as a post/image-reference change, then let Pages delete the
-- corresponding Storage objects and acknowledge the queue entry afterwards.
create table if not exists public.community_image_cleanup_queue (
  object_path text primary key check (char_length(object_path) between 1 and 512),
  not_before timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- Apply after 20260930-ordering-notices-stars.sql. No stored bytes are deleted
-- by SQL: only the authenticated Storage API removes objects.

insert into storage.buckets(id, name, public, file_size_limit)
values ('community-files', 'community-files', false, 26214400)
on conflict(id) do update set public = false, file_size_limit = excluded.file_size_limit;

alter table public.community_posts add column if not exists attachments jsonb not null default '[]';
alter table public.community_posts drop constraint if exists community_posts_attachment_count_check;
alter table public.community_posts add constraint community_posts_attachment_count_check
check (jsonb_typeof(attachments) = 'array' and jsonb_array_length(attachments) <= 8);
create index if not exists community_posts_images_gin on public.community_posts using gin(image_urls);
create index if not exists community_posts_attachments_gin on public.community_posts using gin(attachments jsonb_path_ops);
create index if not exists community_posts_tags_gin on public.community_posts using gin(tags);

create table if not exists public.community_attachments (
  object_path text primary key check (char_length(object_path) between 1 and 512),
  owner_id uuid not null references auth.users(id) on delete cascade,
  file_name text not null check (char_length(file_name) between 1 and 255),
  size_bytes bigint not null check (size_bytes between 1 and 26214400),
  created_at timestamptz not null default now()
);
alter table public.community_attachments enable row level security;
revoke all on public.community_attachments from public, anon, authenticated;
grant select, insert, update, delete on public.community_attachments to service_role;

alter table public.community_image_cleanup_queue add column if not exists bucket_id text not null default 'community-images';
alter table public.community_image_cleanup_queue add column if not exists lease_id uuid;
alter table public.community_image_cleanup_queue add column if not exists attempts integer not null default 0;
alter table public.community_image_cleanup_queue drop constraint if exists community_image_cleanup_queue_pkey;
alter table public.community_image_cleanup_queue add primary key(bucket_id, object_path);
alter table public.community_image_cleanup_queue drop constraint if exists community_cleanup_bucket_check;
alter table public.community_image_cleanup_queue add constraint community_cleanup_bucket_check check(bucket_id in ('community-images', 'community-files'));

create table if not exists public.community_storage_maintenance (
  id boolean primary key default true check(id),
  swept_at timestamptz not null default '-infinity'
);
insert into public.community_storage_maintenance(id) values(true) on conflict do nothing;
alter table public.community_storage_maintenance enable row level security;
revoke all on public.community_storage_maintenance from public, anon, authenticated;
grant select, update on public.community_storage_maintenance to service_role;

create or replace function public.community_storage_is_referenced(bucket_value text, path_value text)
returns boolean language sql stable security definer set search_path = pg_catalog, public as $$
  select case bucket_value
    when 'community-images' then exists(select 1 from public.community_posts where image_urls @> array[path_value])
    when 'community-files' then exists(select 1 from public.community_posts where attachments @> jsonb_build_array(jsonb_build_object('path',path_value)))
    else false end;
$$;

create or replace function public.community_reserve_upload(bucket_value text, path_value text, name_value text, size_value bigint, owner_value uuid)
returns void language plpgsql security invoker set search_path = pg_catalog, public as $$
begin
  if bucket_value is null or path_value is null or owner_value is null or size_value is null
    or bucket_value not in ('community-images','community-files')
    or split_part(path_value,'/',1) <> owner_value::text
    or path_value !~ '^[0-9a-f-]{36}/[A-Za-z0-9._-]+$'
    or char_length(path_value) > 512 or size_value not between 1 and 26214400 then
    raise exception 'Invalid upload reservation.' using errcode = '22023';
  end if;
  insert into public.community_image_cleanup_queue(bucket_id,object_path,not_before)
  values(bucket_value,path_value,now()+interval '1 hour');
  if bucket_value = 'community-files' then
    insert into public.community_attachments(object_path,owner_id,file_name,size_bytes)
    values(path_value,owner_value,name_value,size_value);
  end if;
end;
$$;

create or replace function public.community_validate_post_media()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
declare file_count integer; canonical jsonb; total_bytes bigint; path_value text; bucket_value text;
begin
  -- Lock old AND new keys in one deterministic order before touching queue
  -- rows, preventing deadlocks when two posts exchange shared files.
  for bucket_value,path_value in
    select 'community-images',unnest(new.image_urls)
    union select 'community-files',value->>'path' from jsonb_array_elements(new.attachments)
    union select 'community-images',unnest(case when tg_op='UPDATE' then old.image_urls else array[]::text[] end)
    union select 'community-files',value->>'path' from jsonb_array_elements(case when tg_op='UPDATE' then old.attachments else '[]'::jsonb end)
    order by 1,2
  loop
    perform pg_advisory_xact_lock(hashtextextended(bucket_value||':'||path_value,94721));
  end loop;
  if cardinality(new.image_urls) > 10 then raise exception 'At most ten images are allowed.' using errcode = '23514'; end if;
  if jsonb_typeof(new.attachments) <> 'array' or jsonb_array_length(new.attachments) > 8 then
    raise exception 'At most eight attachments are allowed.' using errcode = '23514';
  end if;
  select count(*), coalesce(sum(a.size_bytes),0), coalesce(jsonb_agg(jsonb_build_object('path',a.object_path,'name',a.file_name,'size',a.size_bytes) order by item.ordinality),'[]'::jsonb)
  into file_count,total_bytes,canonical
  from jsonb_array_elements(new.attachments) with ordinality item(value,ordinality)
  join public.community_attachments a on a.object_path = item.value->>'path'
  join storage.objects o on o.bucket_id = 'community-files' and o.name = a.object_path
    and (o.metadata->>'size')::bigint = a.size_bytes;
  if file_count <> jsonb_array_length(new.attachments)
    or file_count <> (select count(distinct value->>'path') from jsonb_array_elements(new.attachments)) then
    raise exception 'An attachment is missing or invalid.' using errcode = '23514';
  end if;
  if total_bytes > 26214400 then raise exception 'Attachment total exceeds 25MB.' using errcode = '23514'; end if;
  new.attachments := canonical;
  -- Lock the same rows as the cleanup claimer. A path already leased for
  -- deletion cannot be attached by a concurrent/retried save.
  for bucket_value,path_value in
    select 'community-images',unnest(new.image_urls)
    union all select 'community-files',value->>'path' from jsonb_array_elements(new.attachments)
    order by 1,2
  loop
    perform 1 from public.community_image_cleanup_queue q
      where q.bucket_id = bucket_value and q.object_path = path_value for update;
    if exists(select 1 from public.community_image_cleanup_queue q where q.bucket_id = bucket_value and q.object_path = path_value and q.lease_id is not null) then
      raise exception 'An upload expired; select the file again.' using errcode = '23514';
    end if;
    if not exists(select 1 from storage.objects o where o.bucket_id = bucket_value and o.name = path_value) then
      raise exception 'A media object is missing.' using errcode = '23514';
    end if;
  end loop;
  return new;
end;
$$;
drop trigger if exists community_validate_post_media on public.community_posts;
create trigger community_validate_post_media before insert or update of image_urls,attachments on public.community_posts
for each row execute function public.community_validate_post_media();

create or replace function public.community_queue_post_media_cleanup()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
declare previous record;
begin
  if tg_op <> 'DELETE' then
    delete from public.community_image_cleanup_queue q
    where (q.bucket_id = 'community-images' and q.object_path = any(new.image_urls))
       or (q.bucket_id = 'community-files' and new.attachments @> jsonb_build_array(jsonb_build_object('path',q.object_path)));
  end if;
  if tg_op <> 'INSERT' then
    for previous in select 'community-images'::text as bucket_id,unnest(old.image_urls) as object_path
      union select 'community-files',value->>'path' from jsonb_array_elements(old.attachments) order by 1,2
    loop
      perform pg_advisory_xact_lock(hashtextextended(previous.bucket_id||':'||previous.object_path,94721));
    end loop;
    insert into public.community_image_cleanup_queue(bucket_id,object_path,not_before)
    select source.bucket_id,source.object_path,now()
    from (
      select 'community-images'::text as bucket_id,unnest(old.image_urls) as object_path
      union select 'community-files',value->>'path' from jsonb_array_elements(old.attachments)
    ) source
    where source.object_path <> '' and not public.community_storage_is_referenced(source.bucket_id,source.object_path)
    on conflict(bucket_id,object_path) do update set not_before = excluded.not_before;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
drop trigger if exists community_queue_post_images_on_insert on public.community_posts;
drop trigger if exists community_queue_post_images_on_update on public.community_posts;
drop trigger if exists community_queue_post_images_on_delete on public.community_posts;
drop trigger if exists community_queue_post_media_on_insert on public.community_posts;
drop trigger if exists community_queue_post_media_on_update on public.community_posts;
drop trigger if exists community_queue_post_media_on_delete on public.community_posts;
create trigger community_queue_post_media_on_insert after insert on public.community_posts for each row execute function public.community_queue_post_media_cleanup();
create trigger community_queue_post_media_on_update after update of image_urls,attachments on public.community_posts for each row execute function public.community_queue_post_media_cleanup();
create trigger community_queue_post_media_on_delete after delete on public.community_posts for each row execute function public.community_queue_post_media_cleanup();

create or replace function public.community_abandon_uploads(bucket_value text, paths_value text[], owner_value uuid)
returns void language plpgsql security invoker set search_path = pg_catalog, public as $$
begin
  update public.community_image_cleanup_queue q set not_before = now()
  where q.bucket_id = bucket_value and q.object_path = any(paths_value)
    and split_part(q.object_path,'/',1) = owner_value::text and q.lease_id is null
    and not public.community_storage_is_referenced(q.bucket_id,q.object_path);
end;
$$;

create or replace function public.community_claim_storage_cleanup(limit_value integer default 20)
returns table(bucket_id text,object_path text,lease_id uuid) language plpgsql security invoker set search_path = pg_catalog, public as $$
declare candidate record;
begin
  -- Sweep object metadata at most once per 15 minutes, including abandoned
  -- uploads predating the queue. No object bodies or downloads are read.
  update public.community_storage_maintenance set swept_at = now()
  where id = true and swept_at < now()-interval '15 minutes';
  if found then
    insert into public.community_image_cleanup_queue(bucket_id,object_path,not_before)
    select o.bucket_id,o.name,now() from storage.objects o
    where o.bucket_id in ('community-images','community-files') and o.created_at < now()-interval '1 hour'
      and not public.community_storage_is_referenced(o.bucket_id,o.name)
    on conflict do nothing;
  end if;
  delete from public.community_image_cleanup_queue q
  where public.community_storage_is_referenced(q.bucket_id,q.object_path);
  for candidate in select q.bucket_id,q.object_path from public.community_image_cleanup_queue q
    where q.not_before <= now() order by q.not_before
    limit least(greatest(limit_value,1),100) for update skip locked
  loop
    -- Never wait for a saver while holding its queue row. After acquiring the
    -- path lock, a separate statement checks a fresh committed snapshot.
    if pg_try_advisory_xact_lock(hashtextextended(candidate.bucket_id||':'||candidate.object_path,94721)) then
      if public.community_storage_is_referenced(candidate.bucket_id,candidate.object_path) then
        delete from public.community_image_cleanup_queue q where q.bucket_id=candidate.bucket_id and q.object_path=candidate.object_path;
      else
        update public.community_image_cleanup_queue q
        set lease_id=gen_random_uuid(),attempts=q.attempts+1,
            not_before=now()+make_interval(secs=>least(86400,300*power(2,least(q.attempts,8)))::integer)
        where q.bucket_id=candidate.bucket_id and q.object_path=candidate.object_path
        returning q.bucket_id,q.object_path,q.lease_id into bucket_id,object_path,lease_id;
        return next;
      end if;
    end if;
  end loop;
end;
$$;

create or replace function public.community_ack_storage_cleanup(entries_value jsonb)
returns void language plpgsql security invoker set search_path = pg_catalog, public as $$
begin
  with acknowledged as (
    delete from public.community_image_cleanup_queue q
    using jsonb_to_recordset(entries_value) e(bucket_id text,object_path text,lease_id uuid)
    where q.bucket_id = e.bucket_id and q.object_path = e.object_path and q.lease_id = e.lease_id
    returning q.bucket_id,q.object_path
  )
  delete from public.community_attachments a using acknowledged q
  where q.bucket_id = 'community-files' and a.object_path = q.object_path;
end;
$$;

create or replace function public.community_media_metadata(bucket_value text,path_value text)
returns table(object_id uuid,size_bytes bigint,mime_type text,file_name text)
language sql stable security invoker set search_path = pg_catalog, public as $$
  select o.id,(o.metadata->>'size')::bigint,o.metadata->>'mimetype',coalesce(a.file_name,'image')
  from storage.objects o left join public.community_attachments a
    on o.bucket_id = 'community-files' and a.object_path = o.name
  where o.bucket_id = bucket_value and o.name = path_value
    and public.community_storage_is_referenced(bucket_value,path_value);
$$;

-- Service-role-only helpers. No public object URLs or new user permissions.
revoke all on function public.community_storage_is_referenced(text,text) from public,anon,authenticated;
revoke all on function public.community_reserve_upload(text,text,text,bigint,uuid) from public,anon,authenticated;
revoke all on function public.community_validate_post_media() from public,anon,authenticated;
revoke all on function public.community_queue_post_media_cleanup() from public,anon,authenticated;
revoke all on function public.community_abandon_uploads(text,text[],uuid) from public,anon,authenticated;
revoke all on function public.community_claim_storage_cleanup(integer) from public,anon,authenticated;
revoke all on function public.community_ack_storage_cleanup(jsonb) from public,anon,authenticated;
revoke all on function public.community_media_metadata(text,text) from public,anon,authenticated;
grant execute on function public.community_storage_is_referenced(text,text),public.community_reserve_upload(text,text,text,bigint,uuid),public.community_abandon_uploads(text,text[],uuid),public.community_claim_storage_cleanup(integer),public.community_ack_storage_cleanup(jsonb),public.community_media_metadata(text,text) to service_role;

-- A single DB round trip replaces the former existence lookup + view update.
create or replace function public.community_record_post_view(post_id_value uuid)
returns bigint language plpgsql security invoker set search_path = pg_catalog,public as $$
declare total bigint;
begin
  update public.community_posts set view_count = view_count+1 where id = post_id_value returning view_count into total;
  return total;
end;
$$;
revoke all on function public.community_record_post_view(uuid) from public,anon,authenticated;
grant execute on function public.community_record_post_view(uuid) to service_role;

create or replace function public.community_update_display_name(user_id_value uuid,name_value text)
returns public.community_profiles language plpgsql security invoker set search_path = pg_catalog,public as $$
declare profile public.community_profiles;
begin
  if name_value is null or char_length(btrim(name_value)) not between 1 and 20 then raise exception 'Invalid display name.' using errcode = '22023'; end if;
  update public.community_profiles set display_name = btrim(name_value),role = 'admin' where id = user_id_value returning * into profile;
  if not found then raise exception 'Profile not found.' using errcode = 'P0002'; end if;
  update public.community_posts set author_name = btrim(name_value),updated_at = now() where author_id = user_id_value;
  return profile;
end;
$$;
revoke all on function public.community_update_display_name(uuid,text) from public,anon,authenticated;
grant execute on function public.community_update_display_name(uuid,text) to service_role;

-- Pages Functions call these with the service_role after checking the board
-- session. They preserve category/post integrity even if two admin requests
-- arrive at the same time.
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
  set sort_order = sort_order + 1000000
  where id is not null;

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
  set sort_order = sort_order + 1000000
  where id is not null;

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

-- Shortcut links have no dependent rows, but their ordering remains an
-- atomic database operation so simultaneous settings edits stay consistent.
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
  set sort_order = sort_order + 1000000
  where id is not null;

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
  set sort_order = sort_order + 1000000
  where id is not null;

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

alter table public.community_profiles enable row level security;
alter table public.community_categories enable row level security;
alter table public.community_shortcuts enable row level security;
alter table public.community_posts enable row level security;
alter table public.community_image_cleanup_queue enable row level security;

revoke all on table public.community_categories from public, anon, authenticated;
grant select, insert, update, delete on table public.community_categories to service_role;

revoke all on table public.community_shortcuts from public, anon, authenticated;
grant select, insert, update, delete on table public.community_shortcuts to service_role;

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
revoke all on function public.community_enforce_notice_limit() from public, anon, authenticated;
revoke all on function public.community_create_category(text) from public, anon, authenticated;
revoke all on function public.community_rename_category(uuid, text) from public, anon, authenticated;
revoke all on function public.community_reorder_categories(uuid[]) from public, anon, authenticated;
revoke all on function public.community_delete_category(uuid, uuid) from public, anon, authenticated;
revoke all on function public.community_create_shortcut(text, text) from public, anon, authenticated;
revoke all on function public.community_update_shortcut(uuid, text, text) from public, anon, authenticated;
revoke all on function public.community_reorder_shortcuts(uuid[]) from public, anon, authenticated;
revoke all on function public.community_delete_shortcut(uuid) from public, anon, authenticated;

grant execute on function public.community_has_board_role(text[]) to authenticated;
grant execute on function public.community_email_is_allowed() to authenticated;
grant execute on function public.community_increment_post_views(uuid) to authenticated;
grant execute on function public.community_create_category(text) to service_role;
grant execute on function public.community_rename_category(uuid, text) to service_role;
grant execute on function public.community_reorder_categories(uuid[]) to service_role;
grant execute on function public.community_delete_category(uuid, uuid) to service_role;
grant execute on function public.community_create_shortcut(text, text) to service_role;
grant execute on function public.community_update_shortcut(uuid, text, text) to service_role;
grant execute on function public.community_reorder_shortcuts(uuid[]) to service_role;
grant execute on function public.community_delete_shortcut(uuid) to service_role;

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
