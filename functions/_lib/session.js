import { getAuthUser, isAllowedEmail, isSupabaseRefreshToken, refreshAuthSession } from './supabase.js';

export const SESSION_COOKIE = '__Host-nkmm_session';
export const PERSISTENT_SESSION_SECONDS = 60 * 60 * 24 * 400;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function base64UrlEncode(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x4000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x4000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecode(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

function sessionSecret(env) {
  const secret = typeof env.SESSION_SECRET === 'string' ? env.SESSION_SECRET.trim() : '';
  if (secret.length < 16) throw new Error('Server configuration is missing.');
  return secret;
}

async function cryptographicKeys(env) {
  const material = await crypto.subtle.digest('SHA-256', encoder.encode(sessionSecret(env)));
  return Promise.all([
    crypto.subtle.importKey('raw', material, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']),
    crypto.subtle.importKey('raw', material, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  ]);
}

async function signature(value, hmacKey) {
  return base64UrlEncode(new Uint8Array(await crypto.subtle.sign('HMAC', hmacKey, encoder.encode(value))));
}

function constantTimeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

function validStoredSession(value) {
  return Boolean(
    value &&
    value.version === 1 &&
    typeof value.accessToken === 'string' && value.accessToken.length >= 16 &&
    isSupabaseRefreshToken(value.refreshToken) &&
    typeof value.expiresAt === 'number' && Number.isFinite(value.expiresAt) &&
    typeof value.persistent === 'boolean'
  );
}

async function sealSession(env, session) {
  const text = JSON.stringify(session);
  if (text.length > 7000) throw new Error('Session is too large.');
  const [aesKey, hmacKey] = await cryptographicKeys(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, encoder.encode(text));
  const signedPart = `v1.${base64UrlEncode(iv)}.${base64UrlEncode(new Uint8Array(encrypted))}`;
  return `${signedPart}.${await signature(signedPart, hmacKey)}`;
}

async function openSession(env, value) {
  if (typeof value !== 'string' || value.length > 12000) return null;
  const parts = value.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;
  const [aesKey, hmacKey] = await cryptographicKeys(env);
  const signedPart = parts.slice(0, 3).join('.');
  const expected = await signature(signedPart, hmacKey);
  if (!constantTimeEqual(parts[3], expected)) return null;
  const iv = base64UrlDecode(parts[1]);
  const encrypted = base64UrlDecode(parts[2]);
  if (!iv || iv.length !== 12 || !encrypted) return null;
  try {
    const clear = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, encrypted);
    const value = JSON.parse(decoder.decode(clear));
    return validStoredSession(value) ? value : null;
  } catch {
    return null;
  }
}

function readCookie(request, name) {
  const source = request.headers.get('Cookie') || '';
  for (const part of source.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return '';
}

export function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

export async function sessionCookie(env, session) {
  const value = await sealSession(env, session);
  const attributes = [`${SESSION_COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax'];
  if (session.persistent) {
    attributes.push(`Max-Age=${PERSISTENT_SESSION_SECONDS}`);
    attributes.push(`Expires=${new Date(Date.now() + PERSISTENT_SESSION_SECONDS * 1000).toUTCString()}`);
  }
  return attributes.join('; ');
}

function safeExpiresAt(accessToken, expiresIn) {
  // Supabase has verified the token. Use its absolute expiry even if an older
  // magic link still reports the original lifetime in expires_in.
  try {
    const payload = accessToken.split('.')[1];
    const bytes = base64UrlDecode(payload);
    const decoded = bytes ? JSON.parse(decoder.decode(bytes)) : null;
    if (Number.isFinite(decoded?.exp)) return decoded.exp * 1000;
  } catch { /* Fall back to the supplied lifetime. */ }
  const parsed = Number(expiresIn);
  if (Number.isFinite(parsed) && parsed >= 30 && parsed <= 60 * 60 * 24 * 31) return Date.now() + parsed * 1000;
  return Date.now() + 30 * 60 * 1000;
}

export async function establishSession(env, values) {
  const accessToken = typeof values?.accessToken === 'string' ? values.accessToken : '';
  const refreshToken = typeof values?.refreshToken === 'string' ? values.refreshToken : '';
  if (accessToken.length < 16 || !isSupabaseRefreshToken(refreshToken)) return null;
  const user = await getAuthUser(env, accessToken);
  if (!user || !isAllowedEmail(env, user.email)) return null;
  const persistent = values?.persistent !== false;
  const session = {
    version: 1,
    accessToken,
    refreshToken,
    expiresAt: safeExpiresAt(accessToken, values?.expiresIn),
    persistent
  };
  return { session, user, cookie: await sessionCookie(env, session) };
}

// Every API request verifies the session with Supabase and the current allowlist.
export async function getAuthorizedSession(request, env, { onFreshSession } = {}) {
  let session = await openSession(env, readCookie(request, SESSION_COOKIE));
  if (!session) return { ok: false };

  let user;
  let setCookie = null;
  if (session.expiresAt > Date.now() + 60_000) {
    onFreshSession?.();
    user = await getAuthUser(env, session.accessToken);
  }
  if (!user) {
    const refreshed = await refreshAuthSession(env, session.refreshToken);
    if (!refreshed) return { ok: false };
    session = {
      ...session,
      accessToken: refreshed.access_token,
      refreshToken: refreshed.refresh_token,
      expiresAt: safeExpiresAt(refreshed.access_token, refreshed.expires_in)
    };
    user = refreshed.user || await getAuthUser(env, session.accessToken);
    if (!user || !isAllowedEmail(env, user.email)) return { ok: false };
    setCookie = await sessionCookie(env, session);
  } else if (!isAllowedEmail(env, user.email)) {
    return { ok: false };
  }
  // An older request can finish after a successful sign-in in another tab.
  // Only explicit logout should send a deletion cookie.
  return { ok: true, session, user, setCookie };
}
