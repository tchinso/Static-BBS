import { supabaseJson } from './supabase.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const BOARD_CATEGORIES = Object.freeze([
  '현생',
  '링크',
  '언어/검색어',
  '리소스/아이디어',
  '쥬우니/에카하나'
]);

function restQuery(table, query) {
  return `/rest/v1/${table}?${new URLSearchParams(query).toString()}`;
}

function firstRow(data) {
  return Array.isArray(data) ? data[0] || null : null;
}

export function isUuid(value) {
  return typeof value === 'string' && UUID.test(value);
}

export function cleanText(value, { min = 0, max, trim = true } = {}) {
  if (typeof value !== 'string') return null;
  const output = trim ? value.trim() : value;
  if (output.length < min || (max && output.length > max)) return null;
  return output;
}

export function cleanTags(value) {
  const source = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\s,]+/) : null;
  if (!source || source.length > 32) return null;
  const tags = [];
  for (const item of source) {
    const tag = cleanText(String(item).replace(/^#+/, ''), { min: 1, max: 24 });
    if (tag && !tags.includes(tag)) tags.push(tag);
  }
  return tags.length <= 8 ? tags : null;
}

function unproxyImagePath(value, env) {
  let raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '';
  if (raw.startsWith('/api/images/')) raw = raw.slice('/api/images/'.length);

  if (/^https?:\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      const prefix = '/storage/v1/object/';
      const start = url.pathname.indexOf(prefix);
      if (start < 0) return '';
      const objectPath = url.pathname.slice(start + prefix.length);
      const match = objectPath.match(/^(?:public|sign)\/community-images\/(.+)$/);
      if (!match) return '';
      raw = match[1];
    } catch {
      return '';
    }
  }
  try {
    raw = decodeURIComponent(raw);
  } catch {
    return '';
  }
  return raw.replace(/^\/+/, '');
}

export function validImagePath(value, env) {
  const path = unproxyImagePath(value, env);
  if (!path || path.length > 512 || path.includes('\\') || path.includes('\0')) return '';
  const parts = path.split('/');
  if (parts.length < 2 || parts.some((part) => !part || part === '.' || part === '..')) return '';
  // Uploaded objects are intentionally contained in a UUID-named user folder.
  if (!UUID.test(parts[0])) return '';
  return path;
}

export function cleanImagePaths(value, env) {
  if (!Array.isArray(value) || value.length > 10) return null;
  const paths = [];
  for (const item of value) {
    const path = validImagePath(item, env);
    if (!path) return null;
    if (!paths.includes(path)) paths.push(path);
  }
  return paths;
}

export function imageProxyUrl(path) {
  return `/api/images/${path.split('/').map(encodeURIComponent).join('/')}`;
}

export function presentPost(post, env) {
  const imagePaths = Array.isArray(post?.image_urls)
    ? post.image_urls.map((value) => validImagePath(value, env)).filter(Boolean)
    : [];
  return {
    ...post,
    image_urls: imagePaths,
    image_proxy_urls: imagePaths.map(imageProxyUrl)
  };
}

export async function ensureAdminProfile(env, user) {
  const lookup = await supabaseJson(env, restQuery('community_profiles', {
    select: 'id,display_name,role',
    id: `eq.${user.id}`
  }));
  if (!lookup.response.ok) throw new Error('Profile lookup failed.');
  let profile = firstRow(lookup.data);
  if (!profile) {
    const displayName = cleanText(user.email.split('@')[0], { min: 1, max: 20 }) || '회원';
    const created = await supabaseJson(env, '/rest/v1/community_profiles', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: { id: user.id, display_name: displayName, role: 'admin' }
    });
    if (!created.response.ok) throw new Error('Profile creation failed.');
    profile = firstRow(created.data);
  }
  if (!profile) throw new Error('Profile unavailable.');
  if (profile.role !== 'admin') {
    const promoted = await supabaseJson(env, restQuery('community_profiles', {
      id: `eq.${user.id}`
    }), {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: { role: 'admin' }
    });
    if (!promoted.response.ok) throw new Error('Profile update failed.');
    profile = firstRow(promoted.data) || { ...profile, role: 'admin' };
  }
  return { id: profile.id, display_name: profile.display_name, role: 'admin' };
}

export async function updateDisplayName(env, userId, displayName) {
  const result = await supabaseJson(env, restQuery('community_profiles', { id: `eq.${userId}` }), {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: { display_name: displayName, role: 'admin' }
  });
  if (!result.response.ok) return null;
  const profile = firstRow(result.data);
  // Author names are denormalized into posts for fast board reads. Keep prior
  // posts in sync when a user changes their public display name.
  const postResult = await supabaseJson(env, restQuery('community_posts', { author_id: `eq.${userId}` }), {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: { author_name: displayName, updated_at: new Date().toISOString() }
  });
  if (!postResult.response.ok) return null;
  return profile ? { id: profile.id, display_name: profile.display_name, role: 'admin' } : null;
}

export async function listPosts(env) {
  const result = await supabaseJson(env, restQuery('community_posts', {
    select: '*',
    order: 'is_pinned.desc,pin_slot.asc.nullslast,is_notice.desc,created_at.desc'
  }));
  if (!result.response.ok || !Array.isArray(result.data)) throw new Error('Post lookup failed.');
  return result.data.map((post) => presentPost(post, env));
}

export async function getPost(env, id) {
  const result = await supabaseJson(env, restQuery('community_posts', { select: '*', id: `eq.${id}` }));
  if (!result.response.ok) throw new Error('Post lookup failed.');
  const post = firstRow(result.data);
  return post ? presentPost(post, env) : null;
}

export async function memberCount(env) {
  const result = await supabaseJson(env, restQuery('community_profiles', { select: 'id' }), {
    method: 'HEAD',
    headers: { Prefer: 'count=exact' }
  });
  if (!result.response.ok) return null;
  const contentRange = result.response.headers.get('content-range') || '';
  const match = contentRange.match(/\/(\d+)$/);
  return match ? Number(match[1]) : null;
}

function writeBoolean(body, name, target) {
  if (!(name in body)) return true;
  if (typeof body[name] !== 'boolean') return false;
  target[name] = body[name];
  return true;
}

export function makePostFields(body, env, { creating = false, profile = null, user = null } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: '요청 내용을 확인해주세요.' };
  const fields = {};

  if (creating || 'category' in body) {
    const category = cleanText(body.category, { min: 1, max: 60 });
    if (!category || !BOARD_CATEGORIES.includes(category)) return { error: '분류를 확인해주세요.' };
    fields.category = category;
  }
  if (creating || 'title' in body) {
    const title = cleanText(body.title, { min: 1, max: 100 });
    if (!title) return { error: '제목은 1~100자로 입력해주세요.' };
    fields.title = title;
  }
  if (creating || 'content' in body) {
    const content = cleanText(body.content, { min: 1, max: 10000, trim: false });
    if (!content || !content.trim()) return { error: '내용은 1~10,000자로 입력해주세요.' };
    fields.content = content;
  }
  if (creating || 'tags' in body) {
    const tags = cleanTags(body.tags ?? []);
    if (!tags) return { error: '태그를 확인해주세요.' };
    fields.tags = tags;
  }
  if (creating || 'image_urls' in body) {
    const imageUrls = cleanImagePaths(body.image_urls ?? [], env);
    if (!imageUrls) return { error: '첨부 이미지 정보를 확인해주세요.' };
    fields.image_urls = imageUrls;
  }
  if (!writeBoolean(body, 'is_notice', fields) || !writeBoolean(body, 'is_pinned', fields) || !writeBoolean(body, 'is_confidential', fields)) {
    return { error: '고정, 공지 또는 기밀 자료 설정을 확인해주세요.' };
  }

  if (creating) {
    fields.author_id = user.id;
    fields.author_name = profile.display_name;
    if (!('is_notice' in fields)) fields.is_notice = false;
    if (!('is_pinned' in fields)) fields.is_pinned = false;
  } else {
    if (!Object.keys(fields).length) return { error: '변경할 내용을 입력해주세요.' };
    fields.updated_at = new Date().toISOString();
  }
  return { fields };
}

export async function createPost(env, fields) {
  const result = await supabaseJson(env, '/rest/v1/community_posts', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: fields
  });
  return { ok: result.response.ok, data: firstRow(result.data), detail: result.data };
}

export async function patchPost(env, id, fields) {
  const result = await supabaseJson(env, restQuery('community_posts', { id: `eq.${id}` }), {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: fields
  });
  return { ok: result.response.ok, data: firstRow(result.data), detail: result.data };
}

function uniqueImagePaths(values, env) {
  return [...new Set(
    (Array.isArray(values) ? values : []).map((value) => validImagePath(value, env)).filter(Boolean)
  )];
}

export async function deleteImageObjects(env, values) {
  const paths = uniqueImagePaths(values, env);
  if (!paths.length) return { ok: true, deleted: 0 };

  // Use the Storage API rather than deleting storage.objects rows directly;
  // this removes the actual object as well as its database metadata.
  const result = await supabaseJson(env, '/storage/v1/object/community-images', {
    method: 'DELETE',
    body: { prefixes: paths }
  });
  return { ok: result.response.ok, deleted: result.response.ok ? paths.length : 0, detail: result.data };
}

export async function queueImageCleanup(env, values, { notBefore = new Date() } = {}) {
  const paths = uniqueImagePaths(values, env);
  if (!paths.length) return { ok: true, queued: 0 };
  const timestamp = notBefore instanceof Date && Number.isFinite(notBefore.getTime())
    ? notBefore.toISOString()
    : new Date().toISOString();
  const result = await supabaseJson(env, '/rest/v1/community_image_cleanup_queue', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: paths.map((object_path) => ({ object_path, not_before: timestamp }))
  });
  return { ok: result.response.ok, queued: result.response.ok ? paths.length : 0 };
}

export async function drainImageCleanupQueue(env, { limit = 20 } = {}) {
  const queued = await supabaseJson(env, restQuery('community_image_cleanup_queue', {
    select: 'object_path',
    not_before: `lte.${new Date().toISOString()}`,
    order: 'not_before.asc',
    limit: String(Math.min(Math.max(Number(limit) || 20, 1), 100))
  }));
  if (!queued.response.ok || !Array.isArray(queued.data)) return { ok: false, deleted: 0, pending: 0 };

  const paths = uniqueImagePaths(queued.data.map((entry) => entry?.object_path), env);
  if (!paths.length) return { ok: true, deleted: 0, pending: 0 };

  const removed = await deleteImageObjects(env, paths);
  if (!removed.ok) return { ok: false, deleted: 0, pending: paths.length };

  const acknowledgements = await Promise.all(paths.map(async (objectPath) => {
    const result = await supabaseJson(env, restQuery('community_image_cleanup_queue', {
      object_path: `eq.${objectPath}`
    }), {
      method: 'DELETE',
      headers: { Prefer: 'return=minimal' }
    });
    return result.response.ok;
  }));
  const cleared = acknowledgements.filter(Boolean).length;
  return { ok: cleared === paths.length, deleted: cleared, pending: paths.length - cleared };
}

export async function deletePost(env, id) {
  const result = await supabaseJson(env, restQuery('community_posts', { id: `eq.${id}` }), {
    method: 'DELETE',
    headers: { Prefer: 'return=representation' }
  });
  return { ok: result.response.ok, deleted: Array.isArray(result.data) && result.data.length > 0 };
}

export async function incrementPostView(env, id, accessToken) {
  const result = await supabaseJson(env, '/rest/v1/rpc/community_increment_post_views', {
    method: 'POST',
    accessToken,
    body: { post_id_value: id }
  });
  return result.response.ok;
}

export function pinLimitError(detail) {
  const source = Array.isArray(detail) ? detail[0] : detail;
  return source?.code === '23514' || /pinned|pin/i.test(String(source?.message || ''));
}
