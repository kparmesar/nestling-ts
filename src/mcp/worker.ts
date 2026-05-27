/**
 * Cloudflare Worker entry point for the Nestling MCP server.
 * Implements OAuth 2.0 (PKCE + dynamic client registration) for Claude connectors
 * and multi-tenant Bearer-token MCP transport.
 * Deploy with: `wrangler deploy`
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { Nestling } from "../client.js";
import { NestlingError } from "../types.js";
import { parseUserDateTime } from "../parseDateTime.js";

// ── Types ──

interface Env {
  OAUTH_SECRET: string;
}

// ── Client cache (persists within isolate lifetime) ──

const clientCache = new Map<string, Nestling>();

// ── Crypto helpers for stateless auth codes ──

function b64url(buf: Uint8Array): string {
  return btoa(String.fromCharCode(...buf)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function b64urlDecode(s: string): Uint8Array {
  const b = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b);
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}
async function deriveKey(secret: string): Promise<CryptoKey> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", hash, "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function encryptAuthCode(payload: object, secret: string): Promise<string> {
  const key = await deriveKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(payload)));
  const buf = new Uint8Array(12 + ct.byteLength);
  buf.set(iv);
  buf.set(new Uint8Array(ct), 12);
  return b64url(buf);
}
async function decryptAuthCode(code: string, secret: string): Promise<any> {
  const key = await deriveKey(secret);
  const buf = b64urlDecode(code);
  const iv = buf.slice(0, 12);
  const ct = buf.slice(12);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return JSON.parse(new TextDecoder().decode(pt));
}

// ── OAuth helpers ──

function oauthMeta(issuer: string) {
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: [],
  };
}

function authorizeHTML(params: { client_id: string; redirect_uri: string; state?: string; code_challenge: string; code_challenge_method: string }) {
  const hidden = Object.entries(params).map(([k, v]) => v != null ? `<input type="hidden" name="${k}" value="${v}">` : "").join("\n");
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
<p class="subtitle">Paste your API token to give this app access to your baby's data.</p>
<form method="POST" action="/oauth/authorize">
${hidden}
<label for="token">API Token</label>
<input type="password" id="token" name="token" placeholder="Paste your Nestling API token" required autocomplete="off">
<button class="btn" type="submit">Connect</button>
</form>
<p class="hint">Open the Nestling app → <b>Settings → Data → API Token</b></p>
<div class="divider"></div>
<p class="footer">By connecting you agree to the <a href="https://nestling-app.com/privacy.html">Privacy Policy</a></p>
</div></body></html>`;
}

// ── MCP tool helpers ──

function ok(data: unknown, totalResults?: number) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ data, totalResults: totalResults ?? (Array.isArray(data) ? data.length : 1) }, null, 2) }],
  };
}

function fail(err: unknown) {
  const isNestling = err instanceof NestlingError;
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: isNestling ? err.name : "Error", message: err instanceof Error ? err.message : String(err), category: isNestling ? err.category : "unknown", retryable: isNestling ? err.retryable : false, recovery: isNestling ? err.recovery : "Check your configuration and try again." }, null, 2) }],
    isError: true,
  };
}

const DATETIME_DESC = 'Date/time — accepts ISO 8601 ("2026-05-07T20:00:00Z"), relative ("2 hours ago", "now"), day+time ("today 3pm", "yesterday 8:30pm"), time-only ("3pm"), or date+time ("2026-05-07 8pm")';
const timezone = "UTC"; // Worker doesn't know user TZ; tools accept ISO or relative

const BabyIdSchema = z.string().uuid().describe("The baby's UUID");
const FlexDateTimeSchema = z.string().transform((val) => parseUserDateTime(val, { timezone }));
const NonNegativeNumberSchema = z.number().finite().nonnegative();
const DateRangeSchema = { start: FlexDateTimeSchema.describe(`Start: ${DATETIME_DESC}`), end: FlexDateTimeSchema.describe(`End: ${DATETIME_DESC}`) };

// ── Server factory ──

function createServer(client: Nestling): McpServer {
  const server = new McpServer({
    name: "nestling",
    title: "Nestling",
    version: "0.2.4",
    description: "Read and log your baby's sleep, feeds, nappies, and diary entries from the Nestling baby tracking app.",
    websiteUrl: "https://nestling-app.com",
    icons: [{ src: "https://nestling-app.com/favicon-512.png", mimeType: "image/png" }],
  });

  server.tool("get_capabilities", "Discovery: list available data sources and tools", {}, async () => {
    return ok({ tools: ["get_capabilities","get_user","list_babies","get_baby","list_sleep","list_feeds","list_nappies","list_diary","create_sleep","create_feed","create_nappy","create_diary"], dataSources: ["babies","sleep","feeds","nappies","diary"], timezone, readOnly: false });
  });

  server.tool("get_user", "Get the authenticated user's profile (email, ID)", {}, async () => {
    try { return ok(await client.getUser()); } catch (e) { return fail(e); }
  });

  server.tool("list_babies", "List all babies the user has access to (owned + shared)", {}, async () => {
    try { return ok(await client.babies.list()); } catch (e) { return fail(e); }
  });

  server.tool("get_baby", "Get details for a specific baby by ID", { babyId: BabyIdSchema }, async ({ babyId }) => {
    try { return ok(await client.babies.get(babyId)); } catch (e) { return fail(e); }
  });

  server.tool("list_sleep", "List sleep sessions for a baby within a date range", { babyId: BabyIdSchema, ...DateRangeSchema }, async ({ babyId, start, end }) => {
    try { return ok(await client.sleep.list(babyId, { start: new Date(start), end: new Date(end) })); } catch (e) { return fail(e); }
  });

  server.tool("list_feeds", "List feeding entries (breast, bottle, solids) for a baby within a date range", { babyId: BabyIdSchema, ...DateRangeSchema }, async ({ babyId, start, end }) => {
    try { return ok(await client.feed.list(babyId, { start: new Date(start), end: new Date(end) })); } catch (e) { return fail(e); }
  });

  server.tool("list_nappies", "List nappy/diaper entries for a baby within a date range", { babyId: BabyIdSchema, ...DateRangeSchema }, async ({ babyId, start, end }) => {
    try { return ok(await client.nappies.list(babyId, { start: new Date(start), end: new Date(end) })); } catch (e) { return fail(e); }
  });

  server.tool("list_diary", "List diary/journal entries for a baby within a date range", { babyId: BabyIdSchema, ...DateRangeSchema }, async ({ babyId, start, end }) => {
    try { return ok(await client.diary.list(babyId, { start: new Date(start), end: new Date(end) })); } catch (e) { return fail(e); }
  });

  server.tool("create_sleep", "Log a sleep session for a baby. Accepts flexible time formats.", { babyId: BabyIdSchema, start: FlexDateTimeSchema.describe(`Sleep start: ${DATETIME_DESC}`), end: FlexDateTimeSchema.describe(`Sleep end: ${DATETIME_DESC}`), notes: z.string().optional().describe("Optional notes") }, async ({ babyId, start, end, notes }) => {
    try { const id = await client.sleep.create(babyId, { start, end, notes }); return ok({ id, message: "Sleep session created" }); } catch (e) { return fail(e); }
  });

  server.tool("create_feed", "Log a feeding entry for a baby. Accepts flexible time formats.", { babyId: BabyIdSchema, timestamp: FlexDateTimeSchema.describe(`When the feed happened: ${DATETIME_DESC}`), type: z.enum(["Breastfeeding","Bottle","Solids","Expressing"]).describe("Feed type"), durationSeconds: NonNegativeNumberSchema.optional().describe("Duration in seconds"), amountMl: NonNegativeNumberSchema.optional().describe("Amount in millilitres"), side: z.enum(["Left","Right","Both"]).optional().describe("Which side (for breastfeeding)"), notes: z.string().optional().describe("Optional notes") }, async ({ babyId, timestamp, type, durationSeconds, amountMl, side, notes }) => {
    try { const id = await client.feed.create(babyId, { timestamp, type, durationSeconds, amountMl, side, notes }); return ok({ id, message: "Feed entry created" }); } catch (e) { return fail(e); }
  });

  server.tool("create_nappy", "Log a nappy/diaper change for a baby. Accepts flexible time formats.", { babyId: BabyIdSchema, timestamp: FlexDateTimeSchema.describe(`When the nappy change happened: ${DATETIME_DESC}`), type: z.enum(["Wet","Dirty","Both"]).describe("Nappy type"), notes: z.string().optional().describe("Optional notes") }, async ({ babyId, timestamp, type, notes }) => {
    try { const id = await client.nappies.create(babyId, { timestamp, type, notes }); return ok({ id, message: "Nappy entry created" }); } catch (e) { return fail(e); }
  });

  server.tool("create_diary", "Log a diary/journal entry for a baby. Accepts flexible time formats.", { babyId: BabyIdSchema, timestamp: FlexDateTimeSchema.describe(`When the event happened: ${DATETIME_DESC}`), text: z.string().describe("The diary entry text"), tags: z.array(z.string()).optional().describe("Optional tags (e.g. ['milestone', 'funny'])") }, async ({ babyId, timestamp, text, tags }) => {
    try { const id = await client.diary.create(babyId, { timestamp, text, tags }); return ok({ id, message: "Diary entry created" }); } catch (e) { return fail(e); }
  });

  return server;
}

// ── Auth ──

async function getOrCreateClient(token: string): Promise<Nestling> {
  if (clientCache.has(token)) return clientCache.get(token)!;
  const c = new Nestling({ apiToken: token });
  await c.signIn();
  clientCache.set(token, c);
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

    const corsHeaders: Record<string, string> = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id",
      "Access-Control-Expose-Headers": "Mcp-Session-Id",
    };

    // CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // Health check
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok" }), { headers: { "Content-Type": "application/json" } });
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
      const body = await req.json() as Record<string, unknown>;
      const clientId = crypto.randomUUID();
      return Response.json({
        client_id: clientId,
        client_name: body.client_name ?? "MCP Client",
        redirect_uris: body.redirect_uris ?? [],
        grant_types: ["authorization_code"],
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
        return new Response(authorizeHTML(params), { headers: { "Content-Type": "text/html;charset=utf-8" } });
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
          return new Response("Missing required fields", { status: 400 });
        }

        // Validate the token by trying to sign in
        try {
          await getOrCreateClient(token);
        } catch {
          // Show form again with error
          const params = { client_id: clientId, redirect_uri: redirectUri, state: state ?? undefined, code_challenge: codeChallenge, code_challenge_method: "S256" };
          const html = authorizeHTML(params).replace(
            '<label for="token">',
            '<div class="error">Invalid API token. Please check and try again.</div>\n<label for="token">',
          );
          return new Response(html, { headers: { "Content-Type": "text/html;charset=utf-8" } });
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

        return Response.redirect(callback.toString(), 302);
      }
    }

    // Token endpoint
    if (url.pathname === "/oauth/token" && req.method === "POST") {
      let body: Record<string, string>;
      const ct = req.headers.get("content-type") ?? "";
      if (ct.includes("application/x-www-form-urlencoded")) {
        const form = await req.formData();
        body = Object.fromEntries(form.entries()) as Record<string, string>;
      } else {
        body = await req.json() as Record<string, string>;
      }

      const { grant_type, code, code_verifier } = body;

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

      // Verify PKCE
      if (code_verifier) {
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code_verifier));
        const expectedChallenge = b64url(new Uint8Array(digest));
        if (expectedChallenge !== payload.codeChallenge) {
          return Response.json({ error: "invalid_grant", error_description: "PKCE verification failed" }, { status: 400 });
        }
      }

      return Response.json({
        access_token: payload.token,
        token_type: "bearer",
      });
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

      const token = extractBearerToken(req);
      if (!token) {
        return new Response(
          JSON.stringify({ error: "Missing Authorization: Bearer <nestling-api-token>", hint: "Get your API token from the Nestling app: Settings → Data → API Token" }),
          {
            status: 401,
            headers: {
              "Content-Type": "application/json",
              "WWW-Authenticate": `Bearer error="invalid_token", error_description="Missing Authorization header", resource_metadata="${resourceMetadataUrl}"`,
            },
          },
        );
      }

      let client: Nestling;
      try {
        client = await getOrCreateClient(token);
      } catch {
        return new Response(
          JSON.stringify({ error: "Authentication failed. Check your Nestling API token." }),
          {
            status: 401,
            headers: {
              "Content-Type": "application/json",
              "WWW-Authenticate": `Bearer error="invalid_token", error_description="Authentication failed", resource_metadata="${resourceMetadataUrl}"`,
            },
          },
        );
      }

      const mcpServer = createServer(client);
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless — no session tracking
      });

      await mcpServer.connect(transport);
      return transport.handleRequest(req);
    }

    return new Response("Not Found", { status: 404 });
  },
};
