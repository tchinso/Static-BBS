import { UPLOAD_CONCURRENCY } from '../shared/limits.js';

export function formatBytes(bytes) {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

// Await every worker even when one upload fails. Successful entries retain
// their upload handle, so retrying a save never uploads the same bytes again.
export async function uploadEntries(entries, api) {
  let next = 0;
  let failure;
  await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, entries.length) }, async () => {
    while (next < entries.length) {
      const entry = entries[next++];
      if (entry.kind === 'retained' || (entry.uploaded && entry.uploaded.expiresAt > Date.now() + 60_000)) continue;
      try {
        const form = new FormData();
        form.append('file', entry.file, entry.file.name);
        const data = await api(`/api/${entry.media}`, { method: 'POST', body: form });
        const uploaded = entry.media === 'files' ? data.attachment : data;
        if (!uploaded?.path) throw new Error('업로드 결과를 확인하지 못했습니다.');
        entry.uploaded = uploaded;
      } catch (error) { failure ||= error; }
    }
  }));
  if (failure) throw failure;
}

export function discardEntries(entries, api) {
  for (const media of ['images', 'files']) {
    const paths = entries.filter((entry) => entry.media === media && entry.kind === 'pending' && entry.uploaded)
      .map((entry) => entry.uploaded.path);
    if (paths.length) void api(`/api/${media}`, { method: 'DELETE', body: JSON.stringify({ paths }), keepalive: true }).catch(() => undefined);
  }
}
