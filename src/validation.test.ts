import { describe, expect, test } from "bun:test";

import { InvalidDateRangeError, NestlingError } from "./types.js";
import {
  isIsoDateTimeString,
  normalizeIsoDateTime,
  validateDateRange,
  validateNonNegativeNumber,
} from "./validation.js";

describe("isIsoDateTimeString", () => {
  test("accepts ISO timestamps with a timezone", () => {
    expect(isIsoDateTimeString("2026-05-08T14:30:00Z")).toBe(true);
    expect(isIsoDateTimeString("2026-05-08T14:30:00+10:00")).toBe(true);
    expect(isIsoDateTimeString("2026-05-08T14:30Z")).toBe(true);
  });

  test("rejects non-ISO or timezone-less timestamps", () => {
    expect(isIsoDateTimeString("2026-05-08T14:30:00")).toBe(false);
    expect(isIsoDateTimeString("May 8 2026 14:30")).toBe(false);
  });
});

test("normalizeIsoDateTime canonicalizes valid timestamps", () => {
  expect(normalizeIsoDateTime("2026-05-08T14:30:00+02:00", "timestamp")).toBe(
    "2026-05-08T12:30:00.000Z",
  );
});

test("validateDateRange rejects invalid dates", () => {
  expect(() =>
    validateDateRange({
      start: new Date("not-a-date"),
      end: new Date("2026-05-08T14:30:00Z"),
    }),
  ).toThrow(InvalidDateRangeError);
});

test("validateDateRange rejects reversed ranges", () => {
  expect(() =>
    validateDateRange({
      start: new Date("2026-05-08T15:30:00Z"),
      end: new Date("2026-05-08T14:30:00Z"),
    }),
  ).toThrow(InvalidDateRangeError);
});

test("validateNonNegativeNumber rejects negative values", () => {
  expect(() => validateNonNegativeNumber(-1, "amountMl")).toThrow(NestlingError);
});