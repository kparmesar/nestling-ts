import type { DateRange } from "./types.js";
import { InvalidDateRangeError, NestlingError } from "./types.js";

const ISO_DATE_TIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

export function isIsoDateTimeString(value: string): boolean {
  if (!ISO_DATE_TIME_PATTERN.test(value)) {
    return false;
  }

  return !Number.isNaN(new Date(value).getTime());
}

export function parseIsoDateTime(value: string, fieldName: string): Date {
  if (!isIsoDateTimeString(value)) {
    throw new NestlingError(
      `${fieldName} must be a valid ISO 8601 date/time with timezone`,
      "validation",
      false,
      `Provide ${fieldName} in ISO 8601 format, for example 2026-05-08T14:30:00Z.`,
    );
  }

  return new Date(value);
}

export function normalizeIsoDateTime(value: string, fieldName: string): string {
  return parseIsoDateTime(value, fieldName).toISOString();
}

export function validateDateRange(range: DateRange): void {
  if (!(range.start instanceof Date) || !(range.end instanceof Date)) {
    throw new InvalidDateRangeError("start and end must be Date objects");
  }

  if (Number.isNaN(range.start.getTime()) || Number.isNaN(range.end.getTime())) {
    throw new InvalidDateRangeError("start and end must be valid dates");
  }

  if (range.start >= range.end) {
    throw new InvalidDateRangeError();
  }
}

export function validateNonNegativeNumber(
  value: number | undefined,
  fieldName: string,
): void {
  if (value === undefined) {
    return;
  }

  if (!Number.isFinite(value) || value < 0) {
    throw new NestlingError(
      `${fieldName} must be a non-negative number`,
      "validation",
      false,
      `Provide ${fieldName} as a non-negative number.`,
    );
  }
}