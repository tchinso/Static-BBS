import { crossSiteRequest, isSameOriginRequest, json, serverError, unauthorized } from '../../../_lib/http.js';
import { getPost, incrementPostView, isUuid } from '../../../_lib/board.js';
import { getAuthorizedSession } from '../../../_lib/session.js';

export async function onRequestPost(context) {
  if (!isSameOriginRequest(context.request)) return crossSiteRequest();
  let auth;
  try {
    auth = await getAuthorizedSession(context.request, context.env);
  } catch {
    return serverError();
  }
  if (!auth.ok) return unauthorized({ 'Set-Cookie': auth.clearCookie });
  const id = context.params?.id;
  if (typeof id !== 'string' || !isUuid(id)) return json({ error: '글을 찾을 수 없습니다.' }, 404);
  try {
    // Check existence first so a missing id does not look like a successful view.
    if (!await getPost(context.env, id)) return json({ error: '글을 찾을 수 없습니다.' }, 404);
    if (!await incrementPostView(context.env, id, auth.session.accessToken)) {
      return json({ error: '조회수를 반영하지 못했습니다. 잠시 후 다시 시도해주세요.' }, 502);
    }
    return json({ viewed: true }, 200, auth.setCookie ? { 'Set-Cookie': auth.setCookie } : undefined);
  } catch {
    return serverError();
  }
}
