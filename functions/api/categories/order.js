import { badRequest, crossSiteRequest, isSameOriginRequest, json, readJson, serverError, unauthorized } from '../../_lib/http.js';
import { categoryErrorMessage, reorderCategories } from '../../_lib/categories.js';
import { ensureAdminProfile } from '../../_lib/board.js';
import { getAuthorizedSession } from '../../_lib/session.js';

async function authenticated(context) {
  try {
    return await getAuthorizedSession(context.request, context.env);
  } catch {
    return null;
  }
}

export async function onRequestPatch(context) {
  if (!isSameOriginRequest(context.request)) return crossSiteRequest();
  const auth = await authenticated(context);
  if (!auth) return serverError();
  if (!auth.ok) return unauthorized({ 'Set-Cookie': auth.clearCookie });
  const body = await readJson(context.request);
  try {
    await ensureAdminProfile(context.env, auth.user);
    const reordered = await reorderCategories(context.env, body?.category_ids);
    if (!reordered.ok) return badRequest(categoryErrorMessage(reordered, '카테고리 순서를 변경하지 못했습니다.'));
    return json({ categories: reordered.data }, 200, auth.setCookie ? { 'Set-Cookie': auth.setCookie } : undefined);
  } catch {
    return serverError();
  }
}
