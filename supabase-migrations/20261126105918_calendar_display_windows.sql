alter table public.community_calendar
  add column home_display_days smallint not null default 3
    constraint community_calendar_home_display_days_valid check (home_display_days between 1 and 7),
  add column notification_days smallint not null default 14
    constraint community_calendar_notification_days_valid check (notification_days between 3 and 30);
