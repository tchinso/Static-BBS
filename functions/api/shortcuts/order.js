import { badRequest, crossSiteRequest, isSameOriginRequest, json, readJson, serverError, unauthorized } from '../../_lib/http.js';
import { reorderShortcuts, shortcutErrorMessage } from '../../_lib/shortcuts.js';
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
    const reordered = await reorderShortcuts(context.env, body?.shortcut_ids);
    if (!reordered.ok) return badRequest(shortcutErrorMessage(reordered, '바로가기 순서를 변경하지 못했습니다.'));
    return json({ shortcuts: reordered.data }, 200, auth.setCookie ? { 'Set-Cookie': auth.setCookie } : undefined);
  } catch {
    return serverError();
  }
}
