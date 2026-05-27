# nestling-ts

TypeScript client, CLI, and MCP server for the [Nestling baby tracking app](https://www.nestling-app.com). Read and log sleep, feed, nappy, and diary data from your Nestling account — from your terminal, a TypeScript/Bun library, or via a [Model Context Protocol](https://modelcontextprotocol.io) server for Claude, ChatGPT, and other AI assistants.

> **Create-only writes.** The API can log new entries that sync to your app. It cannot update or delete existing entries — your data is always safe.

## Requirements

- [Bun](https://bun.sh/) 1.3+ — the package ships TypeScript source with no build step, so it must be run on Bun (not Node).
- A [Nestling](https://www.nestling-app.com) account (Sign in with Google or Apple)
- A Nestling API token (generate one from the app: **Settings → Data → API Token**)

## Install

From npm:

```bash
bun add -g nestling-ts
# provides `nestling` and `nestling-mcp`

# or add it to a project as a library
bun add nestling-ts
```

From a source checkout:

```bash
cd nestling-ts
bun install
bun link          # makes `nestling` available globally
```

## CLI

### Quick start

```bash
nestling login
# API Token: (from Nestling app → Settings → Data → API Token)
# Timezone: Europe/London
# ✓ Authenticated as you@example.com! Found 1 child(ren).

nestling babies
# • Eloise (id: abc-123)  8 months old
```

If you haven't run `bun link`, use the package script instead:

```bash
bun run --cwd /path/to/nestling-ts nestling -- login
bun run --cwd /path/to/nestling-ts nestling -- babies
```

### Commands

```bash
# Sleep
nestling sleep history --days 3
nestling sleep log --start "yesterday 8pm" --end "today 6:30am"
nestling sleep log --start 2026-05-07T20:00:00Z --end 2026-05-08T06:30:00Z

# Feed
nestling feed history --days 2
nestling feed log --at "now" --type Bottle --amount 180
nestling feed log --at "30m ago" --type Breastfeeding --side Left

# Nappy
nestling nappy history --days 2
nestling nappy log --at "5 minutes ago" --type Wet

# Diary
nestling diary history --days 7
nestling diary log --at "today 3pm" --text "First time clapping!" --tags milestone,funny

# Multiple babies
nestling --baby "Eloise" sleep history
```

All `history` commands support `--json` for machine-readable output. The `--baby` flag selects a specific child by name or ID (defaults to the first baby).

### Time formats

All time arguments accept flexible, human-friendly formats:

| Format | Example |
| --- | --- |
| ISO 8601 | `2026-05-07T20:00:00Z` |
| Date + time | `2026-05-07 8pm`, `2026-05-07 20:00` |
| Relative day | `today 3pm`, `yesterday 8:30pm`, `tomorrow 7am` |
| Time only (today) | `3pm`, `3:30pm`, `15:30` |
| Relative | `now`, `5 minutes ago`, `2 hours ago`, `30m ago` |

Times are resolved using your configured timezone (`NESTLING_TIMEZONE` env var or `timezone` in `~/.config/nestling/config.json`).

### Authentication

Configuration is stored at `~/.config/nestling/config.json`.

- Interactive login: `nestling login`
- Environment variables (take precedence over config file):
  - `NESTLING_API_TOKEN`
  - `NESTLING_TIMEZONE` (optional)

## Library usage

```ts
import { Nestling } from "nestling-ts";

const client = new Nestling({
  apiToken: process.env.NESTLING_API_TOKEN!,
});

// Authenticate
await client.signIn();

// Account & babies
const user = await client.getUser();
const babies = await client.babies.list();
const baby = await client.babies.get(babies[0].id);

// History (all take a DateRange)
const range = {
  start: new Date("2026-05-01T00:00:00Z"),
  end: new Date("2026-05-08T00:00:00Z"),
};
await client.sleep.list(baby.id, range);
await client.feed.list(baby.id, range);     // breast | bottle | solids | expressing
await client.nappies.list(baby.id, range);  // wet | dirty | both
await client.diary.list(baby.id, range);    // journal entries & milestones

// Log new entries
await client.sleep.create(baby.id, {
  start: "2026-05-07T20:00:00Z",
  end: "2026-05-08T06:30:00Z",
});

await client.feed.create(baby.id, {
  timestamp: "2026-05-07T12:00:00Z",
  type: "Bottle",
  amountMl: 180,
});

await client.nappies.create(baby.id, {
  timestamp: "2026-05-07T14:00:00Z",
  type: "Wet",
});

await client.diary.create(baby.id, {
  timestamp: "2026-05-07T15:00:00Z",
  text: "First time clapping!",
  tags: ["milestone"],
});

await client.close();
```

### Cloud compatibility

`nestling-ts` keeps API-facing names ergonomic while writing the iOS-compatible cloud model. For example, `amountMl` and `durationSeconds` are accepted by `client.feed.create()`, then stored in Supabase as feed payload keys `amount` and `duration`. Entry payloads are written as stringified JSON in `entries.data` to match the current iOS sync implementation.

When adding new tools or direct Supabase writers, follow the root README's canonical entry wire format. In particular, use feed values `Breastfeeding`, `Bottle`, `Solids`, `Expressing`; nappy values `Wet`, `Dirty`, `Both`; and sleep `source` values `manual` or `timer`.

## MCP server

`nestling-ts` ships an MCP server as the `nestling-mcp` bin. It wraps the library as a set of MCP tools any AI agent can call — including Claude, ChatGPT, and other LLM interfaces that support MCP.

The server supports two transport modes:

- **stdio** (default) — for local use with Claude Desktop, Claude Code, Cursor, etc.
- **HTTP** (`--http`) — remote Streamable HTTP transport for Claude custom connectors, ChatGPT custom connectors, or any MCP-compatible client over the network.

### Claude Desktop / Claude Code (stdio)

Point at the source checkout:

```json
{
  "mcpServers": {
    "nestling": {
      "command": "bun",
      "args": ["run", "nestling-mcp"],
      "cwd": "/absolute/path/to/nestling-ts",
      "env": {
        "NESTLING_API_TOKEN": "your-token-from-nestling-app",
        "NESTLING_TIMEZONE": "Europe/London"
      }
    }
  }
}
```

> **Note:** the command must be `bun`/`bunx` — not `node`/`npx`. The package is published as raw TypeScript, which Bun executes directly.

### Claude custom connector (remote MCP / HTTP mode)

**Hosted (simplest — no setup required):**

If a hosted Nestling MCP endpoint is available (e.g. `https://mcp.nestling-app.com/mcp`), just add it as a connector in Claude:

1. Get your API token: open Nestling → **Settings → Data → API Token** → Copy.
2. In Claude, go to **Customize → Connectors → Add custom connector** (Pro/Max) or ask an org owner to add it (Team/Enterprise).
3. Set:
   - **URL:** `https://mcp.nestling-app.com/mcp`
   - **Auth type:** Bearer Token
   - **Token:** paste your Nestling API token
4. Done. Claude can now read and log your baby's data.

No ngrok, no ports, no self-hosting. Each user authenticates with their own token.

**Self-hosted:**

Run the MCP server in HTTP mode yourself:

```bash
# Single-user (token from env)
export NESTLING_API_TOKEN="your-token"
bun run nestling-mcp -- --http
# Nestling MCP server (HTTP) listening on http://localhost:8787/mcp

# Multi-user (no env token; each request authenticates via Bearer header)
bun run nestling-mcp -- --http
# Users pass their own token as Authorization: Bearer <token>
```

Set a custom port with `PORT=3000 bun run nestling-mcp -- --http`.

For public access, put the server behind HTTPS (Cloudflare Tunnel, nginx, etc.) — Claude connects from Anthropic's cloud, so localhost won't work.

### ChatGPT custom connector

ChatGPT supports MCP tool servers as custom connectors in GPT Builder. Use the hosted endpoint or run your own:

1. Use the hosted URL or run `bun run nestling-mcp -- --http` on a server.
2. In ChatGPT GPT Builder → Actions → "Add action".
3. Set the server URL to your `/mcp` endpoint.
4. Set auth to **Bearer** and paste your Nestling API token.
5. ChatGPT will discover tools automatically via the MCP protocol.

### Tools

| Tool                | Purpose                                                               |
| ------------------- | --------------------------------------------------------------------- |
| `get_capabilities`  | Discovery: what data sources and tools are available                  |
| `get_user`          | Account profile (email, user ID)                                      |
| `list_babies`       | Baby roster (`id` is passed to every other tool)                      |
| `get_baby`          | Baby details (nickname, birth date, etc.)                             |
| `list_sleep`        | Sleep sessions for a baby in a date range                             |
| `list_feeds`        | Feeding entries (breast, bottle, solids) in a date range              |
| `list_nappies`      | Nappy/diaper entries in a date range                                  |
| `list_diary`        | Diary/journal entries in a date range                                 |
| `create_sleep`      | Log a new sleep session (start + end time)                            |
| `create_feed`       | Log a new feed (breast, bottle, solids, expressing)                   |
| `create_nappy`      | Log a new nappy/diaper change                                         |
| `create_diary`      | Log a new diary/journal entry                                         |

Read tools return data; write tools create new entries (no update or delete).

### Response envelope

```json
{
  "data": [...],
  "totalResults": 12
}
```

### Error envelope

```json
{
  "error": "BabyNotFoundError",
  "message": "Baby not found: abc",
  "category": "not_found",
  "retryable": false,
  "recovery": "Use client.babies.list() (or the list_babies MCP tool) to get valid baby IDs."
}
```

## Security

- **Create-only writes** — the API can add new entries but cannot update or delete existing ones.
- **User-scoped** — authenticates as a regular Nestling user via Supabase Auth. Row Level Security ensures you can only access your own babies and data (plus any shared with you).
- **No service keys** — uses the Supabase **anon** key, not a service role key. The anon key is safe to distribute; it only enables RLS-protected access.
- **Local or self-hosted remote** — in stdio mode, credentials stay on your machine. In HTTP mode, each user authenticates per-session with their own Bearer token.
- **Per-user isolation** — the HTTP server creates a separate authenticated session per token. Users can only access their own data via Supabase RLS.
- **Short-lived sessions** — Supabase JWTs expire after 1 hour and are auto-refreshed. Your long-lived API token is only used to bootstrap the session.

## Getting your API token

1. Open the [Nestling](https://www.nestling-app.com) app on your phone.
2. Go to **Settings → Data → API Token**.
3. Tap **Copy Token**.
4. Paste the token into your MCP config or environment variables.

The token is tied to your account. You can revoke it at any time by tapping **API Token** again — generating a new token invalidates the old one.

## API reference

### `new Nestling(options)`

| Option             | Type     | Notes                                |
| ------------------- | -------- | ------------------------------------ |
| `apiToken`         | `string` | API token from the Nestling app      |

### Read methods

- `client.babies.list()` → `Baby[]`
- `client.babies.get(babyId)` → `Baby`
- `client.sleep.list(babyId, range)` → `SleepEntry[]`
- `client.feed.list(babyId, range)` → `FeedEntry[]`
- `client.nappies.list(babyId, range)` → `NappyEntry[]`
- `client.diary.list(babyId, range)` → `DiaryEntry[]`

### Write methods

- `client.sleep.create(babyId, input)` → `string` (new entry ID)
- `client.feed.create(babyId, input)` → `string`
- `client.nappies.create(babyId, input)` → `string`
- `client.diary.create(babyId, input)` → `string`

### Error classes

- `NestlingError` — base class with `category`, `retryable`, `recovery`
- `AuthenticationError` — bad credentials or expired session
- `BabyNotFoundError` — unknown baby ID
- `InvalidDateRangeError` — `start >= end`, or non-Date input

## Development

```bash
bun install
bun link               # register `nestling` and `nestling-mcp` on your PATH
bun test               # run the test suite
bun run lint           # tsc --noEmit
bun run nestling       # run the CLI (e.g. bun run nestling -- babies)
bun run mcp            # start the MCP server locally
```

## Voice assistants

### Siri

Built into the iOS app — no setup needed. Say things like:

- "Log nappy in Nestling"
- "Start sleep in Nestling"
- "Log breastfeed in Nestling"
- "Log bottle in Nestling"

Works via the Shortcuts app on iOS 16+.

### Alexa

The [`alexa/`](alexa/) directory contains a self-hosted Alexa skill that tracks feeds, sleep, and nappies by voice. It runs on your own AWS account as a Lambda function.

#### Voice commands

| What you want to do | Say |
|---|---|
| Start sleep | "Alexa, tell Nestling to start sleep" |
| Stop sleep | "Alexa, tell Nestling to stop sleep" |
| Pause / resume sleep | "Alexa, tell Nestling to pause sleep" |
| Log a wet nappy | "Alexa, tell Nestling to log a wee nappy" |
| Log a dirty nappy | "Alexa, tell Nestling to log a poo nappy" |
| Log a wet and dirty nappy | "Alexa, tell Nestling to log a wet and dirty nappy" |
| Start nursing | "Alexa, tell Nestling to start nursing" |
| Switch sides | "Alexa, tell Nestling to switch sides" |
| Stop nursing | "Alexa, tell Nestling to stop nursing" |
| Log a bottle | "Alexa, tell Nestling to log a 120 ml bottle" |
| Log solids | "Alexa, tell Nestling to log sweet potato" |
| Last sleep | "Alexa, ask Nestling for the last sleep" |
| Last feed | "Alexa, ask Nestling for the last feed" |
| Last nappy | "Alexa, ask Nestling for the last nappy" |

Both **nappy/diaper** and **wee/pee** are accepted.

#### Prerequisites

- AWS account with permissions to deploy CloudFormation stacks and Lambda functions
- [Alexa Developer account](https://developer.amazon.com/alexa) (free)
- Nestling account with at least one baby added
- Your API token from the Nestling app (Settings → Data → API Token for AI Access)
- Node.js 20+ and npm
- [SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html)

#### Deploy

```bash
cd alexa
npm install
npm run build
sam build
sam deploy --guided
```

SAM will prompt for:

| Parameter | Description | Example |
|---|---|---|
| `NestlingApiToken` | API token from the app | (base64 string) |
| `Timezone` | IANA timezone for spoken times | `Europe/London` |

After the stack deploys, copy the **Lambda ARN** from the outputs.

#### Connect to Alexa

1. Open the [Alexa Developer Console](https://developer.amazon.com/alexa/console/ask)
2. Create a new **Custom** skill (choose "Provision your own" hosting)
3. Go to **Build** → **Interaction Model** → **JSON Editor**
4. Paste the contents of [`alexa/skill/interactionModel.json`](alexa/skill/interactionModel.json)
5. Under **Endpoint**, select **AWS Lambda ARN** and paste your Lambda ARN
6. Click **Save Model**, then **Build Model**
7. Test in the Alexa simulator or on your device

#### Updating

After code changes or a new API token:

```bash
cd alexa && npm run build && sam build && sam deploy
```

#### Security

- Your API token is stored as an encrypted Lambda environment variable (`NoEcho`)
- It is never logged or included in Alexa responses
- All Supabase queries run through Row Level Security — the token can only access your own data

## Limitations

- **Create-only.** No update or delete. New entries sync to the app automatically.
- **Bun only.** The CLI and library require Bun. The Alexa skill uses Node.js (deployed as a Lambda).

## License

MIT
