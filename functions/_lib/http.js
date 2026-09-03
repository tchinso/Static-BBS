const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

export function json(body, status = 200, extraHeaders = undefined) {
  const headers = new Headers(extraHeaders);
  headers.set('Content-Type', JSON_CONTENT_TYPE);
  headers.set('Cache-Control', 'no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  return new Response(JSON.stringify(body), { status, headers });
}

export function apiError(status, message) {
  return json({ error: message }, status);
}

export function unauthorized(extraHeaders = undefined) {
  return json({ error: '로그인이 필요하거나 로그인 상태가 만료되었습니다.' }, 401, extraHeaders);
}

export function forbidden() {
  return apiError(403, '접근 권한이 없습니다.');
}

export function badRequest(message = '요청 내용을 확인해주세요.') {
  return apiError(400, message);
}

export function serverError() {
  return apiError(500, '서버에서 요청을 처리하지 못했습니다. 잠시 후 다시 시도해주세요.');
}

export function methodNotAllowed() {
  return apiError(405, '허용되지 않은 요청 방식입니다.');
}

export async function readJson(request) {
  const contentType = request.headers.get('content-type') || '';
  if (!contentType.toLowerCase().includes('application/json')) return null;
  try {
    return await request.json();
  } catch {
    return null;
  }
}

// SameSite=Lax cookies already protect ordinary cross-site POSTs. Checking Origin as
// well makes forged state-changing fetches fail when browsers send that header.
export function isSameOriginRequest(request) {
  const origin = request.headers.get('origin');
  if (!origin) return true;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

export function crossSiteRequest() {
  return apiError(403, '허용되지 않은 요청 출처입니다.');
}

export function noContent(extraHeaders = undefined) {
  const headers = new Headers(extraHeaders);
  headers.set('Cache-Control', 'no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  return new Response(null, { status: 204, headers });
}
