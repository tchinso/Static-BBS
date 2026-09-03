import { badRequest, crossSiteRequest, isSameOriginRequest, json, readJson, serverError, unauthorized } from '../../_lib/http.js';
import { createPost, ensureAdminProfile, listPosts, makePostFields, pinLimitError, presentPost } from '../../_lib/board.js';
import { getAuthorizedSession } from '../../_lib/session.js';

async function authenticated(context) {
  try {
    return await getAuthorizedSession(context.request, context.env);
  } catch {
    return null;
  }
}

export async function onRequestGet(context) {
  const auth = await authenticated(context);
  if (!auth) return serverError();
  if (!auth.ok) return unauthorized({ 'Set-Cookie': auth.clearCookie });
  try {
    const posts = await listPosts(context.env);
    return json({ posts }, 200, auth.setCookie ? { 'Set-Cookie': auth.setCookie } : undefined);
  } catch {
    return serverError();
  }
}

export async function onRequestPost(context) {
  if (!isSameOriginRequest(context.request)) return crossSiteRequest();
  const auth = await authenticated(context);
  if (!auth) return serverError();
  if (!auth.ok) return unauthorized({ 'Set-Cookie': auth.clearCookie });
  const body = await readJson(context.request);
  try {
    const profile = await ensureAdminProfile(context.env, auth.user);
    const prepared = makePostFields(body, context.env, { creating: true, profile, user: auth.user });
    if (prepared.error) return badRequest(prepared.error);
    const created = await createPost(context.env, prepared.fields);
    if (!created.ok) {
      if (pinLimitError(created.detail)) return json({ error: '상단 고정 글은 최대 2개까지만 설정할 수 있습니다.' }, 409);
      return json({ error: '글을 저장하지 못했습니다. 잠시 후 다시 시도해주세요.' }, 502);
    }
    return json({ post: presentPost(created.data, context.env) }, 201, auth.setCookie ? { 'Set-Cookie': auth.setCookie } : undefined);
  } catch {
    return serverError();
  }
}
