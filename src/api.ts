// Frontend API client for the Vox status Worker.
// Types reuse the shapes originally defined in statusData.ts.

import type { ServiceGroup, Status, IncidentUpdate } from "./statusData";

export type IncidentState = "investigating" | "monitoring" | "resolved";
export type MaintenanceState = "scheduled" | "in_progress" | "completed";

export type Incident = {
  id: number;
  title: string;
  state: IncidentState;
  date: string;
  affected: string[];
  updates: IncidentUpdate[];
};

export type Maintenance = {
  id: number;
  title: string;
  body: string;
  windowStart: string | null;
  windowEnd: string | null;
  state: MaintenanceState;
  affected: string[];
};

export type Snapshot = {
  serviceGroups: ServiceGroup[];
  incidents: Incident[];
  maintenance: Maintenance[];
  settings: Record<string, string>;
  updatedAt: number;
};

export type Template = {
  id: number;
  type: "incident" | "maintenance" | "service";
  name: string;
  data: string; // JSON string
};

async function req<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.json())?.error ?? "";
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, detail || res.statusText);
  }
  return (await res.json()) as T;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

// --- Public ---
export const getStatus = () => req<Snapshot>("/api/status");

// --- Auth ---
export const login = (password: string) =>
  req<{ ok: true }>("/api/login", { method: "POST", body: JSON.stringify({ password }) });
export const logout = () => req<{ ok: true }>("/api/logout", { method: "POST" });
export const getSession = () => req<{ authenticated: boolean }>("/api/session");

// --- Services ---
export type EditableService = {
  id: number;
  group_id: number;
  name: string;
  description: string;
  status: Status;
  uptime: string;
  sort_order: number;
};
export type ServiceGroupRow = { id: number; title: string };

export const getServices = () =>
  req<{ services: EditableService[]; groups: ServiceGroupRow[] }>("/api/services");
export const createService = (body: Partial<EditableService>) =>
  req<{ ok: true; id: number }>("/api/services", { method: "POST", body: JSON.stringify(body) });
export const updateService = (id: number, body: Partial<EditableService>) =>
  req<{ ok: true }>(`/api/services/${id}`, { method: "PATCH", body: JSON.stringify(body) });
export const deleteService = (id: number) =>
  req<{ ok: true }>(`/api/services/${id}`, { method: "DELETE" });

// --- Incidents ---
export type IncidentRow = { id: number; title: string; state: IncidentState; date: string; affected: string };
export type IncidentUpdateRow = {
  id: number;
  incident_id: number;
  label: string;
  time: string;
  message: string;
  sort_order: number;
  // Per-update Telegram publishing state. telegram_html is the composed
  // (server-stored) draft/last-sent content; the other fields describe
  // whether it has been sent to the channel yet and when it last changed.
  telegram_html: string | null;
  telegram_message_id: number | null;
  telegram_sent_at: number | null;
  telegram_edited_at: number | null;
  // Optional inline-keyboard button (text + url) sent alongside the message.
  telegram_button_text: string | null;
  telegram_button_url: string | null;
};

export const getIncidents = () =>
  req<{ incidents: IncidentRow[]; updates: IncidentUpdateRow[] }>("/api/incidents");
export const createIncident = (body: {
  title: string;
  state?: IncidentState;
  date?: string;
  affected?: string[];
  update?: { label?: string; time?: string; message: string };
}) => req<{ ok: true; id: number }>("/api/incidents", { method: "POST", body: JSON.stringify(body) });
export const updateIncident = (id: number, body: Record<string, unknown>) =>
  req<{ ok: true }>(`/api/incidents/${id}`, { method: "PATCH", body: JSON.stringify(body) });
export const deleteIncident = (id: number) =>
  req<{ ok: true }>(`/api/incidents/${id}`, { method: "DELETE" });
export const postIncidentUpdate = (
  id: number,
  body: { label?: string; time?: string; message: string; state?: IncidentState },
) => req<{ ok: true }>(`/api/incidents/${id}/updates`, { method: "POST", body: JSON.stringify(body) });

// --- Telegram (per incident update) ---
// The bot token / channel id live server-side; these endpoints proxy through
// the Worker so the browser never sees Telegram credentials.
export type TelegramButton = {
  telegram_button_text?: string | null;
  telegram_button_url?: string | null;
};

export const saveTelegramDraft = (
  incidentId: number, updateId: number, telegram_html: string, button: TelegramButton = {},
) =>
  req<{ ok: true }>(`/api/incidents/${incidentId}/updates/${updateId}/telegram`, {
    method: "PATCH",
    body: JSON.stringify({ telegram_html, ...button }),
  });

export const sendTelegramUpdate = (
  incidentId: number, updateId: number, telegram_html: string, button: TelegramButton = {},
) =>
  req<{ ok: true; telegram_message_id: number; telegram_sent_at: number }>(
    `/api/incidents/${incidentId}/updates/${updateId}/telegram/send`,
    { method: "POST", body: JSON.stringify({ telegram_html, ...button }) },
  );

export const editTelegramUpdate = (
  incidentId: number, updateId: number, telegram_html: string, button: TelegramButton = {},
) =>
  req<{ ok: true; telegram_edited_at: number }>(
    `/api/incidents/${incidentId}/updates/${updateId}/telegram/edit`,
    { method: "POST", body: JSON.stringify({ telegram_html, ...button }) },
  );

// --- Maintenance ---
export type MaintenanceRow = {
  id: number;
  title: string;
  body: string;
  window_start: string | null;
  window_end: string | null;
  state: MaintenanceState;
  affected: string;
};
export const getMaintenance = () => req<{ maintenance: MaintenanceRow[] }>("/api/maintenance");
export const createMaintenance = (body: {
  title: string;
  body?: string;
  window_start?: string | null;
  window_end?: string | null;
  state?: MaintenanceState;
  affected?: string[];
}) => req<{ ok: true; id: number }>("/api/maintenance", { method: "POST", body: JSON.stringify(body) });
export const updateMaintenance = (id: number, body: Record<string, unknown>) =>
  req<{ ok: true }>(`/api/maintenance/${id}`, { method: "PATCH", body: JSON.stringify(body) });
export const deleteMaintenance = (id: number) =>
  req<{ ok: true }>(`/api/maintenance/${id}`, { method: "DELETE" });

// --- Templates ---
export const getTemplates = (type?: string) =>
  req<{ templates: Template[] }>(`/api/templates${type ? `?type=${type}` : ""}`);
export const createTemplate = (body: { type: string; name: string; data: unknown }) =>
  req<{ ok: true; id: number }>("/api/templates", { method: "POST", body: JSON.stringify(body) });
export const deleteTemplate = (id: number) =>
  req<{ ok: true }>(`/api/templates/${id}`, { method: "DELETE" });
