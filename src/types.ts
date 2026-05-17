// ── Nestling API types ──

/** Entry categories stored in the `entries` table */
export type EntryType = "sleep" | "feed" | "nappy" | "diary";

/** Date range filter for list queries */
export interface DateRange {
  start: Date;
  end: Date;
}

// ── Baby ──

export interface Baby {
  id: string;
  ownerId: string;
  nickname: string | null;
  birthDate: string | null; // ISO date
  createdAt: string;
}

// ── Membership ──

export interface Membership {
  userId: string;
  babyId: string;
  role: "owner" | "member";
  createdAt: string;
}

// ── Raw entry row from Supabase ──

export interface RawEntry {
  id: string;
  baby_id: string;
  type: EntryType;
  data: Record<string, unknown>;
  start_at: string | null;
  end_at: string | null;
  timestamp: string;
  updated_at: string;
}

// ── Decoded entry types ──

export interface SleepEntry {
  id: string;
  start: string | null;
  end: string | null;
  durationMinutes: number | null;
  type: string | null; // e.g. "nap", "night"
  source: string | null;
  notes: string | null;
}

export interface FeedEntry {
  id: string;
  timestamp: string;
  type: string | null; // "breast", "bottle", "solid"
  durationSeconds: number | null;
  amountMl: number | null;
  side: string | null;
  notes: string | null;
}

export interface NappyEntry {
  id: string;
  timestamp: string;
  type: string | null; // "wet", "dirty", "both", "dry"
  notes: string | null;
}

export interface DiaryEntry {
  id: string;
  timestamp: string;
  text: string | null;
  tags: string[] | null;
}

// ── Write input types ──

export type SleepType = "sleep";
export type FeedType = "Breastfeeding" | "Bottle" | "Solids" | "Expressing";
export type FeedSide = "Left" | "Right" | "Both";
export type NappyType = "Wet" | "Dirty" | "Both";

export interface CreateSleepInput {
  /** Sleep start time (ISO 8601) */
  start: string;
  /** Sleep end time (ISO 8601) */
  end: string;
  /** Optional notes */
  notes?: string;
}

export interface CreateFeedInput {
  /** When the feed happened (ISO 8601) */
  timestamp: string;
  /** Feed type */
  type: FeedType;
  /** Duration in seconds (optional) */
  durationSeconds?: number;
  /** Amount in ml (optional) */
  amountMl?: number;
  /** Which side (optional, for breastfeeding) */
  side?: FeedSide;
  /** Optional notes */
  notes?: string;
}

export interface CreateNappyInput {
  /** When the nappy change happened (ISO 8601) */
  timestamp: string;
  /** Nappy type */
  type: NappyType;
  /** Optional notes */
  notes?: string;
}

export interface CreateDiaryInput {
  /** When the diary entry happened (ISO 8601) */
  timestamp: string;
  /** Diary text content */
  text: string;
  /** Optional tags */
  tags?: string[];
}

// ── Client options ──

export interface NestlingOptions {
  /** API token from the Nestling app (Settings → Data → API Token) */
  apiToken: string;
}

// ── Error types ──

export class NestlingError extends Error {
  constructor(
    message: string,
    public readonly category: string,
    public readonly retryable: boolean,
    public readonly recovery: string,
  ) {
    super(message);
    this.name = "NestlingError";
  }
}

export class AuthenticationError extends NestlingError {
  constructor(message = "Authentication failed") {
    super(
      message,
      "authentication",
      false,
      "Check your refresh token, Supabase URL, and anon key. You may need to generate a new token from the Nestling app.",
    );
    this.name = "AuthenticationError";
  }
}

export class BabyNotFoundError extends NestlingError {
  constructor(babyId: string) {
    super(
      `Baby not found: ${babyId}`,
      "not_found",
      false,
      "Use client.babies.list() (or the list_babies MCP tool) to get valid baby IDs.",
    );
    this.name = "BabyNotFoundError";
  }
}

export class InvalidDateRangeError extends NestlingError {
  constructor(message = "Invalid date range: start must be before end") {
    super(message, "validation", false, "Provide a valid date range where start < end.");
    this.name = "InvalidDateRangeError";
  }
}
