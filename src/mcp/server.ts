#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Nestling } from "../client.js";
import { NestlingError } from "../types.js";
import { parseUserDateTime } from "../parseDateTime.js";

// ── Environment ──

const NESTLING_API_TOKEN = process.env.NESTLING_API_TOKEN;
const NESTLING_TIMEZONE = process.env.NESTLING_TIMEZONE ?? "UTC";

const isHttpMode = process.argv.includes("--http");

if (!isHttpMode && !NESTLING_API_TOKEN) {
  console.error("Missing required env var: NESTLING_API_TOKEN");
  process.exit(1);
}

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

/**
 * Flexible date/time schema that accepts user-friendly formats:
 * ISO 8601 ("2026-05-07T20:00:00Z"), relative ("2 hours ago", "now"),
 * day+time ("today 3pm", "yesterday 8:30pm"), time-only ("3pm", "15:30"),
 * or date+time ("2026-05-07 8pm").
 */
const FlexDateTimeSchema = z
  .string()
  .transform((val) => parseUserDateTime(val, { timezone: NESTLING_TIMEZONE }));

const NonNegativeNumberSchema = z.number().finite().nonnegative();

const DATETIME_DESC =
  'Date/time — accepts ISO 8601 ("2026-05-07T20:00:00Z"), relative ("2 hours ago", "now"), day+time ("today 3pm", "yesterday 8:30pm"), time-only ("3pm"), or date+time ("2026-05-07 8pm")';

const DateRangeSchema = {
  start: FlexDateTimeSchema.describe(`Start: ${DATETIME_DESC}`),
  end: FlexDateTimeSchema.describe(`End: ${DATETIME_DESC}`),
};

// ── Server factory ──

function createServer(client: Nestling): McpServer {
  const server = new McpServer({
    name: "nestling",
    version: "0.2.3",
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
  "Log a sleep session for a baby. Accepts flexible time formats: ISO 8601, relative (\"2 hours ago\"), day+time (\"today 3pm\"), or time-only (\"3pm\").",
  {
    babyId: BabyIdSchema,
    start: FlexDateTimeSchema.describe(`Sleep start: ${DATETIME_DESC}`),
    end: FlexDateTimeSchema.describe(`Sleep end: ${DATETIME_DESC}`),
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
  "Log a feeding entry for a baby. Accepts flexible time formats.",
  {
    babyId: BabyIdSchema,
    timestamp: FlexDateTimeSchema.describe(`When the feed happened: ${DATETIME_DESC}`),
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
  "Log a nappy/diaper change for a baby. Accepts flexible time formats.",
  {
    babyId: BabyIdSchema,
    timestamp: FlexDateTimeSchema.describe(`When the nappy change happened: ${DATETIME_DESC}`),
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
  "Log a diary/journal entry for a baby. Accepts flexible time formats.",
  {
    babyId: BabyIdSchema,
    timestamp: FlexDateTimeSchema.describe(`When the event happened: ${DATETIME_DESC}`),
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

  return server;
}

// ── Start ──

async function main() {
  const mode = isHttpMode ? "http" : "stdio";

  if (mode === "http") {
    const { WebStandardStreamableHTTPServerTransport } = await import(
      "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
    );

    const port = parseInt(process.env.PORT ?? "8787", 10);

    // Per-session state: each session has its own McpServer + Nestling client
    const sessions = new Map<string, {
      transport: InstanceType<typeof WebStandardStreamableHTTPServerTransport>;
      server: McpServer;
    }>();

    // Client cache: reuse authenticated clients across sessions for the same token
    const clientCache = new Map<string, Nestling>();

    async function getOrCreateClient(token: string): Promise<Nestling> {
      if (clientCache.has(token)) return clientCache.get(token)!;
      const c = new Nestling({ apiToken: token });
      await c.signIn();
      clientCache.set(token, c);
      return c;
    }

    function extractBearerToken(req: Request): string | null {
      const auth = req.headers.get("authorization");
      if (!auth) return null;
      const match = auth.match(/^Bearer\s+(.+)$/i);
      return match?.[1] ?? null;
    }

    Bun.serve({
      port,
      async fetch(req: Request): Promise<Response> {
        const url = new URL(req.url);

        // Health check
        if (url.pathname === "/health") {
          return new Response(JSON.stringify({ status: "ok" }), {
            headers: { "Content-Type": "application/json" },
          });
        }

        // MCP endpoint
        if (url.pathname === "/mcp") {
          // Check for existing session
          const sessionId = req.headers.get("mcp-session-id");

          if (sessionId && sessions.has(sessionId)) {
            const { transport } = sessions.get(sessionId)!;
            return transport.handleRequest(req);
          }

          // New session — requires Bearer token
          if (req.method === "POST" && !sessionId) {
            const token = extractBearerToken(req) ?? NESTLING_API_TOKEN;
            if (!token) {
              return new Response(
                JSON.stringify({ error: "Missing Authorization: Bearer <nestling-api-token>" }),
                { status: 401, headers: { "Content-Type": "application/json" } },
              );
            }

            let client: Nestling;
            try {
              client = await getOrCreateClient(token);
            } catch (e) {
              return new Response(
                JSON.stringify({ error: "Authentication failed. Check your Nestling API token." }),
                { status: 401, headers: { "Content-Type": "application/json" } },
              );
            }

            const mcpServer = createServer(client);
            const transport = new WebStandardStreamableHTTPServerTransport({
              sessionIdGenerator: () => crypto.randomUUID(),
              onsessioninitialized: (id) => {
                sessions.set(id, { transport, server: mcpServer });
              },
            });

            transport.onclose = () => {
              const id = [...sessions.entries()].find(([, s]) => s.transport === transport)?.[0];
              if (id) sessions.delete(id);
            };

            await mcpServer.connect(transport);
            return transport.handleRequest(req);
          }

          return new Response("Session not found", { status: 404 });
        }

        return new Response("Not Found", { status: 404 });
      },
    });

    console.error(`Nestling MCP server (HTTP) listening on http://localhost:${port}/mcp`);
    console.error(`Auth: Bearer token (Nestling API token) ${NESTLING_API_TOKEN ? "or env fallback" : "required"}`);
  } else {
    // stdio mode — single client from env
    const client = new Nestling({ apiToken: NESTLING_API_TOKEN! });
    await client.signIn();
    const server = createServer(client);
    const transport = new StdioServerTransport();
    await server.connect(transport);
  }
}

main().catch((err) => {
  console.error("Failed to start nestling MCP server:", err.message);
  process.exit(1);
});
