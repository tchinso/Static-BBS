import { badRequest, crossSiteRequest, isSameOriginRequest, json, readJson, serverError } from '../../_lib/http.js';
import { createBoardBootstrap } from '../../_lib/bootstrap.js';
import { establishSession } from '../../_lib/session.js';

// Supabase places tokens after # in the redirect URL. Fragments never reach a
// server, so the small client callback bridge POSTs them here and immediately
// clears the fragment. Tokens are verified here and never persisted in JS.
export async function onRequestPost(context) {
  if (!isSameOriginRequest(context.request)) return crossSiteRequest();
  const body = await readJson(context.request);
  if (!body || typeof body.access_token !== 'string' || typeof body.refresh_token !== 'string') {
    return badRequest('로그인 링크 정보를 확인해주세요.');
  }
  try {
    const startedAt = performance.now();
    const established = await establishSession(context.env, {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresIn: body.expires_in,
      persistent: body.persistent !== false
    });
    if (!established) return json({ error: '허용되지 않은 이메일이거나 로그인 링크가 만료되었습니다.' }, 403);
    const authenticatedAt = performance.now();

    // A magic-link callback already has a verified user. Reuse that result to
    // prepare the first board payload, avoiding a second Pages request and
    // another /auth/v1/user lookup. A transient board-read failure must not
    // discard a valid new session; the client safely falls back to bootstrap.
    let bootstrap = null;
    try {
      bootstrap = await createBoardBootstrap(context.env, established.user);
    } catch {
      console.error('callback_bootstrap_deferred');
    }
    const completedAt = performance.now();
    const headers = new Headers({ 'Set-Cookie': established.cookie });
    headers.set('Server-Timing', [
      `auth;dur=${(authenticatedAt - startedAt).toFixed(1)}`,
      `board;dur=${(completedAt - authenticatedAt).toFixed(1)}`,
      `total;dur=${(completedAt - startedAt).toFixed(1)}`
    ].join(', '));
    return json({
      authenticated: true,
      user: { id: established.user.id, email: established.user.email, role: 'admin' },
      persistent: established.session.persistent,
      bootstrap
    }, 200, headers);
  } catch {
    return serverError();
  }
}
