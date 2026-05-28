import { describe, expect, test } from "bun:test";
import { parseUserDateTime } from "./parseDateTime.js";

describe("parseUserDateTime", () => {
  test("passes through ISO 8601 strings", () => {
    const result = parseUserDateTime("2026-05-07T20:00:00Z");
    expect(result).toBe("2026-05-07T20:00:00.000Z");
  });

  test("passes through ISO with offset", () => {
    const result = parseUserDateTime("2026-05-07T20:00:00+02:00");
    expect(result).toBe("2026-05-07T18:00:00.000Z");
  });

  test("parses 'now'", () => {
    const before = Date.now();
    const result = new Date(parseUserDateTime("now")).getTime();
    const after = Date.now();
    expect(result).toBeGreaterThanOrEqual(before);
    expect(result).toBeLessThanOrEqual(after);
  });

  test("parses 'just now'", () => {
    const before = Date.now();
    const result = new Date(parseUserDateTime("just now")).getTime();
    expect(result).toBeGreaterThanOrEqual(before);
  });

  test("parses relative minutes", () => {
    const before = Date.now();
    const result = new Date(parseUserDateTime("5 minutes ago")).getTime();
    const expected = before - 5 * 60 * 1000;
    expect(Math.abs(result - expected)).toBeLessThan(1000);
  });

  test("parses relative hours", () => {
    const before = Date.now();
    const result = new Date(parseUserDateTime("2 hours ago")).getTime();
    const expected = before - 2 * 60 * 60 * 1000;
    expect(Math.abs(result - expected)).toBeLessThan(1000);
  });

  test("parses short relative '30m ago'", () => {
    const before = Date.now();
    const result = new Date(parseUserDateTime("30m ago")).getTime();
    const expected = before - 30 * 60 * 1000;
    expect(Math.abs(result - expected)).toBeLessThan(1000);
  });

  test("parses '2h ago'", () => {
    const before = Date.now();
    const result = new Date(parseUserDateTime("2h ago")).getTime();
    const expected = before - 2 * 60 * 60 * 1000;
    expect(Math.abs(result - expected)).toBeLessThan(1000);
  });

  test("parses time-only '3pm' as today", () => {
    const result = new Date(parseUserDateTime("3pm"));
    const today = new Date();
    expect(result.getFullYear()).toBe(today.getFullYear());
    expect(result.getMonth()).toBe(today.getMonth());
    expect(result.getDate()).toBe(today.getDate());
    // 3pm = 15:00 local
    expect(result.getHours()).toBe(15);
    expect(result.getMinutes()).toBe(0);
  });

  test("parses '8:30am'", () => {
    const result = new Date(parseUserDateTime("8:30am"));
    expect(result.getHours()).toBe(8);
    expect(result.getMinutes()).toBe(30);
  });

  test("parses 24h format '15:30'", () => {
    const result = new Date(parseUserDateTime("15:30"));
    expect(result.getHours()).toBe(15);
    expect(result.getMinutes()).toBe(30);
  });

  test("parses 'today 3pm'", () => {
    const result = new Date(parseUserDateTime("today 3pm"));
    const today = new Date();
    expect(result.getDate()).toBe(today.getDate());
    expect(result.getHours()).toBe(15);
  });

  test("parses 'yesterday 8:30pm'", () => {
    const result = new Date(parseUserDateTime("yesterday 8:30pm"));
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    expect(result.getDate()).toBe(yesterday.getDate());
    expect(result.getHours()).toBe(20);
    expect(result.getMinutes()).toBe(30);
  });

  test("parses 'tomorrow 7am'", () => {
    const result = new Date(parseUserDateTime("tomorrow 7am"));
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    expect(result.getDate()).toBe(tomorrow.getDate());
    expect(result.getHours()).toBe(7);
  });

  test("parses date + time '2026-05-07 8pm'", () => {
    const result = new Date(parseUserDateTime("2026-05-07 8pm"));
    expect(result.getFullYear()).toBe(2026);
    expect(result.getMonth()).toBe(4); // May = 4
    expect(result.getDate()).toBe(7);
    expect(result.getHours()).toBe(20);
  });

  test("parses date + 24h time '2026-05-07 20:00'", () => {
    const result = new Date(parseUserDateTime("2026-05-07 20:00"));
    expect(result.getHours()).toBe(20);
    expect(result.getMinutes()).toBe(0);
  });

  test("handles timezone option", () => {
    // 3pm in UTC+0 should be 3pm UTC = 15:00:00Z
    const result = parseUserDateTime("2026-05-07 3pm", { timezone: "UTC" });
    expect(result).toBe("2026-05-07T15:00:00.000Z");
  });

  test("handles London BST timezone (UTC+1)", () => {
    // 3pm London BST = 2pm UTC
    const result = parseUserDateTime("2026-05-07 3pm", { timezone: "Europe/London" });
    expect(result).toBe("2026-05-07T14:00:00.000Z");
  });

  test("handles New York EDT timezone (UTC-4)", () => {
    // 3pm New York EDT = 7pm UTC
    const result = parseUserDateTime("2026-05-07 3pm", { timezone: "America/New_York" });
    expect(result).toBe("2026-05-07T19:00:00.000Z");
  });

  test("handles Sydney AEST timezone (UTC+10)", () => {
    // 3pm Sydney AEST = 5am UTC
    const result = parseUserDateTime("2026-05-07 3pm", { timezone: "Australia/Sydney" });
    expect(result).toBe("2026-05-07T05:00:00.000Z");
  });

  test("handles London GMT (winter, UTC+0)", () => {
    // 3pm London in January (GMT) = 3pm UTC
    const result = parseUserDateTime("2026-01-07 3pm", { timezone: "Europe/London" });
    expect(result).toBe("2026-01-07T15:00:00.000Z");
  });

  test("12pm is noon", () => {
    const result = new Date(parseUserDateTime("12pm"));
    expect(result.getHours()).toBe(12);
  });

  test("12am is midnight", () => {
    const result = new Date(parseUserDateTime("12am"));
    expect(result.getHours()).toBe(0);
  });

  test("throws on empty string", () => {
    expect(() => parseUserDateTime("")).toThrow("Empty");
  });

  test("throws on garbage", () => {
    expect(() => parseUserDateTime("not a date")).toThrow("Could not parse");
  });

  test("rejects oversized invalid date-like input", () => {
    const input = `2026-05-07 ${"x".repeat(50_000)}`;
    expect(() => parseUserDateTime(input)).toThrow("Cannot parse time");
  });
});
