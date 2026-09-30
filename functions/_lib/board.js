import { MAX_IMAGES } from '../../shared/limits.js';
import { restQuery, firstRow, rpc } from './database.js';
import { objectKey, isUuid } from '../../shared/validation.js';
import { cleanAttachments } from './media.js';
export { isUuid } from '../../shared/validation.js';
import { supabaseJson } from './supabase.js';

const SHARE_TAG_UPPERCASE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const SHARE_TAG_LOWERCASE = 'abcdefghijklmnopqrstuvwxyz';
const SHARE_TAG_DIGITS = '0123456789';
const SHARE_TAG_CHARACTERS = `${SHARE_TAG_UPPERCASE}${SHARE_TAG_LOWERCASE}${SHARE_TAG_DIGITS}`;
const SHARE_TAG_LENGTH = 6;
const POST_SELECT = 'id,category_id,title,tags,content,image_urls,attachments,author_id,author_name,is_notice,is_confidential,is_pinned,view_count,created_at,updated_at,community_categories(id,name)';

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

// Share identifiers live in the existing tags array, so they must be
// distinguishable from ordinary tags without adding a database column.
export const SHARE_TAG_PATTERN = /^(?=.*[A-Z])(?=.*[a-z])(?=.*\d)[A-Za-z\d]{6}$/;

export function isShareTag(value) {
  return typeof value === 'string' && SHARE_TAG_PATTERN.test(value);
}

export function findShareTag(tags) {
  return (Array.isArray(tags) ? tags : []).find((tag) => isShareTag(tag)) || null;
}

function secureRandomIndex(maximum) {
  if (!Number.isInteger(maximum) || maximum < 1) throw new Error('Invalid random range.');
  const getRandomValues = globalThis.crypto?.getRandomValues;
  if (typeof getRandomValues !== 'function') throw new Error('Secure randomness is unavailable.');

  // Rejection sampling avoids modulo bias when the character set size does
  // not divide the 32-bit random range.
  const limit = Math.floor(0x100000000 / maximum) * maximum;
  const values = new Uint32Array(1);
  do {
    getRandomValues.call(globalThis.crypto, values);
  } while (values[0] >= limit);
  return values[0] % maximum;
}

function randomCharacter(characters) {
  return characters[secureRandomIndex(characters.length)];
}

export function generateShareTag() {
  const characters = [
    randomCharacter(SHARE_TAG_UPPERCASE),
    randomCharacter(SHARE_TAG_LOWERCASE),
    randomCharacter(SHARE_TAG_DIGITS),
    ...Array.from({ length: SHARE_TAG_LENGTH - 3 }, () => randomCharacter(SHARE_TAG_CHARACTERS))
  ];

  for (let index = characters.length - 1; index > 0; index -= 1) {
    const target = secureRandomIndex(index + 1);
    [characters[index], characters[target]] = [characters[target], characters[index]];
  }
  return characters.join('');
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
  return objectKey(path);
}

export function cleanImagePaths(value, env) {
  if (!Array.isArray(value) || value.length > MAX_IMAGES) return null;
  const paths = [];
  for (const item of value) {
    const path = validImagePath(item, env);
    if (!path) return null;
    if (!paths.includes(path)) paths.push(path);
  }
  return paths;
}

export function presentPost(post, env) {
  const categoryRelation = Array.isArray(post?.community_categories)
    ? post.community_categories[0]
    : post?.community_categories;
  const categoryName = typeof categoryRelation?.name === 'string' && categoryRelation.name
    ? categoryRelation.name
    : typeof post?.category === 'string'
      ? post.category
      : '';
  const imagePaths = Array.isArray(post?.image_urls)
    ? post.image_urls.map((value) => validImagePath(value, env)).filter(Boolean)
    : [];
  return {
    ...post,
    category_name: categoryName,
    // Keep this alias while older clients are still cached. The authoritative
    // relationship is category_id -> community_categories.
    category: categoryName,
    community_categories: undefined,
    image_urls: imagePaths,
    attachments: cleanAttachments(post?.attachments ?? []) || []
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
  const result = await rpc(env, 'community_update_display_name', { user_id_value: userId, name_value: displayName });
  const profile = firstRow(result.data);
  return result.response.ok && profile ? { id: profile.id, display_name: profile.display_name, role: 'admin' } : null;
}

export async function listPosts(env) {
  // PostgREST applies a row ceiling. Page explicitly rather than silently
  // hiding everything beyond the first server page.
  const posts = [];
  const limit = 500;
  for (let offset = 0; ; offset += limit) {
    const result = await supabaseJson(env, restQuery('community_posts', {
      select: POST_SELECT, order: 'created_at.desc,id.desc', limit: String(limit), offset: String(offset)
    }));
    if (!result.response.ok || !Array.isArray(result.data)) throw new Error('Post lookup failed.');
    posts.push(...result.data);
    if (result.data.length < limit) break;
  }
  return [...new Map(posts.map((post) => [post.id, presentPost(post, env)])).values()];
}

export async function getPost(env, id) {
  const result = await supabaseJson(env, restQuery('community_posts', { select: POST_SELECT, id: `eq.${id}` }));
  if (!result.response.ok) throw new Error('Post lookup failed.');
  const post = firstRow(result.data);
  return post ? presentPost(post, env) : null;
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

  if (creating || 'category_id' in body) {
    const categoryId = body.category_id;
    if (!isUuid(categoryId)) return { error: '분류를 확인해주세요.' };
    fields.category_id = categoryId;
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
  if (creating || 'attachments' in body) {
    const attachments = cleanAttachments(body.attachments ?? []);
    if (!attachments) return { error: '첨부파일은 최대 8개, 총 25MB 이하로 올려주세요.' };
    fields.attachments = attachments;
  }
  if (!writeBoolean(body, 'is_notice', fields) || !writeBoolean(body, 'is_pinned', fields) || !writeBoolean(body, 'is_confidential', fields)) {
    return { error: '별표, 공지 또는 기밀 자료 설정을 확인해주세요.' };
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

async function patchPostIfUnchanged(env, post, fields) {
  if (typeof post?.updated_at !== 'string' || !post.updated_at) return { ok: false, data: null };
  const result = await supabaseJson(env, restQuery('community_posts', {
    id: `eq.${post.id}`,
    updated_at: `eq.${post.updated_at}`
  }), {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: fields
  });
  return { ok: result.response.ok, data: firstRow(result.data), detail: result.data };
}

async function shareTagExists(env, shareTag) {
  const result = await supabaseJson(env, restQuery('community_posts', {
    select: 'id',
    tags: `cs.{${shareTag}}`,
    limit: '1'
  }));
  if (!result.response.ok || !Array.isArray(result.data)) return null;
  return result.data.length > 0;
}

export async function createPostShareLink(env, id) {
  // Compare-and-swap on updated_at prevents a simultaneous share request or
  // ordinary post edit from overwriting tags read by an earlier request.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const post = await getPost(env, id);
    if (!post) return { ok: false, reason: 'not_found' };

    const existingShareTag = findShareTag(post.tags);
    if (existingShareTag) {
      return { ok: true, post, shareTag: existingShareTag, created: false };
    }

    const tags = cleanTags(post.tags);
    if (!tags) return { ok: false, reason: 'invalid_tags' };
    if (tags.length >= 8) return { ok: false, reason: 'tag_limit' };

    // The tag column has no uniqueness constraint, so check generated values
    // before saving. The large key space makes a retry exceptionally unlikely.
    const shareTag = generateShareTag();
    const alreadyUsed = await shareTagExists(env, shareTag);
    if (alreadyUsed === null) return { ok: false, reason: 'lookup_failed' };
    if (alreadyUsed) continue;

    const patched = await patchPostIfUnchanged(env, post, {
      tags: [...tags, shareTag],
      updated_at: new Date().toISOString()
    });
    if (!patched.ok) return { ok: false, reason: 'save_failed', detail: patched.detail };
    if (!patched.data) continue;
    // A mutation response contains only post columns, not the embedded
    // category relation used for the display label. Read it once more so a
    // recently renamed category is represented accurately in the viewer.
    const updatedPost = await getPost(env, id);
    return { ok: true, post: updatedPost || presentPost(patched.data, env), shareTag, created: true };
  }
  return { ok: false, reason: 'retry_exhausted' };
}

export async function deletePost(env, id) {
  const result = await supabaseJson(env, restQuery('community_posts', { id: `eq.${id}` }), {
    method: 'DELETE',
    headers: { Prefer: 'return=representation' }
  });
  return { ok: result.response.ok, deleted: Array.isArray(result.data) && result.data.length > 0 };
}

export async function incrementPostView(env, id) {
  const result = await rpc(env, 'community_record_post_view', { post_id_value: id });
  return { ok: result.response.ok, count: result.data };
}

export function mediaValidationError(detail) {
  const source = Array.isArray(detail) ? detail[0] : detail;
  return source?.code === '23514' && /attachment|media|upload|images/i.test(source.message || '');
}

export function noticeLimitError(detail) {
  const source = Array.isArray(detail) ? detail[0] : detail;
  return ['23514', '23505'].includes(source?.code) && /notice/i.test(String(source?.message || ''));
}
