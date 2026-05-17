#!/usr/bin/env bun
import { Nestling } from "../client.js";
import type { FeedSide, FeedType, NappyType } from "../types.js";
import { NestlingError } from "../types.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ── Config file ──

const CONFIG_DIR = path.join(os.homedir(), ".config", "nestling");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

interface Config {
  refreshToken: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
  timezone?: string;
}

const FEED_TYPES = ["Breastfeeding", "Bottle", "Solids", "Expressing"] as const;
const FEED_SIDES = ["Left", "Right", "Both"] as const;
const NAPPY_TYPES = ["Wet", "Dirty", "Both"] as const;

function isConfig(value: unknown): value is Config {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<Config>;
  return (
    typeof candidate.refreshToken === "string" &&
    typeof candidate.supabaseUrl === "string" &&
    typeof candidate.supabaseAnonKey === "string" &&
    (candidate.timezone === undefined || typeof candidate.timezone === "string")
  );
}

function loadConfig(): Config | null {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    return isConfig(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function saveConfig(config: Config): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n", {
    mode: 0o600,
  });
  fs.chmodSync(CONFIG_FILE, 0o600);
}

function getConfig(): Config {
  // Env vars take precedence
  const envToken = process.env.NESTLING_REFRESH_TOKEN;
  const envUrl = process.env.NESTLING_SUPABASE_URL;
  const envKey = process.env.NESTLING_SUPABASE_ANON_KEY;

  if (envToken && envUrl && envKey) {
    return {
      refreshToken: envToken,
      supabaseUrl: envUrl,
      supabaseAnonKey: envKey,
      timezone: process.env.NESTLING_TIMEZONE,
    };
  }

  const config = loadConfig();
  if (config) return config;

  console.error("Not logged in. Run: nestling login");
  process.exit(1);
}

async function getClient(): Promise<Nestling> {
  const config = getConfig();
  const client = new Nestling({
    supabaseUrl: config.supabaseUrl,
    supabaseAnonKey: config.supabaseAnonKey,
    refreshToken: config.refreshToken,
  });
  await client.signIn();
  return client;
}

// ── Helpers ──

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const timeZone = process.env.NESTLING_TIMEZONE ?? loadConfig()?.timezone;
  return d.toLocaleString(undefined, timeZone ? { timeZone } : undefined);
}

function formatDuration(minutes: number | null): string {
  if (minutes === null) return "—";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function daysAgoRange(days: number): { start: Date; end: Date } {
  const end = new Date();
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  return { start, end };
}

function printJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

function normalizeChoice<T extends readonly string[]>(
  value: string,
  allowed: T,
  label: string,
): T[number] {
  const normalized = value.trim().toLowerCase();
  const match = allowed.find((candidate) => candidate.toLowerCase() === normalized);
  if (!match) {
    throw new NestlingError(
      `${label} must be one of: ${allowed.join(", ")}`,
      "validation",
      false,
      `Provide ${label} as one of: ${allowed.join(", ")}.`,
    );
  }
  return match;
}

// ── Commands ──

async function cmdLogin(): Promise<void> {
  const rl = await import("readline");
  const iface = rl.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> =>
    new Promise((res) => iface.question(q, (a: string) => res(a.trim())));

  let muted = false;
  const output = iface as typeof iface & {
    output: NodeJS.WriteStream & { mute?: boolean; _writeToOutput?: (value: string) => void };
  };
  const originalWrite = output.output._writeToOutput?.bind(output.output);
  output.output._writeToOutput = (value: string) => {
    if (!muted) {
      originalWrite?.(value);
    }
  };
  const askHidden = async (q: string): Promise<string> => {
    process.stdout.write(q);
    muted = true;
    const answer = await ask("");
    muted = false;
    console.log();
    return answer;
  };

  console.log("Nestling CLI Login");
  console.log("Enter your API token and Supabase connection details.\n");

  const supabaseUrl = await ask("Supabase URL: ");
  const supabaseAnonKey = await ask("Supabase Anon Key: ");
  const refreshToken = await askHidden(
    "API Token (from Nestling app → Settings → Data → API Token): ",
  );
  const timezone = await ask("Timezone (e.g. Europe/London, leave blank for UTC): ");

  iface.close();

  // Verify credentials
  const client = new Nestling({ supabaseUrl, supabaseAnonKey, refreshToken });
  try {
    await client.signIn();
    const user = await client.getUser();
    const babies = await client.babies.list();
    await client.close();

    saveConfig({
      supabaseUrl,
      supabaseAnonKey,
      refreshToken,
      timezone: timezone || undefined,
    });

    console.log(`\n✓ Authenticated as ${user.email}! Found ${babies.length} child(ren).`);
    console.log(`  Config saved to ${CONFIG_FILE}`);
  } catch (err) {
    console.error(
      `\n✗ Authentication failed: ${err instanceof Error ? err.message : err}`,
    );
    process.exit(1);
  }
}

async function cmdBabies(json: boolean): Promise<void> {
  const client = await getClient();
  const babies = await client.babies.list();
  await client.close();

  if (json) {
    printJson(babies);
    return;
  }

  if (babies.length === 0) {
    console.log("No babies found.");
    return;
  }

  for (const b of babies) {
    const age = b.birthDate ? ageString(b.birthDate) : "";
    console.log(`• ${b.nickname ?? "Unnamed"} (id: ${b.id})${age ? `  ${age}` : ""}`);
  }
}

function ageString(birthDate: string): string {
  const birth = new Date(birthDate);
  const now = new Date();
  const months = (now.getFullYear() - birth.getFullYear()) * 12 + (now.getMonth() - birth.getMonth());
  if (months < 1) {
    const days = Math.floor((now.getTime() - birth.getTime()) / (24 * 60 * 60 * 1000));
    return `${days} days old`;
  }
  if (months < 24) return `${months} months old`;
  const years = Math.floor(months / 12);
  const rem = months % 12;
  return rem > 0 ? `${years}y ${rem}m old` : `${years}y old`;
}

async function resolveBabyId(client: Nestling, babyArg?: string): Promise<string> {
  const babies = await client.babies.list();
  if (babies.length === 0) {
    console.error("No babies found on this account.");
    process.exit(1);
  }
  if (babyArg) {
    const match = babies.find(
      (b) =>
        b.id === babyArg ||
        b.nickname?.toLowerCase() === babyArg.toLowerCase(),
    );
    if (!match) {
      console.error(`Baby not found: ${babyArg}`);
      console.error(`Available: ${babies.map((b) => b.nickname ?? b.id).join(", ")}`);
      process.exit(1);
    }
    return match.id;
  }
  return babies[0].id;
}

async function cmdSleepHistory(days: number, babyArg: string | undefined, json: boolean): Promise<void> {
  const client = await getClient();
  const babyId = await resolveBabyId(client, babyArg);
  const range = daysAgoRange(days);
  const entries = await client.sleep.list(babyId, range);
  await client.close();

  if (json) { printJson(entries); return; }
  if (entries.length === 0) { console.log("No sleep entries."); return; }

  for (const e of entries) {
    console.log(`  ${formatDate(e.start)} → ${formatDate(e.end)}  ${formatDuration(e.durationMinutes)}${e.notes ? `  "${e.notes}"` : ""}`);
  }
  console.log(`\n${entries.length} sleep session(s) in the last ${days} day(s).`);
}

async function cmdFeedHistory(days: number, babyArg: string | undefined, json: boolean): Promise<void> {
  const client = await getClient();
  const babyId = await resolveBabyId(client, babyArg);
  const range = daysAgoRange(days);
  const entries = await client.feed.list(babyId, range);
  await client.close();

  if (json) { printJson(entries); return; }
  if (entries.length === 0) { console.log("No feed entries."); return; }

  for (const e of entries) {
    const details = [
      e.type,
      e.amountMl != null ? `${e.amountMl}ml` : null,
      e.durationSeconds != null ? `${Math.round(e.durationSeconds / 60)}m` : null,
      e.side,
    ].filter(Boolean).join(", ");
    console.log(`  ${formatDate(e.timestamp)}  ${details}${e.notes ? `  "${e.notes}"` : ""}`);
  }
  console.log(`\n${entries.length} feed(s) in the last ${days} day(s).`);
}

async function cmdNappyHistory(days: number, babyArg: string | undefined, json: boolean): Promise<void> {
  const client = await getClient();
  const babyId = await resolveBabyId(client, babyArg);
  const range = daysAgoRange(days);
  const entries = await client.nappies.list(babyId, range);
  await client.close();

  if (json) { printJson(entries); return; }
  if (entries.length === 0) { console.log("No nappy entries."); return; }

  for (const e of entries) {
    console.log(`  ${formatDate(e.timestamp)}  ${e.type ?? "unknown"}${e.notes ? `  "${e.notes}"` : ""}`);
  }
  console.log(`\n${entries.length} nappy change(s) in the last ${days} day(s).`);
}

async function cmdDiaryHistory(days: number, babyArg: string | undefined, json: boolean): Promise<void> {
  const client = await getClient();
  const babyId = await resolveBabyId(client, babyArg);
  const range = daysAgoRange(days);
  const entries = await client.diary.list(babyId, range);
  await client.close();

  if (json) { printJson(entries); return; }
  if (entries.length === 0) { console.log("No diary entries."); return; }

  for (const e of entries) {
    const tags = e.tags?.length ? ` [${e.tags.join(", ")}]` : "";
    console.log(`  ${formatDate(e.timestamp)}  ${e.text ?? ""}${tags}`);
  }
  console.log(`\n${entries.length} diary entry/entries in the last ${days} day(s).`);
}

async function cmdSleepLog(start: string, end: string, babyArg: string | undefined, notes?: string): Promise<void> {
  const client = await getClient();
  const babyId = await resolveBabyId(client, babyArg);
  const id = await client.sleep.create(babyId, { start, end, notes });
  await client.close();
  console.log(`✓ Sleep logged (${id})`);
}

async function cmdFeedLog(
  timestamp: string,
  type: string,
  babyArg: string | undefined,
  opts: { amountMl?: number; durationSeconds?: number; side?: string; notes?: string },
): Promise<void> {
  const client = await getClient();
  const babyId = await resolveBabyId(client, babyArg);
  const feedType = normalizeChoice(type, FEED_TYPES, "type") as FeedType;
  const feedSide = opts.side
    ? (normalizeChoice(opts.side, FEED_SIDES, "side") as FeedSide)
    : undefined;
  const id = await client.feed.create(babyId, {
    timestamp,
    type: feedType,
    amountMl: opts.amountMl,
    durationSeconds: opts.durationSeconds,
    side: feedSide,
    notes: opts.notes,
  });
  await client.close();
  console.log(`✓ Feed logged (${id})`);
}

async function cmdNappyLog(timestamp: string, type: string, babyArg: string | undefined, notes?: string): Promise<void> {
  const client = await getClient();
  const babyId = await resolveBabyId(client, babyArg);
  const nappyType = normalizeChoice(type, NAPPY_TYPES, "type") as NappyType;
  const id = await client.nappies.create(babyId, {
    timestamp,
    type: nappyType,
    notes,
  });
  await client.close();
  console.log(`✓ Nappy logged (${id})`);
}

async function cmdDiaryLog(
  timestamp: string,
  text: string,
  babyArg: string | undefined,
  tags?: string[],
): Promise<void> {
  const client = await getClient();
  const babyId = await resolveBabyId(client, babyArg);
  const id = await client.diary.create(babyId, { timestamp, text, tags });
  await client.close();
  console.log(`✓ Diary entry logged (${id})`);
}

// ── Usage ──

function printUsage(): void {
  console.log(`
nestling — CLI for the Nestling baby tracking app (https://www.nestling-app.com)

Usage: nestling <command> [options]

Setup:
  login                            Interactive setup (saves to ~/.config/nestling/config.json)
  babies [--json]                  List babies on your account

Sleep:
  sleep log --start <ISO> --end <ISO> [--notes <text>]
  sleep history [--days <n>] [--json]

Feed:
  feed log --at <ISO> --type <Breastfeeding|Bottle|Solids|Expressing> [--amount <ml>] [--duration <sec>] [--side <Left|Right|Both>] [--notes <text>]
  feed history [--days <n>] [--json]

Nappy:
  nappy log --at <ISO> --type <Wet|Dirty|Both> [--notes <text>]
  nappy history [--days <n>] [--json]

Diary:
  diary log --at <ISO> --text <text> [--tags <tag1,tag2>]
  diary history [--days <n>] [--json]

Global options:
  --baby <name|id>                 Select a specific baby (defaults to first)
  --help                           Show this help message
`);
}

// ── Main ──

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    printUsage();
    process.exit(0);
  }

  const command = args[0];
  const subcommand = args[1];

  // Parse global --baby flag
  const babyIdx = args.indexOf("--baby");
  const babyArg = babyIdx >= 0 ? args[babyIdx + 1] : undefined;

  // Parse common flags
  const jsonFlag = args.includes("--json");
  const daysIdx = args.indexOf("--days");
  const days = daysIdx >= 0 ? parseInt(args[daysIdx + 1], 10) : 7;

  const getFlag = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    return idx >= 0 ? args[idx + 1] : undefined;
  };

  try {
    switch (command) {
      case "login":
        await cmdLogin();
        break;

      case "babies":
      case "children":
        await cmdBabies(jsonFlag);
        break;

      case "sleep":
        if (subcommand === "log") {
          const start = getFlag("--start");
          const end = getFlag("--end");
          if (!start || !end) {
            console.error("Usage: nestling sleep log --start <ISO> --end <ISO> [--notes <text>]");
            process.exit(1);
          }
          await cmdSleepLog(start, end, babyArg, getFlag("--notes"));
        } else if (subcommand === "history") {
          await cmdSleepHistory(days, babyArg, jsonFlag);
        } else {
          await cmdSleepHistory(days, babyArg, jsonFlag);
        }
        break;

      case "feed":
        if (subcommand === "log") {
          const at = getFlag("--at");
          const type = getFlag("--type");
          if (!at || !type) {
            console.error("Usage: nestling feed log --at <ISO> --type <Breastfeeding|Bottle|Solids|Expressing>");
            process.exit(1);
          }
          await cmdFeedLog(at, type, babyArg, {
            amountMl: getFlag("--amount") ? parseFloat(getFlag("--amount")!) : undefined,
            durationSeconds: getFlag("--duration") ? parseFloat(getFlag("--duration")!) : undefined,
            side: getFlag("--side"),
            notes: getFlag("--notes"),
          });
        } else if (subcommand === "history") {
          await cmdFeedHistory(days, babyArg, jsonFlag);
        } else {
          await cmdFeedHistory(days, babyArg, jsonFlag);
        }
        break;

      case "nappy":
      case "diaper":
        if (subcommand === "log") {
          const at = getFlag("--at");
          const type = getFlag("--type");
          if (!at || !type) {
            console.error("Usage: nestling nappy log --at <ISO> --type <Wet|Dirty|Both>");
            process.exit(1);
          }
          await cmdNappyLog(at, type, babyArg, getFlag("--notes"));
        } else if (subcommand === "history") {
          await cmdNappyHistory(days, babyArg, jsonFlag);
        } else {
          await cmdNappyHistory(days, babyArg, jsonFlag);
        }
        break;

      case "diary":
        if (subcommand === "log") {
          const at = getFlag("--at");
          const text = getFlag("--text");
          if (!at || !text) {
            console.error("Usage: nestling diary log --at <ISO> --text <text>");
            process.exit(1);
          }
          const tagsStr = getFlag("--tags");
          const tags = tagsStr ? tagsStr.split(",").map((t) => t.trim()) : undefined;
          await cmdDiaryLog(at, text, babyArg, tags);
        } else if (subcommand === "history") {
          await cmdDiaryHistory(days, babyArg, jsonFlag);
        } else {
          await cmdDiaryHistory(days, babyArg, jsonFlag);
        }
        break;

      default:
        console.error(`Unknown command: ${command}`);
        printUsage();
        process.exit(1);
    }
  } catch (err) {
    if (err instanceof NestlingError) {
      console.error(`✗ ${err.name}: ${err.message}`);
      if (err.recovery) console.error(`  ${err.recovery}`);
    } else {
      console.error(`✗ ${err instanceof Error ? err.message : err}`);
    }
    process.exit(1);
  }
}

main();
