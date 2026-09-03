-- Run once in the Supabase SQL Editor for an existing project.
-- It stops rather than guessing how to remap any legacy category values.
begin;

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

commit;
