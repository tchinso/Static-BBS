import { badRequest, crossSiteRequest, isSameOriginRequest, json, readJson, serverError, unauthorized } from '../../_lib/http.js';
import { deleteShortcut, isShortcutId, shortcutErrorMessage, updateShortcut } from '../../_lib/shortcuts.js';
import { ensureAdminProfile } from '../../_lib/board.js';
import { getAuthorizedSession } from '../../_lib/session.js';

function shortcutId(context) {
  const id = context.params?.id;
  return isShortcutId(id) ? id : '';
}

async function authenticated(context) {
  try {
    return await getAuthorizedSession(context.request, context.env);
  } catch {
    return null;
  }
}

function notFound() {
  return json({ error: '바로가기를 찾을 수 없습니다.' }, 404);
}

export async function onRequestPatch(context) {
  if (!isSameOriginRequest(context.request)) return crossSiteRequest();
  const auth = await authenticated(context);
  if (!auth) return serverError();
  if (!auth.ok) return unauthorized({ 'Set-Cookie': auth.clearCookie });
  const id = shortcutId(context);
  if (!id) return notFound();
  const body = await readJson(context.request);
  try {
    await ensureAdminProfile(context.env, auth.user);
    const updated = await updateShortcut(context.env, id, body?.title, body?.url);
    if (!updated.ok) {
      const message = shortcutErrorMessage(updated, '바로가기를 수정하지 못했습니다.');
      return json({ error: message }, /찾을 수 없습니다/.test(message) ? 404 : 400);
    }
    return json({ shortcut: updated.data }, 200, auth.setCookie ? { 'Set-Cookie': auth.setCookie } : undefined);
  } catch {
    return serverError();
  }
}

export async function onRequestDelete(context) {
  if (!isSameOriginRequest(context.request)) return crossSiteRequest();
  const auth = await authenticated(context);
  if (!auth) return serverError();
  if (!auth.ok) return unauthorized({ 'Set-Cookie': auth.clearCookie });
  const id = shortcutId(context);
  if (!id) return notFound();
  try {
    await ensureAdminProfile(context.env, auth.user);
    const deleted = await deleteShortcut(context.env, id);
    if (!deleted.ok) {
      const message = shortcutErrorMessage(deleted, '바로가기를 삭제하지 못했습니다.');
      return json({ error: message }, /찾을 수 없습니다/.test(message) ? 404 : 400);
    }
    return json({ deleted: true, shortcutId: deleted.data?.deleted_shortcut_id || id }, 200,
      auth.setCookie ? { 'Set-Cookie': auth.setCookie } : undefined);
  } catch {
    return serverError();
  }
}
