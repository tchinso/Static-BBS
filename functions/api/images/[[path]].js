import { apiError, serverError, unauthorized } from '../../_lib/http.js';
import { validImagePath } from '../../_lib/board.js';
import { getAuthorizedSession } from '../../_lib/session.js';
import { supabaseRaw } from '../../_lib/supabase.js';

function routePath(context) {
  const value = context.params?.path;
  if (Array.isArray(value)) return value.join('/');
  if (typeof value === 'string') return value;
  const pathname = new URL(context.request.url).pathname;
  return pathname.startsWith('/api/images/') ? pathname.slice('/api/images/'.length) : '';
}

function objectPath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

export async function onRequestGet(context) {
  let auth;
  try {
    auth = await getAuthorizedSession(context.request, context.env);
  } catch {
    return serverError();
  }
  if (!auth.ok) return unauthorized({ 'Set-Cookie': auth.clearCookie });
  const path = validImagePath(routePath(context), context.env);
  if (!path) return apiError(404, '이미지를 찾을 수 없습니다.');

  try {
    const upstream = await supabaseRaw(context.env, `/storage/v1/object/community-images/${objectPath(path)}`);
    if (!upstream.ok) return apiError(404, '이미지를 찾을 수 없습니다.');
    const headers = new Headers();
    headers.set('Content-Type', upstream.headers.get('content-type') || 'application/octet-stream');
    headers.set('Cache-Control', 'private, no-store');
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Content-Disposition', 'inline');
    if (auth.setCookie) headers.set('Set-Cookie', auth.setCookie);
    return new Response(upstream.body, { status: 200, headers });
  } catch {
    return serverError();
  }
}
