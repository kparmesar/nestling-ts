/**
 * Time-zone helpers for day-based views. Worker runtimes run in UTC, so every
 * calendar calculation here takes an explicit IANA zone.
 */

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True when `tz` is an IANA zone the runtime understands. */
export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || tz.length === 0 || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock parts of `instant` in `tz`. */
function zonedParts(instant: Date, tz: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(instant);
  const get = (type: string) => parseInt(parts.find((p) => p.type === type)?.value ?? "0", 10);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour") === 24 ? 0 : get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

/** How far `tz` is ahead of UTC at `instant`, in ms. */
function offsetMs(instant: Date, tz: string): number {
  const p = zonedParts(instant, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(instant.getTime() / 1000) * 1000;
}

/** The UTC instant for a wall-clock time in `tz`. Two passes settle DST edges. */
export function zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, tz: string): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const first = guess - offsetMs(new Date(guess), tz);
  return new Date(guess - offsetMs(new Date(first), tz));
}

/** Calendar date ("YYYY-MM-DD") of `instant` in `tz`. */
export function dateInZone(instant: Date, tz: string): string {
  const p = zonedParts(instant, tz);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** True when `value` is a real calendar date in "YYYY-MM-DD" form. */
export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const m = value.match(DATE_PATTERN);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

/** Add `days` to a "YYYY-MM-DD" date. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + days));
  return next.toISOString().slice(0, 10);
}

/** UTC bounds of a calendar day in `tz`: [start, end). */
export function dayBounds(date: string, tz: string): { start: Date; end: Date } {
  const [y, m, d] = date.split("-").map(Number);
  const [ny, nm, nd] = addDays(date, 1).split("-").map(Number);
  return { start: zonedTimeToUtc(y, m, d, 0, 0, tz), end: zonedTimeToUtc(ny, nm, nd, 0, 0, tz) };
}
