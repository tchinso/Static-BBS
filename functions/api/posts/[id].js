import { badRequest, crossSiteRequest, isSameOriginRequest, json, readJson, serverError, unauthorized } from '../../_lib/http.js';
import { deletePost, getPost, isUuid, makePostFields, patchPost, pinLimitError, presentPost } from '../../_lib/board.js';
import { getAuthorizedSession } from '../../_lib/session.js';

function postId(context) {
  const id = context.params?.id;
  return typeof id === 'string' && isUuid(id) ? id : '';
}

async function authenticated(context) {
  try {
    return await getAuthorizedSession(context.request, context.env);
  } catch {
    return null;
  }
}

function notFound() {
  return json({ error: '글을 찾을 수 없습니다.' }, 404);
}

export async function onRequestGet(context) {
  const auth = await authenticated(context);
  if (!auth) return serverError();
  if (!auth.ok) return unauthorized({ 'Set-Cookie': auth.clearCookie });
  const id = postId(context);
  if (!id) return notFound();
  try {
    const post = await getPost(context.env, id);
    if (!post) return notFound();
    return json({ post }, 200, auth.setCookie ? { 'Set-Cookie': auth.setCookie } : undefined);
  } catch {
    return serverError();
  }
}

export async function onRequestPatch(context) {
  if (!isSameOriginRequest(context.request)) return crossSiteRequest();
  const auth = await authenticated(context);
  if (!auth) return serverError();
  if (!auth.ok) return unauthorized({ 'Set-Cookie': auth.clearCookie });
  const id = postId(context);
  if (!id) return notFound();
  const body = await readJson(context.request);
  const prepared = makePostFields(body, context.env);
  if (prepared.error) return badRequest(prepared.error);
  try {
    const patched = await patchPost(context.env, id, prepared.fields);
    if (!patched.ok) {
      if (pinLimitError(patched.detail)) return json({ error: '상단 고정 글은 최대 2개까지만 설정할 수 있습니다.' }, 409);
      return json({ error: '글을 수정하지 못했습니다. 잠시 후 다시 시도해주세요.' }, 502);
    }
    if (!patched.data) return notFound();
    return json({ post: presentPost(patched.data, context.env) }, 200, auth.setCookie ? { 'Set-Cookie': auth.setCookie } : undefined);
  } catch {
    return serverError();
  }
}

export async function onRequestDelete(context) {
  if (!isSameOriginRequest(context.request)) return crossSiteRequest();
  const auth = await authenticated(context);
  if (!auth) return serverError();
  if (!auth.ok) return unauthorized({ 'Set-Cookie': auth.clearCookie });
  const id = postId(context);
  if (!id) return notFound();
  try {
    const deleted = await deletePost(context.env, id);
    if (!deleted.ok) return json({ error: '글을 삭제하지 못했습니다. 잠시 후 다시 시도해주세요.' }, 502);
    if (!deleted.deleted) return notFound();
    return json({ deleted: true }, 200, auth.setCookie ? { 'Set-Cookie': auth.setCookie } : undefined);
  } catch {
    return serverError();
  }
}
