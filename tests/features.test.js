import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cleanExternalLinks, daysUntil, koreaToday, validCalendarDate, convertSearchList, searchUrl } from '../shared/features.js';
import { makePostFields, presentPost } from '../functions/_lib/board.js';

test('external attachments permit only the three HTTPS origins and never become storage paths', () => {
  for (const host of ['app.koofr.net', 'filedn.com', 'transfer.it']) {
    const links = [{ name: '파일', url: `https://${host}/share/file?q=1#key` }];
    assert.deepEqual(cleanExternalLinks(links), links);
    assert.deepEqual(makePostFields({ external_links: links }, {}).fields.external_links, links);
    assert.deepEqual(presentPost({ external_links: links, attachments: [] }, {}).external_links, links);
  }
  for (const url of ['http://filedn.com/a', 'https://filedn.com.evil.test/a', 'https://filedn.com@evil.test/a', 'https://evil.test/filedn.com/a', 'https://user@filedn.com/a', 'https://filedn.com:8443/a', 'javascript:alert(1)', 'https://filedn.com\\@evil.test/a']) {
    assert.equal(cleanExternalLinks([{ name: 'file', url }]), null, url);
    assert.ok(makePostFields({ external_links: [{ name: 'file', url }] }, {}).error);
  }
  assert.equal(cleanExternalLinks(Array(9).fill({ name: 'file', url: 'https://filedn.com/a' })), null);
  assert.equal(cleanExternalLinks([{ name: ' ', url: 'https://filedn.com/a' }]), null);
});

test('calendar boundaries are inclusive and based on Korea midnight', () => {
  assert.equal(koreaToday(new Date('2026-10-31T14:59:59Z')), '2026-10-31');
  assert.equal(koreaToday(new Date('2026-10-31T15:00:00Z')), '2026-11-01');
  for (const [date, days] of [['2026-10-31', -1], ['2026-11-01', 0], ['2026-11-04', 3], ['2026-11-05', 4], ['2026-11-15', 14], ['2026-11-16', 15]]) assert.equal(daysUntil(date, '2026-11-01'), days);
  for (const date of ['2026-02-29', '2026-02-30', '2026-13-01', '2026-1-1', '0000-01-01', 'bad']) assert.equal(validCalendarDate(date), false, date);
  assert.equal(validCalendarDate('2028-02-29'), true);
  assert.equal(daysUntil('2027-01-01', '2026-12-31'), 1);
});

test('repository JSON converts in order and safely encodes query placeholders', () => {
  const source = JSON.parse(readFileSync(new URL('../NKMM/search-list.json', import.meta.url), 'utf8'));
  const groups = convertSearchList(source);
  assert.equal(groups[0].category, '종합');
  assert.equal(groups.flatMap(group => group.engines).length, source.filter(item => item.type === 'engine').length);
  assert.equal(searchUrl('https://example.com/imouto?q=imouto', '한글 &?#/'), 'https://example.com/' + encodeURIComponent('한글 &?#/') + '?q=' + encodeURIComponent('한글 &?#/'));
  assert.throws(() => convertSearchList([{ type: 'engine', name: 'bad', url: 'javascript:alert(1)' }]));
  assert.throws(() => convertSearchList({}));
});
