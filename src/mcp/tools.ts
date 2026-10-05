/**
 * Tools and UI resources served by the hosted Nestling MCP server (worker.ts).
 * The UI tools implement the OpenAI MCP Extensions spec (sidebar + conversation
 * panel entrypoints) on top of the MCP Apps standard.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { Nestling } from "../client.js";
import { NestlingError } from "../types.js";
import { parseUserDateTime } from "../parseDateTime.js";
import { describeDaySummary, getDaySummary, type DaySummary } from "../daySummary.js";
import { isCalendarDate, isValidTimeZone } from "../time.js";
import { NESTLING_UI_CSS, NESTLING_UI_JS } from "./ui.generated.js";

export const SERVER_VERSION = "0.4.0";

// ── Result helpers ──

function ok(data: unknown, totalResults?: number) {
  const structured = { data, totalResults: totalResults ?? (Array.isArray(data) ? data.length : 1) };
  return {
    structuredContent: structured,
    content: [{ type: "text" as const, text: JSON.stringify(structured, null, 2) }],
  };
}

function fail(err: unknown) {
  const isNestling = err instanceof NestlingError;
  // Mask internal error details (Supabase/Postgres messages may leak schema info)
  const safeMessage = isNestling ? err.message : "An internal error occurred. Please try again.";
  const structured = { error: isNestling ? err.name : "Error", message: safeMessage, category: isNestling ? err.category : "unknown", retryable: isNestling ? err.retryable : false, recovery: isNestling ? err.recovery : "Check your configuration and try again." };
  return {
    structuredContent: structured,
    content: [{ type: "text" as const, text: JSON.stringify(structured, null, 2) }],
    isError: true,
  };
}

class SignInRequiredError extends Error {}

/** Tool error that asks ChatGPT to show its sign-in UI. */
function signInRequired(issuer: string) {
  return {
    content: [{ type: "text" as const, text: "Sign in to Nestling to continue." }],
    _meta: {
      "mcp/www_authenticate": [
        `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource/mcp", error="invalid_token", error_description="Sign in to Nestling to continue"`,
      ],
    },
    isError: true,
  };
}

function validationError(message: string, recovery: string) {
  return new NestlingError(message, "validation", false, recovery);
}

// ── Time handling ──

type RequestMeta = Record<string, unknown> | undefined;

/** Time zone for this call: explicit argument, then ChatGPT's location hint, then UTC. */
function zoneFor(explicit: string | undefined, meta: RequestMeta): string {
  if (explicit !== undefined) {
    if (!isValidTimeZone(explicit)) throw validationError(`Unknown time zone: ${explicit}`, 'Use an IANA time zone such as "Europe/London".');
    return explicit;
  }
  const hinted = (meta?.["openai/userLocation"] as { timezone?: unknown } | undefined)?.timezone;
  return isValidTimeZone(hinted) ? hinted : "UTC";
}

function when(value: string, tz: string, field: string): string {
  try {
    return parseUserDateTime(value, { timezone: tz, isoInTimezone: true });
  } catch (e) {
    throw validationError(`${field}: ${(e as Error).message}`, 'Use ISO 8601, "now", "2 hours ago", "today 3pm", or "3:30pm".');
  }
}

/**
 * Write result. `message` keeps its original wording for existing clients;
 * `localTime` ("3:05 pm, 3 Oct 2026 (Europe/London)") shows which zone was used.
 */
function logged(id: string, message: string, iso: string, tz: string) {
  const local = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true, day: "numeric", month: "short", year: "numeric" }).format(new Date(iso));
  return ok({ id, message, at: iso, localTime: `${local} (${tz})`, timezone: tz });
}

// ── Schemas ──

const DATETIME_DESC = 'Accepts ISO 8601 ("2026-05-07T20:00:00Z"), relative ("2 hours ago", "now"), day and time ("today 3pm", "yesterday 8:30pm"), time only ("3pm"), or date and time ("2026-05-07 8pm"). Times without a zone use the timezone argument.';

const BabyIdSchema = z.string().uuid().describe("The baby's ID from list_babies");
const OptionalBabyIdSchema = BabyIdSchema.optional().describe("The baby's ID from list_babies. Leave out when the account has one baby.");
const TimeZoneSchema = z.string().max(64).optional().describe('The user\'s IANA time zone, such as "Europe/London". When left out, the host\'s location hint is used if it sends one, else UTC.');
const DateTimeSchema = z.string().min(1).max(100);
const DateSchema = z.string().optional().describe('Calendar date as "YYYY-MM-DD". Leave out for today.');
const AmountMlSchema = z.number().finite().nonnegative().max(5000).describe("Amount in millilitres (max 5000)");
const NotesSchema = z.string().max(10000).optional().describe("Optional notes (max 10,000 characters)");
const DiaryTextSchema = z.string().max(10000).describe("The diary entry text (max 10,000 characters)");
const TagsSchema = z.array(z.string().max(100)).max(50).optional().describe("Optional tags (max 50 tags, each max 100 characters)");
const RangeSchema = {
  babyId: BabyIdSchema,
  start: DateTimeSchema.describe(`Start of the range. ${DATETIME_DESC}`),
  end: DateTimeSchema.describe(`End of the range. ${DATETIME_DESC}`),
  timezone: TimeZoneSchema,
};

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
// Writes only add new entries; Nestling's API cannot edit or delete.
const ADD_ONLY = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;

const ListOutputSchema = {
  data: z.array(z.record(z.string(), z.unknown())).describe("Array of records"),
  totalResults: z.number().int().nonnegative(),
};
const RecordOutputSchema = {
  data: z.record(z.string(), z.unknown()).describe("Single record"),
  totalResults: z.number().int().nonnegative(),
};
const MutationOutputSchema = {
  data: z.object({
    id: z.string(),
    message: z.string(),
    at: z.string().optional().describe("When the entry happened, ISO 8601 UTC"),
    localTime: z.string().optional().describe("The same time in the time zone used, with the zone name"),
    timezone: z.string().optional().describe("Time zone used to read the times given"),
  }),
  totalResults: z.number().int().nonnegative(),
};

const ProfileOutputSchema = z
  .object({
    id: z.string().min(1).regex(/\S/).describe("Opaque Nestling account ID. Stable across sign-ins."),
    email: z.string().optional().describe("Email address for display; not used as the profile identity."),
  })
  .strict();

const DaySummaryOutputSchema = z.object({
  baby: z.object({ id: z.string(), name: z.string(), birthDate: z.string().nullable() }),
  babies: z.array(z.object({ id: z.string(), name: z.string() })),
  date: z.string().describe("Calendar date, YYYY-MM-DD"),
  timezone: z.string(),
  isToday: z.boolean(),
  totals: z.object({
    sleepMinutes: z.number().describe("Minutes asleep within this day, including sleep that crossed midnight"),
    sleeps: z.number().describe("Sleeps that started this day"),
    longestSleepMinutes: z.number().describe("Full length of the longest sleep that touched this day, including any part before midnight"),
    feeds: z.number(),
    bottleMl: z.number(),
    breastfeedMinutes: z.number(),
    solids: z.number(),
    nappies: z.number(),
    wetNappies: z.number(),
    dirtyNappies: z.number(),
    diaryEntries: z.number(),
  }),
  lastFeedAt: z.string().nullable(),
  lastNappyAt: z.string().nullable(),
  awakeSince: z.string().nullable().describe("Today only: when the most recent sleep ended"),
  timeline: z.array(
    z.object({
      id: z.string(),
      kind: z.enum(["sleep", "feed", "nappy", "diary"]),
      at: z.string(),
      end: z.string().nullable(),
      label: z.string(),
      detail: z.string().nullable(),
      notes: z.string().nullable(),
    }),
  ),
});

// ── UI resources ──

const DAY_UI = "ui://nestling/day-v1.html";
const LOG_UI = "ui://nestling/log-v1.html";

function appHtml(view: "day" | "log"): string {
  // The bundle is inlined; escape "</script" so it cannot end the tag early.
  const js = NESTLING_UI_JS.replace(/<\/script/gi, "<\\/script");
  return `<!doctype html><html lang="en" data-view="${view}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Nestling</title><style>${NESTLING_UI_CSS}</style></head><body><main id="root" aria-live="polite"></main><script type="module">${js}</script></body></html>`;
}

function uiResourceMeta(issuer: string, chatgpt: boolean, modes: { preferred: "inline" | "fullscreen"; available: ("inline" | "fullscreen")[] }, description: string) {
  return {
    ui: {
      prefersBorder: true,
      // Each host has its own domain format, and Claude rejects any value but its own hash.
      // The app makes no requests, so only ChatGPT (which requires one to publish) gets a domain.
      ...(chatgpt ? { domain: issuer } : {}),
      csp: { connectDomains: [], resourceDomains: [] },
    },
    "openai/widgetDomain": issuer,
    "openai/ui": { preferredDisplayMode: modes.preferred, availableDisplayModes: modes.available },
    "openai/widgetDescription": description,
  };
}

// ── Tool list extras the SDK cannot express: icons and per-tool auth ──

const OAUTH = [{ type: "oauth2", scopes: [] as string[] }];

function entrypointIcon(issuer: string, name: string) {
  return [{ src: `${issuer}/icons/${name}.svg`, mimeType: "image/svg+xml", sizes: ["any"] }];
}

function patchToolList(server: McpServer, extras: Map<string, Record<string, unknown>>) {
  // McpServer owns the tools/list handler; wrap it to add spec fields its config type lacks.
  const handlers = (server.server as unknown as { _requestHandlers: Map<string, (req: unknown, extra: unknown) => Promise<{ tools: Record<string, unknown>[] }>> })._requestHandlers;
  const original = handlers.get("tools/list");
  if (!original) return;
  handlers.set("tools/list", async (req, extra) => {
    const result = await original(req, extra);
    for (const tool of result.tools) {
      Object.assign(tool, { securitySchemes: OAUTH }, extras.get(tool.name as string) ?? {});
    }
    return result;
  });
}

// ── Server ──

export interface ToolContext {
  client: Nestling | null;
  issuer: string;
  /** The request came from ChatGPT, which reads host-specific resource metadata. */
  chatgpt?: boolean;
}

export function registerNestlingTools(server: McpServer, { client, issuer, chatgpt = false }: ToolContext): void {
  const extras = new Map<string, Record<string, unknown>>();
  const meta = (more: Record<string, unknown> = {}) => ({ securitySchemes: OAUTH, ...more });

  /** Run a tool body with a signed-in client and uniform error handling. */
  const run = async <T>(body: (c: Nestling) => Promise<T>): Promise<T | ReturnType<typeof fail> | ReturnType<typeof signInRequired>> => {
    try {
      if (!client) throw new SignInRequiredError();
      return await body(client);
    } catch (e) {
      if (e instanceof SignInRequiredError) return signInRequired(issuer);
      return fail(e);
    }
  };

  const daySummaryResult = (summary: DaySummary, note?: string) => ({
    structuredContent: summary as unknown as Record<string, unknown>,
    content: [{ type: "text" as const, text: note ? `${describeDaySummary(summary)} ${note}` : describeDaySummary(summary) }],
  });

  /** Day summary for UI tools: falls back to the first baby instead of asking. */
  const uiDay = async (c: Nestling, args: { babyId?: string; date?: string; timezone?: string }, reqMeta: RequestMeta) => {
    const tz = zoneFor(args.timezone, reqMeta);
    if (args.date !== undefined && !isCalendarDate(args.date)) throw validationError(`Invalid date: ${args.date}`, 'Use "YYYY-MM-DD".');
    let babyId = args.babyId;
    if (!babyId) {
      const babies = await c.babies.list();
      babyId = babies[0]?.id;
    }
    return getDaySummary(c, { babyId, date: args.date, timezone: tz });
  };

  // ── Account ──

  server.registerTool("get_user", {
    title: "Get Nestling account",
    description: "Get the signed-in user's Nestling profile (email, ID).",
    outputSchema: RecordOutputSchema,
    annotations: READ_ONLY,
    _meta: meta(),
  }, async () => run(async (c) => ok(await c.getUser())));

  // ChatGPT's account profile tool. A separate tool, so get_user keeps its original output shape.
  server.registerTool("get_profile", {
    title: "Get connected account",
    description: "Return the connected Nestling account as a stable account ID and email address. Use this when the user asks which Nestling account is connected.",
    outputSchema: ProfileOutputSchema,
    annotations: READ_ONLY,
    _meta: meta({ "openai/profile": true }),
  }, async () => run(async (c) => {
    const user = await c.getUser();
    const profile = { id: user.id, ...(user.email ? { email: user.email } : {}) };
    return { structuredContent: profile, content: [{ type: "text" as const, text: JSON.stringify(profile) }] };
  }));

  server.registerTool("get_capabilities", {
    title: "List Nestling features",
    description: "List what this Nestling connection can read and log. Use this only when the user asks what Nestling can do here.",
    outputSchema: RecordOutputSchema,
    annotations: READ_ONLY,
    _meta: meta(),
  }, async () => ok({
    // Original fields, kept for existing clients
    tools: ["get_capabilities", "get_user", "get_profile", "list_babies", "get_baby", "get_day_summary", "show_day", "list_sleep", "list_feeds", "list_nappies", "list_diary", "create_sleep", "create_feed", "create_nappy", "create_diary"],
    dataSources: ["babies", "sleep", "feeds", "nappies", "diary"],
    timezone: "UTC",
    readOnly: false,
    read: ["babies", "sleep", "feeds", "nappies", "diary", "day summaries"],
    log: ["sleep", "feeds", "nappies", "diary entries"],
    limits: "New entries only. This connection cannot edit or delete entries.",
  }));

  // ── Read tools ──

  server.registerTool("list_babies", {
    title: "List babies",
    description: "List the babies on the user's Nestling account, including babies shared with them. Use this first to get a babyId when the user has not named a baby or when a tool needs babyId.",
    outputSchema: ListOutputSchema,
    annotations: READ_ONLY,
    _meta: meta(),
  }, async () => run(async (c) => ok(await c.babies.list())));

  server.registerTool("get_baby", {
    title: "Get baby details",
    description: "Get one baby's details: name, birth date and when they were added. Use this when the user asks about a baby's age or profile.",
    inputSchema: { babyId: BabyIdSchema },
    outputSchema: RecordOutputSchema,
    annotations: READ_ONLY,
    _meta: meta(),
  }, async ({ babyId }) => run(async (c) => ok(await c.babies.get(babyId))));

  server.registerTool("get_day_summary", {
    title: "Get day summary",
    description: "Summarise one calendar day for a baby: total sleep (including overnight sleep that crossed midnight), number of sleeps and feeds, bottle millilitres, breastfeeding minutes, wet and dirty nappies, and a timeline of every entry. Use this for questions like \"how did she sleep today?\", \"how many feeds yesterday?\" or \"when was the last nappy?\". Returns data only; to show the day visually, call show_day.",
    inputSchema: { babyId: OptionalBabyIdSchema, date: DateSchema, timezone: TimeZoneSchema },
    outputSchema: DaySummaryOutputSchema,
    annotations: READ_ONLY,
    _meta: meta({ "openai/toolInvocation/invoking": "Reading the day…", "openai/toolInvocation/invoked": "Day ready" }),
  }, async (args, extra) => run(async (c) => {
    if (args.date !== undefined && !isCalendarDate(args.date)) throw validationError(`Invalid date: ${args.date}`, 'Use "YYYY-MM-DD".');
    const summary = await getDaySummary(c, { babyId: args.babyId, date: args.date, timezone: zoneFor(args.timezone, extra._meta) });
    return daySummaryResult(summary);
  }));

  const listTool = (name: string, title: string, description: string, read: (c: Nestling, babyId: string, start: Date, end: Date) => Promise<unknown[]>) =>
    server.registerTool(name, {
      title,
      description,
      inputSchema: RangeSchema,
      outputSchema: ListOutputSchema,
      annotations: READ_ONLY,
      _meta: meta(),
    }, async ({ babyId, start, end, timezone }, extra) => run(async (c) => {
      const tz = zoneFor(timezone, extra._meta);
      return ok(await read(c, babyId, new Date(when(start, tz, "start")), new Date(when(end, tz, "end"))));
    }));

  listTool("list_sleep", "List sleep", "List a baby's sleep sessions that started within a time range, with start, end and length in minutes. Use this for sleep across several days or exact sleep times. For one day's totals, prefer get_day_summary.", (c, id, s, e) => c.sleep.list(id, { start: s, end: e }));
  listTool("list_feeds", "List feeds", "List a baby's feeds (breastfeeding, bottle, solids, expressing) within a time range, with amount in ml, duration in seconds and side. Use this for feeds across several days or exact feed times. For one day's totals, prefer get_day_summary.", (c, id, s, e) => c.feed.list(id, { start: s, end: e }));
  listTool("list_nappies", "List nappies", "List a baby's nappy (diaper) changes within a time range, each marked Wet, Dirty or Both. Use this for nappies across several days. For one day's totals, prefer get_day_summary.", (c, id, s, e) => c.nappies.list(id, { start: s, end: e }));
  listTool("list_diary", "List diary entries", "List a baby's diary entries (free-text notes and milestones) within a time range. Use this when the user asks what they wrote, or about notes and milestones.", (c, id, s, e) => c.diary.list(id, { start: s, end: e }));

  // ── Write tools (add-only) ──

  server.registerTool("create_sleep", {
    title: "Log sleep",
    description: `Add a finished sleep session to the baby's Nestling log. Use this only when the user asks to log or record a sleep that has ended. Each call adds a new entry, so do not retry after success. ${DATETIME_DESC}`,
    inputSchema: { babyId: BabyIdSchema, start: DateTimeSchema.describe("When the sleep started"), end: DateTimeSchema.describe("When the sleep ended"), notes: NotesSchema, timezone: TimeZoneSchema },
    outputSchema: MutationOutputSchema,
    annotations: ADD_ONLY,
    _meta: meta({ "openai/toolInvocation/invoking": "Logging sleep…", "openai/toolInvocation/invoked": "Sleep logged" }),
  }, async ({ babyId, start, end, notes, timezone }, extra) => run(async (c) => {
    const tz = zoneFor(timezone, extra._meta);
    const startAt = when(start, tz, "start");
    const id = await c.sleep.create(babyId, { start: startAt, end: when(end, tz, "end"), notes });
    return logged(id, "Sleep session created", startAt, tz);
  }));

  server.registerTool("create_feed", {
    title: "Log feed",
    description: `Add a feed to the baby's Nestling log: breastfeeding (with duration and side), bottle (with amount in ml), solids, or expressing. Use this only when the user asks to log or record a feed. Each call adds a new entry, so do not retry after success. ${DATETIME_DESC}`,
    inputSchema: {
      babyId: BabyIdSchema,
      timestamp: DateTimeSchema.describe("When the feed happened (for breastfeeding, when it started)"),
      type: z.enum(["Breastfeeding", "Bottle", "Solids", "Expressing"]).describe("Feed type"),
      durationSeconds: z.number().finite().nonnegative().optional().describe("Duration in seconds"),
      amountMl: AmountMlSchema.optional(),
      side: z.enum(["Left", "Right", "Both"]).optional().describe("Breast side, for breastfeeding or expressing"),
      notes: NotesSchema,
      timezone: TimeZoneSchema,
    },
    outputSchema: MutationOutputSchema,
    annotations: ADD_ONLY,
    _meta: meta({ "openai/toolInvocation/invoking": "Logging feed…", "openai/toolInvocation/invoked": "Feed logged" }),
  }, async ({ babyId, timestamp, type, durationSeconds, amountMl, side, notes, timezone }, extra) => run(async (c) => {
    const tz = zoneFor(timezone, extra._meta);
    const at = when(timestamp, tz, "timestamp");
    const id = await c.feed.create(babyId, { timestamp: at, type, durationSeconds, amountMl, side, notes });
    return logged(id, "Feed entry created", at, tz);
  }));

  server.registerTool("create_nappy", {
    title: "Log nappy",
    description: `Add a nappy (diaper) change to the baby's Nestling log: Wet, Dirty, or Both. Use this only when the user asks to log or record a nappy change. Each call adds a new entry, so do not retry after success. ${DATETIME_DESC}`,
    inputSchema: { babyId: BabyIdSchema, timestamp: DateTimeSchema.describe("When the nappy was changed"), type: z.enum(["Wet", "Dirty", "Both"]).describe("Nappy type"), notes: NotesSchema, timezone: TimeZoneSchema },
    outputSchema: MutationOutputSchema,
    annotations: ADD_ONLY,
    _meta: meta({ "openai/toolInvocation/invoking": "Logging nappy…", "openai/toolInvocation/invoked": "Nappy logged" }),
  }, async ({ babyId, timestamp, type, notes, timezone }, extra) => run(async (c) => {
    const tz = zoneFor(timezone, extra._meta);
    const at = when(timestamp, tz, "timestamp");
    const id = await c.nappies.create(babyId, { timestamp: at, type, notes });
    return logged(id, "Nappy entry created", at, tz);
  }));

  server.registerTool("create_diary", {
    title: "Add diary entry",
    description: `Add a diary entry (a free-text note or milestone) to the baby's Nestling diary. Use this only when the user asks to write, note or record something in the diary. Each call adds a new entry, so do not retry after success. ${DATETIME_DESC}`,
    inputSchema: { babyId: BabyIdSchema, timestamp: DateTimeSchema.describe("When it happened"), text: DiaryTextSchema, tags: TagsSchema, timezone: TimeZoneSchema },
    outputSchema: MutationOutputSchema,
    annotations: ADD_ONLY,
    _meta: meta({ "openai/toolInvocation/invoking": "Saving to the diary…", "openai/toolInvocation/invoked": "Diary entry added" }),
  }, async ({ babyId, timestamp, text, tags, timezone }, extra) => run(async (c) => {
    const tz = zoneFor(timezone, extra._meta);
    const at = when(timestamp, tz, "timestamp");
    const id = await c.diary.create(babyId, { timestamp: at, text, tags });
    return logged(id, "Diary entry created", at, tz);
  }));

  // ── UI: day view (inline card + sidebar app) and quick-log panel ──

  server.registerResource("nestling-day", DAY_UI, { title: "Nestling day view", mimeType: RESOURCE_MIME_TYPE }, async () => ({
    contents: [{
      uri: DAY_UI,
      mimeType: RESOURCE_MIME_TYPE,
      text: appHtml("day"),
      _meta: uiResourceMeta(issuer, chatgpt, { preferred: "inline", available: ["inline", "fullscreen"] }, "Shows the baby's day: total sleep, feeds and nappies, and a timeline. The user can change the day and log new entries here."),
    }],
  }));

  server.registerResource("nestling-log", LOG_UI, { title: "Nestling quick log", mimeType: RESOURCE_MIME_TYPE }, async () => ({
    contents: [{
      uri: LOG_UI,
      mimeType: RESOURCE_MIME_TYPE,
      text: appHtml("log"),
      _meta: uiResourceMeta(issuer, chatgpt, { preferred: "fullscreen", available: ["fullscreen"] }, "A panel with buttons to log a feed, sleep or nappy, and the latest entries for today."),
    }],
  }));

  const uiInput = { babyId: OptionalBabyIdSchema, date: DateSchema, timezone: TimeZoneSchema };

  server.registerTool("show_day", {
    title: "Show day",
    description: "Show the user a visual view of one day for a baby: total sleep, feeds and nappies, and a timeline they can scroll and add to. Use this when the user asks to see, show or open their day or timeline. For a plain answer without a visual, use get_day_summary.",
    inputSchema: uiInput,
    outputSchema: DaySummaryOutputSchema,
    annotations: READ_ONLY,
    _meta: meta({ ui: { resourceUri: DAY_UI }, "openai/toolInvocation/invoking": "Opening the day…", "openai/toolInvocation/invoked": "Day shown" }),
  }, async (args, extra) => run(async (c) => daySummaryResult(await uiDay(c, args, extra._meta), "The day view is now shown to the user; do not repeat every entry.")));

  server.registerTool("open_dashboard", {
    title: "Nestling",
    description: "Open the Nestling day view from the sidebar.",
    inputSchema: uiInput,
    outputSchema: DaySummaryOutputSchema,
    annotations: READ_ONLY,
    _meta: meta({ ui: { resourceUri: DAY_UI, visibility: ["app"] }, "openai/ui": { entrypoints: [{ type: "global" }] }, "openai/iconStyle": "monochrome" }),
  }, async (args, extra) => run(async (c) => daySummaryResult(await uiDay(c, args, extra._meta))));
  extras.set("open_dashboard", { icons: entrypointIcon(issuer, "nest") });

  server.registerTool("open_quick_log", {
    title: "Quick log",
    description: "Open a panel beside the conversation for logging feeds, sleep and nappies.",
    inputSchema: uiInput,
    outputSchema: DaySummaryOutputSchema,
    annotations: READ_ONLY,
    _meta: meta({ ui: { resourceUri: LOG_UI, visibility: ["app"] }, "openai/ui": { entrypoints: [{ type: "thread" }] }, "openai/iconStyle": "monochrome" }),
  }, async (args, extra) => run(async (c) => daySummaryResult(await uiDay(c, args, extra._meta))));
  extras.set("open_quick_log", { icons: entrypointIcon(issuer, "quick-log") });

  patchToolList(server, extras);
}

/** Monochrome 20×20 sidebar icons (currentColor, 1.33px strokes) per the OpenAI icon guidelines. */
export const ENTRYPOINT_ICONS: Record<string, string> = {
  nest: `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.33" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5c0 3.3 3.1 5.5 7 5.5s7-2.2 7-5.5"/><path d="M3 10.5h14"/><path d="M5 13l2-1M15 13l-2-1M10 16v-2"/><circle cx="10" cy="6.5" r="2.5"/></svg>`,
  "quick-log": `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.33" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="3.5" width="13" height="13" rx="3"/><path d="M10 7v6M7 10h6"/></svg>`,
};
