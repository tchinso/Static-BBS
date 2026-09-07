import { badRequest, crossSiteRequest, isSameOriginRequest, json, readJson, serverError, unauthorized } from '../../_lib/http.js';
import { categoryErrorMessage, deleteCategory, isCategoryId, renameCategory } from '../../_lib/categories.js';
import { ensureAdminProfile } from '../../_lib/board.js';
import { getAuthorizedSession } from '../../_lib/session.js';

function categoryId(context) {
  const id = context.params?.id;
  return isCategoryId(id) ? id : '';
}

async function authenticated(context) {
  try {
    return await getAuthorizedSession(context.request, context.env);
  } catch {
    return null;
  }
}

function notFound() {
  return json({ error: '카테고리를 찾을 수 없습니다.' }, 404);
}

export async function onRequestPatch(context) {
  if (!isSameOriginRequest(context.request)) return crossSiteRequest();
  const auth = await authenticated(context);
  if (!auth) return serverError();
  if (!auth.ok) return unauthorized({ 'Set-Cookie': auth.clearCookie });
  const id = categoryId(context);
  if (!id) return notFound();
  const body = await readJson(context.request);
  try {
    await ensureAdminProfile(context.env, auth.user);
    const renamed = await renameCategory(context.env, id, body?.name);
    if (!renamed.ok) {
      const message = categoryErrorMessage(renamed, '카테고리를 수정하지 못했습니다.');
      return json({ error: message }, /찾을 수 없습니다/.test(message) ? 404 : 400);
    }
    return json({ category: renamed.data }, 200, auth.setCookie ? { 'Set-Cookie': auth.setCookie } : undefined);
  } catch {
    return serverError();
  }
}

export async function onRequestDelete(context) {
  if (!isSameOriginRequest(context.request)) return crossSiteRequest();
  const auth = await authenticated(context);
  if (!auth) return serverError();
  if (!auth.ok) return unauthorized({ 'Set-Cookie': auth.clearCookie });
  const id = categoryId(context);
  if (!id) return notFound();
  const body = await readJson(context.request);
  const replacementId = body?.replacement_id ?? null;
  if (replacementId !== null && !isCategoryId(replacementId)) return badRequest('이동할 카테고리를 선택해주세요.');
  try {
    await ensureAdminProfile(context.env, auth.user);
    const deleted = await deleteCategory(context.env, id, replacementId);
    if (!deleted.ok) {
      const message = categoryErrorMessage(deleted, '카테고리를 삭제하지 못했습니다.');
      return json({ error: message }, /찾을 수 없습니다/.test(message) ? 404 : 409);
    }
    return json({ deleted: true, reassignedPostCount: deleted.data?.reassigned_post_count || 0 }, 200,
      auth.setCookie ? { 'Set-Cookie': auth.setCookie } : undefined);
  } catch {
    return serverError();
  }
}
