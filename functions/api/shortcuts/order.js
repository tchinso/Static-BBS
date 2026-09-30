import { badRequest, json, readJson, serverError } from '../../_lib/http.js';
import { reorderShortcuts, shortcutErrorMessage } from '../../_lib/shortcuts.js';
import { authorize } from '../../_lib/authorize.js';

export async function onRequestPatch(context) {
  const { auth, response } = await authorize(context, { mutation: true });
  if (response) return response;
  const body = await readJson(context.request);
  try {
    const reordered = await reorderShortcuts(context.env, body?.shortcut_ids);
    if (!reordered.ok) return badRequest(shortcutErrorMessage(reordered, '바로가기 순서를 변경하지 못했습니다.'));
    return json({ shortcuts: reordered.data }, 200, auth.setCookie ? { 'Set-Cookie': auth.setCookie } : undefined);
  } catch {
    return serverError();
  }
}
