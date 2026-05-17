#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Nestling } from "../client.js";
import { NestlingError } from "../types.js";
import { isIsoDateTimeString } from "../validation.js";

// ── Environment ──

const NESTLING_API_TOKEN = process.env.NESTLING_API_TOKEN;
const NESTLING_TIMEZONE = process.env.NESTLING_TIMEZONE ?? "UTC";

if (!NESTLING_API_TOKEN) {
  console.error("Missing required env var: NESTLING_API_TOKEN");
  process.exit(1);
}

// ── Client ──

const client = new Nestling({
  apiToken: NESTLING_API_TOKEN,
});

// ── Helpers ──

function ok(data: unknown, totalResults?: number) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          { data, totalResults: totalResults ?? (Array.isArray(data) ? data.length : 1) },
          null,
          2,
        ),
      },
    ],
  };
}

function fail(err: unknown) {
  const isNestling = err instanceof NestlingError;
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            error: isNestling ? err.name : "Error",
            message: err instanceof Error ? err.message : String(err),
            category: isNestling ? err.category : "unknown",
            retryable: isNestling ? err.retryable : false,
            recovery: isNestling ? err.recovery : "Check your configuration and try again.",
          },
          null,
          2,
        ),
      },
    ],
    isError: true,
  };
}

const BabyIdSchema = z.string().uuid().describe("The baby's UUID");

const IsoDateTimeSchema = z
  .string()
  .refine(isIsoDateTimeString, {
    message: "Must be a valid ISO 8601 date/time with timezone",
  });

const NonNegativeNumberSchema = z.number().finite().nonnegative();

const DateRangeSchema = {
  start: IsoDateTimeSchema.describe(
    "Start date/time in ISO 8601 format (e.g. 2026-05-01T00:00:00Z)",
  ),
  end: IsoDateTimeSchema.describe(
    "End date/time in ISO 8601 format (e.g. 2026-05-08T00:00:00Z)",
  ),
};

// ── Server ──

const server = new McpServer({
  name: "nestling",
  version: "0.1.0",
});

// get_capabilities
server.tool(
  "get_capabilities",
  "Discovery: list available data sources and tools",
  {},
  async () => {
    return ok({
      tools: [
        "get_capabilities",
        "get_user",
        "list_babies",
        "get_baby",
        "list_sleep",
        "list_feeds",
        "list_nappies",
        "list_diary",
        "create_sleep",
        "create_feed",
        "create_nappy",
        "create_diary",
      ],
      dataSources: ["babies", "sleep", "feeds", "nappies", "diary"],
      timezone: NESTLING_TIMEZONE,
      readOnly: false,
    });
  },
);

// get_user
server.tool(
  "get_user",
  "Get the authenticated user's profile (email, ID)",
  {},
  async () => {
    try {
      const user = await client.getUser();
      return ok(user);
    } catch (e) {
      return fail(e);
    }
  },
);

// list_babies
server.tool(
  "list_babies",
  "List all babies the user has access to (owned + shared)",
  {},
  async () => {
    try {
      const babies = await client.babies.list();
      return ok(babies);
    } catch (e) {
      return fail(e);
    }
  },
);

// get_baby
server.tool(
  "get_baby",
  "Get details for a specific baby by ID",
  {
    babyId: BabyIdSchema,
  },
  async ({ babyId }) => {
    try {
      const baby = await client.babies.get(babyId);
      return ok(baby);
    } catch (e) {
      return fail(e);
    }
  },
);

// list_sleep
server.tool(
  "list_sleep",
  "List sleep sessions for a baby within a date range",
  {
    babyId: BabyIdSchema,
    ...DateRangeSchema,
  },
  async ({ babyId, start, end }) => {
    try {
      const entries = await client.sleep.list(babyId, {
        start: new Date(start),
        end: new Date(end),
      });
      return ok(entries);
    } catch (e) {
      return fail(e);
    }
  },
);

// list_feeds
server.tool(
  "list_feeds",
  "List feeding entries (breast, bottle, solids) for a baby within a date range",
  {
    babyId: BabyIdSchema,
    ...DateRangeSchema,
  },
  async ({ babyId, start, end }) => {
    try {
      const entries = await client.feed.list(babyId, {
        start: new Date(start),
        end: new Date(end),
      });
      return ok(entries);
    } catch (e) {
      return fail(e);
    }
  },
);

// list_nappies
server.tool(
  "list_nappies",
  "List nappy/diaper entries for a baby within a date range",
  {
    babyId: BabyIdSchema,
    ...DateRangeSchema,
  },
  async ({ babyId, start, end }) => {
    try {
      const entries = await client.nappies.list(babyId, {
        start: new Date(start),
        end: new Date(end),
      });
      return ok(entries);
    } catch (e) {
      return fail(e);
    }
  },
);

// list_diary
server.tool(
  "list_diary",
  "List diary/journal entries for a baby within a date range",
  {
    babyId: BabyIdSchema,
    ...DateRangeSchema,
  },
  async ({ babyId, start, end }) => {
    try {
      const entries = await client.diary.list(babyId, {
        start: new Date(start),
        end: new Date(end),
      });
      return ok(entries);
    } catch (e) {
      return fail(e);
    }
  },
);

// ── Write tools ──

// create_sleep
server.tool(
  "create_sleep",
  "Log a sleep session for a baby. Provide start and end times in ISO 8601 format.",
  {
    babyId: BabyIdSchema,
    start: IsoDateTimeSchema.describe("Sleep start time in ISO 8601 format"),
    end: IsoDateTimeSchema.describe("Sleep end time in ISO 8601 format"),
    notes: z.string().optional().describe("Optional notes about the sleep session"),
  },
  async ({ babyId, start, end, notes }) => {
    try {
      const id = await client.sleep.create(babyId, { start, end, notes });
      return ok({ id, message: "Sleep session created" });
    } catch (e) {
      return fail(e);
    }
  },
);

// create_feed
server.tool(
  "create_feed",
  "Log a feeding entry for a baby",
  {
    babyId: BabyIdSchema,
    timestamp: IsoDateTimeSchema.describe("When the feed happened (ISO 8601)"),
    type: z.enum(["Breastfeeding", "Bottle", "Solids", "Expressing"]).describe("Feed type"),
    durationSeconds: NonNegativeNumberSchema.optional().describe("Duration in seconds"),
    amountMl: NonNegativeNumberSchema.optional().describe("Amount in millilitres"),
    side: z.enum(["Left", "Right", "Both"]).optional().describe("Which side (for breastfeeding)"),
    notes: z.string().optional().describe("Optional notes"),
  },
  async ({ babyId, timestamp, type, durationSeconds, amountMl, side, notes }) => {
    try {
      const id = await client.feed.create(babyId, {
        timestamp, type, durationSeconds, amountMl, side, notes,
      });
      return ok({ id, message: "Feed entry created" });
    } catch (e) {
      return fail(e);
    }
  },
);

// create_nappy
server.tool(
  "create_nappy",
  "Log a nappy/diaper change for a baby",
  {
    babyId: BabyIdSchema,
    timestamp: IsoDateTimeSchema.describe("When the nappy change happened (ISO 8601)"),
    type: z.enum(["Wet", "Dirty", "Both"]).describe("Nappy type"),
    notes: z.string().optional().describe("Optional notes"),
  },
  async ({ babyId, timestamp, type, notes }) => {
    try {
      const id = await client.nappies.create(babyId, { timestamp, type, notes });
      return ok({ id, message: "Nappy entry created" });
    } catch (e) {
      return fail(e);
    }
  },
);

// create_diary
server.tool(
  "create_diary",
  "Log a diary/journal entry for a baby",
  {
    babyId: BabyIdSchema,
    timestamp: IsoDateTimeSchema.describe("When the event happened (ISO 8601)"),
    text: z.string().describe("The diary entry text"),
    tags: z.array(z.string()).optional().describe("Optional tags (e.g. ['milestone', 'funny'])"),
  },
  async ({ babyId, timestamp, text, tags }) => {
    try {
      const id = await client.diary.create(babyId, { timestamp, text, tags });
      return ok({ id, message: "Diary entry created" });
    } catch (e) {
      return fail(e);
    }
  },
);

// ── Start ──

async function main() {
  await client.signIn();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Failed to start nestling MCP server:", err.message);
  process.exit(1);
});
