const { DateTime } = require('luxon');

require('dotenv').config();

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function csv(name) {
  return (process.env[name] || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function integer(name, fallback, minimum = 0) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer of at least ${minimum}`);
  }
  return value;
}

const timezone = process.env.TIMEZONE?.trim() || 'UTC';
if (!DateTime.now().setZone(timezone).isValid) {
  throw new Error(`TIMEZONE is not a valid IANA timezone: ${timezone}`);
}

module.exports = Object.freeze({
  token: required('DISCORD_TOKEN'),
  databaseUrl: required('DATABASE_URL'),
  donutApiKey: required('DONUTSMP_API_KEY'),
  guildId: process.env.GUILD_ID?.trim() || null,
  sourceBotId: process.env.SOURCE_BOT_ID?.trim() || null,
  sourceChannelIds: new Set(csv('SOURCE_CHANNEL_IDS')),
  hourlyChannelId: process.env.HOURLY_CHANNEL_ID?.trim() || '1537958861229523034',
  dailyChannelId: process.env.DAILY_CHANNEL_ID?.trim() || '1537957766826557541',
  prefix: process.env.PREFIX || '!',
  minimumArrowsToKeep: BigInt(integer('MIN_ARROWS_TO_KEEP', 5000, 0)),
  timezone,
  leaderboardUpdateDelayMs: integer('LEADERBOARD_UPDATE_DELAY_MS', 5000, 1000),
  adminRoleIds: new Set(csv('ADMIN_ROLE_IDS')),
  deliveryRegex: process.env.DELIVERY_REGEX?.trim() || null,
  port: integer('PORT', 3000, 1),
});
