import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { SESSION_COOKIE, sessionCookie } from '../functions/_lib/session.js';
import { onRequest as keepRotatedSession } from '../functions/api/_middleware.js';
import { onRequestPost as completeMagicLink } from '../functions/api/auth/callback.js';
import { onRequestGet as bootstrap } from '../functions/api/bootstrap.js';
import { onRequestGet as checkSession } from '../functions/api/auth/session.js';
import { onRequestPatch as updateProfile } from '../functions/api/profile.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const user = { id: '11111111-1111-4111-8111-111111111111', email: 'test@example.test' };
const profile = { id: user.id, display_name: '테스트', role: 'admin' };
const env = {
  SUPABASE_URL: 'https://database.example.test',
  SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_test',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
  SESSION_SECRET: 'test-only-session-secret-with-32-characters',
  ALLOWED_EMAILS: user.email
};
const rotatedTokens = {
  access_token: 'test-rotated-access-token',
  refresh_token: 'test-rotated-refresh-token',
  expires_in: 3600
};

async function loginCookie(expiresAt = Date.now() + 3_600_000) {
  const cookie = await sessionCookie(env, {
    version: 1,
    accessToken: 'test-access-token-valid-length',
    refreshToken: 'test-refresh-token-valid-length',
    expiresAt,
    persistent: true
  });
  return cookie.split(';')[0];
}

function context(path = '/api/bootstrap', cookie) {
  const headers = cookie ? { Cookie: cookie } : undefined;
  const jobs = [];
  return {
    env,
    request: new Request(`https://board.example.test${path}`, { headers }),
    waitUntil: (job) => jobs.push(job),
    jobs
  };
}

function mockSupabase({
  lookup = () => Response.json(user),
  refresh = () => Response.json({ ...rotatedTokens, user }),
  read = (path) => Response.json(path === '/rest/v1/community_profiles' ? [profile] : [])
} = {}) {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    const path = new URL(url).pathname;
    calls.push({ path, method: options.method });
    if (path === '/auth/v1/user') return lookup();
    if (path === '/auth/v1/token') return refresh();
    return read(path, options);
  };
  return calls;
}

test('passive requests without a usable cookie do not clear a session in another tab', async () => {
  const calls = mockSupabase();
  for (const cookie of [undefined, `${SESSION_COOKIE}=invalid`]) {
    const board = await bootstrap(context('/api/bootstrap', cookie));
    assert.equal(board.status, 401);
    assert.equal(board.headers.get('Set-Cookie'), null);
    const session = await checkSession(context('/api/auth/session', cookie));
    assert.equal(session.status, 200);
    assert.equal(session.headers.get('Set-Cookie'), null);
    assert.deepEqual(await session.json(), { authenticated: false });
  }
  assert.deepEqual(calls, []);
});

test('startup prefetches board reads during verification without releasing them to a rejected user', async () => {
  const lookup = Promise.withResolvers();
  const boardReadStarted = Promise.withResolvers();
  const calls = mockSupabase({
    lookup: () => lookup.promise,
    read(path) {
      if (path === '/rest/v1/community_posts') boardReadStarted.resolve();
      return Response.json(path === '/rest/v1/community_posts' ? [{ title: 'private' }] : []);
    }
  });
  const ctx = context('/api/bootstrap', await loginCookie());
  const pending = bootstrap(ctx);
  let timer;
  try {
    await Promise.race([
      boardReadStarted.promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Board reads waited for authentication')), 1000);
      })
    ]);
  } finally {
    clearTimeout(timer);
    lookup.resolve(Response.json({ ...user, email: 'removed@example.test' }));
  }
  const response = await pending;
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('Set-Cookie'), null);
  assert.doesNotMatch(await response.text(), /private/);
  assert.equal(calls.some(({ method }) => method !== 'GET'), false);
  assert.deepEqual(ctx.jobs, []);
});

test('transport, rate limit, and upstream failures preserve both fresh and expired cookies', async () => {
  const failures = [
    () => { throw new TypeError('network error'); },
    () => Response.json({ code: 'over_request_rate_limit' }, { status: 429 }),
    () => Response.json({ code: 'unexpected_failure' }, { status: 502 }),
    () => new Response('<html>Unexpected response</html>')
  ];
  const fresh = await loginCookie();
  const expired = await loginCookie(Date.now() - 1000);
  for (const failure of failures) {
    for (const [cookie, options] of [[fresh, { lookup: failure }], [expired, { refresh: failure }]]) {
      mockSupabase(options);
      const response = await bootstrap(context('/api/bootstrap', cookie));
      assert.equal(response.status, 503);
      assert.equal(response.headers.get('Set-Cookie'), null);
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
    }
  }
});

test('a definitively expired refresh session returns unauthorized without a cookie deletion', async () => {
  const calls = mockSupabase({ refresh: () => Response.json({ code: 'refresh_token_not_found' }, { status: 400 }) });
  const response = await bootstrap(context('/api/bootstrap', await loginCookie(Date.now() - 1000)));
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('Set-Cookie'), null);
  assert.deepEqual(calls, [{ path: '/auth/v1/token', method: 'POST' }]);
});

test('refresh reuses the verified response user and keeps the replacement cookie if a board read fails', async () => {
  const calls = mockSupabase({
    read(path) {
      if (path === '/rest/v1/community_posts') return Response.json({ code: 'unavailable' }, { status: 500 });
      return Response.json(path === '/rest/v1/community_profiles' ? [profile] : []);
    }
  });
  const response = await bootstrap(context('/api/bootstrap', await loginCookie(Date.now() - 1000)));
  assert.ok(response.status >= 500);
  const replacement = response.headers.get('Set-Cookie');
  assert.match(replacement, new RegExp(`^${SESSION_COOKIE}=v1\\.`));
  assert.match(replacement, /Max-Age=/);
  assert.equal(calls.some(({ path }) => path === '/auth/v1/user'), false);

  const retryCalls = mockSupabase();
  const ctx = context('/api/bootstrap', replacement.split(';')[0]);
  const retry = await bootstrap(ctx);
  assert.equal(retry.status, 200);
  assert.deepEqual((await retry.json()).user, { ...user, role: 'admin' });
  assert.equal(retryCalls.some(({ path }) => path === '/auth/v1/token'), false);
  await Promise.all(ctx.jobs);
});

test('refresh looks up the user when an otherwise valid token response omits the identity', async () => {
  const calls = mockSupabase({ refresh: () => Response.json(rotatedTokens) });
  const ctx = context('/api/bootstrap', await loginCookie(Date.now() - 1000));
  const response = await bootstrap(ctx);
  assert.equal(response.status, 200);
  assert.ok(response.headers.has('Set-Cookie'));
  assert.deepEqual(calls.filter(({ path }) => path.startsWith('/auth/')), [
    { path: '/auth/v1/token', method: 'POST' },
    { path: '/auth/v1/user', method: 'GET' }
  ]);
  await Promise.all(ctx.jobs);
});

test('a protected API validation error still sends a session rotation performed by its authorization', async () => {
  const calls = mockSupabase();
  const ctx = context();
  ctx.data = {};
  ctx.request = new Request('https://board.example.test/api/profile', {
    method: 'PATCH',
    headers: { Cookie: await loginCookie(Date.now() - 1000), 'Content-Type': 'application/json' },
    body: JSON.stringify({ display_name: '' })
  });
  ctx.next = () => updateProfile(ctx);
  const response = await keepRotatedSession(ctx);
  assert.equal(response.status, 400);
  assert.match(response.headers.get('Set-Cookie'), new RegExp(`^${SESSION_COOKIE}=v1\\.`));
  assert.deepEqual(calls, [{ path: '/auth/v1/token', method: 'POST' }]);
});

test('a magic-link callback distinguishes a temporarily unavailable auth service from a rejected link', async () => {
  const callback = () => completeMagicLink({
    env,
    request: new Request('https://board.example.test/api/auth/callback', {
      method: 'POST',
      headers: { Origin: 'https://board.example.test', 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...rotatedTokens, persistent: false })
    })
  });
  mockSupabase({ lookup: () => Response.json({ code: 'unexpected_failure' }, { status: 503 }) });
  const unavailable = await callback();
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.headers.get('Set-Cookie'), null);

  mockSupabase({ lookup: () => Response.json({ code: 'bad_jwt' }, { status: 401 }) });
  const rejected = await callback();
  assert.equal(rejected.status, 403);
  assert.equal(rejected.headers.get('Set-Cookie'), null);
});
