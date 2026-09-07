import { supabaseJson } from './supabase.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function restQuery(table, query) {
  return `/rest/v1/${table}?${new URLSearchParams(query).toString()}`;
}

function firstRow(data) {
  return Array.isArray(data) ? data[0] || null : null;
}

function categoryName(value) {
  if (typeof value !== 'string') return '';
  const name = value.trim();
  return name.length >= 1 && name.length <= 60 ? name : '';
}

function rpc(env, name, body) {
  return supabaseJson(env, `/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body
  });
}

export function isCategoryId(value) {
  return typeof value === 'string' && UUID.test(value);
}

export function withCategoryPostCounts(categories, posts) {
  const postCounts = new Map();
  for (const post of Array.isArray(posts) ? posts : []) {
    if (!isCategoryId(post?.category_id)) continue;
    postCounts.set(post.category_id, (postCounts.get(post.category_id) || 0) + 1);
  }
  return (Array.isArray(categories) ? categories : []).map((category) => ({
    ...category,
    post_count: postCounts.get(category.id) || 0
  }));
}

export async function listCategories(env, { includePostCount = false } = {}) {
  const categoriesResult = await supabaseJson(env, restQuery('community_categories', {
    select: 'id,name,sort_order',
    order: 'sort_order.asc,name.asc'
  }));
  if (!categoriesResult.response.ok || !Array.isArray(categoriesResult.data)) {
    throw new Error('Category lookup failed.');
  }

  const categories = categoriesResult.data;
  if (!includePostCount) return categories;

  const postsResult = await supabaseJson(env, restQuery('community_posts', { select: 'category_id' }));
  if (!postsResult.response.ok || !Array.isArray(postsResult.data)) {
    throw new Error('Category post count lookup failed.');
  }
  return withCategoryPostCounts(categories, postsResult.data);
}

export async function createCategory(env, name) {
  const category = categoryName(name);
  if (!category) return { ok: false, reason: 'invalid_name' };
  const result = await rpc(env, 'community_create_category', { category_name: category });
  return { ok: result.response.ok, data: firstRow(result.data), detail: result.data };
}

export async function renameCategory(env, id, name) {
  const category = categoryName(name);
  if (!isCategoryId(id) || !category) return { ok: false, reason: 'invalid_input' };
  const result = await rpc(env, 'community_rename_category', {
    category_id_value: id,
    category_name: category
  });
  return { ok: result.response.ok, data: firstRow(result.data), detail: result.data };
}

export async function reorderCategories(env, ids) {
  if (!Array.isArray(ids) || !ids.length || ids.some((id) => !isCategoryId(id))) {
    return { ok: false, reason: 'invalid_input' };
  }
  const result = await rpc(env, 'community_reorder_categories', { category_ids_value: ids });
  return { ok: result.response.ok, data: result.data, detail: result.data };
}

export async function deleteCategory(env, id, replacementId = null) {
  if (!isCategoryId(id) || (replacementId !== null && !isCategoryId(replacementId))) {
    return { ok: false, reason: 'invalid_input' };
  }
  const result = await rpc(env, 'community_delete_category', {
    category_id_value: id,
    replacement_category_id_value: replacementId
  });
  return { ok: result.response.ok, data: firstRow(result.data), detail: result.data };
}

export function categoryErrorMessage(result, fallback) {
  if (result?.reason === 'invalid_name' || result?.reason === 'invalid_input') {
    return '카테고리 정보를 확인해주세요.';
  }
  const detail = Array.isArray(result?.detail) ? result.detail[0] : result?.detail;
  return typeof detail?.message === 'string' && detail.message ? detail.message : fallback;
}
