import { authUnavailable, json, serverError } from '../../_lib/http.js';
import { getAuthorizedSession } from '../../_lib/session.js';
import { AuthServiceUnavailable } from '../../_lib/supabase.js';

export async function onRequestGet(context) {
  try {
    const auth = await getAuthorizedSession(context.request, context.env);
    if (!auth.ok) {
      return json({ authenticated: false });
    }
    return json({
      authenticated: true,
      user: { id: auth.user.id, email: auth.user.email, role: 'admin' },
      persistent: auth.session.persistent
    }, 200, auth.setCookie ? { 'Set-Cookie': auth.setCookie } : undefined);
  } catch (error) {
    return error instanceof AuthServiceUnavailable ? authUnavailable() : serverError();
  }
}
