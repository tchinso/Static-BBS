import { crossSiteRequest, isSameOriginRequest, json, serverError, unauthorized } from '../../../_lib/http.js';
import { createPostShareLink, isUuid, presentPost } from '../../../_lib/board.js';
import { getAuthorizedSession } from '../../../_lib/session.js';

function notFound() {
  return json({ error: '글을 찾을 수 없습니다.' }, 404);
}

function shareUrl(request, shareTag) {
  const url = new URL(request.url);
  url.pathname = `/${shareTag}`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

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
  if (typeof id !== 'string' || !isUuid(id)) return notFound();

  try {
    const shared = await createPostShareLink(context.env, id);
    if (!shared.ok) {
      if (shared.reason === 'not_found') return notFound();
      if (shared.reason === 'tag_limit') {
        return json({ error: '태그가 최대 8개라 공유 링크를 만들 수 없습니다. 태그를 하나 비운 뒤 다시 시도해주세요.' }, 409);
      }
      return json({ error: '공유 링크를 만들지 못했습니다. 잠시 후 다시 시도해주세요.' }, 502);
    }

    return json({
      post: presentPost(shared.post, context.env),
      shareTag: shared.shareTag,
      shareUrl: shareUrl(context.request, shared.shareTag),
      created: shared.created
    }, shared.created ? 201 : 200, auth.setCookie ? { 'Set-Cookie': auth.setCookie } : undefined);
  } catch {
    return serverError();
  }
}
