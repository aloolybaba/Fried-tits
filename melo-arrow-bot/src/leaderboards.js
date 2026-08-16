const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  escapeMarkdown,
} = require('discord.js');
const { DateTime } = require('luxon');
const { formatCompact, formatInteger } = require('./format');

const COLORS = { hourly: 0x57f287, daily: 0x5865f2 };
const PAGE_SIZE = 10;

function buildLeaderboardPayload(rows, periodType, periodStart, timezone, requestedPage = 0) {
  const localStart = DateTime.fromJSDate(periodStart).setZone(timezone);
  const periodEpoch = Math.floor(periodStart.getTime() / 1000);
  const title = periodType === 'hourly' ? 'Hourly Arrow Leaderboard' : 'Daily Arrow Leaderboard';
  const periodLabel = periodType === 'hourly'
    ? localStart.toFormat('ccc, dd LLL yyyy • hh:00 a ZZZZ')
    : localStart.toFormat('cccc, dd LLL yyyy • ZZZZ');

  if (!rows.length) {
    return { embeds: [new EmbedBuilder()
      .setColor(COLORS[periodType])
      .setTitle(`🏹 ${title}`)
      .setDescription('No arrow deliveries recorded yet.')
      .setFooter({ text: `${periodLabel} • Page 1/1 • Updates automatically` })
      .setTimestamp()], components: [] };
  }

  const totalPages = Math.max(1, Math.ceil(Math.min(rows.length, 100) / PAGE_SIZE));
  const page = Math.min(Math.max(Number(requestedPage) || 0, 0), totalPages - 1);
  const startIndex = page * PAGE_SIZE;
  const visibleRows = rows.slice(startIndex, startIndex + PAGE_SIZE);
  const makeLines = (compact) => visibleRows.map((row, index) => {
    const name = escapeMarkdown(row.display_ign.slice(0, 32));
    const arrows = compact ? formatCompact(row.total) : formatInteger(row.total);
    return `**${startIndex + index + 1}. ${name} — ${arrows} arrows**`;
  });
  let lines = makeLines(false);
  if (lines.join('\n').length > 4096) lines = makeLines(true);
  const embed = new EmbedBuilder()
    .setColor(COLORS[periodType])
    .setTitle(`🏹 ${title}`)
    .setDescription(lines.join('\n'))
    .setFooter({ text: `${periodLabel} • Page ${page + 1}/${totalPages} • Top ${rows.length}/100 • Updates automatically` })
    .setTimestamp();
  const components = totalPages === 1 ? [] : [new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`arrowlb:${periodType}:${periodEpoch}:first:0`)
      .setLabel('First')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page === 0),
    new ButtonBuilder()
      .setCustomId(`arrowlb:${periodType}:${periodEpoch}:previous:${Math.max(0, page - 1)}`)
      .setLabel('Previous')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(page === 0),
    new ButtonBuilder()
      .setCustomId(`arrowlb:${periodType}:${periodEpoch}:page:${page}`)
      .setLabel(`${page + 1}/${totalPages}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId(`arrowlb:${periodType}:${periodEpoch}:next:${Math.min(totalPages - 1, page + 1)}`)
      .setLabel('Next')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(page === totalPages - 1),
    new ButtonBuilder()
      .setCustomId(`arrowlb:${periodType}:${periodEpoch}:last:${totalPages - 1}`)
      .setLabel('Last')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page === totalPages - 1),
  )];
  return { embeds: [embed], components };
}

function buildLeaderboardEmbeds(rows, periodType, periodStart, timezone, requestedPage = 0) {
  return buildLeaderboardPayload(rows, periodType, periodStart, timezone, requestedPage).embeds;
}

class LeaderboardManager {
  constructor(client, db, config) {
    this.client = client;
    this.db = db;
    this.config = config;
    this.interval = null;
    this.periodKeys = new Map();
    this.running = Promise.resolve();
  }

  async start() {
    for (const periodType of ['hourly', 'daily']) {
      this.periodKeys.set(periodType, this.db.period(periodType).start.toISOString());
    }
    await this.force();
    this.interval = setInterval(() => {
      this.handleRollovers().catch((error) => console.error('Leaderboard rollover failed:', error));
    }, 1_000);
    this.interval.unref();
  }

  stop() {
    if (this.interval) clearInterval(this.interval);
  }

  completedPeriodStart(periodType) {
    const currentStart = this.db.period(periodType).start;
    const unit = periodType === 'hourly' ? 'hour' : 'day';
    return DateTime.fromJSDate(currentStart)
      .setZone(this.config.timezone)
      .minus({ [periodType === 'hourly' ? 'hours' : 'days']: 1 })
      .startOf(unit)
      .toUTC()
      .toJSDate();
  }

  async force() {
    this.running = this.running
      .catch((error) => console.error('Previous leaderboard publish failed:', error))
      .then(() => Promise.all([
        this.updatePeriod('hourly', this.config.hourlyChannelId, this.completedPeriodStart('hourly')),
        this.updatePeriod('daily', this.config.dailyChannelId, this.completedPeriodStart('daily')),
      ]));
    return this.running;
  }

  async handleRollovers() {
    const completed = [];
    for (const [periodType, channelId] of [
      ['hourly', this.config.hourlyChannelId],
      ['daily', this.config.dailyChannelId],
    ]) {
      const currentStart = this.db.period(periodType).start;
      const previousKey = this.periodKeys.get(periodType);
      if (previousKey && previousKey !== currentStart.toISOString()) {
        completed.push([periodType, channelId, new Date(previousKey)]);
      }
      this.periodKeys.set(periodType, currentStart.toISOString());
    }
    if (completed.length) {
      this.running = this.running
        .catch((error) => console.error('Previous leaderboard publish failed:', error))
        .then(() => Promise.all(completed.map(
          ([periodType, channelId, periodStart]) => this.updatePeriod(periodType, channelId, periodStart),
        )));
      await this.running;
    }
  }

  async updatePeriod(periodType, channelId, periodStartOverride = null) {
    if (!channelId) return;
    const channel = await this.client.channels.fetch(channelId);
    if (!channel?.isTextBased() || !channel.guildId) {
      throw new Error(`${periodType} channel ${channelId} is not a server text channel`);
    }
    const periodStart = periodStartOverride || this.completedPeriodStart(periodType);
    const rows = await this.db.getLeaderboard(
      channel.guildId,
      periodType,
      periodStart,
      100,
      this.config.minimumArrowsToKeep,
    );
    // A completed period is immutable. If its snapshot already exists, leave
    // it untouched; otherwise post exactly one new message for that hour/day.
    const saved = await this.db.getLeaderboardMessage(channel.guildId, periodType, periodStart);
    if (saved?.finalized) {
      try {
        const existing = await channel.messages.fetch(saved.message_id);
        if (existing) return existing;
      } catch (error) {
        if (error.code !== 10008) throw error;
      }
    }
    const payload = buildLeaderboardPayload(rows, periodType, periodStart, this.config.timezone, 0);
    const message = await channel.send(payload);
    await this.db.saveLeaderboardMessage(channel.guildId, periodType, periodStart, message.id, channel.id, true);
    return message;
  }

  async onInteraction(interaction) {
    if (!interaction.isButton()) return false;
    const match = interaction.customId.match(/^arrowlb:(hourly|daily):(\d+):(first|previous|next|last):(\d+)$/);
    if (!match) return false;
    const [, periodType, periodEpoch, , requestedPage] = match;
    if (!interaction.guildId) {
      await interaction.reply({ content: 'Leaderboard pages only work inside a server.', ephemeral: true });
      return true;
    }
    const periodStart = new Date(Number(periodEpoch) * 1000);
    if (Number.isNaN(periodStart.getTime())) {
      await interaction.reply({ content: 'That leaderboard period is invalid.', ephemeral: true });
      return true;
    }
    const rows = await this.db.getLeaderboard(
      interaction.guildId,
      periodType,
      periodStart,
      100,
      this.config.minimumArrowsToKeep,
    );
    const page = Number(requestedPage);
    const payload = buildLeaderboardPayload(rows, periodType, periodStart, this.config.timezone, page);
    await interaction.update(payload);
    return true;
  }
}

module.exports = { LeaderboardManager, buildLeaderboardEmbeds, buildLeaderboardPayload, PAGE_SIZE };
