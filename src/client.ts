import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  type NestlingOptions,
  type Baby,
  type Membership,
  type RawEntry,
  type SleepEntry,
  type FeedEntry,
  type NappyEntry,
  type DiaryEntry,
  type DateRange,
  type EntryType,
  type CreateSleepInput,
  type CreateFeedInput,
  type CreateNappyInput,
  type CreateDiaryInput,
  AuthenticationError,
  BabyNotFoundError,
  InvalidDateRangeError,
  NestlingError,
} from "./types.js";
import {
  normalizeIsoDateTime,
  parseIsoDateTime,
  validateDateRange,
  validateNonNegativeNumber,
} from "./validation.js";

export class Nestling {
  private supabase: SupabaseClient;
  private userId: string | null = null;
  private authenticated = false;

  public readonly babies: BabiesDomain;
  public readonly sleep: SleepDomain;
  public readonly feed: FeedDomain;
  public readonly nappies: NappyDomain;
  public readonly diary: DiaryDomain;

  /** Nestling Supabase project URL — same for all users */
  static readonly SUPABASE_URL = "https://qfpmkjoyxoizztghpalf.supabase.co";
  /** Nestling Supabase anon key — public, safe to embed */
  static readonly SUPABASE_ANON_KEY = "sb_publishable_ff_weK7w5-LCnovg6snqXQ_lG3Je_28";

  constructor(private opts: NestlingOptions) {
    this.supabase = createClient(Nestling.SUPABASE_URL, Nestling.SUPABASE_ANON_KEY, {
      auth: { autoRefreshToken: true, persistSession: false },
    });

    this.babies = new BabiesDomain(this);
    this.sleep = new SleepDomain(this);
    this.feed = new FeedDomain(this);
    this.nappies = new NappyDomain(this);
    this.diary = new DiaryDomain(this);
  }

  /** Decode a base64-encoded API token into email + password */
  private static decodeApiToken(token: string): { email: string; password: string } {
    let decoded: string;
    try {
      decoded = atob(token);
    } catch {
      throw new AuthenticationError(
        "Invalid API token format. Generate a new one from the Nestling app (Settings → Data → API Token).",
      );
    }
    const idx = decoded.indexOf("\n");
    if (idx === -1) {
      throw new AuthenticationError(
        "Invalid API token format. Generate a new one from the Nestling app (Settings → Data → API Token).",
      );
    }
    return { email: decoded.substring(0, idx), password: decoded.substring(idx + 1) };
  }

  /** Authenticate using the API token and return the user ID */
  async signIn(): Promise<string> {
    const { email, password } = Nestling.decodeApiToken(this.opts.apiToken);
    const { data, error } = await this.supabase.auth.signInWithPassword({
      email,
      password,
    });
    if (error || !data.user) {
      throw new AuthenticationError(
        error?.message ?? "Sign-in failed — token may be invalid or revoked",
      );
    }
    this.userId = data.user.id;
    this.authenticated = true;
    return this.userId;
  }

  /** Ensure authenticated, sign in if needed */
  async ensureAuth(): Promise<string> {
    if (this.authenticated && this.userId) return this.userId;
    return this.signIn();
  }

  /** Get the underlying Supabase client (RLS-scoped to the signed-in user) */
  getClient(): SupabaseClient {
    return this.supabase;
  }

  /** Get current user email */
  async getUser(): Promise<{ id: string; email: string }> {
    await this.ensureAuth();
    const { data } = await this.supabase.auth.getUser();
    if (!data.user) throw new AuthenticationError("No active session");
    return { id: data.user.id, email: data.user.email ?? "" };
  }

  /** Sign out and clean up */
  async close(): Promise<void> {
    await this.supabase.auth.signOut();
    this.authenticated = false;
    this.userId = null;
  }
}

// ── Babies domain ──

class BabiesDomain {
  constructor(private client: Nestling) {}

  /** List all babies the user has access to */
  async list(): Promise<Baby[]> {
    await this.client.ensureAuth();
    const { data, error } = await this.client
      .getClient()
      .from("babies")
      .select("id, owner_id, nickname, birth_date, created_at")
      .order("created_at", { ascending: true });

    if (error) throw new NestlingError(error.message, "api", true, "Retry the request.");
    return (data ?? []).map(mapBaby);
  }

  /** Get a single baby by ID */
  async get(babyId: string): Promise<Baby> {
    await this.client.ensureAuth();
    const { data, error } = await this.client
      .getClient()
      .from("babies")
      .select("id, owner_id, nickname, birth_date, created_at")
      .eq("id", babyId)
      .single();

    if (error || !data) throw new BabyNotFoundError(babyId);
    return mapBaby(data);
  }
}

// ── Generic entries domain (read) ──

class EntriesDomain<T> {
  constructor(
    protected client: Nestling,
    protected entryType: EntryType,
    private decode: (raw: RawEntry) => T,
    private effectiveTimestamp: (raw: RawEntry, decoded: T) => string | null = (raw) => raw.timestamp,
  ) {}

  /** List entries for a baby within a date range */
  async list(babyId: string, range: DateRange): Promise<T[]> {
    validateDateRange(range);
    await this.client.ensureAuth();

    let query = this.client
      .getClient()
      .from("entries")
      .select("id, baby_id, type, data, start_at, end_at, timestamp, updated_at")
      .eq("baby_id", babyId)
      .eq("type", this.entryType)
      .gte("timestamp", range.start.toISOString())
      .lte("timestamp", range.end.toISOString())
      .order("timestamp", { ascending: true })
      .limit(1000);

    const { data, error } = await query;
    if (error) throw new NestlingError(error.message, "api", true, "Retry the request.");

    return (data ?? [])
      .map((row) => {
        const raw = row as RawEntry;
        const decoded = this.decode(raw);
        return {
          decoded,
          effectiveTimestamp: this.effectiveTimestamp(raw, decoded),
        };
      })
      .filter(({ effectiveTimestamp }) => isWithinDateRange(effectiveTimestamp, range))
      .sort((left, right) => compareDateTimeStrings(left.effectiveTimestamp, right.effectiveTimestamp))
      .map(({ decoded }) => decoded);
  }

  /** Insert a new entry row */
  protected async insert(
    entryId: string,
    babyId: string,
    data: Record<string, unknown>,
    timestamp: string,
    bounds?: { startAt?: string; endAt?: string },
  ): Promise<string> {
    await this.client.ensureAuth();
    const now = new Date().toISOString();
    const { error } = await this.client
      .getClient()
      .from("entries")
      .insert({
        id: entryId,
        baby_id: babyId,
        type: this.entryType,
        data: JSON.stringify(data),
        start_at: bounds?.startAt ?? null,
        end_at: bounds?.endAt ?? null,
        timestamp,
        updated_at: now,
      });
    if (error) throw new NestlingError(error.message, "api", true, "Retry the request.");
    return entryId;
  }
}

// ── Sleep domain ──

class SleepDomain extends EntriesDomain<SleepEntry> {
  constructor(client: Nestling) {
    super(
      client,
      "sleep",
      decodeSleep,
      (raw, decoded) => decoded.start ?? raw.start_at,
    );
  }

  /** Create a new sleep session */
  async create(babyId: string, input: CreateSleepInput): Promise<string> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const start = parseIsoDateTime(input.start, "start");
    const end = parseIsoDateTime(input.end, "end");
    if (start >= end) throw new InvalidDateRangeError("Sleep start must be before end");
    const startAt = start.toISOString();
    const endAt = end.toISOString();
    const durationMinutes = Math.round((end.getTime() - start.getTime()) / 60000);
    return this.insert(
      id,
      babyId,
      {
        id,
        babyId,
        start: startAt,
        end: endAt,
        durationMinutes,
        type: "sleep",
        source: "manual",
        isActive: false,
        notes: input.notes ?? null,
        updatedAt: now,
      },
      startAt,
      { startAt, endAt },
    );
  }
}

// ── Feed domain ──

class FeedDomain extends EntriesDomain<FeedEntry> {
  constructor(client: Nestling) {
    super(client, "feed", decodeFeed);
  }

  /** Create a new feed entry */
  async create(babyId: string, input: CreateFeedInput): Promise<string> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const timestamp = normalizeIsoDateTime(input.timestamp, "timestamp");
    validateNonNegativeNumber(input.durationSeconds, "durationSeconds");
    validateNonNegativeNumber(input.amountMl, "amountMl");
    return this.insert(
      id,
      babyId,
      {
        id,
        babyId,
        timestamp,
        type: input.type,
        duration: input.durationSeconds ?? null,
        amount: input.amountMl ?? null,
        side: input.side ?? null,
        notes: input.notes ?? null,
        updatedAt: now,
      },
      timestamp,
    );
  }
}

// ── Nappy domain ──

class NappyDomain extends EntriesDomain<NappyEntry> {
  constructor(client: Nestling) {
    super(client, "nappy", decodeNappy);
  }

  /** Create a new nappy entry */
  async create(babyId: string, input: CreateNappyInput): Promise<string> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const timestamp = normalizeIsoDateTime(input.timestamp, "timestamp");
    return this.insert(
      id,
      babyId,
      {
        id,
        babyId,
        timestamp,
        type: input.type,
        notes: input.notes ?? null,
        updatedAt: now,
      },
      timestamp,
    );
  }
}

// ── Diary domain ──

class DiaryDomain extends EntriesDomain<DiaryEntry> {
  constructor(client: Nestling) {
    super(client, "diary", decodeDiary);
  }

  /** Create a new diary entry */
  async create(babyId: string, input: CreateDiaryInput): Promise<string> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const timestamp = normalizeIsoDateTime(input.timestamp, "timestamp");
    return this.insert(
      id,
      babyId,
      {
        id,
        babyId,
        timestamp,
        text: input.text,
        tags: input.tags ?? [],
        updatedAt: now,
      },
      timestamp,
    );
  }
}

// ── Decoders ──

function decodeSleep(raw: RawEntry): SleepEntry {
  const d = entryData(raw.data);
  const start = stringValue(d.start) ?? stringValue(d.startTime) ?? raw.start_at;
  const end = stringValue(d.end) ?? stringValue(d.endTime) ?? raw.end_at;
  let durationMinutes = numberValue(d.durationMinutes);
  if (durationMinutes === null && start && end) {
    durationMinutes = Math.round(
      (new Date(end).getTime() - new Date(start).getTime()) / 60000,
    );
  }
  return {
    id: raw.id,
    start: start ?? null,
    end: end ?? null,
    durationMinutes,
    type: stringValue(d.type),
    source: stringValue(d.source),
    notes: stringValue(d.notes),
  };
}

function decodeFeed(raw: RawEntry): FeedEntry {
  const d = entryData(raw.data);
  return {
    id: raw.id,
    timestamp: raw.timestamp,
    type: stringValue(d.type),
    durationSeconds: numberValue(d.duration) ?? numberValue(d.durationSeconds),
    amountMl: numberValue(d.amount) ?? numberValue(d.amountMl),
    side: stringValue(d.side),
    notes: stringValue(d.notes),
  };
}

function isWithinDateRange(value: string | null, range: DateRange): boolean {
  if (!value) return false;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed >= range.start && parsed <= range.end;
}

function compareDateTimeStrings(left: string | null, right: string | null): number {
  const leftTime = left ? new Date(left).getTime() : Number.POSITIVE_INFINITY;
  const rightTime = right ? new Date(right).getTime() : Number.POSITIVE_INFINITY;
  return leftTime - rightTime;
}

function decodeNappy(raw: RawEntry): NappyEntry {
  const d = entryData(raw.data);
  return {
    id: raw.id,
    timestamp: raw.timestamp,
    type: stringValue(d.type),
    notes: stringValue(d.notes),
  };
}

function decodeDiary(raw: RawEntry): DiaryEntry {
  const d = entryData(raw.data);
  return {
    id: raw.id,
    timestamp: raw.timestamp,
    text: stringValue(d.text),
    tags: Array.isArray(d.tags) ? d.tags.filter((tag): tag is string => typeof tag === "string") : null,
  };
}

// ── Helpers ──

function entryData(data: RawEntry["data"]): Record<string, unknown> {
  if (!data) return {};
  if (typeof data === "string") {
    try {
      const parsed = JSON.parse(data) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return data;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function mapBaby(row: Record<string, unknown>): Baby {
  return {
    id: row.id as string,
    ownerId: row.owner_id as string,
    nickname: (row.nickname as string) ?? null,
    birthDate: (row.birth_date as string) ?? null,
    createdAt: row.created_at as string,
  };
}
