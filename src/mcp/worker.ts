/**
 * Cloudflare Worker entry point for the Nestling MCP server.
 * Implements OAuth 2.0 (PKCE + dynamic client registration) for Claude connectors
 * and multi-tenant Bearer-token MCP transport.
 * Deploy with: `wrangler deploy`
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Nestling } from "../client.js";
import { ENTRYPOINT_ICONS, registerNestlingTools, SERVER_VERSION } from "./tools.js";

// ── Types ──

interface Env {
  OAUTH_SECRET: string;
  /** Domain-verification token from the OpenAI Platform plugin dashboard */
  OPENAI_APPS_CHALLENGE?: string;
}

// ── Client cache (persists within isolate lifetime, with TTL) ──

interface CachedClient { client: Nestling; createdAt: number; }
const clientCache = new Map<string, CachedClient>();
const CLIENT_TTL_MS = 60 * 60 * 1000; // 1 hour

// ── Rate limiter (sliding window per token, persists within isolate) ──

interface RateBucket { timestamps: number[]; }
const rateBuckets = new Map<string, RateBucket>();
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 120; // 120 requests per minute per token

function isRateLimited(token: string): boolean {
  const now = Date.now();
  let bucket = rateBuckets.get(token);
  if (!bucket) {
    bucket = { timestamps: [] };
    rateBuckets.set(token, bucket);
  }
  // Evict old timestamps outside the window
  bucket.timestamps = bucket.timestamps.filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  if (bucket.timestamps.length >= RATE_LIMIT_MAX_REQUESTS) {
    return true;
  }
  bucket.timestamps.push(now);
  return false;
}

// ── Failed sign-in limiter (per account and client IP, persists within isolate) ──
// Raw API tokens are email + password, so failed sign-ins are capped to stop guessing.
// The key includes the account: Claude and ChatGPT send many users' requests from shared
// IPs, and one user's stale token must not lock everyone else out.

const failedSignIns = new Map<string, number[]>();
const FAILED_SIGN_IN_WINDOW_MS = 10 * 60 * 1000;
const FAILED_SIGN_IN_MAX = 10;

function signInKey(token: string, ip: string): string {
  try {
    const decoded = atob(token);
    const newline = decoded.indexOf("\n");
    if (newline > 0) return `${ip}|${decoded.slice(0, newline).trim().toLowerCase()}`;
  } catch {
    // Not a valid API token; it fails sign-in without a network call
  }
  return `${ip}|?`;
}

class TooManySignInsError extends Error {}

async function signInLimited(token: string, ip: string): Promise<Nestling> {
  const now = Date.now();
  const key = signInKey(token, ip);
  const recent = (failedSignIns.get(key) ?? []).filter(t => now - t < FAILED_SIGN_IN_WINDOW_MS);
  if (recent.length >= FAILED_SIGN_IN_MAX) throw new TooManySignInsError();
  try {
    return await getOrCreateClient(token);
  } catch (e) {
    recent.push(now);
    if (failedSignIns.size > 10_000) failedSignIns.clear(); // bound memory in a long-lived isolate
    failedSignIns.set(key, recent);
    throw e;
  }
}

// ── Crypto helpers for stateless auth codes ──

function b64url(buf: Uint8Array): string {
  return btoa(String.fromCharCode(...buf)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function b64urlDecode(s: string): Uint8Array {
  const b = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b);
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}
async function deriveKey(secret: string, purpose = ""): Promise<CryptoKey> {
  // Auth codes use the bare secret (unchanged so in-flight codes survive deploys); access tokens use a separate key
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(purpose ? `${secret}:${purpose}` : secret));
  return crypto.subtle.importKey("raw", hash, "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function encryptAuthCode(payload: object, secret: string, purpose = ""): Promise<string> {
  const key = await deriveKey(secret, purpose);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(payload)));
  const buf = new Uint8Array(12 + ct.byteLength);
  buf.set(iv);
  buf.set(new Uint8Array(ct), 12);
  return b64url(buf);
}
async function decryptAuthCode(code: string, secret: string, purpose = ""): Promise<any> {
  const key = await deriveKey(secret, purpose);
  const buf = b64urlDecode(code);
  const iv = buf.slice(0, 12);
  const ct = buf.slice(12);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return JSON.parse(new TextDecoder().decode(pt));
}

// Access tokens wrap the user's API token so the bearer credential issued to MCP
// clients only works against this server, not as a Nestling sign-in.
const ACCESS_TOKEN_PREFIX = "nst1_";
const REFRESH_TOKEN_PREFIX = "nsr1_";
// Long enough that MCP clients which never refresh are not signed out daily
const ACCESS_TOKEN_TTL_S = 30 * 24 * 60 * 60;
const REFRESH_TOKEN_TTL_MS = 180 * 24 * 60 * 60 * 1000;

/** Access + refresh token pair for a token endpoint response. */
async function issueTokens(apiToken: string, audience: string, secret: string) {
  const now = Date.now();
  return {
    access_token: ACCESS_TOKEN_PREFIX + await encryptAuthCode({ t: apiToken, aud: audience, exp: now + ACCESS_TOKEN_TTL_S * 1000 }, secret, "access"),
    token_type: "bearer",
    expires_in: ACCESS_TOKEN_TTL_S,
    refresh_token: REFRESH_TOKEN_PREFIX + await encryptAuthCode({ t: apiToken, aud: audience, exp: now + REFRESH_TOKEN_TTL_MS }, secret, "refresh"),
  };
}

async function apiTokenFromRefreshToken(refreshToken: string, audience: string, secret: string): Promise<string | null> {
  if (!refreshToken.startsWith(REFRESH_TOKEN_PREFIX)) return null;
  try {
    const payload = await decryptAuthCode(refreshToken.slice(REFRESH_TOKEN_PREFIX.length), secret, "refresh");
    return payload.aud === audience && typeof payload.t === "string" && Date.now() < payload.exp ? payload.t : null;
  } catch {
    return null;
  }
}

/** The user's API token behind a bearer credential, or null if it was not issued for this server. */
async function apiTokenFromBearer(bearer: string, audience: string, secret: string): Promise<string | null> {
  // Connections made before access tokens existed send the API token directly
  if (!bearer.startsWith(ACCESS_TOKEN_PREFIX)) return bearer;
  try {
    const payload = await decryptAuthCode(bearer.slice(ACCESS_TOKEN_PREFIX.length), secret, "access");
    const fresh = typeof payload.exp === "number" && Date.now() < payload.exp;
    return payload.aud === audience && typeof payload.t === "string" && fresh ? payload.t : null;
  } catch {
    return null;
  }
}

// ── OAuth helpers ──

function oauthMeta(issuer: string) {
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: [],
    // ChatGPT uses its stable redirect URI only when the issuer is returned with every authorization response (RFC 9207)
    authorization_response_iss_parameter_supported: true,
  };
}

// MCP requires open dynamic client registration, so anyone can mint a client_id.
// What stops a self-registered client from phishing tokens is that auth codes are
// only ever sent to these known MCP clients, or to the user's own machine.
const ALLOWED_REDIRECT_URIS = new Map([
  ["https://claude.ai/api/mcp/auth_callback", "Claude"],
  ["https://claude.com/api/mcp/auth_callback", "Claude"],
  ["https://chatgpt.com/connector_platform_oauth_redirect", "ChatGPT"],
  ["https://vscode.dev/redirect", "VS Code"],
  ["cursor://anysphere.cursor-mcp/oauth/callback", "Cursor"],
  ["https://www.cursor.com/agents/mcp/oauth/callback", "Cursor"],
]);
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
// ChatGPT's per-connector callback, used by connections created before the stable redirect
const CHATGPT_CONNECTOR_REDIRECT = /^https:\/\/chatgpt\.com\/connector\/oauth\/[A-Za-z0-9_-]{1,128}$/;

function isAllowedRedirectUri(raw: unknown): raw is string {
  if (typeof raw !== "string" || raw.length > 2048) return false;
  if (ALLOWED_REDIRECT_URIS.has(raw) || CHATGPT_CONNECTOR_REDIRECT.test(raw)) return true;
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  // Loopback redirects (Claude Code, desktop clients, MCP Inspector) can only reach the user's own machine
  return u.protocol === "http:" && LOOPBACK_HOSTS.has(u.hostname) && !u.username && !u.password && !u.hash;
}

function redirectAppName(redirectUri: string): string {
  if (CHATGPT_CONNECTOR_REDIRECT.test(redirectUri)) return "ChatGPT";
  return ALLOWED_REDIRECT_URIS.get(redirectUri) ?? "an app on this device";
}

function escapeHTML(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

const HTML_HEADERS: Record<string, string> = {
  "Content-Type": "text/html;charset=utf-8",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src https://nestling-app.com; frame-ancestors 'none'; base-uri 'none'",
};

function errorHTML(message: string, status = 400) {
  return new Response(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Nestling</title></head><body style="font-family:-apple-system,sans-serif;max-width:420px;margin:4rem auto;padding:1rem"><h1>Can't connect</h1><p>${escapeHTML(message)}</p></body></html>`, { status, headers: HTML_HEADERS });
}

function authorizeHTML(params: { client_id: string; redirect_uri: string; state?: string; code_challenge: string; code_challenge_method: string }, error?: string) {
  const hidden = Object.entries(params).map(([k, v]) => v != null ? `<input type="hidden" name="${k}" value="${escapeHTML(v)}">` : "").join("\n");
  const destination = escapeHTML(redirectAppName(params.redirect_uri));
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in — Nestling</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Lora:wght@500;600&family=Inter:wght@400;500;600&display=swap">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif;background:#fdfbf7;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:1rem;color:#1c1917;line-height:1.6}
.card{background:#fff;border-radius:1rem;box-shadow:0 20px 25px -5px rgba(0,0,0,.08),0 10px 10px -5px rgba(0,0,0,.02);max-width:420px;width:100%;padding:2.5rem}
.logo{display:flex;align-items:center;justify-content:center;gap:.625rem;margin-bottom:1.5rem}
.logo img{width:36px;height:36px;border-radius:8px}
.logo span{font-family:'Lora',Georgia,serif;font-size:1.375rem;font-weight:600;letter-spacing:-.01em}
h1{font-family:'Lora',Georgia,serif;font-size:1.5rem;font-weight:600;text-align:center;margin-bottom:.375rem;letter-spacing:-.01em}
.subtitle{color:#57534e;text-align:center;margin-bottom:1.75rem;font-size:.9rem}
label{display:block;font-weight:600;margin-bottom:.375rem;font-size:.875rem}
input[type=password]{width:100%;padding:.75rem 1rem;border:1px solid rgba(212,184,149,.24);border-radius:.5rem;font-size:1rem;font-family:inherit;background:#fdfbf7;transition:border-color .2s}
input[type=password]:focus{outline:none;border-color:#c19a6b;box-shadow:0 0 0 3px rgba(193,154,107,.15)}
input[type=password]::placeholder{color:#a8a29e}
.btn{display:block;width:100%;padding:.875rem;background:linear-gradient(135deg,#c19a6b 0%,#a67c52 100%);color:#fff;border:none;border-radius:.5rem;font-size:.9375rem;font-weight:600;cursor:pointer;font-family:'Inter',sans-serif;margin-top:1.25rem;transition:all .2s cubic-bezier(.4,0,.2,1);box-shadow:0 4px 12px rgba(193,154,107,.25)}
.btn:hover{transform:translateY(-1px);box-shadow:0 8px 20px rgba(193,154,107,.35)}
.btn:active{transform:translateY(0)}
.hint{color:#78716c;font-size:.8rem;text-align:center;margin-top:1.25rem;line-height:1.5}
.hint b{color:#57534e;font-weight:600}
.error{color:#b91c1c;background:#fef2f2;border:1px solid #fecaca;border-radius:.5rem;padding:.75rem 1rem;text-align:center;font-size:.875rem;margin-bottom:1rem}
.divider{height:1px;background:rgba(212,184,149,.12);margin:1.5rem 0}
.footer{text-align:center;font-size:.75rem;color:#a8a29e}
.footer a{color:#c19a6b;text-decoration:none}
.footer a:hover{text-decoration:underline}
</style></head><body>
<div class="card">
<div class="logo">
<img src="https://nestling-app.com/logo.png" alt="Nestling" width="36" height="36">
<span>Nestling</span>
</div>
<h1>Connect your account</h1>
<p class="subtitle">Paste your API token to give <b>${destination}</b> access to your baby's data. Only continue if you started this from that app.</p>
<form method="POST" action="/oauth/authorize">
${hidden}
${error ? `<div class="error">${escapeHTML(error)}</div>\n` : ""}<label for="token">API Token</label>
<input type="password" id="token" name="token" placeholder="Paste your Nestling API token" required autocomplete="off">
<button class="btn" type="submit">Connect</button>
</form>
<p class="hint">Open the Nestling app → <b>Settings → Data → API Token</b></p>
<div class="divider"></div>
<p class="footer">By connecting you agree to the <a href="https://nestling-app.com/privacy.html">Privacy Policy</a></p>
</div></body></html>`;
}

// ── MCP server ──

const HOSTED_ICON_SOURCE_URL = "https://nestling-app.com/favicon-512.png";

function createServer(client: Nestling | null, issuer: string, chatgpt: boolean): McpServer {
  const server = new McpServer({
    name: "nestling",
    title: "Nestling",
    version: SERVER_VERSION,
    description: "Read and log your baby's sleep, feeds, nappies, and diary entries from the Nestling baby tracking app.",
    websiteUrl: "https://nestling-app.com",
    icons: [{ src: `${issuer}/icon.png`, mimeType: "image/png" }],
  });
  registerNestlingTools(server, { client, issuer, chatgpt });
  return server;
}

// ── JSON-RPC method detection for unauthenticated discovery ──

// Resources are the static plugin UI, so hosts can prefetch them before sign-in.
const DISCOVERY_METHODS = new Set(["initialize", "tools/list", "resources/list", "resources/templates/list", "resources/read", "ping", "notifications/initialized"]);

function needsAuth(body: string): boolean {
  try {
    const parsed = JSON.parse(body);
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    return messages.some((msg: { method?: string }) => msg.method && !msg.method.startsWith("notifications/") && !DISCOVERY_METHODS.has(msg.method));
  } catch {
    return true; // malformed → require auth, transport will reject
  }
}

// ── Auth ──

async function getOrCreateClient(token: string): Promise<Nestling> {
  const cached = clientCache.get(token);
  if (cached && Date.now() - cached.createdAt < CLIENT_TTL_MS) {
    return cached.client;
  }
  // Evict stale entry if expired
  if (cached) clientCache.delete(token);
  const c = new Nestling({ apiToken: token });
  await c.signIn();
  clientCache.set(token, { client: c, createdAt: Date.now() });
  return c;
}

function extractBearerToken(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (!auth) return null;
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? null;
}

// ── Worker fetch handler ──

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const issuer = `${url.protocol}//${url.host}`;
    const resourceMetadataUrl = `${issuer}/.well-known/oauth-protected-resource/mcp`;
    const clientIp = req.headers.get("cf-connecting-ip") ?? "unknown";

    // CORS: intentionally permissive ("*") because MCP clients connect from diverse origins.
    // Authentication is enforced via Bearer tokens, not origin checks.
    const corsHeaders: Record<string, string> = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id",
      "Access-Control-Expose-Headers": "Mcp-Session-Id",
    };

    // Security headers applied to all responses
    const securityHeaders: Record<string, string> = {
      "X-Content-Type-Options": "nosniff",
      "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
      "X-Frame-Options": "DENY",
    };

    // CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: { ...corsHeaders, ...securityHeaders } });
    }

    // Health check
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok" }), { headers: { "Content-Type": "application/json", ...securityHeaders } });
    }

    // Same-host icon endpoint for server metadata discovery
    if (url.pathname === "/icon.png") {
      const upstream = await fetch(HOSTED_ICON_SOURCE_URL, {
        headers: { Accept: "image/png,image/*;q=0.8,*/*;q=0.5" },
      });

      if (!upstream.ok || !upstream.body) {
        return new Response("Icon unavailable", { status: 502 });
      }

      return new Response(upstream.body, {
        headers: {
          "Content-Type": upstream.headers.get("content-type") ?? "image/png",
          "Cache-Control": "public, max-age=86400",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    // OpenAI plugin domain verification
    if (url.pathname === "/.well-known/openai-apps-challenge") {
      if (!env.OPENAI_APPS_CHALLENGE) return new Response("Not Found", { status: 404, headers: securityHeaders });
      return new Response(env.OPENAI_APPS_CHALLENGE, { headers: { "Content-Type": "text/plain;charset=utf-8", "Cache-Control": "no-store", ...securityHeaders } });
    }

    // Monochrome sidebar icons for plugin entrypoints
    const iconMatch = url.pathname.match(/^\/icons\/([a-z-]+)\.svg$/);
    if (iconMatch && ENTRYPOINT_ICONS[iconMatch[1]]) {
      return new Response(ENTRYPOINT_ICONS[iconMatch[1]], {
        headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400", "Access-Control-Allow-Origin": "*", ...securityHeaders },
      });
    }

    // ── OAuth 2.0 endpoints ──

    // Authorization server metadata
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return Response.json(oauthMeta(issuer), { headers: { "Cache-Control": "public, max-age=3600" } });
    }

    // Protected resource metadata (for /mcp resource)
    if (url.pathname === "/.well-known/oauth-protected-resource" || url.pathname === "/.well-known/oauth-protected-resource/mcp") {
      return Response.json({
        resource: `${issuer}/mcp`,
        authorization_servers: [issuer],
        bearer_methods_supported: ["header"],
      }, { headers: { "Cache-Control": "public, max-age=3600" } });
    }

    // Dynamic client registration (RFC 7591)
    if (url.pathname === "/oauth/register" && req.method === "POST") {
      let body: Record<string, unknown>;
      try { body = await req.json() as Record<string, unknown>; } catch {
        return Response.json({ error: "invalid_client_metadata", error_description: "Body must be JSON" }, { status: 400 });
      }
      const redirectUris = body.redirect_uris;
      if (!Array.isArray(redirectUris) || redirectUris.length === 0 || redirectUris.length > 10 || !redirectUris.every(isAllowedRedirectUri)) {
        return Response.json({ error: "invalid_redirect_uri", error_description: "redirect_uris must be a supported MCP client callback or a loopback address" }, { status: 400 });
      }
      const clientName = typeof body.client_name === "string" ? body.client_name.slice(0, 100) : "MCP Client";
      return Response.json({
        client_id: crypto.randomUUID(),
        client_name: clientName,
        redirect_uris: redirectUris,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }, { status: 201 });
    }

    // Authorization endpoint
    if (url.pathname === "/oauth/authorize") {
      if (req.method === "GET") {
        // Show login form
        const params = {
          client_id: url.searchParams.get("client_id") ?? "",
          redirect_uri: url.searchParams.get("redirect_uri") ?? "",
          state: url.searchParams.get("state") ?? undefined,
          code_challenge: url.searchParams.get("code_challenge") ?? "",
          code_challenge_method: url.searchParams.get("code_challenge_method") ?? "S256",
        };
        if (!isAllowedRedirectUri(params.redirect_uri)) {
          return errorHTML("This app isn't allowed to connect to Nestling.");
        }
        if (!params.code_challenge || params.code_challenge_method !== "S256") {
          return errorHTML("This app sent an incomplete sign-in request. Please try again from the app.");
        }
        return new Response(authorizeHTML(params), { headers: HTML_HEADERS });
      }

      if (req.method === "POST") {
        // Process login form submission
        const form = await req.formData();
        const token = (form.get("token") as string)?.trim();
        const redirectUri = form.get("redirect_uri") as string;
        const state = form.get("state") as string | null;
        const codeChallenge = form.get("code_challenge") as string;
        const clientId = form.get("client_id") as string;

        if (!token || !redirectUri || !codeChallenge) {
          return errorHTML("Some details are missing. Please try again from the app.");
        }
        if (!isAllowedRedirectUri(redirectUri)) {
          return errorHTML("This app isn't allowed to connect to Nestling.");
        }

        // Validate the token by trying to sign in
        try {
          await signInLimited(token, clientIp);
        } catch (e) {
          if (e instanceof TooManySignInsError) return errorHTML("Too many attempts. Wait 10 minutes, then try again.", 429);
          // Show form again with error
          const params = { client_id: clientId ?? "", redirect_uri: redirectUri, state: state ?? undefined, code_challenge: codeChallenge, code_challenge_method: "S256" };
          return new Response(authorizeHTML(params, "That token didn't work. Check it and try again."), { headers: HTML_HEADERS });
        }

        // Create encrypted auth code
        const code = await encryptAuthCode({
          token,
          codeChallenge,
          redirectUri,
          clientId,
          exp: Date.now() + 5 * 60 * 1000, // 5 min expiry
        }, env.OAUTH_SECRET);

        const callback = new URL(redirectUri);
        callback.searchParams.set("code", code);
        if (state) callback.searchParams.set("state", state);
        callback.searchParams.set("iss", issuer);

        return Response.redirect(callback.toString(), 302);
      }
    }

    // Token endpoint
    if (url.pathname === "/oauth/token" && req.method === "POST") {
      let body: Record<string, string>;
      const ct = req.headers.get("content-type") ?? "";
      try {
        if (ct.includes("application/x-www-form-urlencoded")) {
          const form = await req.formData();
          body = Object.fromEntries(form.entries()) as Record<string, string>;
        } else {
          body = await req.json() as Record<string, string>;
        }
      } catch {
        return Response.json({ error: "invalid_request", error_description: "Body must be form-encoded or JSON" }, { status: 400 });
      }

      const { grant_type, code, code_verifier, redirect_uri, client_id } = body;

      if (grant_type === "refresh_token") {
        const apiToken = typeof body.refresh_token === "string" ? await apiTokenFromRefreshToken(body.refresh_token, `${issuer}/mcp`, env.OAUTH_SECRET) : null;
        if (!apiToken) {
          return Response.json({ error: "invalid_grant", error_description: "Invalid or expired refresh token" }, { status: 400 });
        }
        // The API token stops working when the user creates a new one; make them reconnect then.
        try {
          await signInLimited(apiToken, clientIp);
        } catch {
          return Response.json({ error: "invalid_grant", error_description: "Sign in to Nestling again" }, { status: 400 });
        }
        return Response.json(await issueTokens(apiToken, `${issuer}/mcp`, env.OAUTH_SECRET), { headers: { "Cache-Control": "no-store" } });
      }

      if (grant_type !== "authorization_code" || !code) {
        return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
      }

      let payload: { token: string; codeChallenge: string; redirectUri: string; clientId: string; exp: number };
      try {
        payload = await decryptAuthCode(code, env.OAUTH_SECRET);
      } catch {
        return Response.json({ error: "invalid_grant", error_description: "Invalid or expired authorization code" }, { status: 400 });
      }

      // Check expiry
      if (Date.now() > payload.exp) {
        return Response.json({ error: "invalid_grant", error_description: "Authorization code expired" }, { status: 400 });
      }

      // The code must be redeemed by the same client, for the same redirect, it was issued to
      if ((redirect_uri && redirect_uri !== payload.redirectUri) || (client_id && payload.clientId && client_id !== payload.clientId)) {
        return Response.json({ error: "invalid_grant", error_description: "Authorization code was issued to a different client" }, { status: 400 });
      }

      // Verify PKCE (mandatory — public clients have no other proof of possession)
      if (!code_verifier) {
        return Response.json({ error: "invalid_request", error_description: "code_verifier is required" }, { status: 400 });
      }
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code_verifier));
      if (b64url(new Uint8Array(digest)) !== payload.codeChallenge) {
        return Response.json({ error: "invalid_grant", error_description: "PKCE verification failed" }, { status: 400 });
      }

      return Response.json(await issueTokens(payload.token, `${issuer}/mcp`, env.OAUTH_SECRET), { headers: { "Cache-Control": "no-store" } });
    }

    // ── MCP endpoint (stateless — each request is independent) ──

    if (url.pathname === "/mcp") {
      if (req.method === "GET" || req.method === "DELETE") {
        // Stateless server has no persistent sessions to stream or delete
        return new Response("Method not allowed", { status: 405 });
      }

      if (req.method !== "POST") {
        return new Response("Method not allowed", { status: 405 });
      }

      // Read body once so we can inspect the JSON-RPC method(s)
      const bodyText = await req.text();
      const authRequired = needsAuth(bodyText);

      let client: Nestling | null = null;
      const bearer = extractBearerToken(req);
      const token = bearer ? await apiTokenFromBearer(bearer, `${issuer}/mcp`, env.OAUTH_SECRET) : null;

      if (authRequired) {
        if (!token) {
          return new Response(
            JSON.stringify({ error: "Missing Authorization: Bearer <nestling-api-token>", hint: "Get your API token from the Nestling app: Settings → Data → API Token" }),
            {
              status: 401,
              headers: {
                "Content-Type": "application/json",
                ...securityHeaders,
                "WWW-Authenticate": `Bearer error="invalid_token", error_description="Missing Authorization header", resource_metadata="${resourceMetadataUrl}"`,
              },
            },
          );
        }

        // Rate limiting (per-token sliding window)
        if (isRateLimited(token)) {
          return new Response(
            JSON.stringify({ error: "rate_limited", message: "Too many requests. Please wait before retrying.", retryAfterSeconds: 60 }),
            {
              status: 429,
              headers: {
                "Content-Type": "application/json",
                "Retry-After": "60",
                ...securityHeaders,
              },
            },
          );
        }

        try {
          client = await signInLimited(token, clientIp);
        } catch (e) {
          if (e instanceof TooManySignInsError) {
            return new Response(
              JSON.stringify({ error: "rate_limited", message: "Too many failed sign-ins. Wait 10 minutes, then try again.", retryAfterSeconds: 600 }),
              { status: 429, headers: { "Content-Type": "application/json", "Retry-After": "600", ...securityHeaders } },
            );
          }
          return new Response(
            JSON.stringify({ error: "Authentication failed. Check your Nestling API token." }),
            {
              status: 401,
              headers: {
                "Content-Type": "application/json",
                ...securityHeaders,
                "WWW-Authenticate": `Bearer error="invalid_token", error_description="Authentication failed", resource_metadata="${resourceMetadataUrl}"`,
              },
            },
          );
        }
      }

      // ChatGPT's connector identifies itself as "openai-mcp/<version>"
      const chatgpt = /openai/i.test(req.headers.get("user-agent") ?? "");
      const mcpServer = createServer(client, issuer, chatgpt);
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless — no session tracking
      });

      await mcpServer.connect(transport);

      // Reconstruct request with the consumed body
      const reconstructed = new Request(req.url, {
        method: req.method,
        headers: req.headers,
        body: bodyText,
      });
      return transport.handleRequest(reconstructed);
    }

    return new Response("Not Found", { status: 404 });
  },
};
