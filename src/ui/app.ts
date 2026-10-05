/**
 * Nestling plugin UI: the day view (inline card and sidebar app) and the
 * quick-log panel. Framework-free; bundled into the worker by scripts/build-ui.ts.
 */
import { App, applyDocumentTheme, applyHostFonts, applyHostStyleVariables, type McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import { OpenAIExtensions } from "@openai/mcp-extensions/app";
import type { DaySummary, TimelineItem } from "../daySummary.js";

type View = "day" | "log";
type FormKind = "feed" | "sleep" | "nappy";

const view: View = document.documentElement.dataset.view === "log" ? "log" : "day";
const root = document.getElementById("root")!;

const app = new App({ name: "nestling", version: "1.0.0" });
new OpenAIExtensions(app);

const state: {
  summary: DaySummary | null;
  loading: boolean;
  problem: { title: string; body: string; signIn?: boolean } | null;
  form: FormKind | null;
  saving: boolean;
  toast: { text: string; error?: boolean } | null;
} = { summary: null, loading: true, problem: null, form: null, saving: false, toast: null };

let toastTimer: ReturnType<typeof setTimeout> | undefined;

// ── DOM helper ──

type Child = Node | string | null | undefined | false;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...children: (Child | Child[])[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2), value as EventListener);
    else if (key === "class") el.className = String(value);
    else el.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    el.append(child);
  }
  return el;
}

// ── Time formatting (always in the summary's time zone) ──

function zone(): string {
  return state.summary?.timezone ?? app.getHostContext()?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function locale(): string | undefined {
  return app.getHostContext()?.locale;
}

function clock(iso: string): string {
  return new Intl.DateTimeFormat(locale(), { hour: "numeric", minute: "2-digit", timeZone: zone() }).format(new Date(iso));
}

function dayLabel(s: DaySummary): string {
  if (s.isToday) return "Today";
  const [y, m, d] = s.date.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d, 12));
  return new Intl.DateTimeFormat(locale(), { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(date);
}

function duration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function since(iso: string): string {
  const minutes = Math.max(0, (Date.now() - new Date(iso).getTime()) / 60000);
  return minutes < 1 ? "just now" : `${duration(minutes)} ago`;
}

/** "YYYY-MM-DDTHH:mm" for a datetime-local input, in the summary's time zone. */
function localInput(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: zone(), year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}

function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

// ── Server calls ──

function readResult(result: { isError?: boolean; structuredContent?: Record<string, unknown>; content?: { type: string; text?: string }[]; _meta?: Record<string, unknown> }) {
  if (result.isError) {
    if (result._meta?.["mcp/www_authenticate"]) throw Object.assign(new Error("Sign in to Nestling to continue."), { signIn: true });
    const message = (result.structuredContent?.message as string | undefined) ?? result.content?.find((c) => c.type === "text")?.text ?? "Something went wrong.";
    throw new Error(message);
  }
  return result.structuredContent;
}

async function load(args: { babyId?: string; date?: string } = {}) {
  state.loading = true;
  render();
  try {
    const result = await app.callServerTool({ name: "open_dashboard", arguments: { ...args, timezone: zone() } });
    showSummary(readResult(result) as unknown as DaySummary);
  } catch (e) {
    showProblem(e);
  }
}

function showSummary(summary: DaySummary, justLogged?: string) {
  state.summary = summary;
  state.loading = false;
  state.problem = null;
  render();
  shareWithModel(justLogged);
}

function showProblem(e: unknown) {
  state.loading = false;
  const err = e as Error & { signIn?: boolean };
  // Keep the day on screen if one is already showing; just explain what failed.
  if (state.summary && !err.signIn) {
    flash(err.message, true);
    render();
    return;
  }
  if (err.signIn) state.problem = { title: "Sign in to Nestling", body: "Connect your Nestling account to see your baby's day.", signIn: true };
  else if (/no babies/i.test(err.message)) state.problem = { title: "No baby yet", body: "Add your baby in the Nestling app, then come back here." };
  else state.problem = { title: "Couldn't load your day", body: err.message };
  render();
}

function flash(text: string, error = false) {
  state.toast = { text, error };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    state.toast = null;
    render();
  }, 4000);
}

/** Tell ChatGPT what the user is looking at, so follow-up questions have context. */
function shareWithModel(justLogged?: string) {
  const s = state.summary;
  if (!s) return;
  const t = s.totals;
  const text =
    `The user is viewing ${s.baby.name}'s day in Nestling: ${s.date} (${s.timezone}). ` +
    `Sleep ${duration(t.sleepMinutes)} across ${t.sleeps} sleeps; ${t.feeds} feeds` +
    (t.bottleMl ? ` (${t.bottleMl} ml by bottle)` : "") +
    `; ${t.nappies} nappies (${t.wetNappies} wet, ${t.dirtyNappies} dirty). babyId: ${s.baby.id}.` +
    (justLogged ? ` The user just logged this here: ${justLogged}.` : "");
  app.updateModelContext({ content: [{ type: "text", text }] }).catch(() => {});
}

// ── Logging ──

async function submit(kind: FormKind, form: HTMLFormElement) {
  const s = state.summary;
  if (!s || state.saving) return;
  const data = new FormData(form);
  const text = (name: string) => String(data.get(name) ?? "").trim();
  const notes = text("notes") || undefined;
  let name: string;
  let args: Record<string, unknown>;
  let done: string;

  if (kind === "feed") {
    const type = text("type");
    const amount = Number(text("amountMl"));
    const minutes = Number(text("minutes"));
    name = "create_feed";
    args = {
      timestamp: text("at"),
      type,
      amountMl: type === "Bottle" && amount > 0 ? amount : undefined,
      durationSeconds: type === "Breastfeeding" && minutes > 0 ? Math.round(minutes * 60) : undefined,
      side: type === "Breastfeeding" && text("side") ? text("side") : undefined,
      notes,
    };
    done = type === "Bottle" && amount > 0 ? `Bottle logged: ${amount} ml` : "Feed logged";
  } else if (kind === "sleep") {
    if (text("end") <= text("start")) {
      flash("The sleep must end after it starts.", true);
      render();
      return;
    }
    name = "create_sleep";
    args = { start: text("start"), end: text("end"), notes };
    done = "Sleep logged";
  } else {
    name = "create_nappy";
    args = { timestamp: text("at"), type: text("type"), notes };
    done = `${text("type") === "Both" ? "Wet and dirty" : text("type")} nappy logged`;
  }

  state.saving = true;
  render();
  try {
    // Form times are wall-clock times in the summary's zone; the server resolves them.
    readResult(await app.callServerTool({ name, arguments: { babyId: s.baby.id, timezone: s.timezone, ...args } }));
    state.form = null;
    flash(done);
    const refreshed = readResult(await app.callServerTool({ name: "open_dashboard", arguments: { babyId: s.baby.id, date: s.isToday ? undefined : s.date, timezone: s.timezone } }));
    showSummary(refreshed as unknown as DaySummary, done);
  } catch (e) {
    flash((e as Error).message, true);
  } finally {
    state.saving = false;
    render();
  }
}

// ── Rendering ──

function segmented(name: string, options: [string, string][], selected: string, onPick?: (value: string) => void) {
  const input = h("input", { type: "hidden", name, value: selected });
  const buttons = options.map(([value, label]) =>
    h("button", {
      type: "button",
      class: "btn",
      "aria-pressed": String(value === selected),
      onclick: (e: Event) => {
        input.value = value;
        for (const b of buttons) b.setAttribute("aria-pressed", String(b === e.currentTarget));
        onPick?.(value);
      },
    }, label),
  );
  return h("div", { class: "segmented", role: "group" }, input, ...buttons);
}

function field(label: string, control: HTMLElement) {
  const id = `f-${Math.random().toString(36).slice(2, 8)}`;
  control.id = id;
  return h("div", { class: "field" }, h("label", { class: "form-label text-small", for: id }, label), control);
}

function timeInput(name: string, value: Date) {
  return h("input", { class: "form-control", type: "datetime-local", name, value: localInput(value), max: localInput(new Date()), required: true });
}

function notesInput() {
  return field("Notes (optional)", h("input", { class: "form-control", name: "notes", maxlength: 500, autocomplete: "off" }));
}

function renderForm(kind: FormKind) {
  const now = new Date();
  const body: HTMLElement[] = [];

  if (kind === "feed") {
    const extra = h("div", { class: "fields" });
    const showExtra = (type: string) => {
      extra.replaceChildren();
      if (type === "Bottle") extra.append(field("Amount (ml)", h("input", { class: "form-control", type: "number", name: "amountMl", min: 0, max: 5000, step: 5, inputmode: "numeric" })));
      if (type === "Breastfeeding") {
        extra.append(
          field("Minutes", h("input", { class: "form-control", type: "number", name: "minutes", min: 0, max: 360, inputmode: "numeric" })),
          h("div", { class: "field" }, h("span", { class: "form-label text-small" }, "Side"), segmented("side", [["Left", "Left"], ["Right", "Right"], ["Both", "Both"]], "")),
        );
      }
    };
    showExtra("Bottle");
    body.push(
      segmented("type", [["Bottle", "Bottle"], ["Breastfeeding", "Breast"], ["Solids", "Solids"]], "Bottle", showExtra),
      h("div", { class: "fields" }, field("When", timeInput("at", now))),
      extra,
    );
  } else if (kind === "sleep") {
    body.push(
      h("p", { class: "text-small text-muted" }, "Log a sleep that has ended."),
      h("div", { class: "fields" }, field("Fell asleep", timeInput("start", new Date(now.getTime() - 60 * 60000))), field("Woke up", timeInput("end", now))),
    );
  } else {
    body.push(segmented("type", [["Wet", "Wet"], ["Dirty", "Dirty"], ["Both", "Both"]], "Wet"), h("div", { class: "fields" }, field("When", timeInput("at", now))));
  }

  const titles: Record<FormKind, string> = { feed: "Log a feed", sleep: "Log a sleep", nappy: "Log a nappy" };
  return h("form", {
    class: "card",
    onsubmit: (e: Event) => {
      e.preventDefault();
      void submit(kind, e.currentTarget as HTMLFormElement);
    },
  },
    h("h3", {}, titles[kind]),
    ...body,
    notesInput(),
    h("div", { class: "row" },
      h("button", { type: "submit", class: "btn btn-primary", disabled: state.saving }, state.saving ? "Saving…" : "Save"),
      h("button", { type: "button", class: "btn btn-ghost", onclick: () => { state.form = null; render(); } }, "Cancel"),
    ),
  );
}

function renderHeader(s: DaySummary) {
  const babyControl = s.babies.length > 1
    ? h("select", {
        class: "form-select baby-select",
        "aria-label": "Baby",
        onchange: (e: Event) => void load({ babyId: (e.target as HTMLSelectElement).value, date: s.isToday ? undefined : s.date }),
      }, ...s.babies.map((b) => {
        const option = h("option", { value: b.id }, b.name);
        option.selected = b.id === s.baby.id;
        return option;
      }))
    : h("h2", {}, s.baby.name);

  const showNav = view === "day";
  return h("div", { class: "row spread wrap" },
    h("div", { class: "title" }, babyControl, view === "log" && h("span", { class: "text-small text-muted" }, "Today so far")),
    showNav && h("div", { class: "row date-nav" },
      h("button", { class: "btn btn-ghost", "aria-label": "Previous day", onclick: () => void load({ babyId: s.baby.id, date: shiftDate(s.date, -1) }) }, "‹"),
      h("span", { "aria-live": "polite" }, dayLabel(s)),
      h("button", { class: "btn btn-ghost", "aria-label": "Next day", disabled: s.isToday, onclick: () => void load({ babyId: s.baby.id, date: shiftDate(s.date, 1) }) }, "›"),
      !s.isToday && h("button", { class: "btn", onclick: () => void load({ babyId: s.baby.id }) }, "Today"),
    ),
  );
}

function stat(kind: string, label: string, value: string, note: string) {
  return h("div", { class: `card stat ${kind}` }, h("span", { class: "text-small text-muted" }, label), h("span", { class: "value" }, value), h("span", { class: "text-small text-muted" }, note));
}

function renderStats(s: DaySummary) {
  const t = s.totals;
  const feedNote = [t.bottleMl ? `${t.bottleMl} ml bottle` : "", t.breastfeedMinutes ? `${duration(t.breastfeedMinutes)} breast` : ""].filter(Boolean).join(" · ");
  const tiles = [
    stat("sleep", "Sleep", duration(t.sleepMinutes), t.sleeps === 1 ? "1 sleep" : `${t.sleeps} sleeps`),
    stat("feed", "Feeds", String(t.feeds), feedNote || (t.solids ? `${t.solids} solids` : " ")),
    stat("nappy", "Nappies", String(t.nappies), `${t.wetNappies} wet · ${t.dirtyNappies} dirty`),
  ];
  if (s.isToday && s.lastFeedAt) tiles.push(stat("feed", "Last feed", since(s.lastFeedAt), clock(s.lastFeedAt)));
  return h("div", { class: "stats" }, ...tiles);
}

function renderActions() {
  const pick = (kind: FormKind) => () => {
    state.form = state.form === kind ? null : kind;
    render();
    document.querySelector<HTMLElement>("form .btn[aria-pressed='true'], form input")?.focus();
  };
  return h("div", { class: `actions ${view === "log" ? "log-actions" : ""}` },
    h("button", { class: "btn feed", "aria-pressed": String(state.form === "feed"), onclick: pick("feed") }, h("span", { class: "dot" }), "Feed"),
    h("button", { class: "btn sleep", "aria-pressed": String(state.form === "sleep"), onclick: pick("sleep") }, h("span", { class: "dot" }), "Sleep"),
    h("button", { class: "btn nappy", "aria-pressed": String(state.form === "nappy"), onclick: pick("nappy") }, h("span", { class: "dot" }), "Nappy"),
  );
}

function renderItem(item: TimelineItem) {
  const detail = item.kind === "sleep" && item.end ? `${item.detail} · until ${clock(item.end)}` : item.detail;
  return h("li", { class: item.kind },
    h("span", { class: "time" }, clock(item.at)),
    h("span", { class: "dot", "aria-hidden": "true" }),
    h("span", { class: "what" }, h("span", {}, item.label), detail && h("span", { class: "detail" }, ` · ${detail}`), item.notes && h("span", { class: "notes text-small" }, item.notes)),
  );
}

function renderTimeline(s: DaySummary, limit?: number) {
  if (s.timeline.length === 0) {
    return h("div", { class: "card empty" }, s.isToday ? "Nothing logged yet today." : "Nothing logged on this day.");
  }
  // Newest first, so the latest entries are always in view.
  const items = [...s.timeline].reverse();
  const shown = limit ? items.slice(0, limit) : items;
  return h("div", { class: "card" },
    h("ul", { class: "timeline", "aria-label": "Timeline" }, ...shown.map(renderItem)),
    !!limit && items.length > limit && h("p", { class: "text-small text-muted" }, `${items.length - limit} earlier ${items.length - limit === 1 ? "entry" : "entries"}`),
  );
}

function render() {
  const mode = app.getHostContext()?.displayMode ?? "inline";
  document.documentElement.dataset.mode = mode;
  const s = state.summary;

  if (state.problem && (!s || state.problem.signIn)) {
    root.replaceChildren(
      h("div", { class: "card message" },
        h("h3", {}, state.problem.title),
        h("p", { class: "text-muted" }, state.problem.body),
        !state.problem.signIn && h("button", { class: "btn", onclick: () => void load() }, "Try again"),
      ),
    );
    return;
  }

  if (!s) {
    root.replaceChildren(h("div", { class: "skeleton" }), h("div", { class: "skeleton" }));
    return;
  }

  const compact = view === "day" && mode === "inline";
  // Hosts that do not list their modes are assumed to allow full screen
  const canExpand = app.getHostContext()?.availableDisplayModes?.includes("fullscreen") ?? true;
  root.setAttribute("aria-busy", String(state.loading));
  root.replaceChildren(...h("div", {},
    renderHeader(s),
    state.toast && h("div", { class: `toast ${state.toast.error ? "error" : ""}`, role: "status" }, state.toast.text),
    // The panel exists to log things, so its buttons come first.
    view === "log" && renderActions(),
    view === "log" && state.form && renderForm(state.form),
    renderStats(s),
    view === "day" && s.isToday && renderActions(),
    view === "day" && state.form && renderForm(state.form),
    renderTimeline(s, compact ? 4 : view === "log" ? 6 : undefined),
    compact && canExpand && h("button", { class: "btn", onclick: () => void app.requestDisplayMode({ mode: "fullscreen" }).then(render).catch(() => {}) }, "Open full view"),
  ).childNodes);
}

// ── Host wiring ──

function applyHost(ctx: Partial<McpUiHostContext> | undefined) {
  if (!ctx) return;
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
  if (ctx.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
}

let gotResult = false;
app.ontoolresult = (params) => {
  gotResult = true;
  try {
    const summary = readResult(params as Parameters<typeof readResult>[0]);
    if (summary && "baby" in summary) showSummary(summary as unknown as DaySummary);
  } catch (e) {
    showProblem(e);
  }
};
app.onhostcontextchanged = (ctx) => {
  applyHost(ctx);
  render();
};

render();
await app.connect();
applyHost(app.getHostContext());
render();
// Hosts send the opening tool result right after connecting; load it ourselves if none arrives.
setTimeout(() => {
  if (!gotResult && !state.summary) void load();
}, 1500);
