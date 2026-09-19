const { Pool } = require('pg');
const { DateTime } = require('luxon');
const { normalizeIgn } = require('./format');

class Database {
  constructor(connectionString, timezone) {
    this.pool = new Pool({ connectionString, max: 10, idleTimeoutMillis: 30_000 });
    this.timezone = timezone;
  }

  async initialize() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS deliveries (
        id BIGSERIAL PRIMARY KEY,
        guild_id TEXT NOT NULL,
        discord_message_id TEXT UNIQUE,
        normalized_ign TEXT NOT NULL,
        display_ign TEXT NOT NULL,
        amount BIGINT NOT NULL CHECK (amount >= 0),
        source_type TEXT NOT NULL CHECK (source_type IN ('automatic', 'manual')),
        recorded_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS deliveries_guild_time_idx ON deliveries (guild_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS deliveries_guild_ign_idx ON deliveries (guild_id, normalized_ign, created_at DESC);

      CREATE TABLE IF NOT EXISTS player_links (
        guild_id TEXT NOT NULL,
        discord_user_id TEXT NOT NULL,
        normalized_ign TEXT NOT NULL,
        display_ign TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (guild_id, discord_user_id)
      );
      CREATE INDEX IF NOT EXISTS player_links_ign_idx ON player_links (guild_id, normalized_ign);

      CREATE TABLE IF NOT EXISTS leaderboard_messages (
        guild_id TEXT NOT NULL,
        period_type TEXT NOT NULL CHECK (period_type IN ('hourly', 'daily')),
        period_start TIMESTAMPTZ NOT NULL,
        message_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        finalized BOOLEAN NOT NULL DEFAULT FALSE,
        PRIMARY KEY (guild_id, period_type, period_start)
      );
      ALTER TABLE leaderboard_messages
        ADD COLUMN IF NOT EXISTS finalized BOOLEAN NOT NULL DEFAULT FALSE;
    `);
  }

  period(periodType, now = DateTime.now()) {
    const local = now.setZone(this.timezone);
    const start = local.startOf(periodType === 'hourly' ? 'hour' : 'day');
    return {
      start: start.toUTC().toJSDate(),
      end: start.plus({ [periodType === 'hourly' ? 'hours' : 'days']: 1 }).toUTC().toJSDate(),
      key: start.toFormat(periodType === 'hourly' ? 'yyyy-LL-dd HH:00 ZZZZ' : 'yyyy-LL-dd ZZZZ'),
    };
  }

  async addDelivery({ guildId, messageId = null, ign, amount, sourceType, recordedBy = null, createdAt = null }) {
    const values = [guildId, messageId, normalizeIgn(ign), ign, amount.toString(), sourceType, recordedBy, createdAt];
    const result = await this.pool.query(
      `INSERT INTO deliveries
       (guild_id, discord_message_id, normalized_ign, display_ign, amount, source_type, recorded_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, NOW()))
       ON CONFLICT (discord_message_id) DO NOTHING
       RETURNING id`,
      values,
    );
    return result.rowCount === 1;
  }

  async getLinkedIgn(guildId, discordUserId) {
    const result = await this.pool.query(
      'SELECT display_ign FROM player_links WHERE guild_id = $1 AND discord_user_id = $2',
      [guildId, discordUserId],
    );
    return result.rows[0]?.display_ign || null;
  }

  async getDiscordUserIdForIgn(guildId, ign) {
    const result = await this.pool.query(
      'SELECT discord_user_id FROM player_links WHERE guild_id = $1 AND normalized_ign = $2 LIMIT 1',
      [guildId, normalizeIgn(ign)],
    );
    return result.rows[0]?.discord_user_id || null;
  }

  async linkIgn(guildId, discordUserId, ign) {
    await this.pool.query(
      `INSERT INTO player_links (guild_id, discord_user_id, normalized_ign, display_ign)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (guild_id, discord_user_id) DO UPDATE
       SET normalized_ign = EXCLUDED.normalized_ign, display_ign = EXCLUDED.display_ign, updated_at = NOW()`,
      [guildId, discordUserId, normalizeIgn(ign), ign],
    );
  }

  async unlinkIgn(guildId, discordUserId) {
    const result = await this.pool.query(
      'DELETE FROM player_links WHERE guild_id = $1 AND discord_user_id = $2',
      [guildId, discordUserId],
    );
    return result.rowCount > 0;
  }

  async getStats(guildId, ign) {
    const normalizedIgn = normalizeIgn(ign);
    const hour = this.period('hourly');
    const day = this.period('daily');
    const result = await this.pool.query(
      `WITH player AS (
         SELECT
           COALESCE(MAX(display_ign), $2) AS display_ign,
           COALESCE(SUM(amount), 0)::text AS lifetime,
           COALESCE(SUM(amount) FILTER (WHERE created_at >= $3 AND created_at < $4), 0)::text AS hourly,
           COALESCE(SUM(amount) FILTER (WHERE created_at >= $5 AND created_at < $6), 0)::text AS daily,
           COALESCE(MAX(amount), 0)::text AS best,
           COUNT(*)::int AS deliveries,
           MAX(created_at) AS last_delivery
         FROM deliveries WHERE guild_id = $1 AND normalized_ign = $2
       ), totals AS (
         SELECT normalized_ign, SUM(amount) AS total
         FROM deliveries WHERE guild_id = $1 GROUP BY normalized_ign
       ), ranked AS (
         SELECT normalized_ign, DENSE_RANK() OVER (ORDER BY total DESC) AS rank
         FROM totals
       )
       SELECT player.*, ranked.rank::int,
         (SELECT discord_user_id FROM player_links WHERE guild_id = $1 AND normalized_ign = $2 LIMIT 1) AS discord_user_id
       FROM player LEFT JOIN ranked ON ranked.normalized_ign = $2`,
      [guildId, normalizedIgn, hour.start, hour.end, day.start, day.end],
    );
    return result.rows[0];
  }

  async getLeaderboard(guildId, periodType, periodOverride = null, limit = 100, minimumTotal = 0n) {
    let bounds;
    if (periodOverride) {
      const start = DateTime.fromJSDate(periodOverride).toUTC();
      bounds = {
        start: start.toJSDate(),
        end: start.plus({ [periodType === 'hourly' ? 'hours' : 'days']: 1 }).toJSDate(),
      };
    } else {
      bounds = this.period(periodType);
    }
    const result = await this.pool.query(
      `SELECT normalized_ign, MAX(display_ign) AS display_ign, SUM(amount)::text AS total, COUNT(*)::int AS deliveries
       FROM deliveries
       WHERE guild_id = $1 AND created_at >= $2 AND created_at < $3
       GROUP BY normalized_ign
       HAVING SUM(amount) > $5
       ORDER BY SUM(amount) DESC, normalized_ign ASC
       LIMIT $4`,
      [guildId, bounds.start, bounds.end, limit, minimumTotal.toString()],
    );
    return result.rows;
  }

  async getLeaderboardMessage(guildId, periodType, periodStart) {
    const result = await this.pool.query(
      `SELECT message_id, channel_id, finalized FROM leaderboard_messages
       WHERE guild_id = $1 AND period_type = $2 AND period_start = $3`,
      [guildId, periodType, periodStart],
    );
    return result.rows[0] || null;
  }

  async saveLeaderboardMessage(guildId, periodType, periodStart, messageId, channelId, finalized = false) {
    await this.pool.query(
      `INSERT INTO leaderboard_messages (guild_id, period_type, period_start, message_id, channel_id, finalized)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (guild_id, period_type, period_start) DO UPDATE
       SET message_id = EXCLUDED.message_id, channel_id = EXCLUDED.channel_id, finalized = EXCLUDED.finalized`,
      [guildId, periodType, periodStart, messageId, channelId, finalized],
    );
  }

  async close() {
    await this.pool.end();
  }
}

module.exports = Database;
