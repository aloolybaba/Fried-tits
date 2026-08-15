const test = require('node:test');
const assert = require('node:assert/strict');
const { DonutApi } = require('../src/donut-api');

test('authenticates with the player API key and caches repeated lookups', async () => {
  const calls = [];
  const fakeFetch = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      json: async () => ({ status: 200, result: { money: '875214' } }),
    };
  };
  const api = new DonutApi('private-player-key', { fetch: fakeFetch, cacheTtlMs: 10_000 });
  const first = await api.getStats('u42e');
  const second = await api.getStats('u42e');

  assert.equal(first.money, '875214');
  assert.deepEqual(second, first);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer private-player-key');
  assert.match(calls[0].url, /\/v1\/stats\/u42e$/);
});
