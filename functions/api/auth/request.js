import { badRequest, crossSiteRequest, isSameOriginRequest, json, readJson, serverError } from '../../_lib/http.js';
import { isAllowedEmail, normalizeEmail, requestMagicLink } from '../../_lib/supabase.js';

export async function onRequestPost(context) {
  if (!isSameOriginRequest(context.request)) return crossSiteRequest();
  const body = await readJson(context.request);
  const email = normalizeEmail(body?.email);
  if (!email) return badRequest('이메일 주소를 확인해주세요.');

  try {
    // Return the same acknowledgement for an unapproved address.  The request
    // is rejected without contacting Supabase, but a caller cannot use this
    // endpoint (or DevTools) as an allowlist-membership oracle.
    if (!isAllowedEmail(context.env, email)) {
      return json({ magicLinkSent: true, persistent: body?.persistent !== false }, 202);
    }
    const result = await requestMagicLink(context.env, email);
    if (!result.response.ok) {
      // Keep the public response generic, while making the upstream class of
      // failure observable in the private Cloudflare Functions log.  Never
      // include the submitted email, token, or raw response body here.
      const upstreamCode = typeof result.data?.code === 'string'
        ? result.data.code
        : typeof result.data?.error_code === 'string'
          ? result.data.error_code
          : 'unknown';
      console.error('magic_link_upstream_rejected', {
        status: result.response.status,
        code: upstreamCode
      });
      const status = result.response.status === 429 ? 429 : 502;
      return json({ error: status === 429 ? '잠시 후 다시 시도해주세요.' : '로그인 링크를 보내지 못했습니다. 잠시 후 다시 시도해주세요.' }, status);
    }
    // Match the unapproved-address acknowledgement exactly.  Otherwise a
    // caller could discover the private allowlist by comparing 200 and 202.
    return json({ magicLinkSent: true, persistent: body?.persistent !== false }, 202);
  } catch {
    return serverError();
  }
}
