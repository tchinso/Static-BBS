import { badRequest, json, readJson, serverError } from '../../_lib/http.js';
import { createShortcut, listShortcuts, shortcutErrorMessage } from '../../_lib/shortcuts.js';
import { authorize } from '../../_lib/authorize.js';

export async function onRequestGet(context) {
  const { auth, response } = await authorize(context);
  if (response) return response;
  try {
    const shortcuts = await listShortcuts(context.env);
    return json({ shortcuts }, 200, auth.setCookie ? { 'Set-Cookie': auth.setCookie } : undefined);
  } catch {
    return serverError();
  }
}

export async function onRequestPost(context) {
  const { auth, response } = await authorize(context, { mutation: true });
  if (response) return response;
  const body = await readJson(context.request);
  try {
    const created = await createShortcut(context.env, body?.title, body?.url);
    if (!created.ok) return badRequest(shortcutErrorMessage(created, '바로가기를 추가하지 못했습니다.'));
    return json({ shortcut: created.data }, 201, auth.setCookie ? { 'Set-Cookie': auth.setCookie } : undefined);
  } catch {
    return serverError();
  }
}
