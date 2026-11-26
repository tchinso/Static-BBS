import { restQuery } from './database.js';
import { supabaseJson } from './supabase.js';
import { CALENDAR_WINDOWS, validCalendarDate } from '../../shared/features.js';

export function makeCalendarFields(input) {
  const content = typeof input?.content === 'string' ? input.content.trim() : '';
  if (!validCalendarDate(input?.event_date) || !content || content.length > 2000) {
    return { error: '날짜와 내용(1~2,000자)을 확인해주세요.' };
  }

  const fields = { event_date: input.event_date, content };
  for (const [field, { min, max, label }] of Object.entries(CALENDAR_WINDOWS)) {
    if (!Object.hasOwn(input, field)) continue;
    const days = input[field];
    if (!Number.isInteger(days) || days < min || days > max) {
      return { error: `${label} 기간을 ${min}~${max}일로 지정해주세요.` };
    }
    fields[field] = days;
  }
  return { fields };
}

export async function listCalendar(env) {
  const events = [];
  for (let offset = 0; ; offset += 500) {
    const result = await supabaseJson(env, restQuery('community_calendar', { select: 'id,event_date,content,home_display_days,notification_days', order: 'event_date.asc,id.asc', limit: '500', offset: String(offset) }));
    if (!result.response.ok || !Array.isArray(result.data)) throw new Error('Calendar lookup failed.');
    events.push(...result.data);
    if (result.data.length < 500) return events;
  }
}
