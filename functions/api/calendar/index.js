import { authorize, sessionHeaders } from '../../_lib/authorize.js';
import { json, readJson, badRequest, serverError } from '../../_lib/http.js';
import { supabaseJson } from '../../_lib/supabase.js';
import { validCalendarDate } from '../../../shared/features.js';
import { listCalendar } from '../../_lib/calendar.js';

export async function onRequestGet(context) {
  const { auth, response } = await authorize(context);
  if (response) return response;
  try { return json({ events: await listCalendar(context.env) }, 200, sessionHeaders(auth)); }
  catch { return serverError(); }
}

export async function onRequestPost(context) {
  const { auth, response } = await authorize(context, { mutation: true });
  if (response) return response;
  const body = await readJson(context.request);
  if (!validCalendarDate(body?.event_date) || typeof body?.content !== 'string' || !body.content.trim() || body.content.trim().length > 2000) return badRequest('날짜와 내용(1~2,000자)을 확인해주세요.');
  try {
    const result = await supabaseJson(context.env, '/rest/v1/community_calendar', { method: 'POST', headers: { Prefer: 'return=representation' }, body: { event_date: body.event_date, content: body.content.trim() } });
    if (!result.response.ok || !result.data?.[0]) return serverError();
    return json({ event: result.data[0] }, 201, sessionHeaders(auth));
  } catch { return serverError(); }
}
