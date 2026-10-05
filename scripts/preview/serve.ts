/**
 * Preview the plugin UI without ChatGPT: bun run preview:ui, then open
 * http://localhost:5174/?view=day (also: view=log, mode=fullscreen, theme=dark,
 * babies=0|2, auth=none, tz=America/New_York).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerNestlingTools } from "../../src/mcp/tools.js";

const root = new URL("../..", import.meta.url).pathname;

/** Read a UI resource straight from the real server definition. */
async function readResource(view: string): Promise<string> {
  const server = new McpServer({ name: "preview", version: "0" });
  registerNestlingTools(server, { client: null, issuer: "http://localhost:5174" });
  const uri = `ui://nestling/${view === "log" ? "log" : "day"}-v1.html`;
  const registered = (server as unknown as { _registeredResources: Record<string, { readCallback: (u: URL, extra: unknown) => Promise<{ contents: { text: string }[] }> }> })._registeredResources[uri];
  const result = await registered.readCallback(new URL(uri), {});
  return result.contents[0].text;
}

const built = await Bun.build({ entrypoints: [`${root}scripts/preview/host.ts`], target: "browser", format: "esm" });
if (!built.success) {
  for (const l of built.logs) console.error(l);
  process.exit(1);
}
const hostJs = await built.outputs[0].text();

const page = `<!doctype html><html><head><meta charset="utf-8"><title>Nestling preview</title><style>
body{margin:0;font-family:system-ui;background:#f4f4f4;display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:16px;padding:16px;min-height:100vh;box-sizing:border-box}
body[data-theme=dark]{background:#0d0d0d;color:#eee}
iframe{border:1px solid #ccc4;border-radius:16px;width:100%;background:transparent}
iframe.inline{max-width:720px;height:420px}iframe.fullscreen{height:calc(100vh - 32px)}
pre{font-size:11px;white-space:pre-wrap;margin:0;overflow:auto;max-height:calc(100vh - 32px)}
</style></head><body><iframe id="app" sandbox="allow-scripts allow-forms" title="Nestling app"></iframe><pre id="log"></pre><script type="module">${hostJs.replace(/<\/script/gi, "<\\/script")}</script></body></html>`;

Bun.serve({
  port: 5174,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/resource") {
      let html = await readResource(url.searchParams.get("view") ?? "day");
      if (url.searchParams.has("debug")) html = html.replace("<head>", `<head><script>const dbg=(...a)=>parent.postMessage({debug:a.map(String).join(" ")},"*");addEventListener("message",e=>{if(!e.data.debug)dbg("APP GOT",JSON.stringify(e.data).slice(0,300))});addEventListener("error",e=>dbg("APP ERROR",e.message));addEventListener("unhandledrejection",e=>dbg("APP REJECT",e.reason&&e.reason.stack||e.reason))</script>`);
      return new Response(html, { headers: { "Content-Type": "text/html" } });
    }
    return new Response(page, { headers: { "Content-Type": "text/html" } });
  },
});
console.log("Preview on http://localhost:5174/?view=day");
