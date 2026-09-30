// 25 MB is defined as 25 × 1024 × 1024 bytes throughout the app and SQL.
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const MAX_IMAGES = 10;
export const MAX_ATTACHMENTS = 8;
export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
export const UPLOAD_CONCURRENCY = 2;
export const UPLOAD_GRACE_MS = 60 * 60 * 1000;

export function attachmentLimitError(files) {
  if (!Array.isArray(files) || files.length > MAX_ATTACHMENTS) return '첨부파일은 최대 8개까지 올릴 수 있습니다.';
  if (files.some((file) => !Number.isSafeInteger(file.size) || file.size < 1)) return '빈 파일이나 잘못된 파일은 첨부할 수 없습니다.';
  if (files.reduce((total, file) => total + file.size, 0) > MAX_UPLOAD_BYTES) return '첨부파일의 총 용량은 25MB 이하여야 합니다. (이미지 제외)';
  return '';
}

export const MAX_SHORTCUT_URL = 4096;
