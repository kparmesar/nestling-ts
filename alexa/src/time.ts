// Helpers for time formatting in spoken responses

export function spokenTime(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  const tz = process.env.TIMEZONE ?? "UTC";
  return d.toLocaleTimeString("en-GB", { hour: "numeric", minute: "2-digit", timeZone: tz });
}

export function spokenDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  if (h > 0 && m > 0) return `${h} hour${h > 1 ? "s" : ""} and ${m} minute${m !== 1 ? "s" : ""}`;
  if (h > 0) return `${h} hour${h > 1 ? "s" : ""}`;
  return `${m} minute${m !== 1 ? "s" : ""}`;
}

export function minutesAgo(iso: string): string {
  const diff = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (diff < 1) return "just now";
  if (diff < 60) return `${diff} minute${diff !== 1 ? "s" : ""} ago`;
  const h = Math.floor(diff / 60);
  const m = diff % 60;
  if (m === 0) return `${h} hour${h > 1 ? "s" : ""} ago`;
  return `${h} hour${h > 1 ? "s" : ""} and ${m} minute${m !== 1 ? "s" : ""} ago`;
}
