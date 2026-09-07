import { json, serverError, unauthorized } from '../_lib/http.js';
import { createBoardBootstrap } from '../_lib/bootstrap.js';
import { getAuthorizedSession } from '../_lib/session.js';

export async function onRequestGet(context) {
  const startedAt = performance.now();
  let auth;
  try {
    auth = await getAuthorizedSession(context.request, context.env);
  } catch {
    return serverError();
  }
  if (!auth.ok) return unauthorized({ 'Set-Cookie': auth.clearCookie });

  try {
    const authenticatedAt = performance.now();
    const bootstrap = await createBoardBootstrap(context.env, auth.user);
    const headers = new Headers(auth.setCookie ? { 'Set-Cookie': auth.setCookie } : undefined);
    const completedAt = performance.now();
    headers.set('Server-Timing', [
      `auth;dur=${(authenticatedAt - startedAt).toFixed(1)}`,
      `board;dur=${(completedAt - authenticatedAt).toFixed(1)}`,
      `total;dur=${(completedAt - startedAt).toFixed(1)}`
    ].join(', '));
    return json(bootstrap, 200, headers);
  } catch {
    return serverError();
  }
}
