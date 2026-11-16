import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpError, shouldRetry } from './http.js';

test('HttpError: повідомлення «HTTP код» і поле status', () => {
  const e = new HttpError(503);
  assert.equal(e.message, 'HTTP 503');
  assert.equal(e.status, 503);
  assert.ok(e instanceof Error);
});

test('shouldRetry: мережевий збій, 5xx і 429 повторюються двічі, усього три спроби', () => {
  for (const err of [new TypeError('Failed to fetch'), new HttpError(500), new HttpError(503), new HttpError(429)]) {
    assert.equal(shouldRetry(0, err), true, String(err));
    assert.equal(shouldRetry(1, err), true, String(err));
    assert.equal(shouldRetry(2, err), false, String(err));
  }
});

test('shouldRetry: 400, 401, 403, 404 не повторюються', () => {
  for (const status of [400, 401, 403, 404, 422]) {
    assert.equal(shouldRetry(0, new HttpError(status)), false, String(status));
  }
});
