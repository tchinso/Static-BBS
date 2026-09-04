-- Run once in the Supabase SQL Editor for an existing project.
-- Adds the per-post display protection option used by the browser.
begin;

alter table public.community_posts
  add column if not exists is_confidential boolean;

update public.community_posts
set is_confidential = false
where is_confidential is null;

alter table public.community_posts
  alter column is_confidential set default false,
  alter column is_confidential set not null;

commit;
