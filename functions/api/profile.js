import { badRequest, json, readJson, serverError } from '../_lib/http.js';
import { cleanText, ensureAdminProfile, updateDisplayName } from '../_lib/board.js';
import { authorize } from '../_lib/authorize.js';

export async function onRequestGet(context) {
  const { auth, response } = await authorize(context);
  if (response) return response;
  try {
    const profile = await ensureAdminProfile(context.env, auth.user);
    return json({ profile }, 200, auth.setCookie ? { 'Set-Cookie': auth.setCookie } : undefined);
  } catch {
    return serverError();
  }
}

export async function onRequestPatch(context) {
  const { auth, response } = await authorize(context, { mutation: true });
  if (response) return response;
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
