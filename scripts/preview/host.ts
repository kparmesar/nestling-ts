/**
 * Local stand-in for ChatGPT: loads a Nestling UI resource in an iframe and
 * answers its tool calls from in-memory sample data. See scripts/preview/serve.ts.
 */
import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { Nestling } from "../../src/client.js";
import { getDaySummary } from "../../src/daySummary.js";

const params = new URLSearchParams(location.search);
const view = params.get("view") === "log" ? "log" : "day";
const mode = (params.get("mode") ?? (view === "log" ? "fullscreen" : "inline")) as "inline" | "fullscreen";
const theme = (params.get("theme") ?? "light") as "light" | "dark";
const babies = params.get("babies") === "0" ? 0 : params.get("babies") === "2" ? 2 : 1;
const signedOut = params.get("auth") === "none";
const timeZone = params.get("tz") ?? "Europe/London";

// ── Sample data: a realistic day, relative to now ──

const now = Date.now();
const ago = (minutes: number) => new Date(now - minutes * 60000).toISOString();
let seq = 0;
const id = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
const babyList = [
  { id: id(), ownerId: "u", nickname: "Ada", birthDate: "2026-05-02", createdAt: ago(60 * 24 * 150) },
  { id: id(), ownerId: "u", nickname: "Theo", birthDate: "2024-02-11", createdAt: ago(60 * 24 * 900) },
].slice(0, babies);

const entries = {
  sleep: [
    { id: id(), start: ago(16 * 60), end: ago(9 * 60 + 40), durationMinutes: null, type: null, source: null, notes: null },
    { id: id(), start: ago(7 * 60), end: ago(5 * 60 + 45), durationMinutes: null, type: null, source: null, notes: "Contact nap" },
    { id: id(), start: ago(3 * 60), end: ago(2 * 60 + 20), durationMinutes: null, type: null, source: null, notes: null },
  ],
  feed: [
    { id: id(), timestamp: ago(9 * 60 + 30), type: "Breastfeeding", durationSeconds: 18 * 60, amountMl: null, side: "Left", notes: null },
    { id: id(), timestamp: ago(6 * 60 + 10), type: "Bottle", durationSeconds: null, amountMl: 150, side: null, notes: null },
    { id: id(), timestamp: ago(4 * 60), type: "Solids", durationSeconds: null, amountMl: null, side: null, notes: "Mashed banana, loved it" },
    { id: id(), timestamp: ago(2 * 60 + 15), type: "Bottle", durationSeconds: null, amountMl: 120, side: null, notes: null },
  ],
  nappy: [
    { id: id(), timestamp: ago(9 * 60 + 15), type: "Both", notes: null },
    { id: id(), timestamp: ago(5 * 60 + 40), type: "Wet", notes: null },
    { id: id(), timestamp: ago(2 * 60 + 25), type: "Wet", notes: null },
  ],
  diary: [{ id: id(), timestamp: ago(4 * 60 + 30), text: "First giggle at the cat!", tags: null }],
};

const inRange = (t: string | null, r: { start: Date; end: Date }) => !!t && new Date(t) >= r.start && new Date(t) <= r.end;
const store = <T extends { timestamp?: string; start?: string | null }>(list: T[]) => ({
  list: async (_baby: string, r: { start: Date; end: Date }) =>
    list.filter((e) => inRange((e.timestamp ?? e.start) as string, r)).sort((a, b) => String(a.timestamp ?? a.start).localeCompare(String(b.timestamp ?? b.start))),
});
const fake = {
  babies: { list: async () => babyList },
  sleep: store(entries.sleep),
  feed: store(entries.feed),
  nappies: store(entries.nappy),
  diary: store(entries.diary),
} as unknown as Nestling;

/** Server-side wall-clock parsing stand-in: "YYYY-MM-DDTHH:mm" in the given zone. */
function wallClockToIso(value: string, tz: string): string {
  const guess = new Date(`${value}:00Z`).getTime();
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const p = Object.fromEntries(fmt.formatToParts(new Date(guess)).map((x) => [x.type, x.value]));
  const offset = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - guess;
  return new Date(guess - offset).toISOString();
}

const log = (...args: unknown[]) => {
  console.log("[host]", ...args);
  document.getElementById("log")!.textContent += args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ") + "\n";
};

async function callTool(name: string, args: Record<string, any>) {
  log("tools/call", name, args);
  if (signedOut) return { isError: true, content: [{ type: "text" as const, text: "Sign in to Nestling to continue." }], _meta: { "mcp/www_authenticate": ["Bearer"] } };
  try {
    if (name === "open_dashboard" || name === "open_quick_log" || name === "get_day_summary" || name === "show_day") {
      const s = await getDaySummary(fake, { babyId: args.babyId ?? babyList[0]?.id, date: args.date, timezone: args.timezone ?? timeZone });
      return { structuredContent: s as unknown as Record<string, unknown>, content: [{ type: "text" as const, text: "summary" }] };
    }
    const tz = args.timezone ?? timeZone;
    if (name === "create_feed") entries.feed.push({ id: id(), timestamp: wallClockToIso(args.timestamp, tz), type: args.type, durationSeconds: args.durationSeconds ?? null, amountMl: args.amountMl ?? null, side: args.side ?? null, notes: args.notes ?? null });
    else if (name === "create_nappy") entries.nappy.push({ id: id(), timestamp: wallClockToIso(args.timestamp, tz), type: args.type, notes: args.notes ?? null });
    else if (name === "create_sleep") entries.sleep.push({ id: id(), start: wallClockToIso(args.start, tz), end: wallClockToIso(args.end, tz), durationMinutes: null, type: null, source: null, notes: args.notes ?? null });
    else throw new Error(`Unknown tool ${name}`);
    return { structuredContent: { data: { id: "new", message: "ok" }, totalResults: 1 }, content: [{ type: "text" as const, text: "ok" }] };
  } catch (e) {
    return { isError: true, structuredContent: { message: (e as Error).message }, content: [{ type: "text" as const, text: (e as Error).message }] };
  }
}

addEventListener("message", (e) => e.data?.debug && log(e.data.debug));
const frame = document.getElementById("app") as HTMLIFrameElement;
frame.className = mode;
document.body.dataset.theme = theme;

const html = await (await fetch(`/resource?view=${view}${params.has("debug") ? "&debug" : ""}`)).text();
const bridge = new AppBridge(null, { name: "preview-host", version: "1" }, { openLinks: {}, serverTools: {}, updateModelContext: { text: {} } }, {
  hostContext: { theme, displayMode: mode, availableDisplayModes: ["inline", "fullscreen"], timeZone, locale: "en-GB", platform: "web" },
});
bridge.oncalltool = async (p) => callTool(p.name, (p.arguments ?? {}) as Record<string, any>);
bridge.onupdatemodelcontext = async (p) => {
  log("model context:", p.content?.map((c) => ("text" in c ? c.text : "")).join(" "));
  return {};
};
bridge.onrequestdisplaymode = async (p) => {
  log("display mode ->", p.mode);
  frame.className = p.mode;
  bridge.setHostContext({ theme, displayMode: p.mode, availableDisplayModes: ["inline", "fullscreen"], timeZone, locale: "en-GB", platform: "web" });
  return { mode: p.mode };
};
bridge.onsizechange = (p) => {
  if (mode === "inline" && p.height) frame.style.height = `${p.height}px`;
};
bridge.oninitialized = async () => {
  log("initialized");
  const opening = view === "log" ? "open_quick_log" : params.get("tool") ?? "open_dashboard";
  bridge.sendToolInput({ arguments: {} });
  bridge.sendToolResult(await callTool(opening, { timezone: timeZone }));
};

// Connect before loading so the view's first message is not missed.
await bridge.connect(new PostMessageTransport(frame.contentWindow!, frame.contentWindow!));
frame.srcdoc = html;
