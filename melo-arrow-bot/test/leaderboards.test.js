const test = require('node:test');
const assert = require('node:assert/strict');
const { buildLeaderboardPayload, LeaderboardManager } = require('../src/leaderboards');

test('renders 100 leaderboard users across ten unpadded, bold pages', () => {
  const rows = Array.from({ length: 100 }, (_, index) => ({
    display_ign: `Player_${index + 1}`,
    total: String((100 - index) * 1000),
  }));
  const first = buildLeaderboardPayload(rows, 'hourly', new Date('2026-08-15T12:00:00Z'), 'Asia/Riyadh');
  assert.equal(first.embeds.length, 1);
  assert.match(first.embeds[0].data.description, /Player\\_1/);
  assert.match(first.embeds[0].data.description, /Player\\_10/);
  assert.doesNotMatch(first.embeds[0].data.description, /Player\\_11/);
  assert.match(first.embeds[0].data.description, /^\*\*1\. Player\\_1 — 100,000 arrows\*\*/);
  assert.doesNotMatch(first.embeds[0].data.description, /```|\*\*001\./);
  assert.match(first.embeds[0].data.footer.text, /Page 1\/10/);
  assert.equal(first.components[0].components.length, 5);
  assert.match(first.components[0].components[0].data.custom_id, /^arrowlb:hourly:\d+:first:0$/);

  const last = buildLeaderboardPayload(rows, 'daily', new Date('2026-08-15T12:00:00Z'), 'Asia/Riyadh', 9);
  assert.match(last.embeds[0].data.description, /^\*\*91\. Player\\_91/);
  assert.match(last.embeds[0].data.description, /\*\*100\. Player\\_100/);
  assert.match(last.embeds[0].data.footer.text, /Page 10\/10/);
  assert.match(last.components[0].components[4].data.custom_id, /^arrowlb:daily:\d+:last:9$/);
  assert.ok(last.embeds[0].data.description.length <= 4096);
});

test('posts a new finalized snapshot for a legacy live period and never edits it automatically', async () => {
  const periodStart = new Date('2026-08-15T12:00:00Z');
  const sent = [];
  const saved = [];
  const channel = {
    id: 'channel-1',
    guildId: 'guild-1',
    isTextBased: () => true,
    messages: { fetch: async () => ({ id: 'existing-final-message' }) },
    send: async (payload) => {
      sent.push(payload);
      return { id: 'new-final-message' };
    },
  };
  const db = {
    period: () => ({ start: periodStart }),
    getLeaderboard: async () => [{ display_ign: 'Melo', total: '6000' }],
    getLeaderboardMessage: async () => ({ message_id: 'legacy-live-message', finalized: false }),
    saveLeaderboardMessage: async (...args) => saved.push(args),
  };
  const manager = new LeaderboardManager(
    { channels: { fetch: async () => channel } },
    db,
    { timezone: 'Asia/Riyadh', minimumArrowsToKeep: 5000n },
  );

  await manager.updatePeriod('hourly', channel.id, periodStart);
  assert.equal(sent.length, 1);
  assert.equal(saved.length, 1);
  assert.equal(saved[0][5], true);

  db.getLeaderboardMessage = async () => ({ message_id: 'existing-final-message', finalized: true });
  await manager.updatePeriod('hourly', channel.id, periodStart);
  assert.equal(sent.length, 1);
});
