import { crossSiteRequest, isSameOriginRequest, noContent } from '../../_lib/http.js';
import { clearSessionCookie, getAuthorizedSession } from '../../_lib/session.js';
import { revokeAuthSession } from '../../_lib/supabase.js';

export async function onRequestPost(context) {
  if (!isSameOriginRequest(context.request)) return crossSiteRequest();
  try {
    const auth = await getAuthorizedSession(context.request, context.env);
    if (auth.ok) await revokeAuthSession(context.env, auth.session.accessToken);
  } catch {
    // Logout must remain usable even if the server session has already expired.
  }
  return noContent({ 'Set-Cookie': clearSessionCookie() });
}
