import type { Nestling } from "./client.js";
import type { Baby, DiaryEntry, FeedEntry, NappyEntry, SleepEntry } from "./types.js";
import { BabyNotFoundError, NestlingError } from "./types.js";
import { dateInZone, dayBounds } from "./time.js";

/** One row in a day's timeline. Times are ISO 8601 UTC. */
export interface TimelineItem {
  id: string;
  kind: "sleep" | "feed" | "nappy" | "diary";
  /** When the event happened (sleep: when it started) */
  at: string;
  /** Sleep only: when it ended */
  end: string | null;
  /** Short label, e.g. "Bottle" or "Wet" */
  label: string;
  /** Extra detail, e.g. "120 ml" or "1h 20m" */
  detail: string | null;
  notes: string | null;
}

export interface DaySummary {
  baby: { id: string; name: string; birthDate: string | null };
  babies: { id: string; name: string }[];
  date: string;
  timezone: string;
  isToday: boolean;
  totals: {
    /** Minutes asleep within this day, including sleep that crossed midnight */
    sleepMinutes: number;
    /** Sleeps that started this day */
    sleeps: number;
    longestSleepMinutes: number;
    feeds: number;
    bottleMl: number;
    breastfeedMinutes: number;
    solids: number;
    nappies: number;
    wetNappies: number;
    dirtyNappies: number;
    diaryEntries: number;
  };
  lastFeedAt: string | null;
  lastNappyAt: string | null;
  /** Today only: when the most recent sleep ended */
  awakeSince: string | null;
  timeline: TimelineItem[];
}

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

export function babyName(baby: Baby): string {
  return baby.nickname?.trim() || "Your baby";
}

/** Pick the requested baby, or the only baby when none is given. */
export async function resolveBaby(client: Nestling, babyId: string | undefined): Promise<{ baby: Baby; babies: Baby[] }> {
  const babies = await client.babies.list();
  if (babies.length === 0) {
    throw new NestlingError(
      "There are no babies on this Nestling account yet.",
      "not_found",
      false,
      "Add a baby in the Nestling app, then try again.",
    );
  }
  if (babyId) {
    const baby = babies.find((b) => b.id === babyId);
    if (!baby) throw new BabyNotFoundError(babyId);
    return { baby, babies };
  }
  if (babies.length > 1) {
    throw new NestlingError(
      `This account has ${babies.length} babies. Say which one: ${babies.map((b) => `${babyName(b)} (${b.id})`).join(", ")}.`,
      "validation",
      false,
      "Call list_babies and pass babyId.",
    );
  }
  return { baby: babies[0], babies };
}

function lower(value: string | null): string {
  return (value ?? "").toLowerCase();
}

function formatMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function feedLabel(type: string | null): string {
  switch (lower(type)) {
    case "breastfeeding":
    case "breast":
      return "Breastfeed";
    case "bottle":
      return "Bottle";
    case "solids":
    case "solid":
      return "Solids";
    case "expressing":
    case "express":
      return "Expressing";
    default:
      return "Feed";
  }
}

function feedDetail(feed: FeedEntry): string | null {
  const parts: string[] = [];
  if (feed.amountMl != null && feed.amountMl > 0) parts.push(`${Math.round(feed.amountMl)} ml`);
  if (feed.durationSeconds != null && feed.durationSeconds > 0) parts.push(formatMinutes(feed.durationSeconds / 60));
  if (feed.side) parts.push(feed.side);
  return parts.length ? parts.join(" · ") : null;
}

function nappyLabel(type: string | null): string {
  switch (lower(type)) {
    case "wet":
      return "Wet";
    case "dirty":
      return "Dirty";
    case "both":
      return "Wet and dirty";
    case "dry":
      return "Dry";
    default:
      return "Nappy";
  }
}

function time(value: string | null): number {
  return value ? new Date(value).getTime() : NaN;
}

/** Build the summary for one baby and one calendar day in `tz`. */
export async function getDaySummary(
  client: Nestling,
  opts: { babyId?: string; date?: string; timezone: string; now?: Date },
): Promise<DaySummary> {
  const now = opts.now ?? new Date();
  const tz = opts.timezone;
  const today = dateInZone(now, tz);
  const date = opts.date ?? today;
  const { start, end } = dayBounds(date, tz);
  const { baby, babies } = await resolveBaby(client, opts.babyId);

  // Sleep is indexed by its start, so look back a day to catch overnight sleep.
  const lastMs = end.getTime() - 1;
  const [sleeps, feeds, nappies, diary] = await Promise.all([
    client.sleep.list(baby.id, { start: new Date(start.getTime() - DAY), end: new Date(lastMs) }),
    client.feed.list(baby.id, { start, end: new Date(lastMs) }),
    client.nappies.list(baby.id, { start, end: new Date(lastMs) }),
    client.diary.list(baby.id, { start, end: new Date(lastMs) }),
  ]);

  const startMs = start.getTime();
  const endMs = end.getTime();
  const nowMs = now.getTime();
  let sleepMinutes = 0;
  let longestSleepMinutes = 0;
  let sleepsStarted = 0;
  let awakeSinceMs = -Infinity;
  const timeline: TimelineItem[] = [];

  for (const s of sleeps as SleepEntry[]) {
    const s0 = time(s.start);
    if (Number.isNaN(s0)) continue;
    // An open sleep (no end yet) counts up to now.
    const s1Raw = time(s.end);
    const s1 = Number.isNaN(s1Raw) ? Math.min(nowMs, s0 + DAY) : s1Raw;
    const overlap = Math.min(s1, endMs) - Math.max(s0, startMs);
    if (overlap <= 0) continue;
    sleepMinutes += overlap / MINUTE;
    const length = (s1 - s0) / MINUTE;
    if (s0 >= startMs) sleepsStarted += 1;
    longestSleepMinutes = Math.max(longestSleepMinutes, length);
    if (!Number.isNaN(s1Raw)) awakeSinceMs = Math.max(awakeSinceMs, s1Raw);
    timeline.push({
      id: s.id,
      kind: "sleep",
      at: new Date(s0).toISOString(),
      end: Number.isNaN(s1Raw) ? null : new Date(s1Raw).toISOString(),
      label: Number.isNaN(s1Raw) ? "Asleep now" : "Sleep",
      detail: formatMinutes(length),
      notes: s.notes,
    });
  }

  let bottleMl = 0;
  let breastfeedSeconds = 0;
  let solids = 0;
  for (const f of feeds as FeedEntry[]) {
    const type = lower(f.type);
    if (type === "bottle" && f.amountMl) bottleMl += f.amountMl;
    if ((type === "breastfeeding" || type === "breast") && f.durationSeconds) breastfeedSeconds += f.durationSeconds;
    if (type === "solids" || type === "solid") solids += 1;
    timeline.push({ id: f.id, kind: "feed", at: f.timestamp, end: null, label: feedLabel(f.type), detail: feedDetail(f), notes: f.notes });
  }

  let wet = 0;
  let dirty = 0;
  for (const n of nappies as NappyEntry[]) {
    const type = lower(n.type);
    if (type === "wet" || type === "both") wet += 1;
    if (type === "dirty" || type === "both") dirty += 1;
    timeline.push({ id: n.id, kind: "nappy", at: n.timestamp, end: null, label: nappyLabel(n.type), detail: null, notes: n.notes });
  }

  for (const d of diary as DiaryEntry[]) {
    timeline.push({ id: d.id, kind: "diary", at: d.timestamp, end: null, label: "Diary", detail: d.text, notes: null });
  }

  timeline.sort((a, b) => time(a.at) - time(b.at));
  const latest = (items: { timestamp: string }[]) => (items.length ? items[items.length - 1].timestamp : null);
  const isToday = date === today;
  const openSleep = timeline.some((t) => t.kind === "sleep" && t.end === null);

  return {
    baby: { id: baby.id, name: babyName(baby), birthDate: baby.birthDate },
    babies: babies.map((b) => ({ id: b.id, name: babyName(b) })),
    date,
    timezone: tz,
    isToday,
    totals: {
      sleepMinutes: Math.round(sleepMinutes),
      sleeps: sleepsStarted,
      longestSleepMinutes: Math.round(longestSleepMinutes),
      feeds: feeds.length,
      bottleMl: Math.round(bottleMl),
      breastfeedMinutes: Math.round(breastfeedSeconds / 60),
      solids,
      nappies: nappies.length,
      wetNappies: wet,
      dirtyNappies: dirty,
      diaryEntries: diary.length,
    },
    lastFeedAt: latest(feeds as FeedEntry[]),
    lastNappyAt: latest(nappies as NappyEntry[]),
    awakeSince: isToday && !openSleep && awakeSinceMs > 0 ? new Date(awakeSinceMs).toISOString() : null,
    timeline,
  };
}

/** One-paragraph plain-text version of a summary, for the model. */
export function describeDaySummary(s: DaySummary): string {
  const t = s.totals;
  const parts = [
    `sleep ${formatMinutes(t.sleepMinutes)} across ${t.sleeps} sleep${t.sleeps === 1 ? "" : "s"}` +
      (t.longestSleepMinutes ? `, longest ${formatMinutes(t.longestSleepMinutes)}` : ""),
    `${t.feeds} feed${t.feeds === 1 ? "" : "s"}` +
      (t.bottleMl ? `, ${t.bottleMl} ml by bottle` : "") +
      (t.breastfeedMinutes ? `, ${formatMinutes(t.breastfeedMinutes)} breastfeeding` : ""),
    `${t.nappies} napp${t.nappies === 1 ? "y" : "ies"} (${t.wetNappies} wet, ${t.dirtyNappies} dirty)`,
  ];
  if (t.diaryEntries) parts.push(`${t.diaryEntries} diary entr${t.diaryEntries === 1 ? "y" : "ies"}`);
  return `${s.baby.name}, ${s.date} (${s.timezone}): ${parts.join("; ")}.`;
}
