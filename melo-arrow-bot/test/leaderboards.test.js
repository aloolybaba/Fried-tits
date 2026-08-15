const test = require('node:test');
const assert = require('node:assert/strict');
const { buildLeaderboardEmbeds } = require('../src/leaderboards');

test('renders all 100 leaderboard users in one embed', () => {
  const rows = Array.from({ length: 100 }, (_, index) => ({
    display_ign: `Player_${index + 1}`,
    total: String((100 - index) * 1000),
  }));
  const embeds = buildLeaderboardEmbeds(rows, 'hourly', new Date('2026-08-15T12:00:00Z'), 'Asia/Riyadh');
  assert.equal(embeds.length, 1);
  assert.match(embeds[0].data.description, /Player_1/);
  assert.match(embeds[0].data.description, /Player_100/);
  assert.ok(embeds[0].data.description.length <= 4096);
});
