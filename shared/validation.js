export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const isUuid = (value) => typeof value === 'string' && UUID.test(value);

export function objectKey(value) {
  if (typeof value !== 'string' || !value || value.length > 512 || /[\\\u0000-\u001f\u007f]/.test(value)) return '';
  const parts = value.split('/');
  return parts.length >= 2 && isUuid(parts[0]) && parts.every((part) => part && part !== '.' && part !== '..') ? value : '';
}

export const encodeObjectKey = (path) => path.split('/').map(encodeURIComponent).join('/');
