import { badRequest, crossSiteRequest, isSameOriginRequest, json, readJson, serverError, unauthorized } from '../../_lib/http.js';
import { categoryErrorMessage, createCategory, listCategories } from '../../_lib/categories.js';
import { ensureAdminProfile } from '../../_lib/board.js';
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
    await ensureAdminProfile(context.env, auth.user);
    const categories = await listCategories(context.env, { includePostCount: true });
    return json({ categories }, 200, auth.setCookie ? { 'Set-Cookie': auth.setCookie } : undefined);
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
    await ensureAdminProfile(context.env, auth.user);
    const created = await createCategory(context.env, body?.name);
    if (!created.ok) return badRequest(categoryErrorMessage(created, '카테고리를 추가하지 못했습니다.'));
    return json({ category: created.data }, 201, auth.setCookie ? { 'Set-Cookie': auth.setCookie } : undefined);
  } catch {
    return serverError();
  }
}
