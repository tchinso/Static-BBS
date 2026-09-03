import { badRequest, crossSiteRequest, isSameOriginRequest, json, readJson, serverError, unauthorized } from '../../_lib/http.js';
import { deleteImageObjects, deletePost, getPost, isUuid, makePostFields, patchPost, pinLimitError, presentPost } from '../../_lib/board.js';
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
    const current = await getPost(context.env, id);
    if (!current) return notFound();
    if (Array.isArray(prepared.fields.image_urls)) {
      const retained = new Set(prepared.fields.image_urls);
      const removed = current.image_urls.filter((path) => !retained.has(path));
      const cleaned = await deleteImageObjects(context.env, removed);
      if (!cleaned.ok) {
        return json({ error: '기존 첨부 이미지 정리를 완료하지 못해 글을 수정하지 않았습니다. 잠시 후 다시 시도해주세요.' }, 502);
      }
    }
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
    const post = await getPost(context.env, id);
    if (!post) return notFound();
    const cleaned = await deleteImageObjects(context.env, post.image_urls);
    if (!cleaned.ok) {
      return json({ error: '첨부 이미지 정리를 완료하지 못해 글은 삭제되지 않았습니다. 잠시 후 다시 시도해주세요.' }, 502);
    }
    const deleted = await deletePost(context.env, id);
    if (!deleted.ok) return json({ error: '글을 삭제하지 못했습니다. 잠시 후 다시 시도해주세요.' }, 502);
    if (!deleted.deleted) return notFound();
    return json({ deleted: true }, 200, auth.setCookie ? { 'Set-Cookie': auth.setCookie } : undefined);
  } catch {
    return serverError();
  }
}
