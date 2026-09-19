const http = require('node:http');
const {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
} = require('discord.js');
const { DateTime } = require('luxon');
const config = require('./config');
const Database = require('./db');
const { createDeliveryParser } = require('./parser');
const { LeaderboardManager } = require('./leaderboards');
const { createCommandHandler, slashCommands } = require('./commands');
const { formatInteger } = require('./format');
const { DonutApi } = require('./donut-api');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  // lets the bot see edits to log messages it has not cached (e.g. after a restart)
  partials: [Partials.Message, Partials.Channel],
});
const db = new Database(config.databaseUrl, config.timezone);
const donutApi = new DonutApi(config.donutApiKey);
const parseDelivery = createDeliveryParser(config.deliveryRegex);
const leaderboards = new LeaderboardManager(client, db, config);
const commands = createCommandHandler({ client, db, donutApi, config, leaderboards });
let ready = false;

const server = http.createServer((request, response) => {
  if (request.url === '/health') {
    response.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: ready }));
    return;
  }
  response.writeHead(200, { 'content-type': 'text/plain' });
  response.end('Melo Arrow Bot is running.');
});

client.once(Events.ClientReady, async (loggedInClient) => {
  console.log(`Logged in as ${loggedInClient.user.tag}`);
  try {
    await db.initialize();
    if (config.guildId) {
      const guild = await client.guilds.fetch(config.guildId);
      await guild.commands.set(slashCommands);
      console.log(`Registered ${slashCommands.length} slash commands in ${guild.name}`);
    } else {
      await client.application.commands.set(slashCommands);
      console.log(`Registered ${slashCommands.length} global slash commands`);
    }
    await describeChannels();
    await leaderboards.start();
    await backfillToday().catch((error) => console.error('Backfill failed:', error));
    ready = true;
    console.log('Database and leaderboards are ready.');
  } catch (error) {
    console.error('Startup failed:', error);
    process.exitCode = 1;
    client.destroy();
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (await leaderboards.onInteraction(interaction)) return;
    await commands.onInteraction(interaction);
  } catch (error) {
    console.error('Slash command failed:', error);
    const payload = { content: 'Something went wrong while running that command.', ephemeral: true };
    if (interaction.deferred || interaction.replied) await interaction.editReply(payload).catch(() => {});
    else await interaction.reply(payload).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// Arrow logs: every message in the source channel is read (any sender except
// this bot). Each one is recorded once, corrected if the message is edited,
// and the hourly/daily boards refresh straight away.
// ---------------------------------------------------------------------------

const pendingDeletes = new Set();

function isLogMessage(message) {
  return Boolean(message?.guildId)
    && message.channelId === config.sourceChannelId
    && message.author?.id !== client.user?.id;
}

async function recordLog(message) {
  const delivery = parseDelivery(message);
  if (!delivery) return null;
  const changed = await db.addDelivery({
    guildId: message.guildId,
    messageId: message.id,
    ign: delivery.ign,
    amount: delivery.amount,
    sourceType: 'automatic',
    createdAt: message.createdAt,
  });
  if (changed) {
    console.log(`Recorded ${formatInteger(delivery.amount)} arrows for ${delivery.ign}`);
    leaderboards.requestRefresh();
  }
  return delivery;
}

// Delete a sub-threshold log after a delay. Right before deleting, re-read the
// message: if it was edited up to the threshold in the meantime, it stays.
function scheduleDelete(message) {
  if (!config.deleteLogs || pendingDeletes.has(message.id)) return;
  pendingDeletes.add(message.id);
  const timer = setTimeout(async () => {
    try {
      const fresh = await message.channel.messages.fetch(message.id);
      const delivery = parseDelivery(fresh);
      if (delivery && delivery.amount < config.minimumArrowsToKeep) {
        await fresh.delete();
        console.log(`Deleted sub-${formatInteger(config.minimumArrowsToKeep)} log ${fresh.id} (${delivery.ign} ${formatInteger(delivery.amount)})`);
      }
    } catch (error) {
      if (error.code !== 10008) console.error(`Delete of ${message.id} failed:`, error);
    } finally {
      pendingDeletes.delete(message.id);
    }
  }, config.deleteDelayMs);
  timer.unref();
}

async function handleLog(message) {
  if (!isLogMessage(message)) return;
  if (message.partial) message = await message.fetch();
  const delivery = await recordLog(message);
  if (delivery && delivery.amount < config.minimumArrowsToKeep) scheduleDelete(message);
}

client.on(Events.MessageCreate, async (message) => {
  try {
    if (await commands.onPrefixMessage(message)) return;
    await handleLog(message);
  } catch (error) {
    console.error(`Message ${message.id} processing failed:`, error);
  }
});

client.on(Events.MessageUpdate, async (_old, message) => {
  try {
    await handleLog(message);
  } catch (error) {
    if (error.code !== 10008) console.error(`Edited message ${message.id} processing failed:`, error);
  }
});

// On startup, read everything posted in the source channel since the start of
// today (Riyadh), so deliveries sent while the bot was restarting still count.
async function backfillToday() {
  const channel = await client.channels.fetch(config.sourceChannelId);
  const since = DateTime.now().setZone(config.timezone).startOf('day').toMillis();
  let before;
  let scanned = 0;
  let found = 0;
  for (let page = 0; page < 100; page += 1) {
    const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    if (!batch.size) break;
    for (const message of batch.values()) {
      if (message.createdTimestamp < since) continue;
      scanned += 1;
      if (!isLogMessage(message)) continue;
      const delivery = await recordLog(message);
      if (!delivery) continue;
      found += 1;
      if (delivery.amount < config.minimumArrowsToKeep) scheduleDelete(message);
    }
    const oldest = batch.last();
    before = oldest.id;
    if (oldest.createdTimestamp < since) break;
  }
  console.log(`Backfill: scanned ${scanned} messages from today, ${found} deliveries recognised.`);
  leaderboards.requestRefresh();
}

async function describeChannels() {
  for (const [label, id] of [
    ['Source', config.sourceChannelId],
    ['Hourly', config.hourlyChannelId],
    ['Daily', config.dailyChannelId],
  ]) {
    try {
      const channel = await client.channels.fetch(id);
      console.log(`${label} channel: #${channel.name} (${id})`);
    } catch (error) {
      console.error(`${label} channel ${id} is not reachable:`, error.message);
    }
  }
  console.log(config.deleteLogs
    ? `Sub-${formatInteger(config.minimumArrowsToKeep)} logs are deleted ${config.deleteDelayMs / 1000}s after they arrive.`
    : 'Log deletion is off (DELETE_LOGS=false).');
}

client.on(Events.Error, (error) => console.error('Discord client error:', error));
process.on('unhandledRejection', (error) => console.error('Unhandled rejection:', error));

async function shutdown(signal) {
  console.log(`${signal} received; shutting down.`);
  ready = false;
  leaderboards.stop();
  client.destroy();
  server.close();
  await db.close().catch(() => {});
  process.exit(0);
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));

server.listen(config.port, '0.0.0.0', () => console.log(`Health server listening on port ${config.port}`));
client.login(config.token);
