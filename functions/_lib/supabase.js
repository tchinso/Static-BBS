import { singleFlight } from './single-flight.js';
const userLookup = singleFlight();
const tokenRefresh = singleFlight();
const rejectedSessionCodes = new Set([
  'bad_jwt', 'invalid_credentials', 'refresh_token_already_used', 'refresh_token_not_found',
  'session_expired', 'session_not_found', 'user_banned', 'user_not_found'
]);

export class AuthServiceUnavailable extends Error {}
function requiredString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

export function supabaseConfig(env) {
  const url = requiredString(env.SUPABASE_URL).replace(/\/+$/, '');
  const serviceRoleKey = requiredString(env.SUPABASE_SERVICE_ROLE_KEY);
  const publishableKey = requiredString(env.SUPABASE_PUBLISHABLE_KEY);
  if (!url || !serviceRoleKey || !publishableKey) throw new Error('Server configuration is missing.');
  return { url, serviceRoleKey, publishableKey };
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

// Supabase Auth supports both modern refresh tokens and its legacy
// 12-character lowercase token format.
export function isSupabaseRefreshToken(value) {
  return typeof value === 'string' && (
    value.length >= 16 || /^[a-z0-9]{12}$/.test(value)
  );
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

export function authHeaders(env, extraHeaders = undefined) {
  const { publishableKey } = supabaseConfig(env);
  const headers = new Headers(extraHeaders);
  // A user JWT must be paired with the project's publishable key. Keep this
  // key in a Pages secret too, so the browser never receives Supabase config.
  headers.set('apikey', publishableKey);
  return headers;
}

export function userHeaders(env, accessToken, extraHeaders = undefined) {
  const headers = authHeaders(env, extraHeaders);
  headers.set('Authorization', `Bearer ${accessToken}`);
  return headers;
}

export async function supabaseJson(env, path, options = {}) {
  const headers = options.accessToken
    ? userHeaders(env, options.accessToken, options.headers)
    : options.auth
      ? authHeaders(env, options.headers)
      : serviceHeaders(env, options.headers);
  if (options.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const response = await fetch(makeUrl(env, path), {
    method: options.method || 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal
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
    : options.auth
      ? authHeaders(env, options.headers)
      : serviceHeaders(env, options.headers);
  return fetch(makeUrl(env, path), {
    method: options.method || 'GET',
    headers,
    body: options.body
  });
}

async function authSessionRequest(env, path, operation, options) {
  let result;
  try {
    result = await supabaseJson(env, path, { ...options, signal: AbortSignal.timeout(7000) });
  } catch {
    console.error('auth_service_unavailable', { operation });
    throw new AuthServiceUnavailable();
  }
  const { response, data } = result;
  const code = data?.error_code ?? data?.code;
  if (response.ok && data) return data;
  if (response.status >= 400 && response.status < 500 && rejectedSessionCodes.has(code)) return null;
  console.error('auth_service_unavailable', { operation, status: response.status });
  throw new AuthServiceUnavailable();
}

function authUser(data) {
  if (typeof data?.id !== 'string' || !data.id) return null;
  return { id: data.id, email: normalizeEmail(data.email) };
}

async function lookupAuthUser(env, accessToken) {
  if (typeof accessToken !== 'string' || accessToken.length < 16) return null;
  const data = await authSessionRequest(env, '/auth/v1/user', 'lookup', { accessToken });
  if (!data) return null;
  const user = authUser(data);
  if (!user) throw new AuthServiceUnavailable();
  return user;
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

async function refreshSession(env, refreshToken) {
  if (!isSupabaseRefreshToken(refreshToken)) return null;
  const data = await authSessionRequest(env, '/auth/v1/token?grant_type=refresh_token', 'refresh', {
    method: 'POST',
    auth: true,
    body: { refresh_token: refreshToken }
  });
  if (!data) return null;
  if (typeof data.access_token !== 'string' || data.access_token.length < 16 || !isSupabaseRefreshToken(data.refresh_token)) {
    throw new AuthServiceUnavailable();
  }
  return { ...data, user: authUser(data.user) };
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

export const getAuthUser = (env, token) => userLookup(`${env.SUPABASE_URL}:${token}`, () => lookupAuthUser(env, token));
export const refreshAuthSession = (env, token) => tokenRefresh(`${env.SUPABASE_URL}:${token}`, () => refreshSession(env, token));
