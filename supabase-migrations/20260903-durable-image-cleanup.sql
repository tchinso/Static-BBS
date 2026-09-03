-- Run after 20260903-categories-and-image-limit.sql.
-- Queue image cleanup in the same database transaction as a post change so a
-- temporary Storage API failure never becomes an untracked orphaned object.
begin;

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
  if tg_op <> 'DELETE' then
    delete from public.community_image_cleanup_queue
    where object_path = any(coalesce(new.image_urls, array[]::text[]));
  end if;

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

alter table public.community_image_cleanup_queue enable row level security;
revoke all on table public.community_image_cleanup_queue from public, anon, authenticated;
grant select, insert, update, delete on table public.community_image_cleanup_queue to service_role;
revoke all on function public.community_queue_image_cleanup() from public, anon, authenticated;

commit;
