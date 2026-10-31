export function cleanExternalLinks(value) {
  if (!Array.isArray(value) || value.length > 8) return null;
  const links = [];
  for (const item of value) {
    if (typeof item?.url !== 'string' || typeof item?.name !== 'string') return null;
    const name = item.name.trim();
    const raw = item.url.trim();
    if (!name || name.length > 200 || raw.length > 4096 || /[\s\\]/.test(raw)) return null;
    try {
      const url = new URL(raw);
      if (url.protocol !== 'https:' || url.username || url.password || url.port || !['app.koofr.net', 'filedn.com', 'transfer.it'].includes(url.hostname)) return null;
      links.push({ name, url: url.href });
    } catch { return null; }
  }
  return links;
}

export function validCalendarDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && value >= '0001-01-01' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}

export function koreaToday(now = new Date()) {
  return new Date(now.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function daysUntil(date, today = koreaToday()) {
  return validCalendarDate(date) && validCalendarDate(today) ? Math.round((Date.parse(date) - Date.parse(today)) / 86400000) : NaN;
}

// Convert the repository's flat category/engine list into the grouped search UI.
export function convertSearchList(source) {
  if (!Array.isArray(source)) throw new Error('검색 목록은 배열이어야 합니다.');
  const groups = [];
  let group;
  for (const item of source) {
    if (!item || typeof item.name !== 'string' || !item.name.trim()) throw new Error('검색 목록 이름을 확인해주세요.');
    if (item.type === 'category') {
      group = { category: item.name, engines: [] };
      groups.push(group);
    } else if (item.type === 'engine') {
      const url = new URL(item.url);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('검색 주소를 확인해주세요.');
      if (!group) { group = { category: '기타', engines: [] }; groups.push(group); }
      group.engines.push({ name: item.name, url: url.href });
    } else throw new Error('알 수 없는 검색 목록 형식입니다.');
  }
  return groups.filter((item) => item.engines.length);
}

export function searchUrl(template, query) {
  const url = new URL(template);
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('검색 주소를 확인해주세요.');
  return url.href.replaceAll('imouto', encodeURIComponent(query.trim()));
}
