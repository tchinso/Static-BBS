import { json, serverError } from '../../_lib/http.js';
import { clearSessionCookie, getAuthorizedSession } from '../../_lib/session.js';

export async function onRequestGet(context) {
  try {
    const auth = await getAuthorizedSession(context.request, context.env);
    if (!auth.ok) {
      return json({ authenticated: false }, 200, { 'Set-Cookie': auth.clearCookie || clearSessionCookie() });
    }
    return json({
      authenticated: true,
      user: { id: auth.user.id, email: auth.user.email, role: 'admin' },
      persistent: auth.session.persistent
    }, 200, auth.setCookie ? { 'Set-Cookie': auth.setCookie } : undefined);
  } catch {
    return serverError();
  }
}
