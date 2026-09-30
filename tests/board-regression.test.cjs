const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');

function board() {
  const elements = new Map();
  const document = {
    querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, {
        innerHTML: '', textContent: '', hidden: false, attributes: {},
        setAttribute(name, value) { this.attributes[name] = value; }
      });
      return elements.get(selector);
    }
  };
  const context = vm.createContext({ window: {}, document, localStorage: { getItem: () => null }, URL });
  const source = readFileSync(require.resolve('../app.js'), 'utf8').replace('void start();', '');
  vm.runInContext(source, context);
  return { run: (code) => vm.runInContext(code, context), elements };
}

test('star view filters all categories, preserves order, and combines with search', () => {
  const { run } = board();
  run(`posts = [
    {id:'new', category_id:'a', is_pinned:false, _searchText:'hello'},
    {id:'star1', category_id:'b', is_pinned:true, _searchText:'hello'},
    {id:'star2', category_id:'a', is_pinned:true, _searchText:'world'}
  ]; selectedCategory = '별표'; applyFilters();`);
  assert.equal(run(`filteredPosts.map(p => p.id).join(',')`), 'star1,star2');
  run(`searchTerm = 'hello'; applyFilters();`);
  assert.equal(run(`filteredPosts.map(p => p.id).join(',')`), 'star1');
  run(`reconcileSelectedCategory();`);
  assert.equal(run('selectedCategory'), '별표');
});

test('star badge hides at zero, counts normally and caps at 9+', () => {
  const { run, elements } = board();
  for (const [count, text, hidden] of [[0, '0', true], [1, '1', false], [9, '9', false], [10, '9+', false], [12, '9+', false]]) {
    run(`posts = Array.from({length:${count}}, () => ({is_pinned:true})); renderHeader();`);
    assert.equal(elements.get('#starCount').textContent, text);
    assert.equal(elements.get('#starCount').hidden, hidden);
  }
  run(`selectedCategory = '별표'; renderHeader();`);
  assert.equal(elements.get('#starFilterButton').attributes['aria-pressed'], 'true');
});

test('both notices show content; confidential notices never reveal content or images', () => {
  const { run, elements } = board();
  run(`posts = [
    {id:'one', is_notice:true, title:'First', content:'first body', image_urls:[]},
    {id:'two', is_notice:true, title:'Second', content:'second body', image_urls:[]}
  ]; renderNotices();`);
  const html = elements.get('#noticeStrip').innerHTML;
  assert.equal((html.match(/class="notice-single/g) || []).length, 2);
  assert.match(html, /first body/);
  assert.match(html, /second body/);
  run(`posts[1].is_confidential = true; posts[1].image_urls = ['secret.png']; renderNotices();`);
  assert.doesNotMatch(elements.get('#noticeStrip').innerHTML, /second body|secret.png/);
  run(`selectedCategory = '별표'; renderNotices();`);
  assert.equal(elements.get('#noticeStrip').hidden, true);
});

test('star category markup escapes category names', () => {
  const { run } = board();
  const html = run(`renderPostCategory({is_pinned:true, category:'<script>'})`);
  assert.match(html, /post-star/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /📌/);
});
