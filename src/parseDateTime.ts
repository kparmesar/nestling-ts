/**
 * User-friendly date/time parser for Nestling CLI and MCP.
 *
 * Accepts:
 *   - ISO 8601: "2026-05-07T20:00:00Z", "2026-05-07T20:00:00+10:00"
 *   - Date + time: "2026-05-07 8pm", "2026-05-07 20:00"
 *   - Relative day + time: "today 3pm", "yesterday 8:30pm", "tomorrow 7am"
 *   - Time only (assumes today): "3pm", "3:30pm", "15:30", "8:00am"
 *   - Relative: "now", "5 minutes ago", "2 hours ago", "30m ago"
 *   - "just now" (alias for now)
 */

const RELATIVE_PATTERN =
  /^(\d+)\s*(m|min|mins|minutes?|h|hr|hrs|hours?)\s*ago$/i;

const TIME_12H_PATTERN =
  /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i;

const TIME_24H_PATTERN =
  /^(\d{1,2}):(\d{2})$/;

const ISO_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

const DAY_WORDS = new Set(["today", "yesterday", "tomorrow"]);

export interface ParseDateTimeOptions {
  /** IANA timezone for resolving wall-clock times (e.g. "Europe/London"). Defaults to local system TZ. */
  timezone?: string;
}

/**
 * Parse a user-friendly date/time string into an ISO 8601 UTC string.
 * Throws if the input cannot be understood.
 */
export function parseUserDateTime(
  input: string,
  opts?: ParseDateTimeOptions,
): string {
  const trimmed = input.trim();

  if (!trimmed) {
    throw new Error("Empty date/time string");
  }

  // ISO 8601 pass-through
  if (ISO_PATTERN.test(trimmed)) {
    const d = new Date(trimmed);
    if (Number.isNaN(d.getTime())) {
      throw new Error(`Invalid ISO date/time: ${describeInput(trimmed)}`);
    }
    return d.toISOString();
  }

  // "now" / "just now"
  if (/^(now|just\s*now)$/i.test(trimmed)) {
    return new Date().toISOString();
  }

  // Relative: "5 minutes ago", "2h ago"
  const relMatch = trimmed.match(RELATIVE_PATTERN);
  if (relMatch) {
    const amount = parseInt(relMatch[1], 10);
    const unit = relMatch[2].toLowerCase();
    let ms: number;
    if (unit.startsWith("h")) {
      ms = amount * 60 * 60 * 1000;
    } else {
      ms = amount * 60 * 1000;
    }
    return new Date(Date.now() - ms).toISOString();
  }

  // "today 3pm", "yesterday 8:30pm", "tomorrow 7am"
  const dayTimeInput = splitDayAndTime(trimmed);
  if (dayTimeInput) {
    const { dayWord, timeStr } = dayTimeInput;
    const { hours, minutes } = parseTimeComponent(timeStr);
    const base = dayOffset(dayWord, opts?.timezone);
    return buildDateTime(base, hours, minutes, opts?.timezone);
  }

  // "2026-05-07 8pm", "2026-05-07 20:00"
  const dateTimeInput = splitDateAndTime(trimmed);
  if (dateTimeInput) {
    const { dateStr, timeStr } = dateTimeInput;
    const { hours, minutes } = parseTimeComponent(timeStr);
    const base = new Date(dateStr + "T00:00:00");
    if (Number.isNaN(base.getTime())) {
      throw new Error(`Invalid date: ${dateStr}`);
    }
    return buildDateTime(base, hours, minutes, opts?.timezone);
  }

  // Time only: "3pm", "3:30pm", "15:30" → today
  try {
    const { hours, minutes } = parseTimeComponent(trimmed);
    const base = dayOffset("today", opts?.timezone);
    return buildDateTime(base, hours, minutes, opts?.timezone);
  } catch {
    // Fall through
  }

  throw new Error(
    `Could not parse date/time: ${describeInput(trimmed)}. ` +
      `Accepted formats: ISO 8601, "today 3pm", "yesterday 8:30pm", "3pm", "15:30", "2 hours ago", "now"`,
  );
}

function parseTimeComponent(str: string): { hours: number; minutes: number } {
  const s = str.trim();

  // 12-hour: "3pm", "3:30pm", "11:00am"
  const match12 = s.match(TIME_12H_PATTERN);
  if (match12) {
    let hours = parseInt(match12[1], 10);
    const minutes = match12[2] ? parseInt(match12[2], 10) : 0;
    const period = match12[3].toLowerCase();
    if (hours < 1 || hours > 12) throw new Error(`Invalid hour: ${hours}`);
    if (minutes < 0 || minutes > 59) throw new Error(`Invalid minutes: ${minutes}`);
    if (period === "pm" && hours !== 12) hours += 12;
    if (period === "am" && hours === 12) hours = 0;
    return { hours, minutes };
  }

  // 24-hour: "15:30", "08:00"
  const match24 = s.match(TIME_24H_PATTERN);
  if (match24) {
    const hours = parseInt(match24[1], 10);
    const minutes = parseInt(match24[2], 10);
    if (hours < 0 || hours > 23) throw new Error(`Invalid hour: ${hours}`);
    if (minutes < 0 || minutes > 59) throw new Error(`Invalid minutes: ${minutes}`);
    return { hours, minutes };
  }

  throw new Error(`Cannot parse time: ${describeInput(str)}`);
}

function splitDayAndTime(
  input: string,
): { dayWord: string; timeStr: string } | null {
  const parts = splitLeadingToken(input);
  if (!parts) {
    return null;
  }

  const dayWord = parts.token.toLowerCase();
  if (!DAY_WORDS.has(dayWord)) {
    return null;
  }

  return { dayWord, timeStr: parts.rest };
}

function splitDateAndTime(
  input: string,
): { dateStr: string; timeStr: string } | null {
  if (!isIsoDatePrefix(input) || !isWhitespace(input[10])) {
    return null;
  }

  let timeStart = 10;
  while (timeStart < input.length && isWhitespace(input[timeStart])) {
    timeStart += 1;
  }

  if (timeStart === input.length) {
    return null;
  }

  return {
    dateStr: input.slice(0, 10),
    timeStr: input.slice(timeStart),
  };
}

function splitLeadingToken(
  input: string,
): { token: string; rest: string } | null {
  let tokenEnd = 0;
  while (tokenEnd < input.length && !isWhitespace(input[tokenEnd])) {
    tokenEnd += 1;
  }

  if (tokenEnd === 0 || tokenEnd === input.length) {
    return null;
  }

  let restStart = tokenEnd;
  while (restStart < input.length && isWhitespace(input[restStart])) {
    restStart += 1;
  }

  if (restStart === input.length) {
    return null;
  }

  return {
    token: input.slice(0, tokenEnd),
    rest: input.slice(restStart),
  };
}

function isIsoDatePrefix(input: string): boolean {
  return (
    input.length >= 10 &&
    isDigit(input[0]) &&
    isDigit(input[1]) &&
    isDigit(input[2]) &&
    isDigit(input[3]) &&
    input[4] === "-" &&
    isDigit(input[5]) &&
    isDigit(input[6]) &&
    input[7] === "-" &&
    isDigit(input[8]) &&
    isDigit(input[9])
  );
}

function isDigit(char: string | undefined): boolean {
  return char !== undefined && char >= "0" && char <= "9";
}

function isWhitespace(char: string | undefined): boolean {
  return char !== undefined && char.trim() === "";
}

function describeInput(value: string, maxLength = 80): string {
  if (value.length <= maxLength) {
    return `"${value}"`;
  }

  const visible = Math.max(1, maxLength - 3);
  return `"${value.slice(0, visible)}..." (length ${value.length})`;
}

function dayOffset(word: string, timezone?: string): Date {
  let year: number, month: number, day: number;
  if (timezone) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date());
    const get = (type: string) =>
      parseInt(parts.find((p) => p.type === type)?.value ?? "0", 10);
    year = get("year");
    month = get("month") - 1;
    day = get("day");
  } else {
    const now = new Date();
    year = now.getFullYear();
    month = now.getMonth();
    day = now.getDate();
  }
  switch (word) {
    case "yesterday":
      return new Date(year, month, day - 1);
    case "tomorrow":
      return new Date(year, month, day + 1);
    case "today":
    default:
      return new Date(year, month, day);
  }
}

function buildDateTime(
  base: Date,
  hours: number,
  minutes: number,
  timezone?: string,
): string {
  if (timezone) {
    // Build the wall-clock time in the specified timezone by finding the UTC offset
    // Create a date at the desired wall-clock time in UTC first
    const year = base.getFullYear();
    const month = base.getMonth();
    const day = base.getDate();

    // Use Intl to find the UTC offset for this timezone at this date/time
    const utcGuess = new Date(Date.UTC(year, month, day, hours, minutes, 0));
    const offset = getTimezoneOffsetMs(utcGuess, timezone);
    const adjusted = new Date(utcGuess.getTime() - offset);
    return adjusted.toISOString();
  }

  // No timezone specified — use local system time
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate(), hours, minutes, 0, 0);
  return d.toISOString();
}

/**
 * Get the offset (in ms) to subtract from a wall-clock time in `tz` to get UTC.
 * i.e. if it's 3pm in Europe/London (BST), offset is +1h = 3600000, so UTC = 3pm - 1h = 2pm.
 */
function getTimezoneOffsetMs(refDate: Date, tz: string): number {
  // Format the reference date in the target timezone to find its local components
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(refDate);

  const get = (type: string) =>
    parseInt(parts.find((p) => p.type === type)?.value ?? "0", 10);

  const tzTime = new Date(
    Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") === 24 ? 0 : get("hour"), get("minute"), get("second")),
  );

  // offset = tzTime - refDate (how far ahead the tz is from UTC)
  return tzTime.getTime() - refDate.getTime();
}
