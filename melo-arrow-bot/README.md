# Melo Arrow Bot

A Railway-ready Discord bot that:

- reads only bot messages from configured arrow-log channels;
- understands `IGN delivered you 311 Arrows` in message text or embeds;
- permanently records every parsed delivery in PostgreSQL;
- deletes only source-bot log messages below the configured threshold (5,000 by default);
- maintains clean top-100 hourly and daily leaderboards in separate channels;
- keeps exactly one hourly embed and one daily embed, editing those same messages continuously;
- shows live DonutSMP `/stats` and balance data through the official API;
- supports fast prefix and slash versions of every command.

## 1. Discord bot setup

1. Open the [Discord Developer Portal](https://discord.com/developers/applications), create an application, and add a bot.
2. On the **Bot** page, enable **Message Content Intent**.
3. Reset/copy the bot token. Never post it or commit it to GitHub.
4. Invite the bot with the `bot` and `applications.commands` scopes.
5. Give it these server/channel permissions:
   - View Channels
   - Send Messages
   - Embed Links
   - Read Message History
   - Manage Messages (required to delete sub-5k logs)
   - Use Application Commands

The source logging bot must post into a normal text channel the new bot can see.

## 2. Railway deployment

1. Upload this entire folder to a GitHub repository.
2. In Railway, create a project and deploy the repository.
3. Add a **PostgreSQL** service to the same Railway project.
4. Open the bot service's **Variables** tab and add the variables below.
5. Deploy. The bot automatically creates its database tables and registers commands.

Do not use Railway ephemeral files for data. This project stores all deliveries, links, and leaderboard message references in PostgreSQL, so redeploys/restarts do not reset anything.

## Required variables

| Variable | Value |
|---|---|
| `DISCORD_TOKEN` | Token from the Discord Developer Portal |
| `DATABASE_URL` | Railway PostgreSQL connection URL; use a Railway reference such as `${{Postgres.DATABASE_URL}}` |
| `DONUTSMP_API_KEY` | Your private DonutSMP player API key. Generate/retrieve it in-game with `/api`; never commit it to GitHub. |
| `GUILD_ID` | Your Discord server ID (recommended for instant slash-command registration) |
| `SOURCE_CHANNEL_IDS` | Arrow log channel ID; comma-separate multiple channels |

## Recommended variables

| Variable | Value |
|---|---|
| `SOURCE_BOT_ID` | User ID of the Minecraft logging bot. This prevents other bots in the log channel being parsed. |
| `HOURLY_CHANNEL_ID` | `1537958861229523034` (already the default) |
| `DAILY_CHANNEL_ID` | `1537957766826557541` (already the default) |
| `TIMEZONE` | `Asia/Riyadh` by default; controls hour/day boundaries |
| `MIN_ARROWS_TO_KEEP` | `5000` by default. Logs below this are deleted; exactly 5,000 stays. |
| `PREFIX` | `!` by default |
| `ADMIN_ROLE_IDS` | Optional comma-separated role IDs allowed to use manual/admin commands |
| `LEADERBOARD_UPDATE_DELAY_MS` | `5000` by default; batches rapid updates to stay fast without rate-limit spam |

Railway automatically supplies `PORT`. You do not need to set it.

## Commands

Every command has both a `!` and `/` version.

| Prefix command | Slash command | Purpose |
|---|---|---|
| `!stats [IGN/@user]` | `/stats` | Live DonutSMP money, shards, kills, deaths, playtime, blocks, mobs, and shop stats |
| `!bal [IGN/@user]` | `/bal` | Live DonutSMP money balance |
| `!balance [IGN/@user]` | `/balance` | Same live balance |
| `!leaderboard [hourly/daily]` | `/leaderboard` | Current top 100 |
| `!lb [hourly/daily]` | `/lb` | Leaderboard alias |
| `!link <IGN>` | `/link` | Link your Discord user to an IGN |
| `!unlink` | `/unlink` | Remove your link |
| `!add <IGN> <amount>` | `/add` | Staff-only manual delivery |
| `!delivery <IGN> <amount>` | `/delivery` | Manual-delivery alias |
| `!refreshleaders` | `/refreshleaders` | Staff-only immediate refresh |
| `!purge <1-100>` | `/purge` | Staff-only deletion of recent channel messages |
| `!ping` | `/ping` | Bot latency |
| `!help` | `/help` | Command list |

Amounts accept commas and suffixes: `5000`, `5,000`, `12.5k`, `2m`.

If `!stats` or `!bal` is used without a player, the bot uses the caller's linked IGN. A direct IGN or a mention of a linked Discord member also works.

Stats and balance use `GET /v1/stats/{user}` from the official DonutSMP API with your player API key in the `Authorization: Bearer ...` header. Responses are cached for 15 seconds to make repeated commands fast and protect the API's rate limit. If DonutSMP returns its generic handler error for a valid player, the bot falls back to the player's public Donut Stats profile. Overall score/rank are added from the public all-time ranking. The API key stays in Railway Variables and is never shown by the bot.

## How automatic logging works

For a message to be processed, all of these must be true:

1. The author is a bot (never a human).
2. The message is in `SOURCE_CHANNEL_IDS`.
3. If `SOURCE_BOT_ID` is set, the author matches that exact bot.
4. The content or embed contains the expected delivery line.

The supplied format is built in:

```text
handcrema delivered you 311 Arrows
KingKiller08 delivered you 1 Arrow
```

The delivery is inserted into PostgreSQL before a sub-5k log is deleted. Discord message IDs are unique in the database, so the same automatic message cannot be counted twice.

## Local test (optional)

```bash
cp .env.example .env
npm install
npm test
npm start
```

If a leaderboard channel already contains an active message created by this bot, its ID is remembered in PostgreSQL and that same single message is edited forever—even when the Riyadh hour/day changes. All 100 ranked users are shown inside one embed.
