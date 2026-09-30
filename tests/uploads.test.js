import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_UPLOAD_BYTES, attachmentLimitError } from '../shared/limits.js';
import { cleanAttachments } from '../functions/_lib/media.js';
import { objectKey } from '../shared/validation.js';
import { uploadEntries, formatBytes } from '../client/uploads.js';
import { singleFlight } from '../functions/_lib/single-flight.js';

const folder = '11111111-1111-4111-8111-111111111111';
const attachment = (size, index = 0) => ({ path: `${folder}/file-${index}.txt`, name: `file-${index}.txt`, size });

test('attachments accept exactly 25MB and 8 files, independently of images', () => {
  assert.equal(attachmentLimitError([attachment(MAX_UPLOAD_BYTES)]), '');
  assert.equal(attachmentLimitError([attachment(MAX_UPLOAD_BYTES - 1), attachment(1, 1)]), '');
  assert.equal(attachmentLimitError(Array.from({length:8}, (_, index) => attachment(1,index))), '');
  assert.ok(attachmentLimitError([attachment(MAX_UPLOAD_BYTES), attachment(1, 1)]));
  assert.ok(attachmentLimitError(Array.from({length:9}, (_, index) => attachment(1,index))));
  for (const size of [0, -1, NaN, Infinity, 0.5]) assert.ok(attachmentLimitError([attachment(size)]));
  assert.equal(cleanAttachments([attachment(MAX_UPLOAD_BYTES)]).length, 1);
  assert.equal(cleanAttachments([attachment(1), attachment(1)]), null);
  assert.equal(cleanAttachments([{...attachment(1), path:'../../secret'}]), null);
});

test('object keys reject traversal, control characters, and invalid owner folders', () => {
  for (const path of ['../../secret', `${folder}/../x`, `${folder}//x`, `${folder}/x\ny`, `${folder}/x\\y`]) assert.equal(objectKey(path), '');
  assert.equal(objectKey(`${folder}/x.txt`), `${folder}/x.txt`);
  assert.equal(formatBytes(MAX_UPLOAD_BYTES), '25.00 MB');
});

test('upload workers are bounded and retry reuses completed uploads', async () => {
  const entries = Array.from({length:5}, (_, index) => ({ kind:'pending',media:'files',file:new File(['test'], `file-${index}.txt`) }));
  let active = 0, peak = 0;
  const calls = new Map();
  let failOnce = true;
  const api = async (path, options) => {
    const name = options.body.get('file').name;
    calls.set(name, (calls.get(name) || 0)+1);
    active++; peak = Math.max(peak, active);
    await new Promise((resolve) => setImmediate(resolve));
    active--;
    if (name === 'file-1.txt' && failOnce) { failOnce = false; throw new Error('transient'); }
    return { attachment:{path:`${folder}/${name}`,size:4,name,expiresAt:Date.now()+3600000} };
  };
  await assert.rejects(uploadEntries(entries, api), /transient/);
  assert.equal(active, 0);
  assert.equal(peak, 2);
  await uploadEntries(entries, api);
  assert.equal(calls.get('file-1.txt'), 2);
  assert.equal(calls.get('file-0.txt'), 1);
  assert.ok(entries.every((entry) => entry.uploaded));
});

test('single flight shares only overlapping work and forgets failures/results', async () => {
  const run = singleFlight();
  let count = 0;
  const work = async () => { count++; await new Promise((resolve) => setImmediate(resolve)); return count; };
  const [a,b] = await Promise.all([run('key', work),run('key', work)]);
  assert.equal(a,b); assert.equal(count,1);
  await run('key',work); assert.equal(count,2);
  await assert.rejects(run('error', async () => { throw new Error('failure'); }));
  assert.equal(await run('error', async () => 'recovered'), 'recovered');
});
