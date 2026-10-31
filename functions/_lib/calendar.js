import { restQuery } from './database.js';
import { supabaseJson } from './supabase.js';

export async function listCalendar(env) {
  const events = [];
  for (let offset = 0; ; offset += 500) {
    const result = await supabaseJson(env, restQuery('community_calendar', { select: 'id,event_date,content', order: 'event_date.asc,id.asc', limit: '500', offset: String(offset) }));
    if (!result.response.ok || !Array.isArray(result.data)) throw new Error('Calendar lookup failed.');
    events.push(...result.data);
    if (result.data.length < 500) return events;
  }
}
