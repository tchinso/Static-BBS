import { supabaseJson } from './supabase.js';
import { restQuery, firstRow, rpc } from './database.js';
import { MAX_SHORTCUT_URL } from '../../shared/limits.js';
import { isUuid } from '../../shared/validation.js';

const MAX_TITLE_LENGTH = 100;
const MAX_URL_LENGTH = MAX_SHORTCUT_URL;

function shortcutTitle(value) {
  if (typeof value !== 'string') return '';
  const title = value.trim();
  return title.length >= 1 && title.length <= MAX_TITLE_LENGTH ? title : '';
}

function shortcutUrl(value) {
  if (typeof value !== 'string') return '';
  const url = value.trim();
  if (url.length < 8 || url.length > MAX_URL_LENGTH || /\s/.test(url)) return '';
  try {
    const parsed = new URL(url);
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && parsed.hostname ? url : '';
  } catch {
    return '';
  }
}

export function isShortcutId(value) {
  return isUuid(value);
}

export async function listShortcuts(env) {
  const result = await supabaseJson(env, restQuery('community_shortcuts', {
    select: 'id,title,url,sort_order',
    order: 'sort_order.asc,title.asc'
  }));
  if (!result.response.ok || !Array.isArray(result.data)) {
    throw new Error('Shortcut lookup failed.');
  }
  return result.data;
}

export async function createShortcut(env, title, url) {
  const normalizedTitle = shortcutTitle(title);
  if (!normalizedTitle) return { ok: false, reason: 'invalid_title' };
  const normalizedUrl = shortcutUrl(url);
  if (!normalizedUrl) return { ok: false, reason: 'invalid_url' };
  const result = await rpc(env, 'community_create_shortcut', {
    shortcut_title: normalizedTitle,
    shortcut_url: normalizedUrl
  });
  return { ok: result.response.ok, data: firstRow(result.data), detail: result.data };
}

export async function updateShortcut(env, id, title, url) {
  if (!isShortcutId(id)) return { ok: false, reason: 'invalid_input' };
  const normalizedTitle = shortcutTitle(title);
  if (!normalizedTitle) return { ok: false, reason: 'invalid_title' };
  const normalizedUrl = shortcutUrl(url);
  if (!normalizedUrl) return { ok: false, reason: 'invalid_url' };
  const result = await rpc(env, 'community_update_shortcut', {
    shortcut_id_value: id,
    shortcut_title: normalizedTitle,
    shortcut_url: normalizedUrl
  });
  return { ok: result.response.ok, data: firstRow(result.data), detail: result.data };
}

export async function reorderShortcuts(env, ids) {
  if (!Array.isArray(ids) || ids.some((id) => !isShortcutId(id))) {
    return { ok: false, reason: 'invalid_input' };
  }
  const result = await rpc(env, 'community_reorder_shortcuts', { shortcut_ids_value: ids });
  return { ok: result.response.ok, data: result.data, detail: result.data };
}

export async function deleteShortcut(env, id) {
  if (!isShortcutId(id)) return { ok: false, reason: 'invalid_input' };
  const result = await rpc(env, 'community_delete_shortcut', { shortcut_id_value: id });
  return { ok: result.response.ok, data: firstRow(result.data), detail: result.data };
}

export function shortcutErrorMessage(result, fallback) {
  if (result?.reason === 'invalid_title') return '바로가기 이름은 1~100자로 입력해주세요.';
  if (result?.reason === 'invalid_url') return 'https:// 또는 http://로 시작하는 링크를 입력해주세요.';
  if (result?.reason === 'invalid_input') return '바로가기 정보를 확인해주세요.';
  const detail = Array.isArray(result?.detail) ? result.detail[0] : result?.detail;
  return typeof detail?.message === 'string' && detail.message ? detail.message : fallback;
}
