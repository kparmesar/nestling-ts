/**
 * Fill a reviewer demo account with a realistic week of entries, so ChatGPT
 * plugin reviewers have data to ask about.
 *
 *   NESTLING_API_TOKEN=... bun run scripts/seed-demo.ts [--tz Europe/London] [--days 7] [--yes]
 *
 * Use only on a demo account: entries cannot be deleted through the API.
 * The account needs one baby, added in the Nestling app first.
 */
import { Nestling } from "../src/client.js";
import { addDays, dateInZone, zonedTimeToUtc } from "../src/time.js";

const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const tz = opt("tz", "Europe/London");
const days = Number(opt("days", "7"));
const token = process.env.NESTLING_API_TOKEN;
if (!token) {
  console.error("Set NESTLING_API_TOKEN to the demo account's API token.");
  process.exit(1);
}

const client = new Nestling({ apiToken: token });
await client.signIn();
const user = await client.getUser();
const babies = await client.babies.list();
if (babies.length !== 1) {
  console.error(`Expected exactly one baby on the demo account, found ${babies.length}. Add one in the Nestling app.`);
  process.exit(1);
}
const baby = babies[0];
console.log(`Account ${user.email}, baby ${baby.nickname ?? "(no name)"}, ${days} days in ${tz}.`);
if (!args.includes("--yes")) {
  console.log("Dry run. Add --yes to write entries.");
  process.exit(0);
}

// Small, repeatable jitter so days differ but reruns look alike.
let seed = 42;
const jitter = (minutes: number) => {
  seed = (seed * 16807) % 2147483647;
  return Math.round(((seed / 2147483647) * 2 - 1) * minutes);
};
const at = (date: string, hour: number, minute: number) => {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(zonedTimeToUtc(y, m, d, hour, minute, tz).getTime() + jitter(15) * 60000);
};
const now = Date.now();
const past = (d: Date) => d.getTime() < now - 5 * 60000;
let written = 0;
const write = async (when: Date, fn: () => Promise<string>) => {
  if (!past(when)) return;
  await fn();
  written += 1;
};

const today = dateInZone(new Date(), tz);
for (let i = days - 1; i >= 0; i--) {
  const date = addDays(today, -i);
  const next = addDays(date, 1);

  // Night sleep (19:15 -> 06:30 next day, with one waking) and three naps.
  const sleeps: [Date, Date][] = [
    [at(date, 9, 15), at(date, 10, 30)],
    [at(date, 12, 45), at(date, 14, 30)],
    [at(date, 16, 30), at(date, 17, 0)],
    [at(date, 19, 15), at(next, 2, 0)],
    [at(next, 2, 30), at(next, 6, 30)],
  ];
  for (const [start, end] of sleeps) {
    if (!past(end)) continue;
    await write(start, () => client.sleep.create(baby.id, { start: start.toISOString(), end: end.toISOString() }));
  }

  const feeds: [number, number, () => Parameters<typeof client.feed.create>[1]["type"], number?][] = [
    [6, 45, () => "Breastfeeding", 15],
    [10, 45, () => "Bottle"],
    [12, 15, () => "Solids"],
    [14, 45, () => "Bottle"],
    [18, 30, () => "Breastfeeding", 20],
    [2, 10, () => "Breastfeeding", 12],
  ];
  for (const [h, m, type, minutes] of feeds) {
    const when = at(h < 4 ? next : date, h, m);
    const t = type();
    await write(when, () =>
      client.feed.create(baby.id, {
        timestamp: when.toISOString(),
        type: t,
        amountMl: t === "Bottle" ? 120 + 10 * Math.abs(jitter(3)) : undefined,
        durationSeconds: minutes ? (minutes + jitter(4)) * 60 : undefined,
        side: t === "Breastfeeding" ? (["Left", "Right", "Both"] as const)[Math.abs(jitter(2)) % 3] : undefined,
        notes: t === "Solids" ? ["Banana", "Sweet potato", "Porridge", "Avocado"][Math.abs(jitter(3)) % 4] : undefined,
      }),
    );
  }

  for (const [h, m, type] of [[7, 0, "Both"], [11, 0, "Wet"], [15, 0, "Wet"], [18, 15, "Dirty"], [19, 0, "Wet"]] as const) {
    const when = at(date, h, m);
    await write(when, () => client.nappies.create(baby.id, { timestamp: when.toISOString(), type }));
  }

  if (i % 3 === 0) {
    const when = at(date, 16, 0);
    const text = ["Rolled over for the first time!", "Lots of smiles at bath time.", "Grabbed her toes and would not let go."][(i / 3) % 3];
    await write(when, () => client.diary.create(baby.id, { timestamp: when.toISOString(), text }));
  }
}
console.log(`Wrote ${written} entries.`);
