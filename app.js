const categories = [
  { name: '현생', icon: '현생' },
  { name: '링크', icon: '링크' },
  { name: '언어/검색어', icon: '언어' },
  { name: '리소스/아이디어', icon: '리소스' },
  { name: '쥬우니/에카하나', icon: '쥬우니' }
];

const boardConfig = window.BOARD_CONFIG || {};
const viewModeStorageKey = 'nyangcatmemoBoardViewMode';
const rememberLoginSettingKey = 'nyangcatmemoRememberLogin';
const pageSize = 10;
const maxImagesPerPost = 10;

let currentUser = null;
let currentProfile = null;
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
  editorImages = [];
  editorIsDirty = false;
  draggedImageIndex = null;
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

async function loadBoard() {
  const data = await api('/api/bootstrap');
  currentUser = data.user || null;
  currentProfile = data.profile || null;
  posts = (data.posts || []).map((post) => ({
    ...post,
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
              <span class="gallery-category">${post.is_pinned ? '📌 고정' : post.is_notice ? '공지' : escapeHtml(post.category)}</span>
            </div>
          ` : ''}
          <div class="gallery-body">
            ${firstImage ? '' : `<span class="gallery-category">${post.is_pinned ? '📌 고정' : post.is_notice ? '공지' : escapeHtml(post.category)}</span>`}
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
          <span class="post-category" role="cell">${post.is_notice ? '공지' : escapeHtml(post.category)}</span>
          <span class="post-title" role="cell"><span class="post-title-text">${post.is_pinned ? '<span class="pin">📌</span>' : ''}${post.is_notice ? '<span class="pin">●</span>' : ''}${post.image_urls?.length ? '<span class="image-indicator">▣</span>' : ''}${escapeHtml(post.title)}</span>${post.tags?.length ? `<span class="post-tags">${renderTags(post.tags)}</span>` : ''}</span>
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
  $('#postCategory').value = post?.category || (selectedCategory !== '전체글' ? selectedCategory : '현생');
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

async function copySelectedPostContent() {
  if (!selectedPost) return;
  const text = String(selectedPost.content || '');
  try {
    let copied = false;
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        copied = true;
      } catch {
        // Fall back for browsers that expose Clipboard API but deny its permission.
      }
    }
    if (!copied) {
      const temporaryField = document.createElement('textarea');
      temporaryField.value = text;
      temporaryField.setAttribute('readonly', '');
      temporaryField.style.position = 'fixed';
      temporaryField.style.opacity = '0';
      document.body.append(temporaryField);
      temporaryField.select();
      copied = document.execCommand('copy');
      temporaryField.remove();
      if (!copied) throw new Error('Copy command failed');
    }
    const button = $('#copyPostContentButton');
    button.textContent = '복사됨';
    setTimeout(() => { if (button) button.textContent = '내용 복사'; }, 1400);
  } catch {
    alert('내용을 복사하지 못했습니다. 직접 선택해 복사해주세요.');
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
  $('#viewerCategory').textContent = isConfidential(selectedPost) ? '🔒 기밀 자료' : selectedPost.is_pinned ? '📌 최상단 고정' : selectedPost.is_notice ? '공지' : selectedPost.category;
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
    is_notice: $('#postNotice').checked,
    is_confidential: $('#postConfidential').checked
  };
  if (!payload.title || !payload.content) {
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
  return { errorCode: null };
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
    navigator.serviceWorker.register('./sw.js').catch((error) => console.warn('Service worker registration failed.', error));
  });
}

async function start() {
  if (boardConfig.siteName) {
    document.title = boardConfig.siteName;
    $('.brand strong').textContent = boardConfig.siteName;
    $('.site-footer span').textContent = boardConfig.siteName;
  }
  $('#rememberLogin').checked = rememberLoginEnabled();
  bindEvents();
  registerServiceWorker();
  try {
    const magicLink = await consumeMagicLink();
    if (magicLink?.errorCode) {
      setBoardVisibility(false, magicLink.errorCode === 'otp_expired'
        ? '로그인 링크가 이미 사용되었거나 만료되었습니다. 가장 최근 로그인 메일의 안내 화면에서 로그인 계속하기를 눌러주세요.'
        : '로그인 링크를 확인하지 못했습니다. 새 로그인 메일을 요청한 뒤 다시 시도해주세요.');
      return;
    }
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
