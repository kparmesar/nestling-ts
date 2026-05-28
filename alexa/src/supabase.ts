import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://qfpmkjoyxoizztghpalf.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_ff_weK7w5-LCnovg6snqXQ_lG3Je_28";
const API_TOKEN = process.env.NESTLING_API_TOKEN!;

function decodeApiToken(token: string): { email: string; password: string } {
  const decoded = atob(token);
  const idx = decoded.indexOf("\n");
  if (idx === -1) throw new Error("Invalid API token format");
  return { email: decoded.substring(0, idx), password: decoded.substring(idx + 1) };
}

let supabase: SupabaseClient | null = null;

export async function getClient(): Promise<SupabaseClient> {
  if (supabase) return supabase;
  supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: true, persistSession: false },
  });
  const { email, password } = decodeApiToken(API_TOKEN);
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`Auth failed: ${error.message}`);
  return supabase;
}

export async function getBabyId(): Promise<string> {
  const client = await getClient();
  const { data, error } = await client
    .from("babies")
    .select("id, nickname")
    .order("created_at", { ascending: true })
    .limit(1);
  if (error || !data?.length) throw new Error("No babies found on this account.");
  return data[0].id;
}

export async function getBabyName(): Promise<string> {
  const client = await getClient();
  const { data } = await client
    .from("babies")
    .select("nickname")
    .order("created_at", { ascending: true })
    .limit(1);
  return data?.[0]?.nickname ?? "your baby";
}

export async function insertEntry(
  babyId: string,
  type: "sleep" | "feed" | "nappy",
  data: Record<string, unknown>,
  opts?: { startAt?: string; endAt?: string },
): Promise<string> {
  const client = await getClient();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const timestamp = (opts?.startAt ?? data.timestamp ?? now) as string;
  const row = {
    id,
    baby_id: babyId,
    type,
    data: JSON.stringify({ id, babyId, ...data, updatedAt: now }),
    start_at: opts?.startAt ?? null,
    end_at: opts?.endAt ?? null,
    timestamp,
    updated_at: now,
  };
  const { error } = await client.from("entries").insert(row);
  if (error) throw new Error(`Failed to insert ${type}: ${error.message}`);
  return id;
}

export async function updateEntry(
  entryId: string,
  data: Record<string, unknown>,
  opts?: { startAt?: string; endAt?: string; timestamp?: string },
): Promise<void> {
  const client = await getClient();
  const now = new Date().toISOString();
  const update: Record<string, unknown> = {
    data: JSON.stringify({ ...data, updatedAt: now }),
    updated_at: now,
  };
  if (opts?.startAt !== undefined) update.start_at = opts.startAt;
  if (opts?.endAt !== undefined) update.end_at = opts.endAt;
  if (opts?.timestamp !== undefined) update.timestamp = opts.timestamp;
  const { error } = await client.from("entries").update(update).eq("id", entryId);
  if (error) throw new Error(`Failed to update entry: ${error.message}`);
}

export async function findActiveEntry(
  babyId: string,
  type: "sleep" | "feed",
): Promise<{ id: string; data: Record<string, unknown> } | null> {
  const client = await getClient();
  const { data, error } = await client
    .from("entries")
    .select("id, data")
    .eq("baby_id", babyId)
    .eq("type", type)
    .order("timestamp", { ascending: false })
    .limit(5);
  if (error || !data?.length) return null;
  for (const row of data) {
    const parsed = typeof row.data === "string" ? JSON.parse(row.data) : row.data;
    if (parsed?.isActive === true) {
      return { id: row.id, data: parsed };
    }
  }
  return null;
}

export async function getLastEntry(
  babyId: string,
  type: "sleep" | "feed" | "nappy",
): Promise<Record<string, unknown> | null> {
  const client = await getClient();
  const { data, error } = await client
    .from("entries")
    .select("data, timestamp")
    .eq("baby_id", babyId)
    .eq("type", type)
    .order("timestamp", { ascending: false })
    .limit(1);
  if (error || !data?.length) return null;
  return { ...(data[0].data as Record<string, unknown>), _timestamp: data[0].timestamp };
}
