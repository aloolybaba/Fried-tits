# Melo Arrow Bot

A Railway-ready Discord bot that:

- reads every message in the arrow-log channel (#1524153641135505529), from any sender except itself;
- understands `IGN delivered you 311 Arrows` in message text or embeds;
- permanently records every parsed delivery in PostgreSQL, and corrects it if the log message is edited;
deletes log messages below 5,000 arrows after a short delay (set DELETE_LOGS=false to keep them);
updates the hourly and daily boards within seconds of each new delivery;
- - maintains clean top-100 hourly and daily leaderboards in separate channels, showing only players whose period total is above the configured 5,000-arrow threshold;
- posts a new hourly leaderboard message each hour and a new daily leaderboard message each day, with Previous/Next controls for 10-player pages;
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
   - Manage Messages (to delete sub-5,000 logs)
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

## Recommended variables

| Variable | Value |
|---|---|
| `TIMEZONE` | `Asia/Riyadh` by default; controls hour/day boundaries |
| `DELETE_LOGS` | `true` by default. Set to `false` to never delete log messages. |
| `DELETE_DELAY_SECONDS` | `60` by default. How long a sub-5,000 log stays before it is deleted. |
| `MIN_ARROWS_TO_KEEP` | `5000` by default. Logs below this are deleted, and only players whose hour/day total is above it appear on the leaderboards. |
| `PREFIX` | `!` by default |
| `ADMIN_ROLE_IDS` | Optional comma-separated role IDs allowed to use manual/admin commands |

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

A message is processed when both of these are true:

1. It is in the arrow-log channel (`1524153641135505529`) and was not sent by this bot. Any sender counts: bots, webhooks and people.
2. The content or embed contains a delivery line.

Edits are processed too, so a log that the logging service updates after posting is recorded with its final amount.

The supplied format is built in:

```text
handcrema delivered you 311 Arrows
KingKiller08 delivered you 1 Arrow
```

Every delivery is stored in PostgreSQL before any sub-5,000 log is deleted. Discord message IDs are unique in the database, so the same automatic message cannot be counted twice.

## Local test (optional)

```bash
cp .env.example .env
npm install
npm test
npm start
```

The bot records deliveries immediately. Each hourly and daily leaderboard is one message: it is posted when the Riyadh hour/day starts and edited every minute as arrows come in. When the period ends it gets a final edit marked **Final** and is never changed again, and a new message starts for the next period. On startup the bot finalizes the period that just ended and resumes editing the current one instead of posting duplicates. The top 100 is divided into 10-player pages with First, Previous, Next, and Last buttons; on a live board the view returns to page 1 at the next minute's refresh. A player is displayed only after their period total is greater than MIN_ARROWS_TO_KEEP. The source, hourly and daily channel IDs are fixed in src/config.js. On startup the bot re-reads today's messages in the source channel so nothing sent during a restart is missed.
