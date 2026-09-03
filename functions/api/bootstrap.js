import { json, serverError, unauthorized } from '../_lib/http.js';
import { ensureAdminProfile, listPosts, memberCount } from '../_lib/board.js';
import { getAuthorizedSession } from '../_lib/session.js';

export async function onRequestGet(context) {
  let auth;
  try {
    auth = await getAuthorizedSession(context.request, context.env);
  } catch {
    return serverError();
  }
  if (!auth.ok) return unauthorized({ 'Set-Cookie': auth.clearCookie });

  try {
    const profile = await ensureAdminProfile(context.env, auth.user);
    const [posts, count] = await Promise.all([listPosts(context.env), memberCount(context.env)]);
    return json({
      user: { id: auth.user.id, email: auth.user.email, role: 'admin' },
      profile,
      posts,
      memberCount: count
    }, 200, auth.setCookie ? { 'Set-Cookie': auth.setCookie } : undefined);
  } catch {
    return serverError();
  }
}
