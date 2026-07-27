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
      env.DB.prepare("SELECT incident_id, label, time, message FROM incident_updates ORDER BY sort_order, id").all(),
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
      .map((u) => ({ label: u.label as string, time: u.time as string, message: u.message as string })),
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
      "SELECT id, incident_id, label, time, message, sort_order FROM incident_updates ORDER BY sort_order, id",
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
