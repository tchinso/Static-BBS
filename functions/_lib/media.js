import { MAX_ATTACHMENTS, attachmentLimitError } from '../../shared/limits.js';
import { objectKey, encodeObjectKey } from '../../shared/validation.js';

export const IMAGE_BUCKET = 'community-images';
export const FILE_BUCKET = 'community-files';
export const mediaUrl = (path, kind = 'files') => `/api/${kind}/${encodeObjectKey(path)}`;

export function cleanAttachments(value) {
  if (!Array.isArray(value) || value.length > MAX_ATTACHMENTS) return null;
  const paths = new Set();
  const files = [];
  for (const file of value) {
    const path = objectKey(file?.path);
    if (!path || paths.has(path) || typeof file.name !== 'string' || !file.name.trim() || Array.from(file.name).length > 255) return null;
    paths.add(path);
    files.push({ path, name: file.name, size: file.size });
  }
  return attachmentLimitError(files) ? null : files;
}

export function safeFileName(value) {
  const name = String(value || 'file').normalize('NFKC').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  return (name || 'file').slice(0, 120);
}
