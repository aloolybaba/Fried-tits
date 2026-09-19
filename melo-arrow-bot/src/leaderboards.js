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

function buildLeaderboardPayload(rows, periodType, periodStart, timezone, requestedPage = 0, options = {}) {
  const { final = false, minimum = null } = options;
  const status = final ? 'Final' : 'Updates every minute';
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
      .setDescription(minimum !== null && BigInt(minimum) > 0n
        ? `No one above ${formatInteger(minimum)} arrows yet.`
        : 'No arrow deliveries recorded yet.')
      .setFooter({ text: `${periodLabel} • Page 1/1 • ${status}` })
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
    .setFooter({ text: `${periodLabel} • Page ${page + 1}/${totalPages} • Top ${rows.length}/100 • ${status}` })
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

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

const REFRESH_MS = 60_000;

class LeaderboardManager {
  constructor(client, db, config) {
    this.client = client;
    this.db = db;
    this.config = config;
    this.interval = null;
    this.periodKeys = new Map();
    this.running = Promise.resolve();
    this.lastRefresh = 0;
  }

  channelFor(periodType) {
    return periodType === 'hourly' ? this.config.hourlyChannelId : this.config.dailyChannelId;
  }

  async start() {
    for (const periodType of ['hourly', 'daily']) {
      this.periodKeys.set(periodType, this.db.period(periodType).start.toISOString());
    }
    await this.force();
    this.interval = setInterval(() => {
      this.tick().catch((error) => console.error('Leaderboard update failed:', error));
    }, 5_000);
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

  // Run leaderboard work one job at a time. A job that hangs is abandoned after
  // a minute so it can never block every later update.
  enqueue(work) {
    const job = this.running.catch(() => {}).then(() => withTimeout(work(), REFRESH_MS, 'Leaderboard update'));
    this.running = job.catch((error) => console.error('Leaderboard update failed:', error));
    return job;
  }

  // Startup and /refreshleaders: close off the period that just ended, then
  // bring the live boards up to date.
  async force() {
    this.lastRefresh = Date.now();
    return this.enqueue(async () => {
      for (const periodType of ['hourly', 'daily']) {
        await this.updatePeriod(periodType, this.channelFor(periodType), this.completedPeriodStart(periodType), true, false);
      }
      for (const periodType of ['hourly', 'daily']) {
        await this.updatePeriod(periodType, this.channelFor(periodType), this.db.period(periodType).start, false);
      }
    });
  }

  async tick() {
    const rolledOver = [];
    for (const periodType of ['hourly', 'daily']) {
      const currentKey = this.db.period(periodType).start.toISOString();
      const previousKey = this.periodKeys.get(periodType);
      if (previousKey && previousKey !== currentKey) rolledOver.push([periodType, new Date(previousKey)]);
      this.periodKeys.set(periodType, currentKey);
    }
    const now = Date.now();
    if (!rolledOver.length && now - this.lastRefresh < REFRESH_MS) return;
    this.lastRefresh = now;
    await this.enqueue(async () => {
      for (const [periodType, periodStart] of rolledOver) {
        await this.updatePeriod(periodType, this.channelFor(periodType), periodStart, true, false);
      }
      for (const periodType of ['hourly', 'daily']) {
        await this.updatePeriod(periodType, this.channelFor(periodType), this.db.period(periodType).start, false);
      }
    });
  }

  // One message per period. While the period runs it is edited in place; when it
  // ends it gets one last edit marked Final and is never touched again.
  // createIfMissing=false: only close off a board that was actually posted, so a
  // restart or first deploy never spams empty "Final" boards for past periods.
  async updatePeriod(periodType, channelId, periodStart, final = false, createIfMissing = true) {
    if (!channelId) return null;
    const channel = await this.client.channels.fetch(channelId);
    if (!channel?.isTextBased() || !channel.guildId) {
      throw new Error(`${periodType} channel ${channelId} is not a server text channel`);
    }
    const saved = await this.db.getLeaderboardMessage(channel.guildId, periodType, periodStart);
    if (saved?.finalized) return null;
    if (!saved && !createIfMissing) return null;
    const rows = await this.db.getLeaderboard(
      channel.guildId,
      periodType,
      periodStart,
      100,
      this.config.minimumArrowsToKeep,
    );
    const payload = buildLeaderboardPayload(rows, periodType, periodStart, this.config.timezone, 0, {
      final,
      minimum: this.config.minimumArrowsToKeep,
    });

    if (saved?.message_id) {
      try {
        const existing = await channel.messages.fetch(saved.message_id);
        await existing.edit(payload);
        await this.db.saveLeaderboardMessage(channel.guildId, periodType, periodStart, existing.id, channel.id, final);
        return existing;
      } catch (error) {
        if (error.code !== 10008) throw error;   // message was deleted: post a fresh one below
        if (!createIfMissing) return null;
      }
    }
    const message = await channel.send(payload);
    await this.db.saveLeaderboardMessage(channel.guildId, periodType, periodStart, message.id, channel.id, final);
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
    const saved = await this.db.getLeaderboardMessage(interaction.guildId, periodType, periodStart);
    const payload = buildLeaderboardPayload(rows, periodType, periodStart, this.config.timezone, page, {
      final: Boolean(saved?.finalized),
      minimum: this.config.minimumArrowsToKeep,
    });
    await interaction.update(payload);
    return true;
  }
}

module.exports = { LeaderboardManager, buildLeaderboardEmbeds, buildLeaderboardPayload, PAGE_SIZE };
