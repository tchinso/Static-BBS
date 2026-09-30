import { scheduleStorageCleanup } from '../_lib/storage-cleanup.js';
import { json, serverError } from '../_lib/http.js';
import { createBoardBootstrap } from '../_lib/bootstrap.js';
import { authorize } from '../_lib/authorize.js';

export async function onRequestGet(context) {
  const startedAt = performance.now();
  const { auth, response } = await authorize(context);
  if (response) return response;

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
    scheduleStorageCleanup(context);
    return json(bootstrap, 200, headers);
  } catch {
    return serverError();
  }
}
