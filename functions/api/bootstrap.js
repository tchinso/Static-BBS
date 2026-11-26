import { scheduleStorageCleanup } from '../_lib/storage-cleanup.js';
import { json, serverError } from '../_lib/http.js';
import { createBoardBootstrap, loadBoardContent } from '../_lib/bootstrap.js';
import { authorize, sessionHeaders } from '../_lib/authorize.js';
import { loadProfile } from '../_lib/board.js';

export async function onRequestGet(context) {
  const startedAt = performance.now();
  let board;
  let prefetchedProfile;
  const { auth, response } = await authorize(context, {
    onFreshSession(subject) {
      // Start read-only work after verifying the sealed cookie. Sending the
      // result and creating a profile still require Supabase authorization.
      board = loadBoardContent(context.env);
      void board.catch(() => undefined);
      if (subject) {
        const lookup = loadProfile(context.env, subject);
        void lookup.catch(() => undefined);
        prefetchedProfile = { subject, lookup };
      }
    }
  });
  if (response) return response;

  try {
    const authenticatedAt = performance.now();
    const profile = prefetchedProfile?.subject === auth.user.id ? prefetchedProfile.lookup : undefined;
    const bootstrap = await createBoardBootstrap(context.env, auth.user, { board, profile });
    const headers = new Headers(sessionHeaders(auth));
    const completedAt = performance.now();
    headers.set('Server-Timing', [
      `auth;dur=${(authenticatedAt - startedAt).toFixed(1)}`,
      `board;dur=${(completedAt - authenticatedAt).toFixed(1)}`,
      `total;dur=${(completedAt - startedAt).toFixed(1)}`
    ].join(', '));
    scheduleStorageCleanup(context);
    return json(bootstrap, 200, headers);
  } catch {
    return serverError(sessionHeaders(auth));
  }
}
