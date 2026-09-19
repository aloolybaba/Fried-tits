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

test('live board: posts once, edits in place, finalizes, then never changes', async () => {
  const periodStart = new Date('2026-08-15T12:00:00Z');
  const sent = [];
  const edits = [];
  const store = new Map();
  const message = { id: 'live-1', edit: async (payload) => edits.push(payload) };
  const channel = {
    id: 'channel-1',
    guildId: 'guild-1',
    isTextBased: () => true,
    messages: { fetch: async () => message },
    send: async (payload) => { sent.push(payload); return message; },
  };
  const db = {
    period: () => ({ start: periodStart }),
    getLeaderboard: async () => [{ display_ign: 'Melo', total: '6000' }],
    getLeaderboardMessage: async () => store.get('m') || null,
    saveLeaderboardMessage: async (g, t, s, id, c, final) => store.set('m', { message_id: id, finalized: final }),
  };
  const manager = new LeaderboardManager(
    { channels: { fetch: async () => channel } },
    db,
    { timezone: 'Asia/Riyadh', minimumArrowsToKeep: 5000n },
  );

  await manager.updatePeriod('hourly', channel.id, periodStart, false);
  assert.equal(sent.length, 1);
  assert.match(sent[0].embeds[0].data.footer.text, /Updates every minute/);

  await manager.updatePeriod('hourly', channel.id, periodStart, false);
  assert.equal(sent.length, 1, 'live refresh must edit, not post again');
  assert.equal(edits.length, 1);

  await manager.updatePeriod('hourly', channel.id, periodStart, true);
  assert.equal(edits.length, 2);
  assert.match(edits[1].embeds[0].data.footer.text, /Final/);
  assert.equal(store.get('m').finalized, true);

  await manager.updatePeriod('hourly', channel.id, periodStart, false);
  assert.equal(edits.length, 2, 'a finished period is never edited again');
  assert.equal(sent.length, 1);
});
