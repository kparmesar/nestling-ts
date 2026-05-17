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

  constructor(private opts: NestlingOptions) {
    this.supabase = createClient(opts.supabaseUrl, opts.supabaseAnonKey, {
      auth: { autoRefreshToken: true, persistSession: false },
    });

    this.babies = new BabiesDomain(this);
    this.sleep = new SleepDomain(this);
    this.feed = new FeedDomain(this);
    this.nappies = new NappyDomain(this);
    this.diary = new DiaryDomain(this);
  }

  /** Authenticate using the refresh token and return the user ID */
  async signIn(): Promise<string> {
    const { data, error } = await this.supabase.auth.refreshSession({
      refresh_token: this.opts.refreshToken,
    });
    if (error || !data.user) {
      throw new AuthenticationError(
        error?.message ?? "Session refresh failed — token may be expired",
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
      .order("timestamp", { ascending: true });

    const { data, error } = await query;
    if (error) throw new NestlingError(error.message, "api", true, "Retry the request.");
    return (data ?? []).map((row) => this.decode(row as RawEntry));
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
        data,
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
    super(client, "sleep", decodeSleep);
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
        source: "api",
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
  const d = raw.data ?? {};
  const start = (d.start as string) ?? raw.start_at;
  const end = (d.end as string) ?? raw.end_at;
  let durationMinutes = (d.durationMinutes as number) ?? null;
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
    type: (d.type as string) ?? null,
    source: (d.source as string) ?? null,
    notes: (d.notes as string) ?? null,
  };
}

function decodeFeed(raw: RawEntry): FeedEntry {
  const d = raw.data ?? {};
  return {
    id: raw.id,
    timestamp: raw.timestamp,
    type: (d.type as string) ?? null,
    durationSeconds: (d.duration as number) ?? null,
    amountMl: (d.amount as number) ?? null,
    side: (d.side as string) ?? null,
    notes: (d.notes as string) ?? null,
  };
}

function decodeNappy(raw: RawEntry): NappyEntry {
  const d = raw.data ?? {};
  return {
    id: raw.id,
    timestamp: raw.timestamp,
    type: (d.type as string) ?? null,
    notes: (d.notes as string) ?? null,
  };
}

function decodeDiary(raw: RawEntry): DiaryEntry {
  const d = raw.data ?? {};
  return {
    id: raw.id,
    timestamp: raw.timestamp,
    text: (d.text as string) ?? null,
    tags: (d.tags as string[]) ?? null,
  };
}

// ── Helpers ──

function mapBaby(row: Record<string, unknown>): Baby {
  return {
    id: row.id as string,
    ownerId: row.owner_id as string,
    nickname: (row.nickname as string) ?? null,
    birthDate: (row.birth_date as string) ?? null,
    createdAt: row.created_at as string,
  };
}
