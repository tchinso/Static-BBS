import { badRequest, json, readJson, serverError } from '../../_lib/http.js';
import { deleteShortcut, isShortcutId, shortcutErrorMessage, updateShortcut } from '../../_lib/shortcuts.js';
import { authorize } from '../../_lib/authorize.js';

function shortcutId(context) {
  const id = context.params?.id;
  return isShortcutId(id) ? id : '';
}

function notFound() {
  return json({ error: '바로가기를 찾을 수 없습니다.' }, 404);
}

export async function onRequestPatch(context) {
  const { auth, response } = await authorize(context, { mutation: true });
  if (response) return response;
  const id = shortcutId(context);
  if (!id) return notFound();
  const body = await readJson(context.request);
  try {
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
  const { auth, response } = await authorize(context, { mutation: true });
  if (response) return response;
  const id = shortcutId(context);
  if (!id) return notFound();
  try {
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
