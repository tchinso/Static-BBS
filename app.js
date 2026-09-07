const boardConfig = window.BOARD_CONFIG || {};
const viewModeStorageKey = 'nyangcatmemoBoardViewMode';
const rememberLoginSettingKey = 'nyangcatmemoRememberLogin';
const pageSize = 10;
const maxImagesPerPost = 10;
const shareTagPattern = /^(?=.*[A-Z])(?=.*[a-z])(?=.*\d)[A-Za-z\d]{6}$/;
const pendingSharedSearchStorageKey = 'nyangcatmemoPendingSharedSearch';
const pendingSharedSearchMaxAge = 60 * 60 * 1000;

let currentUser = null;
let currentProfile = null;
let categories = [];
let shortcuts = [];
let posts = [];
let filteredPosts = [];
let selectedCategory = '전체글';
let searchTerm = '';
let currentPage = 1;
let viewMode = localStorage.getItem(viewModeStorageKey) === 'gallery' ? 'gallery' : 'list';
let selectedPost = null;
let editorImages = [];
let editorIsDirty = false;
let draggedImageIndex = null;
let editingCategoryId = null;
let categoryDeleteTarget = null;
let editingShortcutId = null;
let shortcutDeleteTarget = null;
let bootStatusTimer = null;
let bootRecoveryTimer = null;

// Check immediately, then retry at 2.7 s and 5.4 s from startup.  The gate
// changes to the recovery state at 8.1 s, after all three checks have had a
// chance to run.
const STARTUP_AUTH_RETRY_AT_MS = [2700, 5400];
const STARTUP_AUTH_RECOVERY_TIMEOUT_MS = 8100;

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

// Never leave previously fetched private content in the DOM after logout or a
// rejected/expired session.  The visual gate is not relied on as the security
// boundary, but clearing it also prevents a local inspector from unhiding a
// stale board view.
function clearBoardState() {
  currentUser = null;
  currentProfile = null;
  categories = [];
  shortcuts = [];
  posts = [];
  filteredPosts = [];
  selectedPost = null;
  editorImages = [];
  editorIsDirty = false;
  draggedImageIndex = null;
  editingCategoryId = null;
  categoryDeleteTarget = null;
  editingShortcutId = null;
  shortcutDeleteTarget = null;
  currentPage = 1;
  selectedCategory = '전체글';
  searchTerm = '';

  ['#categoryNav', '#postCategory', '#categoryList', '#shortcutList', '#shortcutSettingsList', '#postList', '#pagination', '#viewerTags', '#viewerImages', '#imageEditorList', '#shareLinkMessage'].forEach((selector) => {
    const element = $(selector);
    if (element) element.replaceChildren();
  });
  const noticeStrip = $('#noticeStrip');
  if (noticeStrip) {
    noticeStrip.replaceChildren();
    noticeStrip.hidden = true;
  }
  const viewerContent = $('#viewerContent');
  if (viewerContent) viewerContent.textContent = '';
  const viewerTitle = $('#viewerTitle');
  if (viewerTitle) viewerTitle.textContent = '';
  const viewerMeta = $('#viewerMeta');
  if (viewerMeta) viewerMeta.textContent = '';
  ['#editorDialog', '#viewerDialog', '#profileDialog'].forEach((selector) => {
    const dialog = $(selector);
    if (dialog?.open) dialog.close();
  });
  const editorForm = $('#postForm');
  if (editorForm) editorForm.reset();
  const profileEmail = $('#profileEmail');
  if (profileEmail) profileEmail.value = '';
  const profileDisplayName = $('#profileDisplayName');
  if (profileDisplayName) profileDisplayName.value = '';
  const categoryDeletePanel = $('#categoryDeletePanel');
  if (categoryDeletePanel) categoryDeletePanel.hidden = true;
  const categoryMessage = $('#categoryMessage');
  if (categoryMessage) categoryMessage.textContent = '';
  const shortcutDeletePanel = $('#shortcutDeletePanel');
  if (shortcutDeletePanel) shortcutDeletePanel.hidden = true;
  const shortcutMessage = $('#shortcutMessage');
  if (shortcutMessage) shortcutMessage.textContent = '';
  const shortcutEditButton = $('#shortcutEditButton');
  if (shortcutEditButton) shortcutEditButton.hidden = true;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function normalizeCategories(value) {
  return (Array.isArray(value) ? value : [])
    .map((category) => ({
      id: String(category?.id ?? '').trim(),
      name: String(category?.name ?? '').trim(),
      sort_order: Number(category?.sort_order ?? 0),
      post_count: Math.max(0, Number(category?.post_count ?? 0) || 0)
    }))
    .filter((category) => category.id && category.name)
    .sort((left, right) => left.sort_order - right.sort_order || left.name.localeCompare(right.name, 'ko'));
}

function normalizeShortcutUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : '';
  } catch {
    return '';
  }
}

function normalizeShortcuts(value) {
  return (Array.isArray(value) ? value : [])
    .map((shortcut) => ({
      id: String(shortcut?.id ?? '').trim(),
      title: String(shortcut?.title ?? '').trim(),
      url: normalizeShortcutUrl(shortcut?.url),
      sort_order: Number(shortcut?.sort_order ?? 0)
    }))
    .filter((shortcut) => shortcut.id && shortcut.title && shortcut.url)
    .sort((left, right) => left.sort_order - right.sort_order || left.title.localeCompare(right.title, 'ko'));
}

function categoryById(id) {
  return categories.find((category) => category.id === String(id ?? '')) || null;
}

function categoryIdByName(name) {
  return categories.find((category) => category.name === String(name ?? ''))?.id || '';
}

function postCategoryRelation(post) {
  const relation = post?.category;
  return Array.isArray(relation) ? relation[0] : relation;
}

function normalizePost(post) {
  const relation = postCategoryRelation(post);
  const categoryId = String(post?.category_id ?? relation?.id ?? categoryIdByName(post?.category_name ?? (typeof relation === 'string' ? relation : ''))).trim();
  const categoryName = String(
    post?.category_name
    ?? relation?.name
    ?? (typeof relation === 'string' ? relation : null)
    ?? categoryById(categoryId)?.name
    ?? ''
  ).trim();
  return {
    ...post,
    category_id: categoryId,
    category: categoryName,
    image_urls: normalizeImagePaths(post?.image_urls)
  };
}

function isAllCategoriesSelected() {
  return selectedCategory === '전체글';
}

function selectedCategoryName() {
  return categoryById(selectedCategory)?.name || '';
}

function reconcileSelectedCategory() {
  if (!isAllCategoriesSelected() && !categoryById(selectedCategory)) selectedCategory = '전체글';
}

function rememberLoginEnabled() {
  return localStorage.getItem(rememberLoginSettingKey) !== 'false';
}

function clearBootStatusTimer() {
  if (bootStatusTimer !== null) {
    window.clearTimeout(bootStatusTimer);
    bootStatusTimer = null;
  }
  if (bootRecoveryTimer !== null) {
    window.clearTimeout(bootRecoveryTimer);
    bootRecoveryTimer = null;
  }
}

function showLoginGate(message = '승인된 이메일로 로그인하면 게시판을 볼 수 있습니다.') {
  clearBootStatusTimer();
  const gate = $('#authGate');
  gate.hidden = false;
  gate.dataset.state = 'login';
  gate.setAttribute('aria-busy', 'false');
  $('#authGateTitle').textContent = '로그인이 필요합니다.';
  $('#authGateMessage').textContent = message;
  $('#authGateProgress').hidden = true;
  $('#gateLoginButton').hidden = false;
  $('#authGateRetryButton').hidden = true;
}

function showConnectionRecoveryGate() {
  clearBootStatusTimer();
  const gate = $('#authGate');
  $('#appShell').hidden = true;
  gate.hidden = false;
  gate.dataset.state = 'recovery';
  gate.setAttribute('aria-busy', 'false');
  $('#authGateTitle').textContent = '로그인 확인에 시간이 걸리고 있어요.';
  $('#authGateMessage').textContent = '연결을 다시 시도하거나 이메일로 로그인할 수 있습니다.';
  $('#authGateProgress').hidden = true;
  $('#gateLoginButton').hidden = false;
  $('#authGateRetryButton').hidden = false;
}

function showBootLoading() {
  const gate = $('#authGate');
  $('#appShell').hidden = true;
  gate.hidden = false;
  gate.dataset.state = 'checking';
  gate.setAttribute('aria-busy', 'true');
  $('#authGateTitle').textContent = '로그인 상태를 확인하고 있어요.';
  $('#authGateMessage').textContent = '안전하게 게시판을 여는 중입니다.';
  $('#authGateProgress').hidden = false;
  $('#authGateProgressLabel').textContent = '잠시만 기다려주세요.';
  $('#gateLoginButton').hidden = true;
  $('#authGateRetryButton').hidden = true;
  clearBootStatusTimer();
  bootStatusTimer = window.setTimeout(() => {
    $('#authGateMessage').textContent = '연결 상태에 따라 조금 더 걸릴 수 있어요. 로그인 정보를 계속 확인하고 있습니다.';
    $('#authGateProgressLabel').textContent = '게시판을 준비하는 중입니다.';
  }, 1200);
  bootRecoveryTimer = window.setTimeout(() => {
    if (gate.dataset.state !== 'checking') return;
    showConnectionRecoveryGate();
  }, STARTUP_AUTH_RECOVERY_TIMEOUT_MS);
}

function setBoardVisibility(visible, message = '승인된 이메일로 로그인하면 게시판을 볼 수 있습니다.') {
  $('#appShell').hidden = !visible;
  if (visible) {
    clearBootStatusTimer();
    $('#authGate').hidden = true;
  } else {
    showLoginGate(message);
  }
}

function createApiError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function api(path, options = {}) {
  const { deferUnauthorizedGate = false, ...requestOptions } = options;
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...requestOptions,
    headers: {
      ...(requestOptions.body instanceof FormData ? {} : requestOptions.body ? { 'Content-Type': 'application/json' } : {}),
      ...(requestOptions.headers || {})
    }
  });
  const contentType = response.headers.get('content-type') || '';
  const body = contentType.includes('application/json') ? await response.json().catch(() => ({})) : {};
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      clearBoardState();
      if (!deferUnauthorizedGate) setBoardVisibility(false);
    }
    throw createApiError(body.error || body.message || '요청을 처리하지 못했습니다.', response.status);
  }
  return body;
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return new Intl.DateTimeFormat('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
  }
  return new Intl.DateTimeFormat('ko-KR', { month: '2-digit', day: '2-digit' }).format(date).replace(/\. /g, '.').replace('.', '').trim();
}

function formatFullDate(value) {
  const date = new Date(value);
  return new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
}

function normalizeTags(value) {
  const source = Array.isArray(value) ? value : String(value || '').split(/[\s,]+/);
  return [...new Set(source.map((tag) => String(tag).trim().replace(/^#+/, '')).filter(Boolean))]
    .slice(0, 8)
    .map((tag) => tag.slice(0, 24));
}

function isShareTag(value) {
  return typeof value === 'string' && shareTagPattern.test(value);
}

function findShareTag(tags) {
  return normalizeTags(tags).find((tag) => isShareTag(tag)) || null;
}

function sharedSearchTermFromLocation() {
  const pathTag = window.location.pathname.replace(/^\/+|\/+$/g, '');
  if (isShareTag(pathTag)) return pathTag;

  // Keep older query-style links working while new links use the short path.
  return new URLSearchParams(window.location.search).get('s')?.trim() || '';
}

function rememberSharedSearchTerm(value) {
  if (!value) return;
  try {
    localStorage.setItem(pendingSharedSearchStorageKey, JSON.stringify({ value, savedAt: Date.now() }));
  } catch {
    // A direct, already-authenticated link still works when storage is unavailable.
  }
}

function pendingSharedSearchTerm() {
  try {
    const raw = localStorage.getItem(pendingSharedSearchStorageKey);
    if (!raw) return '';
    const saved = JSON.parse(raw);
    if (typeof saved?.value !== 'string' || !saved.value || !Number.isFinite(saved.savedAt)
      || Date.now() - saved.savedAt > pendingSharedSearchMaxAge) {
      localStorage.removeItem(pendingSharedSearchStorageKey);
      return '';
    }
    return saved.value;
  } catch {
    return '';
  }
}

function clearPendingSharedSearchTerm() {
  try {
    localStorage.removeItem(pendingSharedSearchStorageKey);
  } catch {
    // Storage cleanup is nonessential.
  }
}

function hasMagicLinkSessionFragment() {
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  return fragment.has('access_token') || fragment.has('refresh_token');
}

function prepareSharedSearch() {
  const urlSearch = sharedSearchTermFromLocation();
  if (urlSearch) rememberSharedSearchTerm(urlSearch);
  // A pending link is only restored after the magic-link callback, so an
  // abandoned link does not unexpectedly open during a later normal visit.
  const search = urlSearch || (hasMagicLinkSessionFragment() ? pendingSharedSearchTerm() : '');
  if (!search) return '';

  selectedCategory = '전체글';
  searchTerm = search;
  currentPage = 1;
  $('#searchInput').value = search;
  $$('.nav-item').forEach((button) => button.classList.toggle('is-active', button.dataset.view === 'all'));
  return search;
}

function preferredSearchResult(search) {
  applyFilters();
  if (isShareTag(search)) {
    const exactTagMatch = filteredPosts.find((post) => normalizeTags(post.tags).includes(search));
    if (exactTagMatch) return exactTagMatch;
  }
  return filteredPosts[0] || null;
}

function shareUrl(shareTag) {
  return new URL(`/${shareTag}`, window.location.origin).toString();
}

function normalizeImagePaths(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim().replace(/^\/+/, ''))
    .filter((value) => value && !value.includes('..') && !/^https?:\/\//i.test(value)))];
}

function imageUrl(path) {
  return `/api/images/${normalizeImagePaths([path])[0]?.split('/').map(encodeURIComponent).join('/') || ''}`;
}

function renderTags(tags) {
  return normalizeTags(tags).map((tag) => `<span class="tag-chip">#${escapeHtml(tag)}</span>`).join('');
}

function appendLinkedText(element, value) {
  const text = String(value ?? '');
  const urlPattern = /https?:\/\/[^\s<>"']+|www\.[^\s<>"']+|(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}(?::\d{1,5})?(?:[/?#][^\s<>"']*)?/gi;
  let lastIndex = 0;
  element.replaceChildren();

  for (const match of text.matchAll(urlPattern)) {
    const matchIndex = match.index ?? 0;
    const rawUrl = match[0];
    const linkText = rawUrl.replace(/[),.!?;:\]}]+$/g, '');
    if (!linkText) continue;
    if (text[matchIndex - 1] === '@') continue;

    element.append(document.createTextNode(text.slice(lastIndex, matchIndex)));
    const href = /^https?:\/\//i.test(linkText) ? linkText : `https://${linkText}`;
    try {
      const url = new URL(href);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Unsupported URL protocol');
      const link = document.createElement('a');
      link.href = url.href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = linkText;
      element.append(link);
    } catch {
      element.append(document.createTextNode(linkText));
    }
    element.append(document.createTextNode(rawUrl.slice(linkText.length)));
    lastIndex = matchIndex + rawUrl.length;
  }
  element.append(document.createTextNode(text.slice(lastIndex)));
}

function roleCanEditAll() {
  return currentProfile?.role === 'admin';
}

function roleIsAdmin() {
  return currentProfile?.role === 'admin';
}

function canEdit(post) {
  return Boolean(currentUser && (post.author_id === currentUser.id || roleCanEditAll()));
}

function canDelete(post) {
  return Boolean(currentUser && (post.author_id === currentUser.id || roleIsAdmin()));
}

function isConfidential(post) {
  return Boolean(post?.is_confidential);
}

async function loadBoard({ deferUnauthorizedGate = false } = {}) {
  const data = await api('/api/bootstrap', { deferUnauthorizedGate });
  applyBoardData(data);
}

async function loadStartupBoard() {
  const startedAt = performance.now();
  let lastUnauthorizedError = null;

  for (const attemptAt of [0, ...STARTUP_AUTH_RETRY_AT_MS]) {
    const waitMs = attemptAt - (performance.now() - startedAt);
    if (waitMs > 0) await new Promise((resolve) => window.setTimeout(resolve, waitMs));

    try {
      await loadBoard({ deferUnauthorizedGate: true });
      return;
    } catch (error) {
      if (error.status !== 401 && error.status !== 403) throw error;
      lastUnauthorizedError = error;
    }
  }

  throw lastUnauthorizedError;
}

function applyBoardData(data) {
  currentUser = data.user || null;
  currentProfile = data.profile || null;
  categories = normalizeCategories(data.categories);
  shortcuts = normalizeShortcuts(data.shortcuts);
  posts = (data.posts || []).map(normalizePost);
  reconcileSelectedCategory();
  setBoardVisibility(true);
  renderAll();
}

function applyFilters() {
  const query = searchTerm.toLocaleLowerCase('ko');
  filteredPosts = posts.filter((post) => {
    const categoryMatch = isAllCategoriesSelected()
      || post.category_id === selectedCategory
      || (!post.category_id && post.category === selectedCategoryName());
    const textMatch = !query || `${post.title} ${post.content} ${post.author_name} ${(post.tags || []).join(' ')}`.toLocaleLowerCase('ko').includes(query);
    return categoryMatch && textMatch;
  });
}

function renderImageEditor() {
  $('#imageEditorList').innerHTML = editorImages.map((image, index) => `
    <div class="image-editor-item ${image.kind === 'pending' ? 'is-pending' : ''}" draggable="true" data-image-index="${index}" aria-label="${index + 1}번 이미지, 드래그해 순서 변경">
      <span class="image-order" aria-hidden="true">${index + 1}</span>
      ${image.kind === 'retained'
        ? `<img src="${escapeHtml(imageUrl(image.path))}" alt="${index + 1}번 첨부 이미지 미리보기">`
        : `<span class="pending-image-name">${escapeHtml(image.file.name)}</span>`}
      <button type="button" data-remove-image="${index}" aria-label="${index + 1}번 이미지 삭제">삭제</button>
    </div>
  `).join('');
}

async function uploadEditorImages() {
  const paths = [];
  for (const image of editorImages) {
    if (image.kind === 'retained') {
      paths.push(image.path);
      continue;
    }
    const formData = new FormData();
    formData.append('file', image.file, image.file.name);
    const data = await api('/api/images', { method: 'POST', body: formData });
    if (!data.path) throw new Error('이미지 업로드 결과를 확인하지 못했습니다.');
    paths.push(data.path);
  }
  return normalizeImagePaths(paths);
}

function formatPostCategory(post) {
  return `${post.is_notice ? '공지 ' : ''}${post.is_pinned ? '📌 ' : ''}${post.category || ''}`.trim();
}

function renderPostCategory(post) {
  return `${post.is_notice ? '<span class="notice-label">공지</span>' : ''}${post.is_pinned ? '<span class="pin" aria-label="고정">📌</span>' : ''}<span class="category-name">${escapeHtml(post.category)}</span>`;
}

function summarizeNoticeContent(value, maxLength = 240) {
  const lineBreakToken = '\uE000';
  value = String(value || '').trim().replace(/\r\n?|\n/g, lineBreakToken);
  const content = String(value || '').replace(/\s+/g, ' ').trim();
  const characters = Array.from(content.replaceAll(lineBreakToken, '\n'));
  return characters.length > maxLength ? `${characters.slice(0, maxLength).join('')}…` : characters.join('');
}

function renderPosts() {
  applyFilters();
  const currentPageSize = viewMode === 'gallery' ? 20 : pageSize;
  const totalPages = Math.max(1, Math.ceil(filteredPosts.length / currentPageSize));
  currentPage = Math.min(currentPage, totalPages);
  const pagePosts = filteredPosts.slice((currentPage - 1) * currentPageSize, currentPage * currentPageSize);
  const table = $('.post-table');
  table.classList.toggle('is-gallery', viewMode === 'gallery');
  table.setAttribute('role', viewMode === 'gallery' ? 'list' : 'table');
  table.setAttribute('aria-label', viewMode === 'gallery' ? '게시글 갤러리' : '게시글 목록');
  $$('.view-toggle [data-view-mode]').forEach((button) => {
    const active = button.dataset.viewMode === viewMode;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
  $('#postList').innerHTML = viewMode === 'gallery'
    ? pagePosts.map((post) => {
      if (isConfidential(post)) {
        return `
          <article class="gallery-card is-confidential" role="listitem" tabindex="0" data-post-id="${escapeHtml(post.id)}" aria-label="기밀 자료: ${escapeHtml(post.title)}">
            <div class="gallery-confidential-title"><h3>🔒 ${escapeHtml(post.title)}</h3></div>
          </article>
        `;
      }
      const firstImage = post.image_urls?.[0];
      const preview = String(post.content || '').replace(/\s+/g, ' ').trim();
      return `
        <article class="gallery-card ${firstImage ? '' : 'has-no-image'} ${post.is_notice ? 'is-notice' : ''} ${post.is_pinned ? 'is-pinned' : ''}" role="listitem" tabindex="0" data-post-id="${escapeHtml(post.id)}">
          ${firstImage ? `
            <div class="gallery-thumb">
              <img src="${escapeHtml(imageUrl(firstImage))}" alt="${escapeHtml(post.title)}" loading="lazy">
              <span class="gallery-category">${escapeHtml(formatPostCategory(post))}</span>
            </div>
          ` : ''}
          <div class="gallery-body">
            ${firstImage ? '' : `<span class="gallery-category">${escapeHtml(formatPostCategory(post))}</span>`}
            <h3>${escapeHtml(post.title)}</h3>
            ${preview ? `<p>${escapeHtml(preview)}</p>` : ''}
            ${post.tags?.length ? `<div class="post-tags">${renderTags(post.tags)}</div>` : ''}
            <div class="gallery-meta"><span>${escapeHtml(post.author_name)}</span><span>${formatDate(post.created_at)} · 조회 ${Number(post.view_count || 0).toLocaleString('ko-KR')}</span></div>
          </div>
        </article>
      `;
    }).join('')
    : pagePosts.map((post) => {
      if (isConfidential(post)) {
        return `
          <div class="post-row post-item is-confidential" role="row" tabindex="0" data-post-id="${escapeHtml(post.id)}" aria-label="기밀 자료: ${escapeHtml(post.title)}">
            <span class="post-title" role="cell"><span class="post-title-text">🔒 ${escapeHtml(post.title)}</span></span>
          </div>
        `;
      }
      return `
        <div class="post-row post-item ${post.is_notice ? 'is-notice' : ''} ${post.is_pinned ? 'is-pinned' : ''}" role="row" tabindex="0" data-post-id="${escapeHtml(post.id)}">
          <span class="post-category" role="cell">${renderPostCategory(post)}</span>
          <span class="post-title" role="cell"><span class="post-title-text">${post.image_urls?.length ? '<span class="image-indicator">▣</span>' : ''}${escapeHtml(post.title)}</span>${post.tags?.length ? `<span class="post-tags">${renderTags(post.tags)}</span>` : ''}</span>
          <span class="post-author" role="cell">${escapeHtml(post.author_name)}</span>
          <span class="post-date" role="cell">${formatDate(post.created_at)}</span>
          <span class="post-views" role="cell">${Number(post.view_count || 0).toLocaleString('ko-KR')}</span>
        </div>
      `;
    }).join('');
  $('#emptyState').hidden = pagePosts.length > 0;
  renderPagination(totalPages);
  renderNotices();
}

function renderNotices() {
  const noticePosts = posts.filter((post) => post.is_notice);
  const notices = noticePosts.slice(0, 2);
  const strip = $('#noticeStrip');
  if (!notices.length || selectedCategory !== '전체글' || searchTerm) {
    strip.hidden = true;
    return;
  }
  if (noticePosts.length === 1 && !isConfidential(noticePosts[0])) {
    const [post] = noticePosts;
    const content = summarizeNoticeContent(post.content);
    const firstImage = post.image_urls?.[0];
    strip.innerHTML = `
      <button class="notice-single ${firstImage ? 'has-image' : ''}" type="button" data-post-id="${escapeHtml(post.id)}">
        <span class="notice-heading"><b>공지</b><strong>${escapeHtml(post.title)}</strong></span>
        ${content ? `<span class="notice-content">${escapeHtml(content)}</span>` : ''}
        ${firstImage ? `<img class="notice-thumbnail" src="${escapeHtml(imageUrl(firstImage))}" alt="" loading="lazy" decoding="async">` : ''}
      </button>
    `;
  } else {
    strip.innerHTML = notices.map((post) => `<button type="button" data-post-id="${escapeHtml(post.id)}"><b>공지</b> ${escapeHtml(post.title)}</button>`).join('');
  }
  strip.hidden = false;
}

function renderPagination(totalPages) {
  $('#pagination').innerHTML = Array.from({ length: totalPages }, (_, index) => index + 1)
    .map((page) => `<button class="page-button ${page === currentPage ? 'is-active' : ''}" type="button" data-page="${page}">${page}</button>`)
    .join('');
}

function renderCategoryNavigation() {
  const navigation = $('#categoryNav');
  if (!navigation) return;
  navigation.innerHTML = `
    <button class="nav-item ${isAllCategoriesSelected() ? 'is-active' : ''}" type="button" data-view="all">전체글</button>
    ${categories.map((category) => `
      <button class="nav-item ${selectedCategory === category.id ? 'is-active' : ''}" type="button" data-category-id="${escapeHtml(category.id)}">${escapeHtml(category.name)}</button>
    `).join('')}
  `;
}

function renderPostCategoryOptions() {
  const select = $('#postCategory');
  if (!select) return;
  const selectedValue = select.value;
  select.innerHTML = categories
    .map((category) => `<option value="${escapeHtml(category.id)}">${escapeHtml(category.name)}</option>`)
    .join('');
  if (categoryById(selectedValue)) select.value = selectedValue;
}

function renderShortcutList() {
  const list = $('#shortcutList');
  const editButton = $('#shortcutEditButton');
  if (editButton) editButton.hidden = !roleIsAdmin();
  if (!list) return;
  list.innerHTML = shortcuts.length
    ? shortcuts.map((shortcut) => `
      <a class="shortcut-link" href="${escapeHtml(shortcut.url)}" target="_blank" rel="noopener noreferrer">
        <span>${escapeHtml(shortcut.title)}</span><b aria-hidden="true">↗</b>
      </a>
    `).join('')
    : '<p class="shortcut-empty">등록된 바로가기 링크가 없습니다.</p>';
}

function renderCategoryDeletePanel() {
  const panel = $('#categoryDeletePanel');
  if (!panel) return;
  const target = categoryById(categoryDeleteTarget);
  if (!target) {
    categoryDeleteTarget = null;
    panel.hidden = true;
    return;
  }

  const otherCategories = categories.filter((category) => category.id !== target.id);
  const hasPosts = target.post_count > 0;
  const title = $('#categoryDeleteTitle');
  const notice = $('#categoryDeleteNotice');
  const replacementField = $('#categoryReplacementField');
  const replacementSelect = $('#categoryReplacementSelect');
  const confirmButton = $('#categoryDeleteConfirmButton');

  title.textContent = `“${target.name}” 카테고리 삭제`;
  if (hasPosts) {
    notice.textContent = `이 카테고리에는 게시글 ${target.post_count.toLocaleString('ko-KR')}개가 있습니다. 삭제하기 전에 모든 게시글을 다른 카테고리로 이동해야 합니다.`;
    replacementField.hidden = false;
    replacementSelect.innerHTML = `
      <option value="">이동할 카테고리를 선택하세요</option>
      ${otherCategories.map((category) => `<option value="${escapeHtml(category.id)}">${escapeHtml(category.name)}</option>`).join('')}
    `;
  } else {
    notice.textContent = otherCategories.length
      ? '게시글이 없는 카테고리입니다. 삭제한 뒤에는 되돌릴 수 없습니다.'
      : '마지막 카테고리는 삭제할 수 없습니다.';
    replacementField.hidden = true;
    replacementSelect.replaceChildren();
  }
  confirmButton.disabled = otherCategories.length === 0 || (hasPosts && !replacementSelect.value);
  panel.hidden = false;
}

function renderCategoryManager() {
  const settings = $('#categorySettings');
  const list = $('#categoryList');
  if (!settings || !list) return;
  const canManage = roleIsAdmin();
  settings.hidden = !canManage;
  if (!canManage) return;

  if (editingCategoryId && !categoryById(editingCategoryId)) editingCategoryId = null;
  list.innerHTML = categories.map((category, index) => {
    const isEditing = editingCategoryId === category.id;
    return `
      <article class="category-row" data-category-id="${escapeHtml(category.id)}">
        <div class="category-row-main">
          ${isEditing ? `
            <form class="category-rename-form" data-category-rename-form data-category-id="${escapeHtml(category.id)}">
              <label class="sr-only" for="categoryRename-${escapeHtml(category.id)}">카테고리 이름</label>
              <input id="categoryRename-${escapeHtml(category.id)}" name="name" maxlength="60" value="${escapeHtml(category.name)}" required>
              <button class="button button-primary" type="submit">저장</button>
              <button class="button button-ghost" type="button" data-category-cancel-rename>취소</button>
            </form>
          ` : `
            <strong>${escapeHtml(category.name)}</strong>
            <span>게시글 ${category.post_count.toLocaleString('ko-KR')}개</span>
          `}
        </div>
        ${isEditing ? '' : `
          <div class="category-row-actions" role="group" aria-label="${escapeHtml(category.name)} 카테고리 관리">
            <button class="button button-ghost" type="button" data-category-move="up" ${index === 0 ? 'disabled' : ''}>위로</button>
            <button class="button button-ghost" type="button" data-category-move="down" ${index === categories.length - 1 ? 'disabled' : ''}>아래로</button>
            <button class="button button-ghost" type="button" data-category-rename>이름 변경</button>
            <button class="button button-danger" type="button" data-category-delete>삭제</button>
          </div>
        `}
      </article>
    `;
  }).join('') || '<p class="category-empty">등록된 카테고리가 없습니다. 새 카테고리를 추가해주세요.</p>';
  renderCategoryDeletePanel();
}

function renderShortcutDeletePanel() {
  const panel = $('#shortcutDeletePanel');
  if (!panel) return;
  const target = shortcuts.find((shortcut) => shortcut.id === shortcutDeleteTarget);
  if (!target) {
    shortcutDeleteTarget = null;
    panel.hidden = true;
    return;
  }
  $('#shortcutDeleteTitle').textContent = `“${target.title}” 바로가기 삭제`;
  panel.hidden = false;
}

function renderShortcutManager() {
  const settings = $('#shortcutSettings');
  const list = $('#shortcutSettingsList');
  if (!settings || !list) return;
  const canManage = roleIsAdmin();
  settings.hidden = !canManage;
  if (!canManage) return;

  if (editingShortcutId && !shortcuts.some((shortcut) => shortcut.id === editingShortcutId)) editingShortcutId = null;
  list.innerHTML = shortcuts.map((shortcut, index) => {
    const isEditing = editingShortcutId === shortcut.id;
    return `
      <article class="shortcut-row" data-shortcut-id="${escapeHtml(shortcut.id)}">
        <div class="shortcut-row-main">
          ${isEditing ? `
            <form class="shortcut-edit-form" data-shortcut-edit-form data-shortcut-id="${escapeHtml(shortcut.id)}">
              <label class="sr-only" for="shortcutEditTitle-${escapeHtml(shortcut.id)}">바로가기 제목</label>
              <input id="shortcutEditTitle-${escapeHtml(shortcut.id)}" name="title" maxlength="100" value="${escapeHtml(shortcut.title)}" required>
              <label class="sr-only" for="shortcutEditUrl-${escapeHtml(shortcut.id)}">바로가기 주소</label>
              <input id="shortcutEditUrl-${escapeHtml(shortcut.id)}" name="url" type="url" maxlength="2048" value="${escapeHtml(shortcut.url)}" required>
              <div class="shortcut-edit-actions">
                <button class="button button-primary" type="submit">저장</button>
                <button class="button button-ghost" type="button" data-shortcut-cancel-edit>취소</button>
              </div>
            </form>
          ` : `
            <strong>${escapeHtml(shortcut.title)}</strong>
            <a href="${escapeHtml(shortcut.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(shortcut.url)}</a>
          `}
        </div>
        ${isEditing ? '' : `
          <div class="shortcut-row-actions" role="group" aria-label="${escapeHtml(shortcut.title)} 바로가기 관리">
            <button class="button button-ghost" type="button" data-shortcut-move="up" ${index === 0 ? 'disabled' : ''}>위로</button>
            <button class="button button-ghost" type="button" data-shortcut-move="down" ${index === shortcuts.length - 1 ? 'disabled' : ''}>아래로</button>
            <button class="button button-ghost" type="button" data-shortcut-edit>수정</button>
            <button class="button button-danger" type="button" data-shortcut-delete>삭제</button>
          </div>
        `}
      </article>
    `;
  }).join('') || '<p class="shortcut-empty">등록된 바로가기 링크가 없습니다. 새 링크를 추가해주세요.</p>';
  renderShortcutDeletePanel();
}

function renderHeader() {
  const categoryName = selectedCategoryName();
  $('#boardTitle').textContent = searchTerm ? `'${searchTerm}' 검색 결과` : isAllCategoriesSelected() ? '전체글보기' : categoryName;
  $('#boardEyebrow').textContent = searchTerm ? 'SEARCH RESULT' : isAllCategoriesSelected() ? 'ALL POSTS' : 'CATEGORY';
  $('#loginButton').textContent = currentUser ? `${currentProfile?.display_name || '관리자'} · 프로필/설정` : '로그인';
}

function renderAll() {
  renderCategoryNavigation();
  renderPostCategoryOptions();
  renderShortcutList();
  renderPosts();
  renderHeader();
  renderCategoryManager();
  renderShortcutManager();
}

function setCategory(categoryId) {
  selectedCategory = categoryId;
  searchTerm = '';
  currentPage = 1;
  $('#searchInput').value = '';
  renderAll();
}

function openLogin() {
  $('#loginMessage').textContent = '';
  $('#rememberLogin').checked = rememberLoginEnabled();
  $('#loginDialog').showModal();
}

function openProfile({ focusShortcuts = false } = {}) {
  if (!currentUser) return;
  $('#profileEmail').value = currentUser.email || '';
  $('#profileDisplayName').value = currentProfile?.display_name || '';
  $('#profileRole').textContent = currentProfile?.role || 'admin';
  $('#profileMessage').textContent = '';
  $('#categoryMessage').textContent = '';
  $('#shortcutMessage').textContent = '';
  editingCategoryId = null;
  categoryDeleteTarget = null;
  editingShortcutId = null;
  shortcutDeleteTarget = null;
  renderCategoryManager();
  renderShortcutManager();
  $('#profileDialog').showModal();
  if (focusShortcuts) {
    requestAnimationFrame(() => {
      $('#shortcutSettings')?.scrollIntoView({ block: 'start' });
      $('#shortcutTitleInput')?.focus();
    });
  }
}

async function saveProfile(event) {
  event.preventDefault();
  const displayName = $('#profileDisplayName').value.trim();
  const message = $('#profileMessage');
  if (!displayName || displayName.length > 20) {
    message.textContent = '작성자 이름은 1~20자로 입력해주세요.';
    return;
  }
  message.textContent = '저장 중...';
  try {
    await api('/api/profile', { method: 'PATCH', body: JSON.stringify({ display_name: displayName }) });
    await loadBoard();
    message.textContent = '프로필을 저장했습니다.';
    setTimeout(() => $('#profileDialog').open && $('#profileDialog').close(), 500);
  } catch (error) {
    message.textContent = error.message || '프로필을 저장하지 못했습니다.';
  }
}

function setCategoryMessage(message = '') {
  const element = $('#categoryMessage');
  if (element) element.textContent = message;
}

async function addCategory(event) {
  event.preventDefault();
  const input = $('#categoryNameInput');
  const name = input.value.trim();
  if (!name || name.length > 60) {
    setCategoryMessage('카테고리 이름은 1~60자로 입력해주세요.');
    return;
  }
  setCategoryMessage('카테고리를 추가하는 중...');
  try {
    await api('/api/categories', { method: 'POST', body: JSON.stringify({ name }) });
    input.value = '';
    await loadBoard();
    setCategoryMessage('카테고리를 추가했습니다.');
  } catch (error) {
    setCategoryMessage(error.message || '카테고리를 추가하지 못했습니다.');
  }
}

function beginCategoryRename(id) {
  if (!categoryById(id)) return;
  editingCategoryId = id;
  categoryDeleteTarget = null;
  renderCategoryManager();
  requestAnimationFrame(() => {
    const input = document.getElementById(`categoryRename-${id}`);
    input?.focus();
    input?.select();
  });
}

function cancelCategoryRename() {
  editingCategoryId = null;
  renderCategoryManager();
}

async function saveCategoryRename(event) {
  event.preventDefault();
  const form = event.target;
  const id = form.dataset.categoryId;
  const category = categoryById(id);
  const name = new FormData(form).get('name')?.toString().trim() || '';
  if (!category) return;
  if (!name || name.length > 60) {
    setCategoryMessage('카테고리 이름은 1~60자로 입력해주세요.');
    return;
  }
  if (name === category.name) {
    cancelCategoryRename();
    return;
  }
  setCategoryMessage('카테고리 이름을 저장하는 중...');
  try {
    await api(`/api/categories/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ name }) });
    editingCategoryId = null;
    await loadBoard();
    setCategoryMessage('카테고리 이름을 변경했습니다.');
  } catch (error) {
    setCategoryMessage(error.message || '카테고리 이름을 변경하지 못했습니다.');
  }
}

async function moveCategory(id, direction) {
  const index = categories.findIndex((category) => category.id === id);
  const destination = direction === 'up' ? index - 1 : index + 1;
  if (index < 0 || destination < 0 || destination >= categories.length) return;
  const reordered = [...categories];
  [reordered[index], reordered[destination]] = [reordered[destination], reordered[index]];
  setCategoryMessage('카테고리 순서를 저장하는 중...');
  try {
    await api('/api/categories/order', {
      method: 'PATCH',
      body: JSON.stringify({ category_ids: reordered.map((category) => category.id) })
    });
    await loadBoard();
    setCategoryMessage('카테고리 순서를 변경했습니다.');
  } catch (error) {
    setCategoryMessage(error.message || '카테고리 순서를 변경하지 못했습니다.');
  }
}

function updateCategoryDeleteConfirmButton() {
  const target = categoryById(categoryDeleteTarget);
  const otherCategories = target ? categories.filter((category) => category.id !== target.id) : [];
  const needsReplacement = Boolean(target?.post_count);
  $('#categoryDeleteConfirmButton').disabled = !target
    || otherCategories.length === 0
    || (needsReplacement && !$('#categoryReplacementSelect').value);
}

function beginCategoryDelete(id) {
  const category = categoryById(id);
  if (!category) return;
  editingCategoryId = null;
  categoryDeleteTarget = id;
  setCategoryMessage('');
  renderCategoryManager();
  requestAnimationFrame(() => {
    if (category.post_count > 0) $('#categoryReplacementSelect').focus();
  });
}

function cancelCategoryDelete() {
  categoryDeleteTarget = null;
  renderCategoryManager();
}

async function deleteCategory() {
  const target = categoryById(categoryDeleteTarget);
  if (!target) return;
  const replacementId = $('#categoryReplacementSelect').value;
  if (target.post_count > 0 && (!replacementId || replacementId === target.id || !categoryById(replacementId))) {
    setCategoryMessage('게시글을 이동할 다른 카테고리를 선택해주세요.');
    updateCategoryDeleteConfirmButton();
    return;
  }
  const confirmButton = $('#categoryDeleteConfirmButton');
  confirmButton.disabled = true;
  setCategoryMessage('카테고리를 삭제하는 중...');
  try {
    await api(`/api/categories/${encodeURIComponent(target.id)}`, {
      method: 'DELETE',
      body: JSON.stringify(replacementId ? { replacement_id: replacementId } : {})
    });
    if (selectedPost?.category_id === target.id) selectedPost = null;
    categoryDeleteTarget = null;
    await loadBoard();
    setCategoryMessage('카테고리를 삭제했습니다.');
  } catch (error) {
    setCategoryMessage(error.message || '카테고리를 삭제하지 못했습니다.');
    updateCategoryDeleteConfirmButton();
  }
}

function setShortcutMessage(message = '') {
  const element = $('#shortcutMessage');
  if (element) element.textContent = message;
}

function shortcutInputValues(form) {
  const values = new FormData(form);
  return {
    title: values.get('title')?.toString().trim() || '',
    url: normalizeShortcutUrl(values.get('url'))
  };
}

function validateShortcutInput({ title, url }) {
  if (!title || title.length > 100) return '바로가기 제목은 1~100자로 입력해주세요.';
  if (!url || url.length > 2048) return 'http 또는 https 주소를 입력해주세요.';
  return '';
}

async function addShortcut(event) {
  event.preventDefault();
  const values = shortcutInputValues(event.target);
  const validationMessage = validateShortcutInput(values);
  if (validationMessage) {
    setShortcutMessage(validationMessage);
    return;
  }
  setShortcutMessage('바로가기 링크를 추가하는 중...');
  try {
    await api('/api/shortcuts', { method: 'POST', body: JSON.stringify(values) });
    event.target.reset();
    await loadBoard();
    setShortcutMessage('바로가기 링크를 추가했습니다.');
  } catch (error) {
    setShortcutMessage(error.message || '바로가기 링크를 추가하지 못했습니다.');
  }
}

function beginShortcutEdit(id) {
  if (!shortcuts.some((shortcut) => shortcut.id === id)) return;
  editingShortcutId = id;
  shortcutDeleteTarget = null;
  renderShortcutManager();
  requestAnimationFrame(() => {
    const input = document.getElementById(`shortcutEditTitle-${id}`);
    input?.focus();
    input?.select();
  });
}

function cancelShortcutEdit() {
  editingShortcutId = null;
  renderShortcutManager();
}

async function saveShortcutEdit(event) {
  event.preventDefault();
  const form = event.target;
  const id = form.dataset.shortcutId;
  const shortcut = shortcuts.find((item) => item.id === id);
  const values = shortcutInputValues(form);
  if (!shortcut) return;
  const validationMessage = validateShortcutInput(values);
  if (validationMessage) {
    setShortcutMessage(validationMessage);
    return;
  }
  if (values.title === shortcut.title && values.url === shortcut.url) {
    cancelShortcutEdit();
    return;
  }
  setShortcutMessage('바로가기 링크를 저장하는 중...');
  try {
    await api(`/api/shortcuts/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(values) });
    editingShortcutId = null;
    await loadBoard();
    setShortcutMessage('바로가기 링크를 수정했습니다.');
  } catch (error) {
    setShortcutMessage(error.message || '바로가기 링크를 수정하지 못했습니다.');
  }
}

async function moveShortcut(id, direction) {
  const index = shortcuts.findIndex((shortcut) => shortcut.id === id);
  const destination = direction === 'up' ? index - 1 : index + 1;
  if (index < 0 || destination < 0 || destination >= shortcuts.length) return;
  const reordered = [...shortcuts];
  [reordered[index], reordered[destination]] = [reordered[destination], reordered[index]];
  setShortcutMessage('바로가기 링크 순서를 저장하는 중...');
  try {
    await api('/api/shortcuts/order', {
      method: 'PATCH',
      body: JSON.stringify({ shortcut_ids: reordered.map((shortcut) => shortcut.id) })
    });
    await loadBoard();
    setShortcutMessage('바로가기 링크 순서를 변경했습니다.');
  } catch (error) {
    setShortcutMessage(error.message || '바로가기 링크 순서를 변경하지 못했습니다.');
  }
}

function beginShortcutDelete(id) {
  if (!shortcuts.some((shortcut) => shortcut.id === id)) return;
  editingShortcutId = null;
  shortcutDeleteTarget = id;
  $('#shortcutDeleteConfirmButton').disabled = false;
  setShortcutMessage('');
  renderShortcutManager();
}

function cancelShortcutDelete() {
  shortcutDeleteTarget = null;
  renderShortcutManager();
}

async function deleteShortcut() {
  const shortcut = shortcuts.find((item) => item.id === shortcutDeleteTarget);
  if (!shortcut) return;
  const confirmButton = $('#shortcutDeleteConfirmButton');
  confirmButton.disabled = true;
  setShortcutMessage('바로가기 링크를 삭제하는 중...');
  try {
    await api(`/api/shortcuts/${encodeURIComponent(shortcut.id)}`, { method: 'DELETE' });
    shortcutDeleteTarget = null;
    await loadBoard();
    setShortcutMessage('바로가기 링크를 삭제했습니다.');
  } catch (error) {
    setShortcutMessage(error.message || '바로가기 링크를 삭제하지 못했습니다.');
    confirmButton.disabled = false;
  }
}

function openShortcutSettings() {
  if (!roleIsAdmin()) return;
  openProfile({ focusShortcuts: true });
}

function openEditor(post = null) {
  if (!currentUser || !currentProfile) {
    openLogin();
    return;
  }
  if (!categories.length) {
    alert('글을 작성하려면 먼저 카테고리를 하나 이상 추가해주세요.');
    return;
  }
  selectedPost = post;
  $('#editorTitle').textContent = post ? '글 수정' : '새 글 작성';
  $('#postId').value = post?.id || '';
  $('#postCategory').value = post?.category_id || categoryIdByName(post?.category) || (!isAllCategoriesSelected() ? selectedCategory : categories[0].id);
  $('#postAuthor').value = post?.author_name || currentProfile.display_name || '';
  $('#postAuthor').readOnly = true;
  $('#postTitle').value = post?.title || '';
  $('#postTags').value = normalizeTags(post?.tags).map((tag) => `#${tag}`).join(' ');
  editorImages = normalizeImagePaths(post?.image_urls).map((path) => ({ kind: 'retained', path }));
  $('#postImages').value = '';
  renderImageEditor();
  $('#postContent').value = post?.content || '';
  $('#postPinned').checked = Boolean(post?.is_pinned);
  $('#postPinned').disabled = !roleIsAdmin();
  $('#postNotice').checked = Boolean(post?.is_notice);
  $('#postNotice').disabled = !roleCanEditAll();
  $('#postConfidential').checked = isConfidential(post);
  $('#editorMessage').textContent = '';
  $('#viewerDialog').close();
  $('#editorDialog').showModal();
  editorIsDirty = false;
}

function markEditorDirty() {
  if ($('#editorDialog').open) editorIsDirty = true;
}

function confirmEditorDiscard() {
  return !editorIsDirty || window.confirm('작성 중인 내용과 이미지 변경 사항이 사라집니다. 닫을까요?');
}

function closeDialog(dialogId) {
  const dialog = document.getElementById(dialogId);
  if (!dialog?.open) return;
  if (dialogId === 'editorDialog' && !confirmEditorDiscard()) return;
  if (dialogId === 'editorDialog') editorIsDirty = false;
  dialog.close();
}

async function writeClipboardText(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall back for browsers that expose Clipboard API but deny its permission.
    }
  }

  const temporaryField = document.createElement('textarea');
  temporaryField.value = text;
  temporaryField.setAttribute('readonly', '');
  temporaryField.style.position = 'fixed';
  temporaryField.style.opacity = '0';
  document.body.append(temporaryField);
  try {
    temporaryField.select();
    return document.execCommand('copy');
  } finally {
    temporaryField.remove();
  }
}

function updateShareButton() {
  const button = $('#sharePostButton');
  const existingShareTag = findShareTag(selectedPost?.tags);
  button.disabled = false;
  button.textContent = existingShareTag ? '공유 링크 복사' : '공유 링크 생성 및 복사';
}

function updateSelectedPost(post) {
  const updated = { ...post, image_urls: normalizeImagePaths(post.image_urls) };
  const index = posts.findIndex((item) => String(item.id) === String(updated.id));
  if (index >= 0) posts[index] = updated;
  selectedPost = updated;
}

async function copySelectedPostContent() {
  if (!selectedPost) return;
  try {
    if (!await writeClipboardText(String(selectedPost.content || ''))) throw new Error('Copy command failed');
    const button = $('#copyPostContentButton');
    button.textContent = '복사됨';
    setTimeout(() => { if (button) button.textContent = '내용 복사'; }, 1400);
  } catch {
    alert('내용을 복사하지 못했습니다. 직접 선택해 복사해주세요.');
  }
}

async function copyPostShareLink() {
  if (!selectedPost) return;

  const button = $('#sharePostButton');
  const message = $('#shareLinkMessage');
  let shareTag = findShareTag(selectedPost.tags);
  let link = shareTag ? shareUrl(shareTag) : '';
  button.disabled = true;
  message.textContent = '';

  try {
    if (!shareTag) {
      button.textContent = '생성 중...';
      const data = await api(`/api/posts/${encodeURIComponent(selectedPost.id)}/share`, { method: 'POST' });
      if (!data.post || !isShareTag(data.shareTag)) throw new Error('공유 링크 정보를 확인하지 못했습니다.');
      updateSelectedPost(data.post);
      shareTag = data.shareTag;
      link = typeof data.shareUrl === 'string' ? data.shareUrl : shareUrl(shareTag);
      $('#viewerTags').innerHTML = renderTags(selectedPost.tags);
      $('#viewerTags').hidden = normalizeTags(selectedPost.tags).length === 0;
      renderAll();
    }

    if (!await writeClipboardText(link)) throw new Error('Copy command failed');
    button.textContent = '복사됨';
    setTimeout(() => updateShareButton(), 1400);
  } catch (error) {
    message.textContent = error.message || '공유 링크를 복사하지 못했습니다. 다시 시도해주세요.';
    updateShareButton();
  }
}

async function openViewer(id) {
  const post = posts.find((item) => String(item.id) === String(id));
  if (!post) return;
  if (isConfidential(post) && !window.confirm('기밀 자료입니다. Discord 화면 공유가 꺼져 있는지 확인한 뒤 열어주세요.')) return;
  selectedPost = post;
  try {
    await api(`/api/posts/${encodeURIComponent(selectedPost.id)}/view`, { method: 'POST' });
    selectedPost.view_count = Number(selectedPost.view_count || 0) + 1;
  } catch (error) {
    console.warn(error);
  }
  $('#viewerCategory').textContent = isConfidential(selectedPost) ? '🔒 기밀 자료' : formatPostCategory(selectedPost);
  $('#viewerTitle').textContent = selectedPost.title;
  $('#viewerMeta').textContent = `${selectedPost.author_name} · ${formatFullDate(selectedPost.created_at)} · 조회 ${Number(selectedPost.view_count || 0).toLocaleString('ko-KR')}`;
  $('#viewerTags').innerHTML = renderTags(selectedPost.tags);
  $('#viewerTags').hidden = normalizeTags(selectedPost.tags).length === 0;
  const imagePaths = normalizeImagePaths(selectedPost.image_urls);
  $('#viewerImages').innerHTML = imagePaths.map((path) => `<img src="${escapeHtml(imageUrl(path))}" alt="${escapeHtml(selectedPost.title)} 첨부 이미지" loading="lazy">`).join('');
  $('#viewerImages').hidden = imagePaths.length === 0;
  appendLinkedText($('#viewerContent'), selectedPost.content);
  $('#editPostButton').hidden = !canEdit(selectedPost);
  $('#deletePostButton').hidden = !canDelete(selectedPost);
  $('#shareLinkMessage').textContent = '';
  updateShareButton();
  $('#viewerDialog').showModal();
  renderAll();
}

async function savePost(event) {
  event.preventDefault();
  const id = $('#postId').value;
  const original = posts.find((post) => String(post.id) === String(id));
  const payload = {
    category_id: $('#postCategory').value,
    title: $('#postTitle').value.trim(),
    tags: normalizeTags($('#postTags').value),
    content: $('#postContent').value.trim(),
    is_pinned: $('#postPinned').checked,
    is_notice: $('#postNotice').checked,
    is_confidential: $('#postConfidential').checked
  };
  if (!payload.category_id || !payload.title || !payload.content) {
    $('#editorMessage').textContent = '빈칸을 모두 채워주세요.';
    return;
  }
  try {
    if (payload.is_pinned && !original?.is_pinned && posts.filter((post) => post.is_pinned).length >= 2) {
      throw new Error('최상단 고정은 최대 2개까지만 가능합니다.');
    }
    payload.image_urls = await uploadEditorImages();
    if (id) {
      if (!canEdit(original)) throw new Error('수정 권한이 없습니다.');
      await api(`/api/posts/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(payload) });
    } else {
      await api('/api/posts', { method: 'POST', body: JSON.stringify(payload) });
    }
    editorIsDirty = false;
    $('#editorDialog').close();
    await loadBoard();
  } catch (error) {
    $('#editorMessage').textContent = error.message || '저장하지 못했습니다.';
  }
}

async function deleteSelectedPost() {
  if (!selectedPost || !canDelete(selectedPost) || !confirm('이 글을 삭제할까요?')) return;
  try {
    await api(`/api/posts/${encodeURIComponent(selectedPost.id)}`, { method: 'DELETE' });
    $('#viewerDialog').close();
    selectedPost = null;
    await loadBoard();
  } catch (error) {
    alert(error.message || '삭제하지 못했습니다.');
  }
}

async function submitLogin(event) {
  event.preventDefault();
  const message = $('#loginMessage');
  const email = $('#loginEmail').value.trim();
  const persistent = $('#rememberLogin').checked;
  localStorage.setItem(rememberLoginSettingKey, persistent ? 'true' : 'false');
  message.textContent = '로그인 링크를 보내는 중...';
  try {
    await api('/api/auth/request', { method: 'POST', body: JSON.stringify({ email, persistent }) });
    message.textContent = '메일함의 가장 최근 로그인 메일을 열고, 안내 화면에서 로그인 계속하기를 눌러주세요.';
  } catch (error) {
    // Do not present a failed server request as if a link was sent. The API
    // already uses the same success response for unapproved addresses, so
    // showing a real transport/configuration error here does not expose the
    // private allowlist.
    message.textContent = error.message || '로그인 링크를 보내지 못했습니다. 잠시 후 다시 시도해주세요.';
  }
}

async function consumeMagicLink() {
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  const errorCode = fragment.get('error_code');
  if (errorCode) {
    window.history.replaceState({}, document.title, `${window.location.pathname}${window.location.search}`);
    return { errorCode };
  }
  const accessToken = fragment.get('access_token');
  const refreshToken = fragment.get('refresh_token');
  if (!accessToken || !refreshToken) return { errorCode: null };
  let callback;
  try {
    callback = await api('/api/auth/callback', {
      method: 'POST',
      body: JSON.stringify({
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_in: Number(fragment.get('expires_in') || 0),
        persistent: rememberLoginEnabled()
      })
    });
  } finally {
    window.history.replaceState({}, document.title, `${window.location.pathname}${window.location.search}`);
  }
  return { errorCode: null, bootstrap: callback?.bootstrap || null };
}

function bindEvents() {
  $('.view-toggle').addEventListener('click', (event) => {
    const button = event.target.closest('[data-view-mode]');
    if (!button || button.dataset.viewMode === viewMode) return;
    viewMode = button.dataset.viewMode;
    localStorage.setItem(viewModeStorageKey, viewMode);
    currentPage = 1;
    renderPosts();
  });
  $('.community-nav').addEventListener('click', (event) => {
    const button = event.target.closest('.nav-item');
    if (button) setCategory(button.dataset.categoryId || '전체글');
  });
  $('#searchForm').addEventListener('submit', (event) => {
    event.preventDefault();
    searchTerm = $('#searchInput').value.trim();
    currentPage = 1;
    renderAll();
  });
  $('#postList').addEventListener('click', (event) => {
    const row = event.target.closest('[data-post-id]');
    if (row) void openViewer(row.dataset.postId);
  });
  $('#postList').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      const row = event.target.closest('[data-post-id]');
      if (row) { event.preventDefault(); void openViewer(row.dataset.postId); }
    }
  });
  $('#noticeStrip').addEventListener('click', (event) => {
    const button = event.target.closest('[data-post-id]');
    if (button) void openViewer(button.dataset.postId);
  });
  $('#pagination').addEventListener('click', (event) => {
    const button = event.target.closest('[data-page]');
    if (button) {
      currentPage = Number(button.dataset.page);
      renderPosts();
      window.scrollTo({ top: $('.board-card').offsetTop - 100, behavior: 'smooth' });
    }
  });
  $('#writeButton').addEventListener('click', () => openEditor());
  $('#postForm').addEventListener('submit', savePost);
  $('#postForm').addEventListener('input', markEditorDirty);
  $('#postForm').addEventListener('change', markEditorDirty);
  $('#postImages').addEventListener('change', (event) => {
    const available = Math.max(0, maxImagesPerPost - editorImages.length);
    const selected = [...event.target.files];
    const valid = selected.filter((file) => ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.type) && file.size <= 25 * 1024 * 1024).slice(0, available);
    editorImages.push(...valid.map((file) => ({ kind: 'pending', file })));
    if (valid.length !== selected.length) $('#editorMessage').textContent = '이미지는 최대 10장, 한 장당 25MB 이하로 올려주세요.';
    event.target.value = '';
    if (valid.length) markEditorDirty();
    renderImageEditor();
  });
  $('#imageEditorList').addEventListener('click', (event) => {
    const removeButton = event.target.closest('[data-remove-image]');
    if (!removeButton) return;
    editorImages.splice(Number(removeButton.dataset.removeImage), 1);
    markEditorDirty();
    renderImageEditor();
  });
  $('#imageEditorList').addEventListener('dragstart', (event) => {
    const item = event.target.closest('[data-image-index]');
    if (!item) return;
    draggedImageIndex = Number(item.dataset.imageIndex);
    item.classList.add('is-dragging');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', String(draggedImageIndex));
  });
  $('#imageEditorList').addEventListener('dragover', (event) => {
    const item = event.target.closest('[data-image-index]');
    if (!item || draggedImageIndex === null) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    $$('.image-editor-item.is-drop-target').forEach((target) => target.classList.remove('is-drop-target'));
    item.classList.add('is-drop-target');
  });
  $('#imageEditorList').addEventListener('dragleave', (event) => {
    const item = event.target.closest('[data-image-index]');
    if (item && !item.contains(event.relatedTarget)) item.classList.remove('is-drop-target');
  });
  $('#imageEditorList').addEventListener('dragend', () => {
    draggedImageIndex = null;
    $$('.image-editor-item.is-dragging, .image-editor-item.is-drop-target').forEach((item) => item.classList.remove('is-dragging', 'is-drop-target'));
  });
  $('#imageEditorList').addEventListener('drop', (event) => {
    const item = event.target.closest('[data-image-index]');
    if (!item || draggedImageIndex === null) return;
    event.preventDefault();
    const fromIndex = draggedImageIndex;
    const targetIndex = Number(item.dataset.imageIndex);
    const bounds = item.getBoundingClientRect();
    let insertAt = targetIndex + (event.clientY > bounds.top + bounds.height / 2 ? 1 : 0);
    const [image] = editorImages.splice(fromIndex, 1);
    if (fromIndex < insertAt) insertAt -= 1;
    editorImages.splice(insertAt, 0, image);
    draggedImageIndex = null;
    markEditorDirty();
    renderImageEditor();
  });
  $('#editPostButton').addEventListener('click', () => openEditor(selectedPost));
  $('#deletePostButton').addEventListener('click', () => void deleteSelectedPost());
  $('#copyPostContentButton').addEventListener('click', () => void copySelectedPostContent());
  $('#sharePostButton').addEventListener('click', () => void copyPostShareLink());
  $('#loginButton').addEventListener('click', () => currentUser ? openProfile() : openLogin());
  $('#gateLoginButton').addEventListener('click', openLogin);
  $('#authGateRetryButton').addEventListener('click', () => window.location.reload());
  $('#loginForm').addEventListener('submit', submitLogin);
  $('#profileForm').addEventListener('submit', saveProfile);
  $('#categoryAddForm').addEventListener('submit', (event) => void addCategory(event));
  $('#categoryList').addEventListener('submit', (event) => {
    if (event.target.matches('[data-category-rename-form]')) void saveCategoryRename(event);
  });
  $('#categoryList').addEventListener('click', (event) => {
    const row = event.target.closest('[data-category-id]');
    if (!row) return;
    const id = row.dataset.categoryId;
    if (event.target.closest('[data-category-cancel-rename]')) {
      cancelCategoryRename();
    } else if (event.target.closest('[data-category-rename]')) {
      beginCategoryRename(id);
    } else if (event.target.closest('[data-category-delete]')) {
      beginCategoryDelete(id);
    } else {
      const moveButton = event.target.closest('[data-category-move]');
      if (moveButton) void moveCategory(id, moveButton.dataset.categoryMove);
    }
  });
  $('#categoryReplacementSelect').addEventListener('change', updateCategoryDeleteConfirmButton);
  $('#categoryDeleteCancelButton').addEventListener('click', cancelCategoryDelete);
  $('#categoryDeleteConfirmButton').addEventListener('click', () => void deleteCategory());
  $('#shortcutAddForm').addEventListener('submit', (event) => void addShortcut(event));
  $('#shortcutSettingsList').addEventListener('submit', (event) => {
    if (event.target.matches('[data-shortcut-edit-form]')) void saveShortcutEdit(event);
  });
  $('#shortcutSettingsList').addEventListener('click', (event) => {
    const row = event.target.closest('[data-shortcut-id]');
    if (!row) return;
    const id = row.dataset.shortcutId;
    if (event.target.closest('[data-shortcut-cancel-edit]')) {
      cancelShortcutEdit();
    } else if (event.target.closest('[data-shortcut-edit]')) {
      beginShortcutEdit(id);
    } else if (event.target.closest('[data-shortcut-delete]')) {
      beginShortcutDelete(id);
    } else {
      const moveButton = event.target.closest('[data-shortcut-move]');
      if (moveButton) void moveShortcut(id, moveButton.dataset.shortcutMove);
    }
  });
  $('#shortcutDeleteCancelButton').addEventListener('click', cancelShortcutDelete);
  $('#shortcutDeleteConfirmButton').addEventListener('click', () => void deleteShortcut());
  $('#profileLogoutButton').addEventListener('click', async () => {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } finally {
      clearBoardState();
      setBoardVisibility(false);
    }
  });
  $('#shortcutToggle').addEventListener('click', () => {
    const list = $('#shortcutList');
    const collapsed = list.classList.toggle('is-collapsed');
    $('#shortcutToggle').textContent = collapsed ? '펼치기' : '접기';
    $('#shortcutToggle').setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  });
  $('#shortcutEditButton').addEventListener('click', openShortcutSettings);
  $$('[data-close-dialog]').forEach((button) => button.addEventListener('click', () => closeDialog(button.dataset.closeDialog)));
  $$('.modal').forEach((dialog) => dialog.addEventListener('click', (event) => { if (event.target === dialog) closeDialog(dialog.id); }));
  $('#editorDialog').addEventListener('cancel', (event) => {
    if (!confirmEditorDiscard()) event.preventDefault();
    else editorIsDirty = false;
  });
  window.addEventListener('beforeunload', (event) => {
    if (!$('#editorDialog').open || !editorIsDirty) return;
    event.preventDefault();
    event.returnValue = '';
  });
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((error) => console.warn('Service worker registration failed.', error));
  });
}

async function start() {
  showBootLoading();
  if (boardConfig.siteName) {
    document.title = boardConfig.siteName;
    $('.brand strong').textContent = boardConfig.siteName;
    $('.site-footer span').textContent = boardConfig.siteName;
  }
  $('#rememberLogin').checked = rememberLoginEnabled();
  bindEvents();
  registerServiceWorker();
  const sharedSearch = prepareSharedSearch();
  try {
    const magicLink = await consumeMagicLink();
    if (magicLink?.errorCode) {
      setBoardVisibility(false, magicLink.errorCode === 'otp_expired'
        ? '로그인 링크가 이미 사용되었거나 만료되었습니다. 가장 최근 로그인 메일의 안내 화면에서 로그인 계속하기를 눌러주세요.'
        : '로그인 링크를 확인하지 못했습니다. 새 로그인 메일을 요청한 뒤 다시 시도해주세요.');
      return;
    }
    if (magicLink?.bootstrap) applyBoardData(magicLink.bootstrap);
    else await loadStartupBoard();
    clearPendingSharedSearchTerm();
    const post = sharedSearch ? preferredSearchResult(sharedSearch) : null;
    if (post) await openViewer(post.id);
  } catch (error) {
    console.error(error);
    if (error.status === 401 || error.status === 403) {
      setBoardVisibility(false);
    } else {
      showConnectionRecoveryGate();
    }
  }
}

void start();
