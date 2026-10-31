import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { sessionCookie } from '../functions/_lib/session.js';
import { onRequestGet, onRequestPost } from '../functions/api/calendar/index.js';
import { onRequestPatch, onRequestDelete } from '../functions/api/calendar/[id].js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
const id = '11111111-1111-4111-8111-111111111111';
const env = { SUPABASE_URL: 'https://database.example.test', SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_test', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test', SESSION_SECRET: 'test-only-session-secret-with-32-characters', ALLOWED_EMAILS: 'test@example.test' };
async function context(method, body, origin = 'https://board.example.test') {
  const cookie = await sessionCookie(env, { version: 1, accessToken: 'test-access-token-valid-length', refreshToken: 'test-refresh-token-valid-length', expiresAt: Date.now() + 3600000, persistent: false });
  return { env, params: { id }, request: new Request('https://board.example.test/api/calendar', { method, headers: { Cookie: cookie.split(';')[0], Origin: origin, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }) };
}
function mockFetch(rows = [{ id, event_date: '2026-11-04', content: '일정' }]) {
  const writes = [];
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).endsWith('/auth/v1/user')) return Response.json({ id, email: 'test@example.test' });
    writes.push({ url: String(url), ...options });
    return Response.json(rows);
  };
  return writes;
}

test('calendar requires login and blocks cross-origin writes before touching the DB', async () => {
  const calls = mockFetch();
  assert.equal((await onRequestGet({ env, request: new Request('https://board.example.test/api/calendar') })).status, 401);
  for (const [method, handler] of [['POST', onRequestPost], ['PATCH', onRequestPatch], ['DELETE', onRequestDelete]]) {
    assert.equal((await handler(await context(method, { event_date: '2026-11-04', content: '일정' }, 'https://evil.test'))).status, 403);
  }
  assert.equal(calls.length, 0);
});

test('calendar validates dates and contents and scopes edits/deletes to an id', async () => {
  const calls = mockFetch();
  assert.equal((await onRequestPost(await context('POST', { event_date: '2026-02-30', content: '일정' }))).status, 400);
  assert.equal((await onRequestPost(await context('POST', { event_date: '2026-11-04', content: ' ' }))).status, 400);
  assert.equal(calls.length, 0);
  const created = await onRequestPost(await context('POST', { event_date: '2026-11-04', content: ' 일정 ', ignored: 'discard' }));
  assert.equal(created.status, 201);
  assert.deepEqual(JSON.parse(calls[0].body), { event_date: '2026-11-04', content: '일정' });
  assert.equal((await onRequestPatch(await context('PATCH', { event_date: '2026-11-05', content: '수정' }))).status, 200);
  assert.equal(new URL(calls[1].url).searchParams.get('id'), `eq.${id}`);
  assert.equal((await onRequestDelete(await context('DELETE'))).status, 200);
  assert.equal(new URL(calls[2].url).searchParams.get('id'), `eq.${id}`);
  mockFetch([]);
  assert.equal((await onRequestDelete(await context('DELETE'))).status, 404);
});
