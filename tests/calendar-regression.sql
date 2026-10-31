-- Run after applying the calendar migration. All fixture writes are rolled back.
begin;
do $$ begin
if not public.community_valid_external_links('[{"name":"test","url":"https://filedn.com/a"}]') then raise exception 'valid link rejected'; end if;
if public.community_valid_external_links('[{"name":"test","url":"https://filedn.com.evil.test/a"}]') then raise exception 'invalid host accepted'; end if;
if public.community_valid_external_links('[{"name":"test","url":"https://user@filedn.com/a"}]') then raise exception 'credentials accepted'; end if;
if public.community_valid_external_links('[{"name":"test"}]') then raise exception 'missing url accepted'; end if;
if public.community_valid_external_links('{}') then raise exception 'object accepted'; end if;
if has_table_privilege('anon','public.community_calendar','SELECT') then raise exception 'anonymous grant'; end if;
if not (select relrowsecurity from pg_class where oid='public.community_calendar'::regclass) then raise exception 'RLS missing'; end if;
end $$;
set local role authenticated;
do $$ begin
if exists(select 1 from public.community_calendar) then raise exception 'unapproved read'; end if;
begin
insert into public.community_calendar(event_date,content) values ('2026-11-01','QA rollback');
raise exception 'unapproved insert accepted';
exception when insufficient_privilege then null;
end;
end $$;
reset role;
set local role service_role;
insert into public.community_calendar(event_date,content) values ('2026-11-01','QA rollback');
select count(*) as fixture_count from public.community_calendar where content='QA rollback';
rollback;
