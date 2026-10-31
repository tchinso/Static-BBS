import { convertSearchList, searchUrl } from '../shared/features.js';

export async function initExternalSearch() {
  const category = document.querySelector('#externalSearchCategory');
  const engine = document.querySelector('#externalSearchEngine');
  const message = document.querySelector('#externalSearchMessage');
  try {
    const response = await fetch('/NKMM/search-list.json', { cache: 'no-cache' });
    if (!response.ok) throw new Error('검색 목록을 불러오지 못했습니다. 새로고침해주세요.');
    const groups = convertSearchList(await response.json());
    if (!groups.length) throw new Error('등록된 검색 사이트가 없습니다.');
    category.replaceChildren(...groups.map((group, index) => new Option(group.category, String(index))));
    const populate = () => engine.replaceChildren(...groups[Number(category.value)].engines.map((item, index) => new Option(item.name, String(index))));
    populate();
    category.addEventListener('change', populate);
    document.querySelector('#externalSearchForm').addEventListener('submit', event => {
      event.preventDefault();
      const query = document.querySelector('#externalQuery');
      if (!query.value.trim()) { query.focus(); return; }
      const selected = groups[Number(category.value)]?.engines[Number(engine.value)];
      if (selected) window.open(searchUrl(selected.url, query.value), '_blank', 'noopener,noreferrer');
    });
  } catch (error) {
    message.textContent = error.message;
    document.querySelector('#externalSearchForm button').disabled = true;
  }
}
