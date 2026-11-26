import assert from 'node:assert/strict';
import { test } from 'node:test';
import { retryStartup } from '../client/startup.js';

const httpError = (status) => Object.assign(new Error(`HTTP ${status}`), { status });

test('startup runs immediately and waits only after a transient failure', async () => {
  const calls = [];
  const failures = [new TypeError('Failed to fetch'), new DOMException('Timed out', 'TimeoutError'), httpError(502)];
  const result = await retryStartup(() => {
    calls.push('request');
    if (failures.length) throw failures.shift();
    return 'board';
  }, { wait: (delay) => calls.push(delay) });

  assert.equal(result, 'board');
  assert.deepEqual(calls, ['request', 300, 'request', 1000, 'request', 2500, 'request']);
});

test('startup stops retrying and propagates the last transient failure', async () => {
  const errors = [httpError(408), httpError(425), httpError(429), new DOMException('Request aborted', 'AbortError')];
  const lastError = errors.at(-1);
  const waits = [];

  await assert.rejects(retryStartup(() => Promise.reject(errors.shift()), {
    wait: (delay) => waits.push(delay), delays: [10, 20, 30]
  }), (error) => error === lastError);
  assert.deepEqual(waits, [10, 20, 30]);
  assert.equal(errors.length, 0);
});

test('startup propagates definitive HTTP errors and programming errors without a retry', async () => {
  for (const expected of [httpError(400), httpError(401), httpError(403), new TypeError('Cannot read properties of null')]) {
    await assert.rejects(retryStartup(() => { throw expected; }, {
      wait: () => assert.fail('Unexpected retry')
    }), (error) => error === expected);
  }
});
