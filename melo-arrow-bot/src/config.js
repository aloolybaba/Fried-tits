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

const timezone = process.env.TIMEZONE?.trim() || 'Asia/Riyadh';
if (!DateTime.now().setZone(timezone).isValid) {
  throw new Error(`TIMEZONE is not a valid IANA timezone: ${timezone}`);
}

module.exports = Object.freeze({
  token: required('DISCORD_TOKEN'),
  databaseUrl: required('DATABASE_URL'),
  donutApiKey: required('DONUTSMP_API_KEY'),
  guildId: process.env.GUILD_ID?.trim() || null,
  // Fixed channels. These deliberately ignore Railway variables so a stale
  // SOURCE_/HOURLY_/DAILY_ variable can never point the bot at the wrong place.
  sourceChannelId: '1524153641135505529',
  hourlyChannelId: '1537958861229523034',
  dailyChannelId: '1537957766826557541',
  // Delete sub-threshold log messages. The delay gives the logging service time
  // to finish with its own message before it disappears.
  deleteLogs: process.env.DELETE_LOGS?.trim().toLowerCase() !== 'false',
  deleteDelayMs: integer('DELETE_DELAY_SECONDS', 60, 0) * 1000,
  prefix: process.env.PREFIX || '!',
  minimumArrowsToKeep: BigInt(integer('MIN_ARROWS_TO_KEEP', 5000, 0)),
  timezone,
  adminRoleIds: new Set(csv('ADMIN_ROLE_IDS')),
  deliveryRegex: process.env.DELIVERY_REGEX?.trim() || null,
  port: integer('PORT', 3000, 1),
});
