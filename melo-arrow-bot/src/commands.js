const {
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
} = require('discord.js');
const { buildLeaderboardEmbeds } = require('./leaderboards');
const { cleanIgn, formatCompact, formatInteger, parseAmount } = require('./format');
const { DonutApiError } = require('./donut-api');

function playerOption(builder) {
  return builder.addStringOption((option) => option
    .setName('player')
    .setDescription('Minecraft IGN or a linked Discord mention')
    .setRequired(false));
}

function adminCommand(name, description) {
  return new SlashCommandBuilder()
    .setName(name)
    .setDescription(description)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);
}

const slashCommands = [
  new SlashCommandBuilder().setName('help').setDescription('Show every command'),
  new SlashCommandBuilder().setName('ping').setDescription('Check the bot response time'),
  playerOption(new SlashCommandBuilder().setName('stats').setDescription('Show arrow delivery statistics')),
  playerOption(new SlashCommandBuilder().setName('balance').setDescription('Show a player arrow balance')),
  playerOption(new SlashCommandBuilder().setName('bal').setDescription('Alias for balance')),
  new SlashCommandBuilder().setName('leaderboard').setDescription('Show the current top 100')
    .addStringOption((option) => option.setName('period').setDescription('Leaderboard period').setRequired(false)
      .addChoices({ name: 'Hourly', value: 'hourly' }, { name: 'Daily', value: 'daily' })),
  new SlashCommandBuilder().setName('lb').setDescription('Alias for leaderboard')
    .addStringOption((option) => option.setName('period').setDescription('Leaderboard period').setRequired(false)
      .addChoices({ name: 'Hourly', value: 'hourly' }, { name: 'Daily', value: 'daily' })),
  new SlashCommandBuilder().setName('link').setDescription('Link your Discord account to an IGN')
    .addStringOption((option) => option.setName('ign').setDescription('Your Minecraft IGN').setRequired(true)),
  new SlashCommandBuilder().setName('unlink').setDescription('Remove your linked IGN'),
  adminCommand('add', 'Manually record an arrow delivery')
    .addStringOption((option) => option.setName('ign').setDescription('Minecraft IGN').setRequired(true))
    .addStringOption((option) => option.setName('amount').setDescription('Arrow amount, such as 5000 or 12.5k').setRequired(true)),
  adminCommand('delivery', 'Alias for manually recording a delivery')
    .addStringOption((option) => option.setName('ign').setDescription('Minecraft IGN').setRequired(true))
    .addStringOption((option) => option.setName('amount').setDescription('Arrow amount, such as 5000 or 12.5k').setRequired(true)),
  adminCommand('refreshleaders', 'Immediately refresh both automatic leaderboards'),
].map((command) => command.toJSON());

function tokenize(input) {
  return [...input.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((match) => match[1] ?? match[2] ?? match[3]);
}

function hasAdmin(member, config) {
  return Boolean(member?.permissions?.has(PermissionFlagsBits.ManageGuild)
    || member?.roles?.cache?.some((role) => config.adminRoleIds.has(role.id)));
}

async function resolveIgn(db, guildId, invokingUserId, raw) {
  if (!raw) return db.getLinkedIgn(guildId, invokingUserId);
  const mention = raw.match(/^<@!?(\d+)>$/);
  if (mention) return db.getLinkedIgn(guildId, mention[1]);
  if (/^\d{16,22}$/.test(raw)) {
    const linked = await db.getLinkedIgn(guildId, raw);
    if (linked) return linked;
  }
  return cleanIgn(raw);
}

function helpEmbed(prefix) {
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('🏹 Arrow Bot Commands')
    .setDescription(`Every command works with both \`/\` and \`${prefix}\`.`)
    .addFields(
      { name: 'Player', value: `\`${prefix}stats [IGN/@user]\` — detailed arrow stats\n\`${prefix}bal [IGN/@user]\` — tracked arrow balance\n\`${prefix}leaderboard [hourly/daily]\` — current top 100\n\`${prefix}link <IGN>\` / \`${prefix}unlink\` — account link` },
      { name: 'Utility', value: `\`${prefix}help\` — this list\n\`${prefix}ping\` — response time` },
      { name: 'Staff', value: `\`${prefix}add <IGN> <amount>\` — manual delivery\n\`${prefix}refreshleaders\` — refresh channel leaderboards` },
    )
    .setFooter({ text: 'Slash aliases: /bal, /lb, and /delivery are also available.' });
}

function formatApiNumber(value, { compact = false, money = false } = {}) {
  const normalized = String(value ?? '0').replace(/,/g, '').trim();
  let formatted = normalized;
  if (/^-?\d+$/.test(normalized)) {
    formatted = compact ? formatCompact(normalized) : formatInteger(normalized);
  } else {
    const number = Number(normalized);
    if (Number.isFinite(number)) formatted = number.toLocaleString('en-US', { maximumFractionDigits: 2 });
  }
  return money ? `$${formatted}` : formatted;
}

function formatPlaytime(milliseconds) {
  let totalMinutes = Math.floor(Number(milliseconds || 0) / 60_000);
  if (!Number.isFinite(totalMinutes) || totalMinutes < 0) return 'Unknown';
  const days = Math.floor(totalMinutes / 1440);
  totalMinutes %= 1440;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return [days && `${days}d`, hours && `${hours}h`, `${minutes}m`].filter(Boolean).join(' ');
}

async function setLinkedThumbnail(embed, db, client, guildId, ign) {
  const discordUserId = await db.getDiscordUserIdForIgn(guildId, ign);
  if (!discordUserId) return;
  const user = await client.users.fetch(discordUserId).catch(() => null);
  if (user) embed.setThumbnail(user.displayAvatarURL({ size: 128 }));
}

async function statsEmbed(db, donutApi, client, guildId, ign) {
  const { stats, lookup } = await donutApi.getProfile(ign);
  const displayIgn = lookup?.username || ign;
  const embed = new EmbedBuilder()
    .setColor(0xd8a7e3)
    .setTitle(`Stats for ${displayIgn}`)
    .setDescription([
      `🟢 **Money:** \`${formatApiNumber(stats.money, { money: true })}\``,
      `🔮 **Shards:** \`${formatApiNumber(stats.shards)}\``,
      `⚔️ **Player Kills:** \`${formatApiNumber(stats.kills)}\``,
      `🪦 **Deaths:** \`${formatApiNumber(stats.deaths)}\``,
      `⏰ **Playtime:** \`${formatPlaytime(stats.playtime)}\``,
      `🧱 **Blocks Placed:** \`${formatApiNumber(stats.placed_blocks)}\``,
      `🧱 **Blocks Broken:** \`${formatApiNumber(stats.broken_blocks)}\``,
      `🟩 **Mobs Killed:** \`${formatApiNumber(stats.mobs_killed)}\``,
      `💡 **Shop Spending:** \`${formatApiNumber(stats.money_spent_on_shop, { money: true })}\``,
      `↪️ **Shop Sales:** \`${formatApiNumber(stats.money_made_from_sell, { money: true })}\``,
      `📍 **Status:** ${lookup ? `Online in ${lookup.location || 'DonutSMP'}` : 'Offline'}`,
      `🏷️ **Rank:** \`${lookup?.rank || 'Unknown'}\``,
    ].join('\n'))
    .setFooter({ text: 'Live data from the official DonutSMP API • Updated just now' })
    .setTimestamp();
  await setLinkedThumbnail(embed, db, client, guildId, ign);
  return embed;
}

async function balanceEmbed(db, donutApi, client, guildId, ign) {
  const { stats, lookup } = await donutApi.getProfile(ign);
  const displayIgn = lookup?.username || ign;
  const embed = new EmbedBuilder()
    .setColor(0xffa500)
    .setTitle(`${displayIgn}'s Balance`)
    .setDescription(`🟢 **Balance:** \`${formatApiNumber(stats.money, { money: true })}\`\n\n${lookup ? `Online in ${lookup.location || 'DonutSMP'}` : 'Offline'}`)
    .setFooter({ text: 'Live data from the official DonutSMP API' })
    .setTimestamp();
  await setLinkedThumbnail(embed, db, client, guildId, ign);
  return embed;
}

function createCommandHandler({ client, db, donutApi, config, leaderboards }) {
  async function execute({ command, args, guildId, userId, member, respond, defer, edit }) {
    if (!guildId) return respond({ content: 'Commands can only be used inside a server.', ephemeral: true });
    const name = ({ bal: 'balance', lb: 'leaderboard', delivery: 'add' })[command] || command;

    if (name === 'help') return respond({ embeds: [helpEmbed(config.prefix)] });
    if (name === 'ping') return respond({ content: `🏓 API heartbeat: ${client.ws.ping}ms` });

    if (name === 'stats' || name === 'balance') {
      await defer();
      const ign = await resolveIgn(db, guildId, userId, args[0]);
      if (!ign) return edit({ content: `No IGN found. Use \`${config.prefix}link YourIGN\` first or include an IGN.` });
      let embed;
      try {
        embed = name === 'stats'
          ? await statsEmbed(db, donutApi, client, guildId, ign)
          : await balanceEmbed(db, donutApi, client, guildId, ign);
      } catch (error) {
        if (error instanceof DonutApiError) return edit({ content: `⚠️ ${error.message}` });
        throw error;
      }
      return edit({ embeds: [embed] });
    }

    if (name === 'leaderboard') {
      await defer();
      const periodType = args[0]?.toLowerCase() === 'daily' ? 'daily' : 'hourly';
      const period = db.period(periodType);
      const rows = await db.getLeaderboard(guildId, periodType, period.start, 100);
      return edit({ embeds: buildLeaderboardEmbeds(rows, periodType, period.start, config.timezone) });
    }

    if (name === 'link') {
      const ign = cleanIgn(args[0]);
      if (!ign) return respond({ content: 'Please provide a valid IGN (letters, numbers, `_`, `-`, or `.`; up to 32 characters).', ephemeral: true });
      await db.linkIgn(guildId, userId, ign);
      return respond({ content: `✅ Linked your Discord account to **${ign}**.`, ephemeral: true });
    }

    if (name === 'unlink') {
      const removed = await db.unlinkIgn(guildId, userId);
      return respond({ content: removed ? '✅ Your IGN link was removed.' : 'You do not have a linked IGN.', ephemeral: true });
    }

    if (name === 'add') {
      if (!hasAdmin(member, config)) return respond({ content: 'You need **Manage Server** or a configured admin role.', ephemeral: true });
      const ign = cleanIgn(args[0]);
      const amount = parseAmount(args[1]);
      if (!ign || amount === null) return respond({ content: `Usage: \`${config.prefix}add <IGN> <amount>\` (example: \`${config.prefix}add Melo 12.5k\`)`, ephemeral: true });
      const inserted = await db.addDelivery({ guildId, ign, amount, sourceType: 'manual', recordedBy: userId });
      if (inserted) leaderboards.schedule();
      return respond({ content: `✅ Added **${formatInteger(amount)} arrows** for **${ign}**.` });
    }

    if (name === 'refreshleaders') {
      if (!hasAdmin(member, config)) return respond({ content: 'You need **Manage Server** or a configured admin role.', ephemeral: true });
      await defer();
      await leaderboards.force();
      return edit({ content: '✅ Hourly and daily leaderboards refreshed.' });
    }

    return respond({ content: `Unknown command. Use \`${config.prefix}help\`.` });
  }

  async function onInteraction(interaction) {
    if (!interaction.isChatInputCommand()) return;
    const args = [];
    if (['stats', 'balance', 'bal'].includes(interaction.commandName)) args.push(interaction.options.getString('player'));
    if (['leaderboard', 'lb'].includes(interaction.commandName)) args.push(interaction.options.getString('period'));
    if (interaction.commandName === 'link') args.push(interaction.options.getString('ign'));
    if (['add', 'delivery'].includes(interaction.commandName)) {
      args.push(interaction.options.getString('ign'), interaction.options.getString('amount'));
    }
    let deferred = false;
    await execute({
      command: interaction.commandName,
      args,
      guildId: interaction.guildId,
      userId: interaction.user.id,
      member: interaction.member,
      respond: (payload) => interaction.reply(payload),
      defer: async () => { deferred = true; await interaction.deferReply(); },
      edit: (payload) => deferred ? interaction.editReply(payload) : interaction.reply(payload),
    });
  }

  async function onPrefixMessage(message) {
    if (message.author.bot || !message.content.startsWith(config.prefix)) return false;
    const tokens = tokenize(message.content.slice(config.prefix.length).trim());
    if (!tokens.length) return false;
    const command = tokens.shift().toLowerCase();
    let placeholder = null;
    await execute({
      command,
      args: tokens,
      guildId: message.guildId,
      userId: message.author.id,
      member: message.member,
      respond: (payload) => message.reply({ ...payload, allowedMentions: { repliedUser: false } }),
      defer: async () => { placeholder = await message.reply({ content: 'Loading…', allowedMentions: { repliedUser: false } }); },
      edit: (payload) => placeholder ? placeholder.edit(payload) : message.reply({ ...payload, allowedMentions: { repliedUser: false } }),
    });
    return true;
  }

  return { onInteraction, onPrefixMessage };
}

module.exports = { slashCommands, createCommandHandler };
