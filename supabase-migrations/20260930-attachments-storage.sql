-- Apply after 20260930-ordering-notices-stars.sql. No stored bytes are deleted
-- by SQL: only the authenticated Storage API removes objects.
begin;

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
commit;
