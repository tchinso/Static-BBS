const categories = [
  { name: '외형 프롬프트', icon: '외형' },
  { name: 'ooc', icon: 'OOC' },
  { name: '유저 노트', icon: '노트' },
  { name: '앵캐 추천', icon: '추천' },
  { name: '자료실', icon: '자료' }
];

const legacyCategoryNames = {
  '공지사항': '외형 프롬프트',
  '자유게시판': 'ooc',
  '정보공유': '유저 노트',
  '정보 공유': '유저 노트',
  '질문답변': '앵캐 추천',
  '질문 답변': '앵캐 추천'
};

const boardConfig = window.BOARD_CONFIG || {};
const viewModeStorageKey = 'nyangcatmemoBoardViewMode';
const rememberLoginSettingKey = 'nyangcatmemoRememberLogin';
const pageSize = 10;

let currentUser = null;
let currentProfile = null;
let posts = [];
let filteredPosts = [];
let selectedCategory = '전체글';
let searchTerm = '';
let currentPage = 1;
let viewMode = localStorage.getItem(viewModeStorageKey) === 'gallery' ? 'gallery' : 'list';
let selectedPost = null;
let retainedImageUrls = [];
let pendingImageFiles = [];
let memberCount = null;

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

// Never leave previously fetched private content in the DOM after logout or a
// rejected/expired session.  The visual gate is not relied on as the security
// boundary, but clearing it also prevents a local inspector from unhiding a
// stale board view.
function clearBoardState() {
  currentUser = null;
  currentProfile = null;
  posts = [];
  filteredPosts = [];
  selectedPost = null;
  retainedImageUrls = [];
  pendingImageFiles = [];
  memberCount = null;
  currentPage = 1;

  ['#postList', '#pagination', '#viewerTags', '#viewerImages', '#imageEditorList'].forEach((selector) => {
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
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function rememberLoginEnabled() {
  return localStorage.getItem(rememberLoginSettingKey) !== 'false';
}

function setBoardVisibility(visible, message = '승인된 이메일로 로그인하면 게시판을 볼 수 있습니다.') {
  $('#appShell').hidden = !visible;
  $('#authGate').hidden = visible;
  if (!visible) $('#authGateMessage').textContent = message;
}

function createApiError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    headers: {
      ...(options.body instanceof FormData ? {} : options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {})
    }
  });
  const contentType = response.headers.get('content-type') || '';
  const body = contentType.includes('application/json') ? await response.json().catch(() => ({})) : {};
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      clearBoardState();
      setBoardVisibility(false);
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

async function loadBoard() {
  const data = await api('/api/bootstrap');
  currentUser = data.user || null;
  currentProfile = data.profile || null;
  posts = (data.posts || []).map((post) => ({
    ...post,
    category: legacyCategoryNames[post.category] || post.category,
    image_urls: normalizeImagePaths(post.image_urls)
  }));
  memberCount = Number.isFinite(data.memberCount) ? data.memberCount : null;
  setBoardVisibility(true);
  renderAll();
}

function applyFilters() {
  const query = searchTerm.toLocaleLowerCase('ko');
  filteredPosts = posts.filter((post) => {
    const categoryMatch = selectedCategory === '전체글' || post.category === selectedCategory;
    const textMatch = !query || `${post.title} ${post.content} ${post.author_name} ${(post.tags || []).join(' ')}`.toLocaleLowerCase('ko').includes(query);
    return categoryMatch && textMatch;
  });
}

function renderImageEditor() {
  const existing = retainedImageUrls.map((path, index) => `
    <div class="image-editor-item">
      <img src="${escapeHtml(imageUrl(path))}" alt="첨부 이미지 미리보기">
      <button type="button" data-remove-existing-image="${index}">삭제</button>
    </div>
  `);
  const pending = pendingImageFiles.map((file, index) => `
    <div class="image-editor-item is-pending">
      <span>${escapeHtml(file.name)}</span>
      <button type="button" data-remove-pending-image="${index}">삭제</button>
    </div>
  `);
  $('#imageEditorList').innerHTML = [...existing, ...pending].join('');
}

async function uploadPendingImages() {
  if (!pendingImageFiles.length) return [...retainedImageUrls];
  const paths = [...retainedImageUrls];
  for (const file of pendingImageFiles) {
    const formData = new FormData();
    formData.append('file', file, file.name);
    const data = await api('/api/images', { method: 'POST', body: formData });
    if (!data.path) throw new Error('이미지 업로드 결과를 확인하지 못했습니다.');
    paths.push(data.path);
  }
  return normalizeImagePaths(paths);
}

function renderCategories() {
  const counts = Object.fromEntries(categories.map(({ name }) => [name, posts.filter((post) => post.category === name).length]));
  $('#categoryList').innerHTML = [
    `<button class="category-button ${selectedCategory === '전체글' ? 'is-active' : ''}" type="button" data-category="전체글"><span>전체글보기</span><em>${posts.length}</em></button>`,
    ...categories.map(({ name }) => `<button class="category-button ${selectedCategory === name ? 'is-active' : ''}" type="button" data-category="${escapeHtml(name)}"><span>${escapeHtml(name)}</span><em>${counts[name] || 0}</em></button>`)
  ].join('');
}

function renderPosts() {
  applyFilters();
  const currentPageSize = viewMode === 'gallery' ? 9 : pageSize;
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
      const firstImage = post.image_urls?.[0];
      const preview = String(post.content || '').replace(/\s+/g, ' ').trim();
      return `
        <article class="gallery-card ${post.is_notice ? 'is-notice' : ''} ${post.is_pinned ? 'is-pinned' : ''}" role="listitem" tabindex="0" data-post-id="${escapeHtml(post.id)}">
          <div class="gallery-thumb">
            ${firstImage ? `<img src="${escapeHtml(imageUrl(firstImage))}" alt="${escapeHtml(post.title)}" loading="lazy">` : '<div class="gallery-placeholder"><span>NO IMAGE</span></div>'}
            <span class="gallery-category">${post.is_pinned ? '📌 고정' : post.is_notice ? '공지' : escapeHtml(post.category)}</span>
          </div>
          <div class="gallery-body">
            <h3>${escapeHtml(post.title)}</h3>
            ${preview ? `<p>${escapeHtml(preview)}</p>` : ''}
            ${post.tags?.length ? `<div class="post-tags">${renderTags(post.tags)}</div>` : ''}
            <div class="gallery-meta"><span>${escapeHtml(post.author_name)}</span><span>${formatDate(post.created_at)} · 조회 ${Number(post.view_count || 0).toLocaleString('ko-KR')}</span></div>
          </div>
        </article>
      `;
    }).join('')
    : pagePosts.map((post) => `
      <div class="post-row post-item ${post.is_notice ? 'is-notice' : ''} ${post.is_pinned ? 'is-pinned' : ''}" role="row" tabindex="0" data-post-id="${escapeHtml(post.id)}">
        <span class="post-category" role="cell">${post.is_notice ? '공지' : escapeHtml(post.category)}</span>
        <span class="post-title" role="cell"><span class="post-title-text">${post.is_pinned ? '<span class="pin">📌</span>' : ''}${post.is_notice ? '<span class="pin">●</span>' : ''}${post.image_urls?.length ? '<span class="image-indicator">▣</span>' : ''}${escapeHtml(post.title)}</span>${post.tags?.length ? `<span class="post-tags">${renderTags(post.tags)}</span>` : ''}</span>
        <span class="post-author" role="cell">${escapeHtml(post.author_name)}</span>
        <span class="post-date" role="cell">${formatDate(post.created_at)}</span>
        <span class="post-views" role="cell">${Number(post.view_count || 0).toLocaleString('ko-KR')}</span>
      </div>
    `).join('');
  $('#emptyState').hidden = pagePosts.length > 0;
  renderPagination(totalPages);
  renderNotices();
}

function renderNotices() {
  const notices = posts.filter((post) => post.is_notice).slice(0, 2);
  const strip = $('#noticeStrip');
  if (!notices.length || selectedCategory !== '전체글' || searchTerm) {
    strip.hidden = true;
    return;
  }
  strip.innerHTML = notices.map((post) => `<button type="button" data-post-id="${escapeHtml(post.id)}"><b>공지</b> ${escapeHtml(post.title)}</button>`).join('');
  strip.hidden = false;
}

function renderPagination(totalPages) {
  $('#pagination').innerHTML = Array.from({ length: totalPages }, (_, index) => index + 1)
    .map((page) => `<button class="page-button ${page === currentPage ? 'is-active' : ''}" type="button" data-page="${page}">${page}</button>`)
    .join('');
}

function renderHeader() {
  $('#boardTitle').textContent = searchTerm ? `'${searchTerm}' 검색 결과` : selectedCategory === '전체글' ? '전체글보기' : selectedCategory;
  $('#boardEyebrow').textContent = searchTerm ? 'SEARCH RESULT' : selectedCategory === '전체글' ? 'ALL POSTS' : 'CATEGORY';
  $('#loginButton').textContent = currentUser ? `${currentProfile?.display_name || '관리자'} · 프로필` : '로그인';
}

function renderAll() {
  renderCategories();
  renderPosts();
  renderHeader();
  $('#postCategory').innerHTML = categories.map(({ name }) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('');
}

function setCategory(category) {
  selectedCategory = category;
  searchTerm = '';
  currentPage = 1;
  $('#searchInput').value = '';
  $$('.nav-item').forEach((button) => button.classList.toggle('is-active', (category === '전체글' && button.dataset.view === 'all') || button.dataset.category === category));
  renderAll();
}

function openLogin() {
  $('#loginMessage').textContent = '';
  $('#rememberLogin').checked = rememberLoginEnabled();
  $('#loginDialog').showModal();
}

function openProfile() {
  if (!currentUser) return;
  $('#profileEmail').value = currentUser.email || '';
  $('#profileDisplayName').value = currentProfile?.display_name || '';
  $('#profileRole').textContent = currentProfile?.role || 'admin';
  $('#profileMessage').textContent = '';
  $('#profileDialog').showModal();
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

function openEditor(post = null) {
  if (!currentUser || !currentProfile) {
    openLogin();
    return;
  }
  selectedPost = post;
  $('#editorTitle').textContent = post ? '글 수정' : '새 글 작성';
  $('#postId').value = post?.id || '';
  $('#postCategory').value = post?.category || (selectedCategory !== '전체글' ? selectedCategory : 'ooc');
  $('#postAuthor').value = post?.author_name || currentProfile.display_name || '';
  $('#postAuthor').readOnly = true;
  $('#postTitle').value = post?.title || '';
  $('#postTags').value = normalizeTags(post?.tags).map((tag) => `#${tag}`).join(' ');
  retainedImageUrls = normalizeImagePaths(post?.image_urls);
  pendingImageFiles = [];
  $('#postImages').value = '';
  renderImageEditor();
  $('#postContent').value = post?.content || '';
  $('#postPinned').checked = Boolean(post?.is_pinned);
  $('#postPinned').disabled = !roleIsAdmin();
  $('#postNotice').checked = Boolean(post?.is_notice);
  $('#postNotice').disabled = !roleCanEditAll();
  $('#editorMessage').textContent = '';
  $('#viewerDialog').close();
  $('#editorDialog').showModal();
}

async function openViewer(id) {
  selectedPost = posts.find((post) => String(post.id) === String(id));
  if (!selectedPost) return;
  try {
    await api(`/api/posts/${encodeURIComponent(selectedPost.id)}/view`, { method: 'POST' });
    selectedPost.view_count = Number(selectedPost.view_count || 0) + 1;
  } catch (error) {
    console.warn(error);
  }
  $('#viewerCategory').textContent = selectedPost.is_pinned ? '📌 최상단 고정' : selectedPost.is_notice ? '공지' : selectedPost.category;
  $('#viewerTitle').textContent = selectedPost.title;
  $('#viewerMeta').textContent = `${selectedPost.author_name} · ${formatFullDate(selectedPost.created_at)} · 조회 ${Number(selectedPost.view_count || 0).toLocaleString('ko-KR')}`;
  $('#viewerTags').innerHTML = renderTags(selectedPost.tags);
  $('#viewerTags').hidden = normalizeTags(selectedPost.tags).length === 0;
  const imagePaths = normalizeImagePaths(selectedPost.image_urls);
  $('#viewerImages').innerHTML = imagePaths.map((path) => `<img src="${escapeHtml(imageUrl(path))}" alt="${escapeHtml(selectedPost.title)} 첨부 이미지" loading="lazy">`).join('');
  $('#viewerImages').hidden = imagePaths.length === 0;
  $('#viewerContent').textContent = selectedPost.content;
  $('#editPostButton').hidden = !canEdit(selectedPost);
  $('#deletePostButton').hidden = !canDelete(selectedPost);
  $('#viewerDialog').showModal();
  renderAll();
}

async function savePost(event) {
  event.preventDefault();
  const id = $('#postId').value;
  const original = posts.find((post) => String(post.id) === String(id));
  const payload = {
    category: $('#postCategory').value,
    title: $('#postTitle').value.trim(),
    tags: normalizeTags($('#postTags').value),
    content: $('#postContent').value.trim(),
    is_pinned: $('#postPinned').checked,
    is_notice: $('#postNotice').checked
  };
  if (!payload.title || !payload.content) {
    $('#editorMessage').textContent = '빈칸을 모두 채워주세요.';
    return;
  }
  try {
    if (payload.is_pinned && !original?.is_pinned && posts.filter((post) => post.is_pinned).length >= 2) {
      throw new Error('최상단 고정은 최대 2개까지만 가능합니다.');
    }
    payload.image_urls = await uploadPendingImages();
    if (id) {
      if (!canEdit(original)) throw new Error('수정 권한이 없습니다.');
      await api(`/api/posts/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(payload) });
    } else {
      await api('/api/posts', { method: 'POST', body: JSON.stringify(payload) });
    }
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
  localStorage.setItem(rememberLoginSettingKey, $('#rememberLogin').checked ? 'true' : 'false');
  message.textContent = '로그인 링크를 보내는 중...';
  try {
    await api('/api/auth/request', { method: 'POST', body: JSON.stringify({ email }) });
    message.textContent = '메일함에서 로그인 링크를 눌러주세요.';
  } catch {
    message.textContent = '메일함에서 로그인 링크를 확인해주세요.';
  }
}

async function consumeMagicLink() {
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  const accessToken = fragment.get('access_token');
  const refreshToken = fragment.get('refresh_token');
  if (!accessToken || !refreshToken) return;
  try {
    await api('/api/auth/callback', {
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
  $('#categoryList').addEventListener('click', (event) => {
    const button = event.target.closest('[data-category]');
    if (button) setCategory(button.dataset.category);
  });
  $('.community-nav').addEventListener('click', (event) => {
    const button = event.target.closest('.nav-item');
    if (button) setCategory(button.dataset.category || '전체글');
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
  $('#postImages').addEventListener('change', (event) => {
    const available = Math.max(0, 5 - retainedImageUrls.length - pendingImageFiles.length);
    const selected = [...event.target.files];
    const valid = selected.filter((file) => ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.type) && file.size <= 8 * 1024 * 1024).slice(0, available);
    pendingImageFiles.push(...valid);
    if (valid.length !== selected.length) $('#editorMessage').textContent = '이미지는 최대 5장, 한 장당 8MB 이하로 올려주세요.';
    event.target.value = '';
    renderImageEditor();
  });
  $('#imageEditorList').addEventListener('click', (event) => {
    const existingButton = event.target.closest('[data-remove-existing-image]');
    const pendingButton = event.target.closest('[data-remove-pending-image]');
    if (existingButton) retainedImageUrls.splice(Number(existingButton.dataset.removeExistingImage), 1);
    if (pendingButton) pendingImageFiles.splice(Number(pendingButton.dataset.removePendingImage), 1);
    if (existingButton || pendingButton) renderImageEditor();
  });
  $('#editPostButton').addEventListener('click', () => openEditor(selectedPost));
  $('#deletePostButton').addEventListener('click', () => void deleteSelectedPost());
  $('#loginButton').addEventListener('click', () => currentUser ? openProfile() : openLogin());
  $('#gateLoginButton').addEventListener('click', openLogin);
  $('#loginForm').addEventListener('submit', submitLogin);
  $('#profileForm').addEventListener('submit', saveProfile);
  $('#profileLogoutButton').addEventListener('click', async () => {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } finally {
      clearBoardState();
      setBoardVisibility(false);
    }
  });
  $('#mobileCategoryToggle').addEventListener('click', () => {
    const list = $('#categoryList');
    const collapsed = list.classList.toggle('is-collapsed');
    $('#mobileCategoryToggle').textContent = collapsed ? '펼치기' : '접기';
    $('#mobileCategoryToggle').setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  });
  $('#shortcutToggle').addEventListener('click', () => {
    const list = $('#shortcutList');
    const collapsed = list.classList.toggle('is-collapsed');
    $('#shortcutToggle').textContent = collapsed ? '펼치기' : '접기';
    $('#shortcutToggle').setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  });
  $$('[data-close-dialog]').forEach((button) => button.addEventListener('click', () => document.getElementById(button.dataset.closeDialog).close()));
  $$('.modal').forEach((dialog) => dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); }));
}

async function start() {
  if (boardConfig.siteName) {
    document.title = boardConfig.siteName;
    $('.brand strong').textContent = boardConfig.siteName;
    $('.site-footer span').textContent = boardConfig.siteName;
  }
  $('#rememberLogin').checked = rememberLoginEnabled();
  bindEvents();
  try {
    await consumeMagicLink();
    await loadBoard();
  } catch (error) {
    console.error(error);
    const message = error.status === 401 || error.status === 403
      ? '승인된 이메일로 로그인하면 게시판을 볼 수 있습니다.'
      : '로그인 상태를 확인하지 못했습니다. 다시 로그인해주세요.';
    setBoardVisibility(false, message);
  }
}

void start();
