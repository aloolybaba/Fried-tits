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

  const pages = [];
  for (let pageStart = 0; pageStart < rows.length; pageStart += 25) {
    const pageRows = rows.slice(pageStart, pageStart + 25);
    const longestName = Math.min(22, Math.max(3, ...pageRows.map((row) => row.display_ign.length)));
    const lines = pageRows.map((row, index) => {
      const rank = String(pageStart + index + 1).padStart(3, '0');
      const name = row.display_ign.slice(0, longestName).padEnd(longestName, ' ');
      return `${rank}  ${name}  ${formatCompact(row.total).padStart(8, ' ')}`;
    });
    const firstRank = pageStart + 1;
    const lastRank = pageStart + pageRows.length;
    pages.push(new EmbedBuilder()
      .setColor(COLORS[periodType])
      .setTitle(pageStart === 0 ? `🏹 ${title}` : `${title} • ${firstRank}–${lastRank}`)
      .setDescription(`\`\`\`text\n #   IGN${' '.repeat(Math.max(1, longestName - 2))}   ARROWS\n${lines.join('\n')}\n\`\`\``)
      .setFooter({ text: `${periodLabel} • Top ${rows.length}/100 • Updates automatically` })
      .setTimestamp());
  }
  return pages;
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
    await this.finalizeLatestSavedPeriods();
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

  async finalizeLatestSavedPeriods() {
    const channel = await this.client.channels.fetch(this.config.hourlyChannelId);
    if (!channel?.guildId) return;
    for (const [periodType, channelId] of [
      ['hourly', this.config.hourlyChannelId],
      ['daily', this.config.dailyChannelId],
    ]) {
      const currentStart = this.db.period(periodType).start;
      const latestStart = await this.db.getLatestLeaderboardPeriod(channel.guildId, periodType);
      if (latestStart && latestStart.getTime() !== currentStart.getTime()) {
        await this.updatePeriod(periodType, channelId, latestStart);
      }
    }
  }

  async handleRollovers() {
    const rollovers = [];
    for (const [periodType, channelId] of [
      ['hourly', this.config.hourlyChannelId],
      ['daily', this.config.dailyChannelId],
    ]) {
      const currentStart = this.db.period(periodType).start;
      const previousKey = this.periodKeys.get(periodType);
      if (previousKey && previousKey !== currentStart.toISOString()) {
        rollovers.push({ periodType, channelId, previousStart: new Date(previousKey) });
      }
    }
    if (!rollovers.length) return;
    this.running = this.running
      .catch((error) => console.error('Previous leaderboard update failed:', error))
      .then(async () => {
      for (const rollover of rollovers) {
        await this.updatePeriod(rollover.periodType, rollover.channelId, rollover.previousStart);
        await this.updatePeriod(rollover.periodType, rollover.channelId);
      }
      });
    await this.running;
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
    const saved = await this.db.getLeaderboardMessage(channel.guildId, periodType, periodStart);
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
    } else {
      message = await channel.send({ embeds });
      await this.db.saveLeaderboardMessage(channel.guildId, periodType, periodStart, message.id, channel.id);
    }
  }
}

module.exports = { LeaderboardManager, buildLeaderboardEmbeds };
