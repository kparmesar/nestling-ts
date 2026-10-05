import { describe, expect, test } from "bun:test";
import type { Nestling } from "./client.js";
import { describeDaySummary, getDaySummary, resolveBaby, type DaySummary } from "./daySummary.js";
import { addDays, dateInZone, dayBounds, isCalendarDate, zonedTimeToUtc } from "./time.js";
import type { Baby, DateRange, DiaryEntry, FeedEntry, NappyEntry, SleepEntry } from "./types.js";
import { BabyNotFoundError, NestlingError } from "./types.js";

// ── Fixtures ──

function baby(id: string, nickname: string | null = "Ada"): Baby {
  return { id, ownerId: "owner-1", nickname, birthDate: "2026-01-01", createdAt: "2026-01-01T00:00:00Z" };
}

function sleep(id: string, start: string | null, end: string | null, notes: string | null = null): SleepEntry {
  return { id, start, end, durationMinutes: null, type: null, source: null, notes };
}

function feed(id: string, timestamp: string, type: string | null, extra: Partial<FeedEntry> = {}): FeedEntry {
  return { id, timestamp, type, durationSeconds: null, amountMl: null, side: null, notes: null, ...extra };
}

function nappy(id: string, timestamp: string, type: string | null): NappyEntry {
  return { id, timestamp, type, notes: null };
}

function diary(id: string, timestamp: string, text: string): DiaryEntry {
  return { id, timestamp, text, tags: null };
}

interface Fixtures {
  babies?: Baby[];
  sleeps?: SleepEntry[];
  feeds?: FeedEntry[];
  nappies?: NappyEntry[];
  diary?: DiaryEntry[];
}

/** Mirrors client.ts: filter by effective timestamp in [start, end] inclusive, ascending. */
function inRange<T>(items: T[], at: (item: T) => string | null, range: DateRange): T[] {
  const lo = range.start.getTime();
  const hi = range.end.getTime();
  return items
    .filter((item) => {
      const v = at(item);
      if (!v) return false;
      const ms = new Date(v).getTime();
      return ms >= lo && ms <= hi;
    })
    .sort((a, b) => new Date(at(a)!).getTime() - new Date(at(b)!).getTime());
}

function fakeClient(f: Fixtures): Nestling {
  const babies = f.babies ?? [baby("b1")];
  return {
    babies: { list: async () => babies },
    sleep: { list: async (_id: string, r: DateRange) => inRange(f.sleeps ?? [], (s) => s.start, r) },
    feed: { list: async (_id: string, r: DateRange) => inRange(f.feeds ?? [], (x) => x.timestamp, r) },
    nappies: { list: async (_id: string, r: DateRange) => inRange(f.nappies ?? [], (x) => x.timestamp, r) },
    diary: { list: async (_id: string, r: DateRange) => inRange(f.diary ?? [], (x) => x.timestamp, r) },
  } as unknown as Nestling;
}

const LONDON = "Europe/London";
const LA = "America/Los_Angeles";
const HOUR = 3_600_000;

// ── time.ts ──

describe("isCalendarDate", () => {
  test("accepts real dates", () => {
    expect(isCalendarDate("2026-07-15")).toBe(true);
    expect(isCalendarDate("2028-02-29")).toBe(true);
  });

  test("rejects impossible dates and bad formats", () => {
    expect(isCalendarDate("2026-02-29")).toBe(false);
    expect(isCalendarDate("2026-13-01")).toBe(false);
    expect(isCalendarDate("2026-04-31")).toBe(false);
    expect(isCalendarDate("2026-7-15")).toBe(false);
    expect(isCalendarDate("2026-07-15T00:00:00Z")).toBe(false);
    expect(isCalendarDate(20260715)).toBe(false);
    expect(isCalendarDate(null)).toBe(false);
  });
});

describe("addDays", () => {
  test("crosses month and year ends", () => {
    expect(addDays("2026-07-15", 1)).toBe("2026-07-16");
    expect(addDays("2026-01-31", 1)).toBe("2026-02-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
  });
});

describe("zonedTimeToUtc", () => {
  test("converts London summer time (BST, UTC+1)", () => {
    expect(zonedTimeToUtc(2026, 7, 15, 9, 30, LONDON).toISOString()).toBe("2026-07-15T08:30:00.000Z");
  });

  test("converts London winter time (GMT)", () => {
    expect(zonedTimeToUtc(2026, 1, 15, 9, 30, LONDON).toISOString()).toBe("2026-01-15T09:30:00.000Z");
  });

  test("converts Los Angeles (PDT, UTC-7)", () => {
    expect(zonedTimeToUtc(2026, 7, 15, 0, 0, LA).toISOString()).toBe("2026-07-15T07:00:00.000Z");
  });

  test("handles times just after the London spring-forward", () => {
    expect(zonedTimeToUtc(2026, 3, 29, 2, 0, LONDON).toISOString()).toBe("2026-03-29T01:00:00.000Z");
  });
});

describe("dateInZone", () => {
  test("uses the local calendar date", () => {
    const instant = new Date("2026-07-14T23:30:00Z");
    expect(dateInZone(instant, LONDON)).toBe("2026-07-15");
    expect(dateInZone(instant, LA)).toBe("2026-07-14");
    expect(dateInZone(instant, "UTC")).toBe("2026-07-14");
  });

  test("handles local midnight", () => {
    expect(dateInZone(new Date("2026-07-14T23:00:00Z"), LONDON)).toBe("2026-07-15");
    expect(dateInZone(new Date("2026-07-14T22:59:59Z"), LONDON)).toBe("2026-07-14");
  });
});

describe("dayBounds", () => {
  test("London BST day", () => {
    const { start, end } = dayBounds("2026-07-15", LONDON);
    expect(start.toISOString()).toBe("2026-07-14T23:00:00.000Z");
    expect(end.toISOString()).toBe("2026-07-15T23:00:00.000Z");
  });

  test("Los Angeles day", () => {
    const { start, end } = dayBounds("2026-07-15", LA);
    expect(start.toISOString()).toBe("2026-07-15T07:00:00.000Z");
    expect(end.toISOString()).toBe("2026-07-16T07:00:00.000Z");
  });

  test("London spring-forward day is 23 hours", () => {
    const { start, end } = dayBounds("2026-03-29", LONDON);
    expect(start.toISOString()).toBe("2026-03-29T00:00:00.000Z");
    expect(end.toISOString()).toBe("2026-03-29T23:00:00.000Z");
    expect(end.getTime() - start.getTime()).toBe(23 * HOUR);
  });

  test("London fall-back day is 25 hours", () => {
    const { start, end } = dayBounds("2026-10-25", LONDON);
    expect(start.toISOString()).toBe("2026-10-24T23:00:00.000Z");
    expect(end.toISOString()).toBe("2026-10-26T00:00:00.000Z");
    expect(end.getTime() - start.getTime()).toBe(25 * HOUR);
  });

  test("Los Angeles DST days", () => {
    const spring = dayBounds("2026-03-08", LA);
    expect(spring.end.getTime() - spring.start.getTime()).toBe(23 * HOUR);
    const fall = dayBounds("2026-11-01", LA);
    expect(fall.end.getTime() - fall.start.getTime()).toBe(25 * HOUR);
  });
});

// ── resolveBaby ──

describe("resolveBaby", () => {
  test("throws when there are no babies", async () => {
    const client = fakeClient({ babies: [] });
    const err = await resolveBaby(client, undefined).catch((e) => e);
    expect(err).toBeInstanceOf(NestlingError);
    expect(err.category).toBe("not_found");
  });

  test("picks the only baby automatically", async () => {
    const client = fakeClient({ babies: [baby("b1", "Ada")] });
    const { baby: b, babies } = await resolveBaby(client, undefined);
    expect(b.id).toBe("b1");
    expect(babies).toHaveLength(1);
  });

  test("several babies and no babyId is a validation error listing names", async () => {
    const client = fakeClient({ babies: [baby("b1", "Ada"), baby("b2", null)] });
    const err = await resolveBaby(client, undefined).catch((e) => e);
    expect(err).toBeInstanceOf(NestlingError);
    expect(err.category).toBe("validation");
    expect(err.message).toContain("2 babies");
    expect(err.message).toContain("Ada (b1)");
    expect(err.message).toContain("Your baby (b2)");
  });

  test("picks the requested baby among several", async () => {
    const client = fakeClient({ babies: [baby("b1", "Ada"), baby("b2", "Bo")] });
    const { baby: b } = await resolveBaby(client, "b2");
    expect(b.nickname).toBe("Bo");
  });

  test("unknown babyId throws BabyNotFoundError", async () => {
    const client = fakeClient({ babies: [baby("b1")] });
    const err = await resolveBaby(client, "nope").catch((e) => e);
    expect(err).toBeInstanceOf(BabyNotFoundError);
  });
});

// ── getDaySummary ──

describe("getDaySummary", () => {
  test("overnight sleep counts only minutes after local midnight (London BST)", async () => {
    // 21:00 BST on the 14th to 06:00 BST on the 15th
    const client = fakeClient({ sleeps: [sleep("s1", "2026-07-14T20:00:00Z", "2026-07-15T05:00:00Z")] });
    const s = await getDaySummary(client, { date: "2026-07-15", timezone: LONDON, now: new Date("2026-07-20T12:00:00Z") });
    expect(s.totals.sleepMinutes).toBe(360);
    expect(s.totals.sleeps).toBe(0);
    expect(s.totals.longestSleepMinutes).toBe(540);
    expect(s.timeline).toHaveLength(1);
    expect(s.timeline[0]).toMatchObject({ id: "s1", kind: "sleep", label: "Sleep", end: "2026-07-15T05:00:00.000Z", detail: "9h" });
    expect(s.isToday).toBe(false);
    expect(s.awakeSince).toBeNull();
  });

  test("overnight sleep counts the evening minutes on the day it started", async () => {
    const client = fakeClient({ sleeps: [sleep("s1", "2026-07-14T20:00:00Z", "2026-07-15T05:00:00Z")] });
    const s = await getDaySummary(client, { date: "2026-07-14", timezone: LONDON, now: new Date("2026-07-20T12:00:00Z") });
    expect(s.totals.sleepMinutes).toBe(180);
    expect(s.totals.sleeps).toBe(1);
  });

  test("Los Angeles day boundaries", async () => {
    // 22:00 PDT on the 14th to 05:00 PDT on the 15th; nap 13:00–14:30 PDT on the 15th
    const client = fakeClient({
      sleeps: [
        sleep("night", "2026-07-15T05:00:00Z", "2026-07-15T12:00:00Z"),
        sleep("nap", "2026-07-15T20:00:00Z", "2026-07-15T21:30:00Z"),
      ],
      // 23:30 PDT on the 15th still belongs to the 15th; 00:30 PDT on the 16th does not
      feeds: [
        feed("f1", "2026-07-16T06:30:00Z", "Bottle", { amountMl: 100 }),
        feed("f2", "2026-07-16T07:30:00Z", "Bottle", { amountMl: 50 }),
      ],
    });
    const s = await getDaySummary(client, { date: "2026-07-15", timezone: LA, now: new Date("2026-07-20T12:00:00Z") });
    expect(s.totals.sleepMinutes).toBe(5 * 60 + 90);
    expect(s.totals.sleeps).toBe(1);
    expect(s.totals.longestSleepMinutes).toBe(420);
    expect(s.totals.feeds).toBe(1);
    expect(s.totals.bottleMl).toBe(100);
    expect(s.timezone).toBe(LA);
  });

  test("sleep on the 25-hour fall-back day counts the full span", async () => {
    // Midnight to midnight local on 2026-10-25 in London is 25 hours
    const client = fakeClient({ sleeps: [sleep("s1", "2026-10-24T23:00:00Z", "2026-10-26T00:00:00Z")] });
    const s = await getDaySummary(client, { date: "2026-10-25", timezone: LONDON, now: new Date("2026-11-01T12:00:00Z") });
    expect(s.totals.sleepMinutes).toBe(25 * 60);
  });

  test("defaults the date to today in the given zone", async () => {
    const client = fakeClient({});
    const s = await getDaySummary(client, { timezone: LONDON, now: new Date("2026-07-14T23:30:00Z") });
    expect(s.date).toBe("2026-07-15");
    expect(s.isToday).toBe(true);
  });

  test("open sleep counts up to now and keeps awakeSince null", async () => {
    const now = new Date("2026-07-15T13:00:00Z"); // 14:00 BST
    const client = fakeClient({
      sleeps: [
        sleep("night", "2026-07-14T20:00:00Z", "2026-07-15T05:00:00Z"),
        sleep("nap", "2026-07-15T12:00:00Z", null),
      ],
    });
    const s = await getDaySummary(client, { date: "2026-07-15", timezone: LONDON, now });
    expect(s.isToday).toBe(true);
    expect(s.totals.sleepMinutes).toBe(360 + 60);
    expect(s.totals.sleeps).toBe(1);
    expect(s.awakeSince).toBeNull();
    const open = s.timeline.find((t) => t.id === "nap")!;
    expect(open).toMatchObject({ end: null, label: "Asleep now", detail: "1h" });
  });

  test("awakeSince is the latest sleep end today when awake", async () => {
    const now = new Date("2026-07-15T13:00:00Z");
    const client = fakeClient({
      sleeps: [
        sleep("night", "2026-07-14T20:00:00Z", "2026-07-15T05:00:00Z"),
        sleep("nap", "2026-07-15T09:00:00Z", "2026-07-15T10:15:00Z"),
      ],
    });
    const s = await getDaySummary(client, { date: "2026-07-15", timezone: LONDON, now });
    expect(s.awakeSince).toBe("2026-07-15T10:15:00.000Z");
    expect(s.totals.sleepMinutes).toBe(360 + 75);
    expect(s.totals.sleeps).toBe(1);
  });

  test("awakeSince is null for a past date", async () => {
    const client = fakeClient({ sleeps: [sleep("nap", "2026-07-15T09:00:00Z", "2026-07-15T10:00:00Z")] });
    const s = await getDaySummary(client, { date: "2026-07-15", timezone: LONDON, now: new Date("2026-07-16T12:00:00Z") });
    expect(s.isToday).toBe(false);
    expect(s.awakeSince).toBeNull();
  });

  test("skips sleeps that ended before the day began", async () => {
    // 20:00–22:00 BST on the 14th
    const client = fakeClient({ sleeps: [sleep("s1", "2026-07-14T19:00:00Z", "2026-07-14T21:00:00Z")] });
    const s = await getDaySummary(client, { date: "2026-07-15", timezone: LONDON, now: new Date("2026-07-20T12:00:00Z") });
    expect(s.totals.sleepMinutes).toBe(0);
    expect(s.timeline).toHaveLength(0);
  });

  test("feed totals with capitalised and legacy lowercase types", async () => {
    const client = fakeClient({
      feeds: [
        feed("f1", "2026-07-15T06:00:00Z", "Bottle", { amountMl: 120 }),
        feed("f2", "2026-07-15T07:00:00Z", "bottle", { amountMl: 90.4 }),
        feed("f3", "2026-07-15T08:00:00Z", "Breastfeeding", { durationSeconds: 600, amountMl: 999, side: "Left" }),
        feed("f4", "2026-07-15T09:00:00Z", "breast", { durationSeconds: 900 }),
        feed("f5", "2026-07-15T10:00:00Z", "Solids"),
        feed("f6", "2026-07-15T11:00:00Z", "solid"),
        feed("f7", "2026-07-15T12:00:00Z", "Expressing", { amountMl: 60 }),
        feed("f8", "2026-07-15T13:00:00Z", null),
      ],
    });
    const s = await getDaySummary(client, { date: "2026-07-15", timezone: LONDON, now: new Date("2026-07-20T12:00:00Z") });
    expect(s.totals.feeds).toBe(8);
    expect(s.totals.bottleMl).toBe(210);
    expect(s.totals.breastfeedMinutes).toBe(25);
    expect(s.totals.solids).toBe(2);
    expect(s.lastFeedAt).toBe("2026-07-15T13:00:00Z");
    const labels = s.timeline.map((t) => t.label);
    expect(labels).toEqual(["Bottle", "Bottle", "Breastfeed", "Breastfeed", "Solids", "Solids", "Expressing", "Feed"]);
    expect(s.timeline[0].detail).toBe("120 ml");
    expect(s.timeline[2].detail).toBe("999 ml · 10m · Left");
    expect(s.timeline[7].detail).toBeNull();
  });

  test("nappy counts for Wet, Dirty and Both", async () => {
    const client = fakeClient({
      nappies: [
        nappy("n1", "2026-07-15T06:00:00Z", "Wet"),
        nappy("n2", "2026-07-15T07:00:00Z", "Dirty"),
        nappy("n3", "2026-07-15T08:00:00Z", "Both"),
        nappy("n4", "2026-07-15T09:00:00Z", "wet"),
        nappy("n5", "2026-07-15T10:00:00Z", "dry"),
      ],
    });
    const s = await getDaySummary(client, { date: "2026-07-15", timezone: LONDON, now: new Date("2026-07-20T12:00:00Z") });
    expect(s.totals.nappies).toBe(5);
    expect(s.totals.wetNappies).toBe(3);
    expect(s.totals.dirtyNappies).toBe(2);
    expect(s.lastNappyAt).toBe("2026-07-15T10:00:00Z");
    expect(s.timeline.map((t) => t.label)).toEqual(["Wet", "Dirty", "Wet and dirty", "Wet", "Dry"]);
  });

  test("timeline mixes all kinds in ascending order and latest times are picked", async () => {
    const client = fakeClient({
      sleeps: [sleep("s1", "2026-07-15T10:00:00Z", "2026-07-15T11:00:00Z", "cot")],
      // Out of order in the fixture; the fake list sorts like the real client
      feeds: [feed("f2", "2026-07-15T14:00:00Z", "Bottle", { amountMl: 100 }), feed("f1", "2026-07-15T06:00:00Z", "Bottle", { amountMl: 100 })],
      nappies: [nappy("n2", "2026-07-15T12:00:00Z", "Wet"), nappy("n1", "2026-07-15T08:00:00Z", "Dirty")],
      diary: [diary("d1", "2026-07-15T09:00:00Z", "First smile")],
    });
    const s = await getDaySummary(client, { date: "2026-07-15", timezone: LONDON, now: new Date("2026-07-20T12:00:00Z") });
    expect(s.timeline.map((t) => t.id)).toEqual(["f1", "n1", "d1", "s1", "n2", "f2"]);
    expect(s.lastFeedAt).toBe("2026-07-15T14:00:00Z");
    expect(s.lastNappyAt).toBe("2026-07-15T12:00:00Z");
    expect(s.totals.diaryEntries).toBe(1);
    expect(s.timeline.find((t) => t.id === "d1")).toMatchObject({ kind: "diary", label: "Diary", detail: "First smile" });
    expect(s.timeline.find((t) => t.id === "s1")!.notes).toBe("cot");
  });

  test("empty day has null latest times", async () => {
    const s = await getDaySummary(fakeClient({}), { date: "2026-07-15", timezone: LONDON, now: new Date("2026-07-20T12:00:00Z") });
    expect(s.lastFeedAt).toBeNull();
    expect(s.lastNappyAt).toBeNull();
    expect(s.timeline).toEqual([]);
    expect(s.totals.sleepMinutes).toBe(0);
  });

  test("baby name falls back to 'Your baby' when nickname is null or blank", async () => {
    const client = fakeClient({ babies: [baby("b1", null), baby("b2", "  ")] });
    const s = await getDaySummary(client, { babyId: "b1", date: "2026-07-15", timezone: LONDON, now: new Date("2026-07-20T12:00:00Z") });
    expect(s.baby).toEqual({ id: "b1", name: "Your baby", birthDate: "2026-01-01" });
    expect(s.babies).toEqual([
      { id: "b1", name: "Your baby" },
      { id: "b2", name: "Your baby" },
    ]);
  });
});

// ── describeDaySummary ──

function summary(totals: Partial<DaySummary["totals"]>): DaySummary {
  return {
    baby: { id: "b1", name: "Ada", birthDate: null },
    babies: [{ id: "b1", name: "Ada" }],
    date: "2026-07-15",
    timezone: LONDON,
    isToday: false,
    totals: {
      sleepMinutes: 0,
      sleeps: 0,
      longestSleepMinutes: 0,
      feeds: 0,
      bottleMl: 0,
      breastfeedMinutes: 0,
      solids: 0,
      nappies: 0,
      wetNappies: 0,
      dirtyNappies: 0,
      diaryEntries: 0,
      ...totals,
    },
    lastFeedAt: null,
    lastNappyAt: null,
    awakeSince: null,
    timeline: [],
  };
}

describe("describeDaySummary", () => {
  test("singular wording", () => {
    const text = describeDaySummary(
      summary({ sleepMinutes: 90, sleeps: 1, longestSleepMinutes: 90, feeds: 1, bottleMl: 120, nappies: 1, wetNappies: 1, diaryEntries: 1 }),
    );
    expect(text).toStartWith("Ada, 2026-07-15 (Europe/London):");
    expect(text).toEndWith("sleep 1h 30m across 1 sleep, longest 1h 30m; 1 feed, 120 ml by bottle; 1 nappy (1 wet, 0 dirty); 1 diary entry.");
  });

  test("plural wording", () => {
    const text = describeDaySummary(
      summary({
        sleepMinutes: 600,
        sleeps: 3,
        longestSleepMinutes: 300,
        feeds: 5,
        breastfeedMinutes: 45,
        nappies: 4,
        wetNappies: 3,
        dirtyNappies: 2,
        diaryEntries: 2,
      }),
    );
    expect(text).toContain("sleep 10h across 3 sleeps, longest 5h");
    expect(text).toContain("5 feeds, 45m breastfeeding");
    expect(text).toContain("4 nappies (3 wet, 2 dirty)");
    expect(text).toContain("2 diary entries");
  });

  test("zero counts use plural and omit optional parts", () => {
    const text = describeDaySummary(summary({}));
    expect(text).toEndWith("sleep 0m across 0 sleeps; 0 feeds; 0 nappies (0 wet, 0 dirty).");
    expect(text).not.toContain("longest");
    expect(text).not.toContain("diary");
  });

  test("header is not followed by a stray '; ' after the colon", () => {
    expect(describeDaySummary(summary({}))).not.toContain(":;");
  });
});
