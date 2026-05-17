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

interface EntryRow {
  id: string;
  baby_id: string;
  type: string;
  data: Record<string, unknown>;
  timestamp: string;
  updated_at: string;
}

export async function insertEntry(
  babyId: string,
  type: "sleep" | "feed" | "nappy",
  data: Record<string, unknown>,
): Promise<void> {
  const client = await getClient();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const row: EntryRow = {
    id,
    baby_id: babyId,
    type,
    data: { id, babyId, ...data, updatedAt: now },
    timestamp: now,
    updated_at: now,
  };
  const { error } = await client.from("entries").insert(row);
  if (error) throw new Error(`Failed to insert ${type}: ${error.message}`);
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
