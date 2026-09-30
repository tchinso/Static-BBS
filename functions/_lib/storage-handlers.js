import { authorize, sessionHeaders } from './authorize.js';
import { apiError, badRequest, json, readJson, serverError } from './http.js';
import { rpc, firstRow } from './database.js';
import { supabaseRaw } from './supabase.js';
import { IMAGE_BUCKET, FILE_BUCKET, mediaUrl, safeFileName } from './media.js';
import { reserveUpload, abandonUploads, scheduleStorageCleanup } from './storage-cleanup.js';
import { IMAGE_TYPES, MAX_UPLOAD_BYTES, UPLOAD_GRACE_MS } from '../../shared/limits.js';
import { objectKey, encodeObjectKey } from '../../shared/validation.js';

async function boundedUploadForm(request) {
  let bytes = 0;
  const bounded = request.body?.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      bytes += chunk.byteLength;
      if (bytes > MAX_UPLOAD_BYTES + 64 * 1024) throw new Error('upload_too_large');
      controller.enqueue(chunk);
    }
  }));
  return new Response(bounded, { headers: request.headers }).formData();
}

export function storageHandlers(kind) {
  const images = kind === 'images';
  const bucket = images ? IMAGE_BUCKET : FILE_BUCKET;

  async function upload(context) {
    const { auth, response } = await authorize(context, { mutation: true });
    if (response) return response;
    const length = Number(context.request.headers.get('content-length'));
    if (length > MAX_UPLOAD_BYTES + 64 * 1024) return apiError(413, '파일은 25MB 이하로 올려주세요.');
    let form;
    try { form = await boundedUploadForm(context.request); }
    catch (error) { return error.message === 'upload_too_large' ? apiError(413, '파일은 25MB 이하로 올려주세요.') : badRequest('파일을 확인해주세요.'); }
    const file = form.get('file');
    if (!file || typeof file.arrayBuffer !== 'function' || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > MAX_UPLOAD_BYTES
      || (images && !IMAGE_TYPES.includes(file.type))) return badRequest(images ? 'JPEG, PNG, WebP, GIF 이미지만 25MB 이하로 올려주세요.' : '빈 파일을 제외한 25MB 이하 파일을 올려주세요.');
    const name = Array.from(String(file.name || 'file').normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, '')).slice(0, 255).join('') || 'file';
    const path = `${auth.user.id}/${crypto.randomUUID()}-${safeFileName(name)}`;
    try {
      // Reserve BEFORE sending bytes; crashes cannot leave untracked uploads.
      const reserved = await reserveUpload(context.env, bucket, path, { name, size: file.size, owner: auth.user.id });
      if (!reserved.response.ok) throw new Error('Upload reservation failed.');
      const upstream = await supabaseRaw(context.env, `/storage/v1/object/${bucket}/${encodeObjectKey(path)}`, {
        method: 'POST', headers: { 'Content-Type': images ? file.type : 'application/octet-stream', 'Cache-Control': '31536000', 'x-upsert': 'false' }, body: file
      });
      await upstream.body?.cancel();
      if (!upstream.ok) {
        await abandonUploads(context.env, bucket, [path], auth.user.id);
        scheduleStorageCleanup(context);
        return apiError(502, '파일을 업로드하지 못했습니다. 잠시 후 다시 시도해주세요.');
      }
      const result = { path, name, size: file.size, url: mediaUrl(path, kind), expiresAt: Date.now() + UPLOAD_GRACE_MS };
      return json(images ? result : { attachment: result }, 201, sessionHeaders(auth));
    } catch {
      scheduleStorageCleanup(context);
      return serverError();
    }
  }

  async function discard(context) {
    const { auth, response } = await authorize(context, { mutation: true });
    if (response) return response;
    const body = await readJson(context.request);
    if (!Array.isArray(body?.paths) || body.paths.length > 18 || body.paths.some((path) => !objectKey(path))) return badRequest();
    try {
      const abandoned = await abandonUploads(context.env, bucket, body.paths, auth.user.id);
      if (!abandoned.response.ok) return serverError();
      scheduleStorageCleanup(context);
      return json({ discarded: true }, 200, sessionHeaders(auth));
    } catch { return serverError(); }
  }

  async function download(context) {
    const { auth, response } = await authorize(context);
    if (response) return response;
    const route = context.params?.path;
    let raw = Array.isArray(route) ? route.join('/') : typeof route === 'string' ? route : '';
    try { raw = decodeURIComponent(raw); } catch { return apiError(404, '파일을 찾을 수 없습니다.'); }
    const path = objectKey(raw);
    if (!path) return apiError(404, '파일을 찾을 수 없습니다.');
    try {
      // Authenticate and confirm a live reference BEFORE consulting the edge
      // cache. Deleted objects remain inaccessible even at a different edge.
      const metadata = await rpc(context.env, 'community_media_metadata', { bucket_value: bucket, path_value: path });
      if (!metadata.response.ok) return serverError();
      const object = firstRow(metadata.data);
      if (!object) return apiError(404, '파일을 찾을 수 없습니다.');
      const cacheUrl = new URL(context.request.url);
      cacheUrl.pathname = `/api/${kind}/${encodeObjectKey(path)}`;
      cacheUrl.search = `?__object=${object.object_id}`;
      const range = context.request.headers.get('range');
      const cacheRequest = new Request(cacheUrl, { headers: range ? { Range: range } : {} });
      const cache = globalThis.caches?.default;
      let upstream;
      if (cache) { try { upstream = await cache.match(cacheRequest); } catch { /* Optional cache. */ } }
      if (!upstream) {
        upstream = await supabaseRaw(context.env, `/storage/v1/object/${bucket}/${encodeObjectKey(path)}`, { method: context.request.method === 'HEAD' ? 'HEAD' : 'GET', headers: range ? { Range: range } : {} });
        if (!upstream.ok) { await upstream.body?.cancel(); return apiError(404, '파일을 찾을 수 없습니다.'); }
        if (cache && upstream.status === 200 && !range && context.request.method !== 'HEAD') {
          const cachedHeaders = new Headers(upstream.headers);
          cachedHeaders.delete('Set-Cookie');
          cachedHeaders.set('Cache-Control', 'public, max-age=86400');
          const cached = new Response(upstream.clone().body, { status: 200, headers: cachedHeaders });
          const storing = cache.put(cacheRequest, cached).catch(() => undefined);
          if (typeof context.waitUntil === 'function') context.waitUntil(storing);
        }
      }
      const headers = new Headers(sessionHeaders(auth));
      for (const name of ['Content-Length','Content-Range','Content-Encoding','Accept-Ranges','ETag','Last-Modified']) {
        if (upstream.headers.has(name)) headers.set(name, upstream.headers.get(name));
      }
      headers.set('Cache-Control', 'private, no-store');
      headers.set('X-Content-Type-Options', 'nosniff');
      headers.set('Referrer-Policy', 'no-referrer');
      const type = IMAGE_TYPES.includes(object.mime_type) ? object.mime_type : 'application/octet-stream';
      headers.set('Content-Type', images ? type : 'application/octet-stream');
      headers.set('Content-Disposition', images ? 'inline' : `attachment; filename*=UTF-8''${encodeURIComponent(object.file_name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16)}`)}`);
      if (!images) headers.set('Content-Security-Policy', "sandbox; default-src 'none'");
      if (context.request.method === 'HEAD') await upstream.body?.cancel();
      return new Response(context.request.method === 'HEAD' ? null : upstream.body, { status: upstream.status, headers });
    } catch { return serverError(); }
  }
  return { upload, discard, download };
}
