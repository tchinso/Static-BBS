import { badRequest, crossSiteRequest, isSameOriginRequest, json, readJson, serverError, unauthorized } from '../_lib/http.js';
import { cleanText, ensureAdminProfile, updateDisplayName } from '../_lib/board.js';
import { getAuthorizedSession } from '../_lib/session.js';

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
    const profile = await ensureAdminProfile(context.env, auth.user);
    return json({ profile }, 200, auth.setCookie ? { 'Set-Cookie': auth.setCookie } : undefined);
  } catch {
    return serverError();
  }
}

export async function onRequestPatch(context) {
  if (!isSameOriginRequest(context.request)) return crossSiteRequest();
  const auth = await authenticated(context);
  if (!auth) return serverError();
  if (!auth.ok) return unauthorized({ 'Set-Cookie': auth.clearCookie });
  const body = await readJson(context.request);
  const displayName = cleanText(body?.display_name, { min: 1, max: 20 });
  if (!displayName) return badRequest('표시 이름은 1~20자로 입력해주세요.');
  try {
    const profile = await updateDisplayName(context.env, auth.user.id, displayName);
    if (!profile) return serverError();
    return json({ profile }, 200, auth.setCookie ? { 'Set-Cookie': auth.setCookie } : undefined);
  } catch {
    return serverError();
  }
}
