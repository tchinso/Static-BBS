import { crossSiteRequest, isSameOriginRequest, json, serverError, unauthorized } from '../../_lib/http.js';
import { createPost, deleteImageObjects, deletePost, drainImageCleanupQueue, ensureAdminProfile, getPost } from '../../_lib/board.js';
import { getAuthorizedSession } from '../../_lib/session.js';
import { supabaseJson, supabaseRaw } from '../../_lib/supabase.js';

// Temporary, authenticated verification route. It is removed after this live
// check; the real deletion path remains the shared board helpers it exercises.
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIW2P4z8DwHwAFgAI/ScLkWAAAAABJRU5ErkJggg==';

function objectPath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

function tinyPng() {
  const binary = atob(TINY_PNG);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: 'image/png' });
}

function cleanupQuery(path) {
  return `/rest/v1/community_image_cleanup_queue?${new URLSearchParams({
    select: 'object_path',
    object_path: `eq.${path}`
  }).toString()}`;
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

  const path = `${auth.user.id}/${crypto.randomUUID()}-deletion-check.png`;
  let postId = '';
  let uploaded = false;
  try {
    const upload = await supabaseRaw(context.env, `/storage/v1/object/community-images/${objectPath(path)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/png', 'x-upsert': 'false' },
      body: tinyPng()
    });
    if (!upload.ok) throw new Error('Storage upload verification failed.');
    uploaded = true;

    const profile = await ensureAdminProfile(context.env, auth.user);
    const created = await createPost(context.env, {
      category: '현생',
      title: '삭제 검증용 임시 글',
      content: '자동 삭제 검증을 위한 임시 게시글입니다.',
      tags: [],
      image_urls: [path],
      author_id: auth.user.id,
      author_name: profile.display_name,
      is_notice: false,
      is_pinned: false
    });
    if (!created.ok || !created.data?.id) throw new Error('Post creation verification failed.');
    postId = created.data.id;

    const deleted = await deletePost(context.env, postId);
    if (!deleted.ok || !deleted.deleted) throw new Error('Post deletion verification failed.');
    postId = '';

    const cleanup = await drainImageCleanupQueue(context.env);
    if (!cleanup.ok) throw new Error('Storage cleanup verification failed.');

    const [post, object, queue] = await Promise.all([
      getPost(context.env, created.data.id),
      supabaseRaw(context.env, `/storage/v1/object/community-images/${objectPath(path)}`),
      supabaseJson(context.env, cleanupQuery(path))
    ]);
    if (post || object.status !== 404 || !queue.response.ok || !Array.isArray(queue.data) || queue.data.length !== 0) {
      throw new Error('Storage deletion verification did not reach the expected final state.');
    }

    return json({ verified: true }, 200, auth.setCookie ? { 'Set-Cookie': auth.setCookie } : undefined);
  } catch {
    // Never leave a verification artifact behind if one of the checks failed.
    try {
      if (postId) await deletePost(context.env, postId);
      await drainImageCleanupQueue(context.env);
      if (uploaded) await deleteImageObjects(context.env, [path]);
    } catch {
      // The request still reports a failure so an unexpected cleanup state is
      // never mistaken for a passed verification.
    }
    return serverError();
  }
}
