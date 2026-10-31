import { authorize, sessionHeaders } from '../../_lib/authorize.js';
import { json, readJson, badRequest, serverError } from '../../_lib/http.js';
import { supabaseJson } from '../../_lib/supabase.js';
import { restQuery } from '../../_lib/database.js';
import { isUuid } from '../../../shared/validation.js';
import { validCalendarDate } from '../../../shared/features.js';

async function mutate(context, method) {
  const { auth, response } = await authorize(context, { mutation: true });
  if (response) return response;
  if (!isUuid(context.params.id)) return badRequest('일정을 확인해주세요.');
  let body;
  if (method === 'PATCH') {
    const input = await readJson(context.request);
    if (!validCalendarDate(input?.event_date) || typeof input?.content !== 'string' || !input.content.trim() || input.content.trim().length > 2000) return badRequest('날짜와 내용(1~2,000자)을 확인해주세요.');
    body = { event_date: input.event_date, content: input.content.trim() };
  }
  try {
    const result = await supabaseJson(context.env, restQuery('community_calendar', { id: `eq.${context.params.id}` }), { method, headers: { Prefer: 'return=representation' }, ...(body ? { body } : {}) });
    if (!result.response.ok) return serverError();
    if (!result.data?.length) return json({ error: '일정을 찾을 수 없습니다.' }, 404, sessionHeaders(auth));
    return json(method === 'DELETE' ? { deleted: true } : { event: result.data[0] }, 200, sessionHeaders(auth));
  } catch { return serverError(); }
}
export const onRequestPatch = (context) => mutate(context, 'PATCH');
export const onRequestDelete = (context) => mutate(context, 'DELETE');
