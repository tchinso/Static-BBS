import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { storageHandlers } from '../functions/_lib/storage-handlers.js';
import { sessionCookie } from '../functions/_lib/session.js';

const realFetch = globalThis.fetch;
const originalCaches = globalThis.caches;
afterEach(() => { globalThis.fetch = realFetch; globalThis.caches = originalCaches; });
const owner = '11111111-1111-4111-8111-111111111111';
const path = `${owner}/test.txt`;
const env = { SUPABASE_URL:'https://database.example.test', SUPABASE_SERVICE_ROLE_KEY:'sb_secret_test', SUPABASE_PUBLISHABLE_KEY:'sb_publishable_test', SESSION_SECRET:'test-only-session-secret-with-32-characters', ALLOWED_EMAILS:'test@example.test' };
const json = (value, status=200) => new Response(JSON.stringify(value), {status,headers:{'Content-Type':'application/json'}});
async function context(url, init={}) {
  const cookie = await sessionCookie(env, { version:1,accessToken:'test-access-token-valid-length',refreshToken:'test-refresh-token-valid-length',expiresAt:Date.now()+3600000,persistent:false });
  const headers = new Headers(init.headers);
  headers.set('Cookie',cookie.split(';')[0]); headers.set('Origin','https://board.example.test');
  const jobs = [];
  return { env,request:new Request(url,{...init,headers}),params:{path:path.split('/')},jobs,waitUntil:(job)=>jobs.push(job) };
}
function mockStorage({ live=true } = {}) {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({url:String(url),options});
    if (String(url).endsWith('/auth/v1/user')) return json({id:owner,email:'test@example.test'});
    if (String(url).includes('/rpc/community_media_metadata')) return json(live ? [{object_id:owner,size_bytes:4,mime_type:'text/plain',file_name:'한글.txt'}] : []);
    if (String(url).includes('/rpc/community_claim_storage_cleanup')) return json([]);
    if (String(url).includes('/rest/v1/rpc/')) return json(null);
    if (options.method === 'POST') return json({Key:path});
    return new Response('test',{headers:{'Content-Type':'text/plain','Content-Length':'4'}});
  };
  return calls;
}

test('anonymous media requests never read metadata, cache or object bytes', async () => {
  const calls = mockStorage();
  let cacheReads = 0;
  globalThis.caches = {default:{match:async()=>{cacheReads++;}}};
  const response = await storageHandlers('files').download({env,request:new Request(`https://board.example.test/api/files/${path}`),params:{path}});
  assert.equal(response.status,401); assert.equal(cacheReads,0); assert.equal(calls.length,0);
});

test('authorized downloads are streamed and force safe download headers', async () => {
  const calls = mockStorage();
  const response = await storageHandlers('files').download(await context(`https://board.example.test/api/files/${path}`));
  assert.equal(response.status,200);
  assert.equal(await response.text(),'test');
  assert.equal(response.headers.get('Cache-Control'),'private, no-store');
  assert.equal(response.headers.get('Content-Type'),'application/octet-stream');
  assert.match(response.headers.get('Content-Disposition'),/^attachment; filename\*=UTF-8''/);
  assert.equal(response.headers.get('X-Content-Type-Options'),'nosniff');
  assert.equal(calls.filter((call)=>call.url.includes('/storage/v1/object/')).length,1);
});

test('an edge hit avoids Storage egress; a removed reference cannot use stale cache', async () => {
  let cacheReads = 0;
  globalThis.caches = {default:{match:async()=>{cacheReads++; return new Response('cached');}}};
  const calls = mockStorage();
  const response = await storageHandlers('files').download(await context(`https://board.example.test/api/files/${path}`));
  assert.equal(await response.text(),'cached');
  assert.equal(calls.filter((call)=>call.url.includes('/storage/v1/object/')).length,0);
  mockStorage({live:false});
  const removed = await storageHandlers('files').download(await context(`https://board.example.test/api/files/${path}`));
  assert.equal(removed.status,404); assert.equal(cacheReads,1);
});

test('uploads reserve cleanup before sending bytes and return metadata only', async () => {
  const calls = mockStorage();
  const form = new FormData(); form.append('file',new File(['test'],'example.txt'));
  const ctx = await context('https://board.example.test/api/files',{method:'POST',body:form});
  const response = await storageHandlers('files').upload(ctx);
  assert.equal(response.status,201);
  const data = await response.json(); assert.equal(data.attachment.size,4);
  const reservation = calls.findIndex((call)=>call.url.includes('community_reserve_upload'));
  const upload = calls.findIndex((call)=>call.url.includes('/storage/v1/object/'));
  assert.ok(reservation>=0 && upload>reservation);
  await Promise.all(ctx.jobs);
});

test('oversized and cross-origin upload requests fail before Storage writes', async () => {
  const calls = mockStorage();
  const ctx = await context('https://board.example.test/api/files',{method:'POST',headers:{'Content-Length':String(27*1024*1024)}});
  assert.equal((await storageHandlers('files').upload(ctx)).status,413);
  const forged = {env,request:new Request('https://board.example.test/api/files',{method:'POST',headers:{Origin:'https://other.example.test'}})};
  assert.equal((await storageHandlers('files').upload(forged)).status,403);
  assert.equal(calls.filter((call)=>call.url.includes('/storage/v1/object/')).length,0);
});

test('chunked uploads without content-length are bounded before reservation', async () => {
  const calls = mockStorage();
  let sent = 0;
  const body = new ReadableStream({ pull(controller) {
    if (sent++ < 27) controller.enqueue(new Uint8Array(1024 * 1024));
    else controller.close();
  } });
  const ctx = await context('https://board.example.test/api/files', {
    method:'POST', body, duplex:'half', headers:{'Content-Type':'multipart/form-data; boundary=test'}
  });
  assert.equal((await storageHandlers('files').upload(ctx)).status,413);
  assert.equal(calls.filter((call)=>call.url.includes('community_reserve_upload')).length,0);
});
