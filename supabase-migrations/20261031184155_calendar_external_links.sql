begin;

-- External links do not enter the Storage registration/cleanup lifecycle.
create or replace function public.community_valid_external_links(links jsonb)
returns boolean language plpgsql immutable set search_path = pg_catalog as $$
declare item jsonb;
begin
  if links is null or jsonb_typeof(links) <> 'array' then return false; end if;
  if jsonb_array_length(links) > 8 then return false; end if;
  for item in select value from jsonb_array_elements(links) loop
    if jsonb_typeof(item) <> 'object'
      or jsonb_typeof(item->'name') is distinct from 'string'
      or jsonb_typeof(item->'url') is distinct from 'string'
      or length(btrim(item->>'name')) not between 1 and 200
      or length(item->>'url') > 4096
      or (item->>'url') !~ '^https://(app[.]koofr[.]net|filedn[.]com|transfer[.]it)/'
      or (item->>'url') ~ '[[:space:][:cntrl:]]'
      or position(chr(92) in (item->>'url')) > 0
    then return false; end if;
  end loop;
  return true;
end;
$$;
revoke all on function public.community_valid_external_links(jsonb) from public, anon;
grant execute on function public.community_valid_external_links(jsonb) to authenticated, service_role;
alter table public.community_posts add column if not exists external_links jsonb not null default '[]'::jsonb;
alter table public.community_posts add constraint community_posts_external_links_valid check (public.community_valid_external_links(external_links));

create table public.community_calendar (
  id uuid primary key default gen_random_uuid(),
  event_date date not null check (event_date between date '0001-01-01' and date '9999-12-31'),
  content text not null check (length(btrim(content)) between 1 and 2000),
  created_at timestamptz not null default now()
);
create index community_calendar_date_id_idx on public.community_calendar(event_date, id);
alter table public.community_calendar enable row level security;
revoke all on public.community_calendar from public, anon, authenticated;
grant select, insert, update, delete on public.community_calendar to authenticated;
grant all on public.community_calendar to service_role;
create policy "approved admins read calendar" on public.community_calendar for select to authenticated using ((select public.community_has_board_role(array['admin'])));
create policy "approved admins create calendar" on public.community_calendar for insert to authenticated with check ((select public.community_has_board_role(array['admin'])));
create policy "approved admins update calendar" on public.community_calendar for update to authenticated using ((select public.community_has_board_role(array['admin']))) with check ((select public.community_has_board_role(array['admin'])));
create policy "approved admins delete calendar" on public.community_calendar for delete to authenticated using ((select public.community_has_board_role(array['admin'])));

commit;
