# nestling-ts

TypeScript client, CLI, and local MCP server for the [Nestling baby tracking app](https://www.nestling-app.com). Read and log sleep, feed, nappy, and diary data from your Nestling account — from your terminal, a TypeScript/Bun library, or via a [Model Context Protocol](https://modelcontextprotocol.io) server for AI assistants.

> **Create-only writes.** The API can log new entries that sync to your app. It cannot update or delete existing entries — your data is always safe.

## Requirements

- [Bun](https://bun.sh/) 1.3+ — the package ships TypeScript source with no build step, so it must be run on Bun (not Node).
- A [Nestling](https://www.nestling-app.com) account (Sign in with Google or Apple)
- A Nestling API token (generate one from the app: **Settings → Data → API Token**)

## Install

Add to a project:

```bash
bun add nestling-ts
```

Or run the MCP server with no install via `bunx` (see [MCP server](#mcp-server) below).

## CLI

### Quick start

```bash
bunx --package nestling-ts nestling login
# or, inside a project where nestling-ts is installed:
bun run nestling login
# Supabase URL: https://your-project.supabase.co
# Supabase Anon Key: eyJ...
# API Token: (from Nestling app → Settings → Data → API Token)
# Timezone: Europe/London
# ✓ Authenticated as you@example.com! Found 1 child(ren).

bunx --package nestling-ts nestling babies
# • Eloise (id: abc-123)  8 months old
```

### Commands

```bash
# Sleep
nestling sleep history --days 3
nestling sleep log --start 2026-05-07T20:00:00Z --end 2026-05-08T06:30:00Z

# Feed
nestling feed history --days 2
nestling feed log --at 2026-05-07T12:00:00Z --type Bottle --amount 180

# Nappy
nestling nappy history --days 2
nestling nappy log --at 2026-05-07T14:00:00Z --type Wet

# Diary
nestling diary history --days 7
nestling diary log --at 2026-05-07T15:00:00Z --text "First time clapping!" --tags milestone,funny

# Multiple babies
nestling --baby "Eloise" sleep history
```

All `history` commands support `--json` for machine-readable output. The `--baby` flag selects a specific child by name or ID (defaults to the first baby).

### Authentication

Configuration is stored at `~/.config/nestling/config.json`.

- Interactive login: `nestling login`
- Environment variables (take precedence over config file):
  - `NESTLING_REFRESH_TOKEN`
  - `NESTLING_SUPABASE_URL`
  - `NESTLING_SUPABASE_ANON_KEY`
  - `NESTLING_TIMEZONE` (optional)

## Library usage

```ts
import { Nestling } from "nestling-ts";

const client = new Nestling({
  supabaseUrl: process.env.NESTLING_SUPABASE_URL!,
  supabaseAnonKey: process.env.NESTLING_SUPABASE_ANON_KEY!,
  refreshToken: process.env.NESTLING_REFRESH_TOKEN!,
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

## MCP server

`nestling-ts` ships a local MCP server as the `nestling-mcp` bin. It wraps the library as a set of MCP tools an AI agent can call.

### Claude Desktop / Claude Code config

The recommended setup uses `bunx` so there's nothing to install or keep up to date:

```json
{
  "mcpServers": {
    "nestling": {
      "command": "bunx",
      "args": ["--package", "nestling-ts", "nestling-mcp"],
      "env": {
        "NESTLING_REFRESH_TOKEN": "your-token-from-nestling-app",
        "NESTLING_SUPABASE_URL": "https://your-project.supabase.co",
        "NESTLING_SUPABASE_ANON_KEY": "eyJ...",
        "NESTLING_TIMEZONE": "Europe/London"
      }
    }
  }
}
```

If you've added `nestling-ts` as a dependency in a project, you can instead point at the installed bin:

```json
{
  "mcpServers": {
    "nestling": {
      "command": "bun",
      "args": ["run", "nestling-mcp"],
      "cwd": "/absolute/path/to/your/project",
      "env": {
        "NESTLING_REFRESH_TOKEN": "...",
        "NESTLING_SUPABASE_URL": "...",
        "NESTLING_SUPABASE_ANON_KEY": "...",
        "NESTLING_TIMEZONE": "..."
      }
    }
  }
}
```

> **Note:** the command must be `bun`/`bunx` — not `node`/`npx`. The package is published as raw TypeScript, which Bun executes directly.

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
- **Local only** — the MCP server runs on your machine. Credentials never leave your device.
- **Short-lived sessions** — Supabase JWTs expire after 1 hour and are auto-refreshed. Your long-lived API token is only used to bootstrap the session.

## Getting your API token

1. Open the [Nestling](https://www.nestling-app.com) app on your phone.
2. Go to **Settings → Data → API Token**.
3. Tap **Copy Token**.
4. Paste the token into your MCP config or environment variables.

The token is tied to your account. You can revoke it at any time by signing out and back in — this generates a new token and invalidates the old one.

## API reference

### `new Nestling(options)`

| Option             | Type     | Notes                                |
| ------------------- | -------- | ------------------------------------ |
| `supabaseUrl`      | `string` | Your Nestling Supabase project URL   |
| `supabaseAnonKey`  | `string` | Supabase anon (public) key           |
| `refreshToken`     | `string` | API token from the Nestling app      |

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
bun test               # run the test suite
bun run lint           # tsc --noEmit
bun run mcp            # start the MCP server locally against your env credentials
```

## Limitations

- **Create-only.** No update or delete. New entries sync to the app automatically.
- **Bun only.** The package is published as raw TypeScript, which Bun executes directly. It won't run on Node.js.

## License

MIT
