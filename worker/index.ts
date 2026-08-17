/**
 * Vox Status Page — Cloudflare Worker API
 *
 * Public:
 *   GET  /api/status                 full public snapshot (service groups, incidents, maintenance, meta)
 *
 * Auth:
 *   POST /api/login                  { password } -> sets httpOnly session cookie
 *   POST /api/logout
 *   GET  /api/session                { authenticated: boolean }
 *
 * Protected (require a valid session cookie):
 *   GET/POST/PATCH/DELETE  /api/services            (+ /api/services/reorder is not needed; sort_order set on write)
 *   GET/POST/PATCH/DELETE  /api/incidents
 *   POST                   /api/incidents/:id/updates
 *   GET/POST/PATCH/DELETE  /api/maintenance
 *   GET/POST/DELETE        /api/templates
 *
 * Everything that is not /api/* is served from the static Vite build (SPA fallback).
 */

export interface Env {
  DB: D1Database;
  SESSIONS: KVNamespace;
  ASSETS: Fetcher;
  DASHBOARD_PASSWORD: string;
  // Telegram publishing — reused from the existing Vox bot. All Telegram API
  // calls happen server-side; these values are never returned to the client.
  BOT_TOKEN?: string;
  TELEGRAM_CHANNEL_ID?: string;
}

type Status = "operational" | "beta" | "degraded" | "partial" | "major" | "maintenance";

const SESSION_COOKIE = "vox_session";
const SESSION_TTL_SECONDS = 60 * 60 * 12; // 12 hours

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...(init.headers || {}),
    },
  });
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

function sessionCookie(token: string, maxAge: number): string {
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
    `Max-Age=${maxAge}`,
  ].join("; ");
}

// Constant-time-ish string comparison to avoid trivial timing leaks.
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

async function isAuthed(request: Request, env: Env): Promise<boolean> {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return false;
  const found = await env.SESSIONS.get(`session:${token}`);
  return found !== null;
}

function parseJsonArray(value: string): string[] {
  try {
    const v = JSON.parse(value);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

async function readBody<T = Record<string, unknown>>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    return {} as T;
  }
}

// ---------------------------------------------------------------------------
// Telegram Bot API — server-side only. The bot token and channel id live in
// the Worker environment (secrets in production, .dev.vars locally) and are
// never returned to the browser.
// ---------------------------------------------------------------------------

type TelegramResult =
  | { ok: true; messageId: number }
  | { ok: false; error: string };

// Telegram channel/supergroup ids are conventionally prefixed with `-100`.
// The value stored in .env is the raw numeric id; normalize it here so the
// user can paste either form.
function normalizeChatId(raw: string | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("-100") || trimmed.startsWith("@")) return trimmed;
  if (trimmed.startsWith("-")) return trimmed;
  // Bare numeric id for a channel: prepend the -100 marker.
  if (/^\d+$/.test(trimmed)) return `-100${trimmed}`;
  return trimmed;
}

async function telegramApi(
  env: Env,
  method: "sendMessage" | "editMessageText",
  body: Record<string, unknown>,
): Promise<TelegramResult> {
  const token = env.BOT_TOKEN;
  const chatId = normalizeChatId(env.TELEGRAM_CHANNEL_ID);
  if (!token) return { ok: false, error: "BOT_TOKEN is not configured on the server." };
  if (!chatId) return { ok: false, error: "TELEGRAM_CHANNEL_ID is not configured on the server." };

  const payload = { chat_id: chatId, parse_mode: "HTML", ...body };
  let res: Response;
  try {
    res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    return { ok: false, error: `Network error: ${String(err)}` };
  }

  let data: any = null;
  try { data = await res.json(); } catch { /* ignore */ }
  if (!res.ok || !data?.ok) {
    const description = data?.description ?? `HTTP ${res.status}`;
    return { ok: false, error: String(description) };
  }
  const messageId = data.result?.message_id;
  if (typeof messageId !== "number") {
    return { ok: false, error: "Telegram did not return a message id." };
  }
  return { ok: true, messageId };
}

function telegramSend(env: Env, html: string, disableLinkPreview: boolean): Promise<TelegramResult> {
  return telegramApi(env, "sendMessage", {
    text: html,
    link_preview_options: { is_disabled: disableLinkPreview },
  });
}

function telegramEdit(env: Env, messageId: number, html: string, disableLinkPreview: boolean): Promise<TelegramResult> {
  return telegramApi(env, "editMessageText", {
    message_id: messageId,
    text: html,
    link_preview_options: { is_disabled: disableLinkPreview },
  });
}

// ---------------------------------------------------------------------------
// Public snapshot
// ---------------------------------------------------------------------------

async function buildSnapshot(env: Env) {
  const [groupRows, serviceRows, incidentRows, updateRows, maintRows, settingRows] =
    await Promise.all([
      env.DB.prepare("SELECT id, title FROM service_groups ORDER BY sort_order, id").all(),
      env.DB.prepare(
        "SELECT id, group_id, name, description, status, uptime FROM services ORDER BY group_id, sort_order, id",
      ).all(),
      env.DB.prepare("SELECT id, title, state, date, affected FROM incidents ORDER BY created_at DESC, id DESC").all(),
      env.DB.prepare(
        "SELECT id, incident_id, label, time, message, telegram_message_id, telegram_sent_at, telegram_edited_at FROM incident_updates ORDER BY sort_order, id",
      ).all(),
      env.DB.prepare(
        "SELECT id, title, body, window_start, window_end, state, affected FROM maintenance ORDER BY created_at DESC, id DESC",
      ).all(),
      env.DB.prepare("SELECT key, value FROM settings").all(),
    ]);

  const groups = (groupRows.results as any[]).map((g) => ({
    title: g.title as string,
    services: (serviceRows.results as any[])
      .filter((s) => s.group_id === g.id)
      .map((s) => ({
        name: s.name as string,
        description: s.description as string,
        status: s.status as Status,
        uptime: s.uptime as string,
      })),
  }));

  const incidents = (incidentRows.results as any[]).map((i) => ({
    id: i.id as number,
    title: i.title as string,
    state: i.state as string,
    date: i.date as string,
    affected: parseJsonArray(i.affected as string),
    updates: (updateRows.results as any[])
      .filter((u) => u.incident_id === i.id)
      .map((u) => ({
        id: u.id as number,
        label: u.label as string,
        time: u.time as string,
        message: u.message as string,
        // Only publish whether Telegram was sent + when. Never expose the raw
        // Telegram HTML, message id, or bot token on the public snapshot.
        telegramSent: u.telegram_message_id != null,
        telegramSentAt: (u.telegram_sent_at as number | null) ?? null,
        telegramEditedAt: (u.telegram_edited_at as number | null) ?? null,
      })),
  }));

  const maintenance = (maintRows.results as any[]).map((m) => ({
    id: m.id as number,
    title: m.title as string,
    body: m.body as string,
    windowStart: m.window_start as string | null,
    windowEnd: m.window_end as string | null,
    state: m.state as string,
    affected: parseJsonArray(m.affected as string),
  }));

  const settings: Record<string, string> = {};
  for (const row of settingRows.results as any[]) settings[row.key] = row.value;

  return { serviceGroups: groups, incidents, maintenance, settings, updatedAt: Date.now() };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname.replace(/\/+$/, ""); // trim trailing slash
  const method = request.method.toUpperCase();

  // --- Public ---
  if (path === "/api/status" && method === "GET") {
    return json(await buildSnapshot(env));
  }

  // --- Auth ---
  if (path === "/api/login" && method === "POST") {
    const { password } = await readBody<{ password?: string }>(request);
    if (!password || !env.DASHBOARD_PASSWORD || !safeEqual(password, env.DASHBOARD_PASSWORD)) {
      return json({ error: "Invalid password" }, { status: 401 });
    }
    const token = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, "");
    await env.SESSIONS.put(`session:${token}`, "1", { expirationTtl: SESSION_TTL_SECONDS });
    return json({ ok: true }, { headers: { "set-cookie": sessionCookie(token, SESSION_TTL_SECONDS) } });
  }

  if (path === "/api/logout" && method === "POST") {
    const token = readCookie(request, SESSION_COOKIE);
    if (token) await env.SESSIONS.delete(`session:${token}`);
    return json({ ok: true }, { headers: { "set-cookie": sessionCookie("", 0) } });
  }

  if (path === "/api/session" && method === "GET") {
    return json({ authenticated: await isAuthed(request, env) });
  }

  // --- Everything below requires auth ---
  if (!(await isAuthed(request, env))) {
    return json({ error: "Unauthorized" }, { status: 401 });
  }

  // --- Services ---
  if (path === "/api/services" && method === "GET") {
    const rows = await env.DB.prepare(
      "SELECT id, group_id, name, description, status, uptime, sort_order FROM services ORDER BY group_id, sort_order, id",
    ).all();
    const groups = await env.DB.prepare("SELECT id, title FROM service_groups ORDER BY sort_order, id").all();
    return json({ services: rows.results, groups: groups.results });
  }

  if (path === "/api/services" && method === "POST") {
    const b = await readBody<any>(request);
    const res = await env.DB.prepare(
      "INSERT INTO services (group_id, name, description, status, uptime, sort_order) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind(b.group_id, b.name, b.description ?? "", b.status ?? "operational", b.uptime ?? "100%", b.sort_order ?? 0)
      .run();
    return json({ ok: true, id: res.meta.last_row_id });
  }

  const serviceMatch = path.match(/^\/api\/services\/(\d+)$/);
  if (serviceMatch && method === "PATCH") {
    const id = Number(serviceMatch[1]);
    const b = await readBody<any>(request);
    const fields: string[] = [];
    const values: unknown[] = [];
    for (const key of ["name", "description", "status", "uptime", "group_id", "sort_order"]) {
      if (key in b) {
        fields.push(`${key} = ?`);
        values.push(b[key]);
      }
    }
    if (fields.length === 0) return json({ error: "No fields to update" }, { status: 400 });
    values.push(id);
    await env.DB.prepare(`UPDATE services SET ${fields.join(", ")} WHERE id = ?`).bind(...values).run();
    return json({ ok: true });
  }

  if (serviceMatch && method === "DELETE") {
    await env.DB.prepare("DELETE FROM services WHERE id = ?").bind(Number(serviceMatch[1])).run();
    return json({ ok: true });
  }

  // --- Incidents ---
  if (path === "/api/incidents" && method === "GET") {
    const incidents = await env.DB.prepare(
      "SELECT id, title, state, date, affected, created_at FROM incidents ORDER BY created_at DESC, id DESC",
    ).all();
    const updates = await env.DB.prepare(
      "SELECT id, incident_id, label, time, message, sort_order, telegram_html, telegram_message_id, telegram_sent_at, telegram_edited_at FROM incident_updates ORDER BY sort_order, id",
    ).all();
    return json({ incidents: incidents.results, updates: updates.results });
  }

  if (path === "/api/incidents" && method === "POST") {
    const b = await readBody<any>(request);
    const affected = JSON.stringify(Array.isArray(b.affected) ? b.affected : []);
    const res = await env.DB.prepare(
      "INSERT INTO incidents (title, state, date, affected) VALUES (?, ?, ?, ?)",
    )
      .bind(b.title, b.state ?? "investigating", b.date ?? "", affected)
      .run();
    const incidentId = res.meta.last_row_id;
    // Optional first update posted alongside the incident.
    if (b.update && b.update.message) {
      await env.DB.prepare(
        "INSERT INTO incident_updates (incident_id, label, time, message, sort_order) VALUES (?, ?, ?, ?, 0)",
      )
        .bind(incidentId, b.update.label ?? "Investigating", b.update.time ?? "", b.update.message)
        .run();
    }
    return json({ ok: true, id: incidentId });
  }

  const incidentMatch = path.match(/^\/api\/incidents\/(\d+)$/);
  if (incidentMatch && method === "PATCH") {
    const id = Number(incidentMatch[1]);
    const b = await readBody<any>(request);
    const fields: string[] = [];
    const values: unknown[] = [];
    if ("title" in b) { fields.push("title = ?"); values.push(b.title); }
    if ("state" in b) { fields.push("state = ?"); values.push(b.state); }
    if ("date" in b) { fields.push("date = ?"); values.push(b.date); }
    if ("affected" in b) { fields.push("affected = ?"); values.push(JSON.stringify(Array.isArray(b.affected) ? b.affected : [])); }
    if (fields.length === 0) return json({ error: "No fields to update" }, { status: 400 });
    values.push(id);
    await env.DB.prepare(`UPDATE incidents SET ${fields.join(", ")} WHERE id = ?`).bind(...values).run();
    return json({ ok: true });
  }

  if (incidentMatch && method === "DELETE") {
    await env.DB.prepare("DELETE FROM incidents WHERE id = ?").bind(Number(incidentMatch[1])).run();
    return json({ ok: true });
  }

  // Post an update to an incident. Newest update sorts to the top (sort_order 0), others shift down.
  const updateMatch = path.match(/^\/api\/incidents\/(\d+)\/updates$/);
  if (updateMatch && method === "POST") {
    const incidentId = Number(updateMatch[1]);
    const b = await readBody<any>(request);
    if (!b.message) return json({ error: "message is required" }, { status: 400 });
    await env.DB.prepare("UPDATE incident_updates SET sort_order = sort_order + 1 WHERE incident_id = ?")
      .bind(incidentId).run();
    await env.DB.prepare(
      "INSERT INTO incident_updates (incident_id, label, time, message, sort_order) VALUES (?, ?, ?, ?, 0)",
    )
      .bind(incidentId, b.label ?? "Update", b.time ?? "", b.message)
      .run();
    // Advancing the update usually advances the incident state too.
    if (b.state) {
      await env.DB.prepare("UPDATE incidents SET state = ? WHERE id = ?").bind(b.state, incidentId).run();
    }
    return json({ ok: true });
  }

  // --- Telegram publishing (per incident update) ---
  //
  // All Telegram Bot API traffic is proxied here. The client never sees
  // BOT_TOKEN or TELEGRAM_CHANNEL_ID and cannot craft direct sendMessage
  // calls; it can only ask the dashboard to (a) save a draft against a
  // known update id, (b) send that draft, or (c) edit an already-sent
  // message. Auth is enforced by the isAuthed() gate above.
  const tgSaveMatch = path.match(/^\/api\/incidents\/(\d+)\/updates\/(\d+)\/telegram$/);
  if (tgSaveMatch && method === "PATCH") {
    const updateId = Number(tgSaveMatch[2]);
    const b = await readBody<{ telegram_html?: string }>(request);
    if (typeof b.telegram_html !== "string") {
      return json({ error: "telegram_html is required" }, { status: 400 });
    }
    await env.DB.prepare("UPDATE incident_updates SET telegram_html = ? WHERE id = ?")
      .bind(b.telegram_html, updateId).run();
    return json({ ok: true });
  }

  const tgSendMatch = path.match(/^\/api\/incidents\/(\d+)\/updates\/(\d+)\/telegram\/send$/);
  if (tgSendMatch && method === "POST") {
    const updateId = Number(tgSendMatch[2]);
    const b = await readBody<{ telegram_html?: string; disable_link_preview?: boolean }>(request);
    const html = (b.telegram_html ?? "").trim();
    if (!html) return json({ error: "Telegram message is empty." }, { status: 400 });
    if (html.length > 4096) return json({ error: "Telegram message exceeds 4096 characters." }, { status: 400 });

    const existing = await env.DB.prepare(
      "SELECT id, telegram_message_id FROM incident_updates WHERE id = ?",
    ).bind(updateId).first<{ id: number; telegram_message_id: number | null }>();
    if (!existing) return json({ error: "Update not found." }, { status: 404 });
    if (existing.telegram_message_id != null) {
      return json({ error: "This update has already been sent to Telegram. Use edit instead." }, { status: 409 });
    }

    const tg = await telegramSend(env, html, b.disable_link_preview ?? true);
    if (!tg.ok) return json({ error: `Telegram: ${tg.error}` }, { status: 502 });

    const sentAt = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      "UPDATE incident_updates SET telegram_html = ?, telegram_message_id = ?, telegram_sent_at = ?, telegram_edited_at = NULL WHERE id = ?",
    ).bind(html, tg.messageId, sentAt, updateId).run();

    return json({ ok: true, telegram_message_id: tg.messageId, telegram_sent_at: sentAt });
  }

  const tgEditMatch = path.match(/^\/api\/incidents\/(\d+)\/updates\/(\d+)\/telegram\/edit$/);
  if (tgEditMatch && method === "POST") {
    const updateId = Number(tgEditMatch[2]);
    const b = await readBody<{ telegram_html?: string; disable_link_preview?: boolean }>(request);
    const html = (b.telegram_html ?? "").trim();
    if (!html) return json({ error: "Telegram message is empty." }, { status: 400 });
    if (html.length > 4096) return json({ error: "Telegram message exceeds 4096 characters." }, { status: 400 });

    const existing = await env.DB.prepare(
      "SELECT telegram_message_id FROM incident_updates WHERE id = ?",
    ).bind(updateId).first<{ telegram_message_id: number | null }>();
    if (!existing) return json({ error: "Update not found." }, { status: 404 });
    if (existing.telegram_message_id == null) {
      return json({ error: "This update has not been sent to Telegram yet." }, { status: 409 });
    }

    const tg = await telegramEdit(env, existing.telegram_message_id, html, b.disable_link_preview ?? true);
    if (!tg.ok) return json({ error: `Telegram: ${tg.error}` }, { status: 502 });

    const editedAt = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      "UPDATE incident_updates SET telegram_html = ?, telegram_edited_at = ? WHERE id = ?",
    ).bind(html, editedAt, updateId).run();

    return json({ ok: true, telegram_edited_at: editedAt });
  }

  // --- Maintenance ---
  if (path === "/api/maintenance" && method === "GET") {
    const rows = await env.DB.prepare(
      "SELECT id, title, body, window_start, window_end, state, affected, created_at FROM maintenance ORDER BY created_at DESC, id DESC",
    ).all();
    return json({ maintenance: rows.results });
  }

  if (path === "/api/maintenance" && method === "POST") {
    const b = await readBody<any>(request);
    const affected = JSON.stringify(Array.isArray(b.affected) ? b.affected : []);
    const res = await env.DB.prepare(
      "INSERT INTO maintenance (title, body, window_start, window_end, state, affected) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind(b.title, b.body ?? "", b.window_start ?? null, b.window_end ?? null, b.state ?? "scheduled", affected)
      .run();
    return json({ ok: true, id: res.meta.last_row_id });
  }

  const maintMatch = path.match(/^\/api\/maintenance\/(\d+)$/);
  if (maintMatch && method === "PATCH") {
    const id = Number(maintMatch[1]);
    const b = await readBody<any>(request);
    const fields: string[] = [];
    const values: unknown[] = [];
    for (const key of ["title", "body", "window_start", "window_end", "state"]) {
      if (key in b) { fields.push(`${key} = ?`); values.push(b[key]); }
    }
    if ("affected" in b) { fields.push("affected = ?"); values.push(JSON.stringify(Array.isArray(b.affected) ? b.affected : [])); }
    if (fields.length === 0) return json({ error: "No fields to update" }, { status: 400 });
    values.push(id);
    await env.DB.prepare(`UPDATE maintenance SET ${fields.join(", ")} WHERE id = ?`).bind(...values).run();
    return json({ ok: true });
  }

  if (maintMatch && method === "DELETE") {
    await env.DB.prepare("DELETE FROM maintenance WHERE id = ?").bind(Number(maintMatch[1])).run();
    return json({ ok: true });
  }

  // --- Templates ---
  if (path === "/api/templates" && method === "GET") {
    const type = url.searchParams.get("type");
    const stmt = type
      ? env.DB.prepare("SELECT id, type, name, data FROM templates WHERE type = ? ORDER BY name").bind(type)
      : env.DB.prepare("SELECT id, type, name, data FROM templates ORDER BY type, name");
    const rows = await stmt.all();
    return json({ templates: rows.results });
  }

  if (path === "/api/templates" && method === "POST") {
    const b = await readBody<any>(request);
    if (!b.type || !b.name) return json({ error: "type and name are required" }, { status: 400 });
    const data = typeof b.data === "string" ? b.data : JSON.stringify(b.data ?? {});
    const res = await env.DB.prepare("INSERT INTO templates (type, name, data) VALUES (?, ?, ?)")
      .bind(b.type, b.name, data)
      .run();
    return json({ ok: true, id: res.meta.last_row_id });
  }

  const templateMatch = path.match(/^\/api\/templates\/(\d+)$/);
  if (templateMatch && method === "DELETE") {
    await env.DB.prepare("DELETE FROM templates WHERE id = ?").bind(Number(templateMatch[1])).run();
    return json({ ok: true });
  }

  return json({ error: "Not found" }, { status: 404 });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(request, env, url);
      } catch (err) {
        return json({ error: "Server error", detail: String(err) }, { status: 500 });
      }
    }
    // Static assets + SPA fallback (configured in wrangler.toml).
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
