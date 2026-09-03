import { badRequest, crossSiteRequest, isSameOriginRequest, json, readJson, serverError } from '../../_lib/http.js';
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
  // Safe temporary-style observability: lengths identify malformed fragment
  // handling without ever emitting the one-time access or refresh tokens.
  console.error('auth_callback_received', {
    accessTokenLength: body.access_token.length,
    refreshTokenLength: body.refresh_token.length
  });
  try {
    const established = await establishSession(context.env, {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresIn: body.expires_in,
      persistent: body.persistent !== false
    });
    if (!established) return json({ error: '허용되지 않은 이메일이거나 로그인 링크가 만료되었습니다.' }, 403);
    return json({
      authenticated: true,
      user: { id: established.user.id, email: established.user.email, role: 'admin' },
      persistent: established.session.persistent
    }, 200, { 'Set-Cookie': established.cookie });
  } catch {
    return serverError();
  }
}
