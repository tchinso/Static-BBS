import { authorize, sessionHeaders } from '../../_lib/authorize.js';
import { json, readJson, badRequest, serverError } from '../../_lib/http.js';
import { supabaseJson } from '../../_lib/supabase.js';
import { listCalendar, makeCalendarFields } from '../../_lib/calendar.js';

export async function onRequestGet(context) {
  const { auth, response } = await authorize(context);
  if (response) return response;
  try { return json({ events: await listCalendar(context.env) }, 200, sessionHeaders(auth)); }
  catch { return serverError(); }
}

export async function onRequestPost(context) {
  const { auth, response } = await authorize(context, { mutation: true });
  if (response) return response;
  const { fields, error } = makeCalendarFields(await readJson(context.request));
  if (error) return badRequest(error);
  try {
    const result = await supabaseJson(context.env, '/rest/v1/community_calendar', { method: 'POST', headers: { Prefer: 'return=representation' }, body: fields });
    if (!result.response.ok || !result.data?.[0]) return serverError();
    return json({ event: result.data[0] }, 201, sessionHeaders(auth));
  } catch { return serverError(); }
}
