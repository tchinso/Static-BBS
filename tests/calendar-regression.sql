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
do $$
declare
  fixture public.community_calendar;
begin
  insert into public.community_calendar(event_date, content)
    values ('2026-11-01', 'QA rollback') returning * into fixture;
  if fixture.home_display_days <> 3 or fixture.notification_days <> 14 then
    raise exception 'unexpected default display windows';
  end if;
  update public.community_calendar set home_display_days = 1, notification_days = 3 where id = fixture.id;
  update public.community_calendar set home_display_days = 7, notification_days = 30 where id = fixture.id;
  begin
    update public.community_calendar set home_display_days = 8 where id = fixture.id;
    raise exception 'invalid home display days accepted';
  exception when check_violation then null;
  end;
  begin
    update public.community_calendar set notification_days = 2 where id = fixture.id;
    raise exception 'invalid notification days accepted';
  exception when check_violation then null;
  end;
end $$;
rollback;
