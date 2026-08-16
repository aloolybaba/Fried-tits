const http = require('node:http');
const {
  Client,
  Events,
  GatewayIntentBits,
} = require('discord.js');
const config = require('./config');
const Database = require('./db');
const { createDeliveryParser } = require('./parser');
const { LeaderboardManager } = require('./leaderboards');
const { createCommandHandler, slashCommands } = require('./commands');
const { formatInteger } = require('./format');
const { DonutApi } = require('./donut-api');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
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
    if (!config.sourceChannelIds.size) {
      console.warn('SOURCE_CHANNEL_IDS is empty: automatic log tracking is disabled until it is configured.');
    }
    await leaderboards.start();
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

client.on(Events.MessageCreate, async (message) => {
  try {
    if (await commands.onPrefixMessage(message)) return;
    if (!message.guildId || !message.author.bot || message.author.id === client.user.id) return;
    if (!config.sourceChannelIds.has(message.channelId)) return;
    if (config.sourceBotId && message.author.id !== config.sourceBotId) return;

    const delivery = parseDelivery(message);
    if (!delivery) return;
    const inserted = await db.addDelivery({
      guildId: message.guildId,
      messageId: message.id,
      ign: delivery.ign,
      amount: delivery.amount,
      sourceType: 'automatic',
      createdAt: message.createdAt,
    });
    if (inserted) {
      console.log(`Recorded ${formatInteger(delivery.amount)} arrows for ${delivery.ign}`);
    }
    if (delivery.amount < config.minimumArrowsToKeep) {
      await message.delete();
      console.log(`Deleted sub-${formatInteger(config.minimumArrowsToKeep)} bot log message ${message.id}`);
    }
  } catch (error) {
    console.error(`Message ${message.id} processing failed:`, error);
  }
});

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
