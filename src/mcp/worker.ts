/**
 * Cloudflare Worker entry point for the Nestling MCP server.
 * Runs multi-tenant: each request authenticates via Bearer token.
 * Deploy with: `wrangler deploy`
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { Nestling } from "../client.js";
import { NestlingError } from "../types.js";
import { parseUserDateTime } from "../parseDateTime.js";

// ── Session + client caches (persist within isolate lifetime) ──

const sessions = new Map<string, {
  transport: InstanceType<typeof WebStandardStreamableHTTPServerTransport>;
  server: McpServer;
}>();

const clientCache = new Map<string, Nestling>();

// ── Helpers ──

function ok(data: unknown, totalResults?: number) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ data, totalResults: totalResults ?? (Array.isArray(data) ? data.length : 1) }, null, 2) }],
  };
}

function fail(err: unknown) {
  const isNestling = err instanceof NestlingError;
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: isNestling ? err.name : "Error", message: err instanceof Error ? err.message : String(err), category: isNestling ? err.category : "unknown", retryable: isNestling ? err.retryable : false, recovery: isNestling ? err.recovery : "Check your configuration and try again." }, null, 2) }],
    isError: true,
  };
}

const DATETIME_DESC = 'Date/time — accepts ISO 8601 ("2026-05-07T20:00:00Z"), relative ("2 hours ago", "now"), day+time ("today 3pm", "yesterday 8:30pm"), time-only ("3pm"), or date+time ("2026-05-07 8pm")';
const timezone = "UTC"; // Worker doesn't know user TZ; tools accept ISO or relative

const BabyIdSchema = z.string().uuid().describe("The baby's UUID");
const FlexDateTimeSchema = z.string().transform((val) => parseUserDateTime(val, { timezone }));
const NonNegativeNumberSchema = z.number().finite().nonnegative();
const DateRangeSchema = { start: FlexDateTimeSchema.describe(`Start: ${DATETIME_DESC}`), end: FlexDateTimeSchema.describe(`End: ${DATETIME_DESC}`) };

// ── Server factory ──

function createServer(client: Nestling): McpServer {
  const server = new McpServer({ name: "nestling", version: "0.2.3" });

  server.tool("get_capabilities", "Discovery: list available data sources and tools", {}, async () => {
    return ok({ tools: ["get_capabilities","get_user","list_babies","get_baby","list_sleep","list_feeds","list_nappies","list_diary","create_sleep","create_feed","create_nappy","create_diary"], dataSources: ["babies","sleep","feeds","nappies","diary"], timezone, readOnly: false });
  });

  server.tool("get_user", "Get the authenticated user's profile (email, ID)", {}, async () => {
    try { return ok(await client.getUser()); } catch (e) { return fail(e); }
  });

  server.tool("list_babies", "List all babies the user has access to (owned + shared)", {}, async () => {
    try { return ok(await client.babies.list()); } catch (e) { return fail(e); }
  });

  server.tool("get_baby", "Get details for a specific baby by ID", { babyId: BabyIdSchema }, async ({ babyId }) => {
    try { return ok(await client.babies.get(babyId)); } catch (e) { return fail(e); }
  });

  server.tool("list_sleep", "List sleep sessions for a baby within a date range", { babyId: BabyIdSchema, ...DateRangeSchema }, async ({ babyId, start, end }) => {
    try { return ok(await client.sleep.list(babyId, { start: new Date(start), end: new Date(end) })); } catch (e) { return fail(e); }
  });

  server.tool("list_feeds", "List feeding entries (breast, bottle, solids) for a baby within a date range", { babyId: BabyIdSchema, ...DateRangeSchema }, async ({ babyId, start, end }) => {
    try { return ok(await client.feed.list(babyId, { start: new Date(start), end: new Date(end) })); } catch (e) { return fail(e); }
  });

  server.tool("list_nappies", "List nappy/diaper entries for a baby within a date range", { babyId: BabyIdSchema, ...DateRangeSchema }, async ({ babyId, start, end }) => {
    try { return ok(await client.nappies.list(babyId, { start: new Date(start), end: new Date(end) })); } catch (e) { return fail(e); }
  });

  server.tool("list_diary", "List diary/journal entries for a baby within a date range", { babyId: BabyIdSchema, ...DateRangeSchema }, async ({ babyId, start, end }) => {
    try { return ok(await client.diary.list(babyId, { start: new Date(start), end: new Date(end) })); } catch (e) { return fail(e); }
  });

  server.tool("create_sleep", "Log a sleep session for a baby. Accepts flexible time formats.", { babyId: BabyIdSchema, start: FlexDateTimeSchema.describe(`Sleep start: ${DATETIME_DESC}`), end: FlexDateTimeSchema.describe(`Sleep end: ${DATETIME_DESC}`), notes: z.string().optional().describe("Optional notes") }, async ({ babyId, start, end, notes }) => {
    try { const id = await client.sleep.create(babyId, { start, end, notes }); return ok({ id, message: "Sleep session created" }); } catch (e) { return fail(e); }
  });

  server.tool("create_feed", "Log a feeding entry for a baby. Accepts flexible time formats.", { babyId: BabyIdSchema, timestamp: FlexDateTimeSchema.describe(`When the feed happened: ${DATETIME_DESC}`), type: z.enum(["Breastfeeding","Bottle","Solids","Expressing"]).describe("Feed type"), durationSeconds: NonNegativeNumberSchema.optional().describe("Duration in seconds"), amountMl: NonNegativeNumberSchema.optional().describe("Amount in millilitres"), side: z.enum(["Left","Right","Both"]).optional().describe("Which side (for breastfeeding)"), notes: z.string().optional().describe("Optional notes") }, async ({ babyId, timestamp, type, durationSeconds, amountMl, side, notes }) => {
    try { const id = await client.feed.create(babyId, { timestamp, type, durationSeconds, amountMl, side, notes }); return ok({ id, message: "Feed entry created" }); } catch (e) { return fail(e); }
  });

  server.tool("create_nappy", "Log a nappy/diaper change for a baby. Accepts flexible time formats.", { babyId: BabyIdSchema, timestamp: FlexDateTimeSchema.describe(`When the nappy change happened: ${DATETIME_DESC}`), type: z.enum(["Wet","Dirty","Both"]).describe("Nappy type"), notes: z.string().optional().describe("Optional notes") }, async ({ babyId, timestamp, type, notes }) => {
    try { const id = await client.nappies.create(babyId, { timestamp, type, notes }); return ok({ id, message: "Nappy entry created" }); } catch (e) { return fail(e); }
  });

  server.tool("create_diary", "Log a diary/journal entry for a baby. Accepts flexible time formats.", { babyId: BabyIdSchema, timestamp: FlexDateTimeSchema.describe(`When the event happened: ${DATETIME_DESC}`), text: z.string().describe("The diary entry text"), tags: z.array(z.string()).optional().describe("Optional tags (e.g. ['milestone', 'funny'])") }, async ({ babyId, timestamp, text, tags }) => {
    try { const id = await client.diary.create(babyId, { timestamp, text, tags }); return ok({ id, message: "Diary entry created" }); } catch (e) { return fail(e); }
  });

  return server;
}

// ── Auth ──

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

// ── Worker fetch handler ──

export default {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id",
          "Access-Control-Expose-Headers": "Mcp-Session-Id",
        },
      });
    }

    // Health check
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok" }), { headers: { "Content-Type": "application/json" } });
    }

    // MCP endpoint
    if (url.pathname === "/mcp") {
      const sessionId = req.headers.get("mcp-session-id");

      // Existing session
      if (sessionId && sessions.has(sessionId)) {
        const { transport } = sessions.get(sessionId)!;
        return transport.handleRequest(req);
      }

      // New session — requires Bearer token
      if (req.method === "POST" && !sessionId) {
        const token = extractBearerToken(req);
        if (!token) {
          return new Response(
            JSON.stringify({ error: "Missing Authorization: Bearer <nestling-api-token>", hint: "Get your API token from the Nestling app: Settings → Data → API Token" }),
            { status: 401, headers: { "Content-Type": "application/json" } },
          );
        }

        let client: Nestling;
        try {
          client = await getOrCreateClient(token);
        } catch {
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

      return new Response("Session not found. Send a new POST without Mcp-Session-Id to start.", { status: 404 });
    }

    return new Response("Not Found", { status: 404 });
  },
};
