import { rpc } from './database.js';
import { supabaseJson } from './supabase.js';
import { IMAGE_BUCKET, FILE_BUCKET } from './media.js';
import { objectKey } from '../../shared/validation.js';

export async function reserveUpload(env, bucket, path, { name = '', size = 0, owner = '' } = {}) {
  return rpc(env, 'community_reserve_upload', { bucket_value: bucket, path_value: path, name_value: name, size_value: size, owner_value: owner });
}

export async function abandonUploads(env, bucket, paths, owner) {
  return rpc(env, 'community_abandon_uploads', { bucket_value: bucket, paths_value: paths.filter(objectKey), owner_value: owner });
}

export async function drainStorageCleanup(env, { limit = 20 } = {}) {
  const claimed = await rpc(env, 'community_claim_storage_cleanup', { limit_value: limit });
  if (!claimed.response.ok || !Array.isArray(claimed.data)) throw new Error('Storage cleanup claim failed.');
  if (!claimed.data.length) return { deleted: 0 };
  const completed = [];
  for (const bucket of [IMAGE_BUCKET, FILE_BUCKET]) {
    const entries = claimed.data.filter((entry) => entry.bucket_id === bucket && objectKey(entry.object_path));
    if (!entries.length) continue;
    const removed = await supabaseJson(env, `/storage/v1/object/${bucket}`, {
      method: 'DELETE', body: { prefixes: entries.map((entry) => entry.object_path) }
    });
    if (removed.response.ok) completed.push(...entries);
    else console.error('storage_cleanup_deferred', { bucket, count: entries.length, status: removed.response.status });
  }
  if (completed.length) {
    const acknowledged = await rpc(env, 'community_ack_storage_cleanup', { entries_value: completed });
    if (!acknowledged.response.ok) throw new Error('Storage cleanup acknowledgement failed.');
  }
  return { deleted: completed.length };
}

export function scheduleStorageCleanup(context) {
  // Cleanup never sits on the user's save/startup critical path.
  const work = drainStorageCleanup(context.env).catch(() => console.error('storage_cleanup_deferred'));
  if (typeof context.waitUntil === 'function') context.waitUntil(work);
  return work;
}
