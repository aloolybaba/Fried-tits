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

test('falls back to public player data and resolves overall score when the API rejects a valid player', async () => {
  const fakeFetch = async (url) => {
    if (url.includes('/v1/stats/')) return { ok: true, status: 200, json: async () => ({ status: 500, message: 'Could not handle your request.' }) };
    if (url.includes('/v1/lookup/')) return { ok: false, status: 503, json: async () => ({ status: 503 }) };
    if (url.includes('/player/')) return {
      ok: true,
      status: 200,
      text: async () => '<script type="application/ld+json">{"additionalProperty":[{"name":"money","value":"7040000000"},{"name":"shards","value":"4553"},{"name":"kills","value":"1312"},{"name":"deaths","value":"754"},{"name":"playtime","value":"10562400000"},{"name":"placed_blocks","value":"377011"},{"name":"broken_blocks","value":"314065"},{"name":"mobs_killed","value":"4115"}]}</script><h3>Money Spent</h3><span class="tabular-nums">$161.26M</span><h3>Money Made</h3><span class="tabular-nums">$6.00B</span>',
    };
    return {
      ok: true,
      status: 200,
      text: async () => '<input placeholder="Search any player from 2,953,285 users..."><span>#<!-- -->356</span><div title="teedeedeedee">teedeedeedee</div><div>bbe4c9da-6c4b-49b6-a5a6-147d6794c5ab</div><div>90.09 Rank #356 View Stats</div>',
    };
  };
  const api = new DonutApi('private-player-key', { fetch: fakeFetch });
  const profile = await api.getProfile('teedeedeedee');
  assert.equal(profile.stats.money, '7040000000');
  assert.equal(profile.stats.money_spent_on_shop, '161260000');
  assert.equal(profile.ranking.rank, 356);
  assert.equal(profile.ranking.score, 90.09);
  assert.equal(profile.ranking.totalPlayers, 2_953_285);
});
