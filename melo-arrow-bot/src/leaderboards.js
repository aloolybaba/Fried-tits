const { EmbedBuilder } = require('discord.js');
const { DateTime } = require('luxon');
const { formatCompact } = require('./format');

const COLORS = { hourly: 0x57f287, daily: 0x5865f2 };

function buildLeaderboardEmbeds(rows, periodType, periodStart, timezone) {
  const localStart = DateTime.fromJSDate(periodStart).setZone(timezone);
  const title = periodType === 'hourly' ? 'Hourly Arrow Leaderboard' : 'Daily Arrow Leaderboard';
  const periodLabel = periodType === 'hourly'
    ? localStart.toFormat('ccc, dd LLL yyyy • hh:00 a ZZZZ')
    : localStart.toFormat('cccc, dd LLL yyyy • ZZZZ');

  if (!rows.length) {
    return [new EmbedBuilder()
      .setColor(COLORS[periodType])
      .setTitle(`🏹 ${title}`)
      .setDescription('No arrow deliveries recorded yet.')
      .setFooter({ text: `${periodLabel} • Updates automatically` })
      .setTimestamp()];
  }

  const nameWidth = 16;
  const lines = rows.slice(0, 100).map((row, index) => {
    const rank = String(index + 1).padStart(3, ' ');
    const name = row.display_ign.slice(0, nameWidth).padEnd(nameWidth, ' ');
    return `${rank}. ${name} ${formatCompact(row.total).padStart(9, ' ')}`;
  });
  return [new EmbedBuilder()
    .setColor(COLORS[periodType])
    .setTitle(`🏹 ${title}`)
    .setDescription(`\`\`\`text\n  #  IGN                 ARROWS\n${lines.join('\n')}\n\`\`\``)
    .setFooter({ text: `${periodLabel} • Top ${rows.length}/100 • This message updates automatically` })
    .setTimestamp()];
}

class LeaderboardManager {
  constructor(client, db, config) {
    this.client = client;
    this.db = db;
    this.config = config;
    this.timer = null;
    this.interval = null;
    this.periodKeys = new Map();
    this.running = Promise.resolve();
  }

  async start() {
    await this.force();
    this.interval = setInterval(() => {
      this.handleRollovers().catch((error) => console.error('Leaderboard rollover failed:', error));
    }, 30_000);
    this.interval.unref();
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    if (this.interval) clearInterval(this.interval);
  }

  schedule() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.force().catch((error) => console.error('Leaderboard update failed:', error));
    }, this.config.leaderboardUpdateDelayMs);
  }

  async force() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.running = this.running
      .catch((error) => console.error('Previous leaderboard update failed:', error))
      .then(() => this.updateAll());
    return this.running;
  }

  async updateAll() {
    await Promise.all([
      this.updatePeriod('hourly', this.config.hourlyChannelId),
      this.updatePeriod('daily', this.config.dailyChannelId),
    ]);
  }

  async handleRollovers() {
    let changed = false;
    for (const [periodType, channelId] of [
      ['hourly', this.config.hourlyChannelId],
      ['daily', this.config.dailyChannelId],
    ]) {
      const currentStart = this.db.period(periodType).start;
      const previousKey = this.periodKeys.get(periodType);
      if (previousKey && previousKey !== currentStart.toISOString()) {
        changed = true;
      }
    }
    if (changed) await this.force();
  }

  async updatePeriod(periodType, channelId, periodStartOverride = null) {
    if (!channelId) return;
    const channel = await this.client.channels.fetch(channelId);
    if (!channel?.isTextBased() || !channel.guildId) {
      throw new Error(`${periodType} channel ${channelId} is not a server text channel`);
    }
    const periodStart = periodStartOverride || this.db.period(periodType).start;
    if (!periodStartOverride) this.periodKeys.set(periodType, periodStart.toISOString());
    const rows = await this.db.getLeaderboard(channel.guildId, periodType, periodStart, 100);
    const embeds = buildLeaderboardEmbeds(rows, periodType, periodStart, this.config.timezone);
    // Reuse the newest message for this channel forever, including after a
    // period rollover. PostgreSQL still retains every raw delivery.
    const saved = await this.db.getLatestLeaderboardMessage(channel.guildId, periodType);
    let message = null;

    if (saved) {
      try {
        message = await channel.messages.fetch(saved.message_id);
      } catch (error) {
        if (error.code !== 10008) throw error;
      }
    }

    if (message) {
      await message.edit({ embeds });
      await this.db.saveLeaderboardMessage(channel.guildId, periodType, periodStart, message.id, channel.id);
    } else {
      message = await channel.send({ embeds });
      await this.db.saveLeaderboardMessage(channel.guildId, periodType, periodStart, message.id, channel.id);
    }

    // Older versions created one leaderboard message per period. Remove only
    // those bot-created messages recorded in our own table, leaving one live
    // message in each configured statistics channel.
    const messageIds = await this.db.getLeaderboardMessageIds(channel.guildId, periodType);
    for (const staleMessageId of messageIds) {
      if (staleMessageId === message.id) continue;
      try {
        const staleMessage = await channel.messages.fetch(staleMessageId);
        if (staleMessage.author.id === this.client.user.id) await staleMessage.delete();
      } catch (error) {
        if (error.code !== 10008) console.warn(`Could not remove old ${periodType} leaderboard ${staleMessageId}:`, error.message);
      }
    }
    await this.db.pruneLeaderboardMessages(channel.guildId, periodType, message.id);
  }
}

module.exports = { LeaderboardManager, buildLeaderboardEmbeds };
