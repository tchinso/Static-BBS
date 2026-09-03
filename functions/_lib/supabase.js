function requiredString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

export function supabaseConfig(env) {
  const url = requiredString(env.SUPABASE_URL).replace(/\/+$/, '');
  const serviceRoleKey = requiredString(env.SUPABASE_SERVICE_ROLE_KEY);
  if (!url || !serviceRoleKey) throw new Error('Server configuration is missing.');
  return { url, serviceRoleKey };
}

export function normalizeEmail(value) {
  if (typeof value !== 'string') return '';
  const email = value.normalize('NFKC').trim().toLowerCase();
  // This deliberately does not apply provider-specific transformations (for
  // example, Gmail dot removal). The server allowlist is an exact email list.
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return '';
  return email;
}

export function allowedEmails(env) {
  const source = requiredString(env.ALLOWED_EMAILS);
  if (!source) throw new Error('Server configuration is missing.');
  return new Set(source.split(/[\s,;]+/).map(normalizeEmail).filter(Boolean));
}

export function isAllowedEmail(env, email) {
  return allowedEmails(env).has(normalizeEmail(email));
}

function makeUrl(env, path) {
  return new URL(path, `${supabaseConfig(env).url}/`).toString();
}

export function serviceHeaders(env, extraHeaders = undefined) {
  const { serviceRoleKey } = supabaseConfig(env);
  const headers = new Headers(extraHeaders);
  headers.set('apikey', serviceRoleKey);
  // `sb_secret_…` keys are opaque API keys, not JWTs.  Supabase requires them
  // in `apikey`; putting one in Authorization would be rejected as an invalid
  // bearer token. User requests add their real JWT in userHeaders below.
  return headers;
}

export function userHeaders(env, accessToken, extraHeaders = undefined) {
  const headers = serviceHeaders(env, extraHeaders);
  headers.set('Authorization', `Bearer ${accessToken}`);
  return headers;
}

export async function supabaseJson(env, path, options = {}) {
  const headers = options.accessToken
    ? userHeaders(env, options.accessToken, options.headers)
    : serviceHeaders(env, options.headers);
  if (options.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const response = await fetch(makeUrl(env, path), {
    method: options.method || 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  let data = null;
  const text = await response.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  return { response, data };
}

export async function supabaseRaw(env, path, options = {}) {
  const headers = options.accessToken
    ? userHeaders(env, options.accessToken, options.headers)
    : serviceHeaders(env, options.headers);
  return fetch(makeUrl(env, path), {
    method: options.method || 'GET',
    headers,
    body: options.body
  });
}

export async function getAuthUser(env, accessToken) {
  if (typeof accessToken !== 'string' || accessToken.length < 16) return null;
  try {
    const { response, data } = await supabaseJson(env, '/auth/v1/user', { accessToken });
    if (!response.ok || !data || typeof data.id !== 'string') return null;
    const email = normalizeEmail(data.email);
    if (!email) return null;
    return { id: data.id, email };
  } catch {
    return null;
  }
}

export async function requestMagicLink(env, email) {
  // GoTrue reads redirect_to from the query string (the same shape used by
  // supabase-js), not from the JSON request body.
  return supabaseJson(env, `/auth/v1/otp?${new URLSearchParams({ redirect_to: 'https://nkmm.pages.dev/' }).toString()}`, {
    method: 'POST',
    body: {
      email,
      create_user: true
    }
  });
}

export async function refreshAuthSession(env, refreshToken) {
  if (typeof refreshToken !== 'string' || refreshToken.length < 16) return null;
  try {
    const { response, data } = await supabaseJson(env, '/auth/v1/token?grant_type=refresh_token', {
      method: 'POST',
      body: { refresh_token: refreshToken }
    });
    if (!response.ok || !data || typeof data.access_token !== 'string' || typeof data.refresh_token !== 'string') {
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

export async function revokeAuthSession(env, accessToken) {
  if (typeof accessToken !== 'string' || accessToken.length < 16) return;
  try {
    await supabaseJson(env, '/auth/v1/logout', {
      method: 'POST',
      accessToken
    });
  } catch {
    // Clearing the local cookie is still the important part of logout.
  }
}
