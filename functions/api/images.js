import { badRequest, crossSiteRequest, isSameOriginRequest, json, serverError, unauthorized } from '../_lib/http.js';
import { imageProxyUrl } from '../_lib/board.js';
import { getAuthorizedSession } from '../_lib/session.js';
import { supabaseRaw } from '../_lib/supabase.js';

const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

function safeFileName(value) {
  const normalized = String(value || 'image').normalize('NFKC').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  return (normalized || 'image').slice(0, 120);
}

function objectPath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

export async function onRequestPost(context) {
  if (!isSameOriginRequest(context.request)) return crossSiteRequest();
  let auth;
  try {
    auth = await getAuthorizedSession(context.request, context.env);
  } catch {
    return serverError();
  }
  if (!auth.ok) return unauthorized({ 'Set-Cookie': auth.clearCookie });

  let form;
  try {
    form = await context.request.formData();
  } catch {
    return badRequest('이미지 파일을 확인해주세요.');
  }
  const file = form.get('file');
  if (!file || typeof file.arrayBuffer !== 'function' || !ALLOWED_IMAGE_TYPES.has(file.type) || file.size > MAX_IMAGE_BYTES) {
    return badRequest('JPEG, PNG, WebP, GIF 이미지만 25MB 이하로 업로드할 수 있습니다.');
  }

  const path = `${auth.user.id}/${crypto.randomUUID()}-${safeFileName(file.name)}`;
  try {
    const upstream = await supabaseRaw(context.env, `/storage/v1/object/community-images/${objectPath(path)}`, {
      method: 'POST',
      headers: {
        'Content-Type': file.type,
        'Cache-Control': '31536000',
        'x-upsert': 'false'
      },
      body: file
    });
    if (!upstream.ok) return json({ error: '이미지를 업로드하지 못했습니다. 잠시 후 다시 시도해주세요.' }, 502);
    return json({ path, url: imageProxyUrl(path) }, 201, auth.setCookie ? { 'Set-Cookie': auth.setCookie } : undefined);
  } catch {
    return serverError();
  }
}
