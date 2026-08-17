import React from "react";
import {
  Activity, LogOut, LayoutGrid, AlertTriangle, Wrench, FileText,
  Plus, Trash2, Check, Loader2, RefreshCw, Send, ChevronDown, ChevronUp,
} from "lucide-react";
import type { Status } from "./statusData";
import * as api from "./api";
import type {
  EditableService, ServiceGroupRow, IncidentRow, IncidentUpdateRow,
  MaintenanceRow, Template, IncidentState, MaintenanceState,
} from "./api";
import { TelegramComposer, escHtml, parseAffected } from "./TelegramComposer";
import type { TelegramTarget } from "./TelegramComposer";
import "./styles.css";
import "./dashboard.css";

const STATUS_OPTIONS: Status[] = ["operational", "beta", "degraded", "partial", "major", "maintenance"];
const STATUS_LABELS: Record<Status, string> = {
  operational: "Operational",
  beta: "Beta",
  degraded: "Degraded",
  partial: "Partial Outage",
  major: "Major Outage",
  maintenance: "Maintenance",
};
const INCIDENT_STATES: IncidentState[] = ["investigating", "monitoring", "resolved"];
const MAINTENANCE_STATES: MaintenanceState[] = ["scheduled", "in_progress", "completed"];

function nowTime() {
  return new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}
function todayDate() {
  return new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}
function parseData(json: string): any {
  try { return JSON.parse(json); } catch { return {}; }
}

// --- Telegram draft generators (kept in Dashboard so the composer stays
// target-agnostic). Each returns Telegram-compatible HTML for a fresh draft. ---

const INCIDENT_STATE_META: Record<string, { emoji: string; label: string; blurb: (svc: string) => string }> = {
  investigating: { emoji: "🔴", label: "Investigating", blurb: (s) => `We're investigating an issue affecting ${s}.` },
  identified:    { emoji: "🟠", label: "Identified",    blurb: (s) => `We've identified the cause of the current ${s} issue and are working on a fix.` },
  monitoring:    { emoji: "🟡", label: "Monitoring",    blurb: (s) => `A fix has been deployed for the ${s} issue and we're monitoring recovery.` },
  resolved:      { emoji: "🟢", label: "Resolved",      blurb: (s) => `The ${s} issue has been resolved and service is operating normally.` },
};

function draftForIncidentUpdate(incident: IncidentRow, update: IncidentUpdateRow): string {
  const key = (update.label || incident.state || "investigating").toLowerCase().trim();
  const meta = INCIDENT_STATE_META[key] ?? INCIDENT_STATE_META[incident.state] ?? INCIDENT_STATE_META.investigating;
  const affected = parseAffected(incident.affected);
  const service = affected[0] ?? "Vox";
  const body = (update.message ?? "").trim() || meta.blurb(service);
  return `${meta.emoji} <b>${escHtml(service)} — ${escHtml(meta.label)}</b>\n${escHtml(body)}`;
}

const MAINTENANCE_STATE_META: Record<string, { emoji: string; label: string; blurb: (svc: string) => string }> = {
  scheduled:   { emoji: "🛠️", label: "Scheduled maintenance", blurb: (s) => `Scheduled maintenance for ${s} is planned. Brief interruptions may occur during the window.` },
  in_progress: { emoji: "🔧", label: "Maintenance in progress", blurb: (s) => `Maintenance on ${s} is now in progress. Brief interruptions may occur.` },
  completed:   { emoji: "✅", label: "Maintenance completed", blurb: (s) => `Maintenance on ${s} is complete. Service is operating normally.` },
};

function draftForMaintenance(m: MaintenanceRow): string {
  const meta = MAINTENANCE_STATE_META[m.state] ?? MAINTENANCE_STATE_META.scheduled;
  const affected = parseAffected(m.affected);
  const service = affected[0] ?? "Vox";
  const title = (m.title ?? "").trim() || meta.label;
  const bodyLine = (m.body ?? "").trim() || meta.blurb(service);
  const windowLine =
    m.window_start || m.window_end
      ? `\n<i>${escHtml([m.window_start, m.window_end].filter(Boolean).join(" → "))}</i>`
      : "";
  return `${meta.emoji} <b>${escHtml(title)}</b>${windowLine}\n${escHtml(bodyLine)}`;
}

// ---------------------------------------------------------------------------
// Root: auth gate
// ---------------------------------------------------------------------------

export function Dashboard() {
  const [authed, setAuthed] = React.useState<boolean | null>(null);

  React.useEffect(() => {
    api.getSession().then((r) => setAuthed(r.authenticated)).catch(() => setAuthed(false));
  }, []);

  if (authed === null) {
    return <div className="dash-loading"><Loader2 className="spin" size={22} /> Loading…</div>;
  }
  if (!authed) return <Login onSuccess={() => setAuthed(true)} />;
  return <DashboardApp onLogout={() => setAuthed(false)} />;
}

function Login({ onSuccess }: { onSuccess: () => void }) {
  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError("");
    try {
      await api.login(password);
      onSuccess();
    } catch {
      setError("Incorrect password.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="dash-auth">
      <form className="side-card dash-login" onSubmit={submit}>
        <span className="brand-mark"><Activity size={19} /></span>
        <h1>Vox Status Dashboard</h1>
        <p>Sign in to post updates.</p>
        <input
          type="password"
          placeholder="Dashboard password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoFocus
        />
        {error && <div className="dash-error">{error}</div>}
        <button className="dash-btn primary" disabled={busy || !password}>
          {busy ? <Loader2 className="spin" size={16} /> : null} Sign in
        </button>
      </form>
    </main>
  );
}

// ---------------------------------------------------------------------------
// App shell + tabs
// ---------------------------------------------------------------------------

type Tab = "services" | "incidents" | "maintenance" | "templates";
const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: "services", label: "Services", icon: <LayoutGrid size={16} /> },
  { id: "incidents", label: "Incidents", icon: <AlertTriangle size={16} /> },
  { id: "maintenance", label: "Maintenance", icon: <Wrench size={16} /> },
  { id: "templates", label: "Templates", icon: <FileText size={16} /> },
];

function DashboardApp({ onLogout }: { onLogout: () => void }) {
  const [tab, setTab] = React.useState<Tab>("services");
  const [toast, setToast] = React.useState<string>("");

  const notify = React.useCallback((message: string) => {
    setToast(message);
    window.clearTimeout((notify as any)._t);
    (notify as any)._t = window.setTimeout(() => setToast(""), 2600);
  }, []);

  async function doLogout() {
    try { await api.logout(); } catch { /* ignore */ }
    onLogout();
  }

  return (
    <main className="dash">
      <header className="site-header">
        <a className="brand" href="/" aria-label="Vox status home">
          <span className="brand-mark"><Activity size={19} /></span>
          <span>Vox Dashboard</span>
        </a>
        <button className="dash-btn ghost" onClick={doLogout}><LogOut size={15} /> Sign out</button>
      </header>

      <nav className="dash-tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={`dash-tab ${tab === t.id ? "active" : ""}`}
            onClick={() => setTab(t.id)}
          >
            {t.icon}<span>{t.label}</span>
          </button>
        ))}
      </nav>

      <div className="dash-body">
        {tab === "services" && <ServicesPanel notify={notify} />}
        {tab === "incidents" && <IncidentsPanel notify={notify} />}
        {tab === "maintenance" && <MaintenancePanel notify={notify} />}
        {tab === "templates" && <TemplatesPanel notify={notify} />}
      </div>

      {toast && <div className="dash-toast"><Check size={15} /> {toast}</div>}
    </main>
  );
}

type PanelProps = { notify: (m: string) => void };

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

function ServicesPanel({ notify }: PanelProps) {
  const [services, setServices] = React.useState<EditableService[]>([]);
  const [groups, setGroups] = React.useState<ServiceGroupRow[]>([]);
  const [templates, setTemplates] = React.useState<Template[]>([]);
  const [loading, setLoading] = React.useState(true);

  const load = React.useCallback(async () => {
    setLoading(true);
    const [s, t] = await Promise.all([api.getServices(), api.getTemplates("service")]);
    setServices(s.services); setGroups(s.groups); setTemplates(t.templates);
    setLoading(false);
  }, []);
  React.useEffect(() => { load(); }, [load]);

  async function setStatus(svc: EditableService, status: Status) {
    setServices((prev) => prev.map((x) => (x.id === svc.id ? { ...x, status } : x)));
    await api.updateService(svc.id, { status });
    notify(`${svc.name} → ${STATUS_LABELS[status]}`);
  }
  async function setUptime(svc: EditableService, uptime: string) {
    await api.updateService(svc.id, { uptime });
    notify(`${svc.name} uptime saved`);
  }

  if (loading) return <PanelLoading />;

  return (
    <div className="panel">
      <PanelHeader title="Services" subtitle="Tap a status to publish it instantly." onRefresh={load} />
      {groups.map((g) => (
        <section className="dash-group" key={g.id}>
          <h3 className="dash-group-title">{g.title}</h3>
          <div className="dash-card-list">
            {services.filter((s) => s.group_id === g.id).map((svc) => (
              <div className="dash-service" key={svc.id}>
                <div className="dash-service-name">
                  <span className={`status-dot status-${svc.status}`} />
                  <div>
                    <strong>{svc.name}</strong>
                    <p>{svc.description}</p>
                  </div>
                </div>
                <div className="dash-status-row">
                  {STATUS_OPTIONS.map((opt) => (
                    <button
                      key={opt}
                      className={`status-chip status-${opt} ${svc.status === opt ? "on" : ""}`}
                      onClick={() => setStatus(svc, opt)}
                    >
                      {STATUS_LABELS[opt]}
                    </button>
                  ))}
                  <input
                    className="dash-uptime"
                    defaultValue={svc.uptime}
                    onBlur={(e) => e.target.value !== svc.uptime && setUptime(svc, e.target.value)}
                    aria-label={`${svc.name} uptime`}
                  />
                </div>
                {templates.length > 0 && (
                  <div className="dash-template-chips">
                    {templates.map((tpl) => {
                      const d = parseData(tpl.data);
                      return (
                        <button key={tpl.id} className="tpl-chip" onClick={() => setStatus(svc, d.status)}>
                          {tpl.name}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Incidents
// ---------------------------------------------------------------------------

function IncidentsPanel({ notify }: PanelProps) {
  const [incidents, setIncidents] = React.useState<IncidentRow[]>([]);
  const [updates, setUpdates] = React.useState<IncidentUpdateRow[]>([]);
  const [templates, setTemplates] = React.useState<Template[]>([]);
  const [services, setServices] = React.useState<EditableService[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [creating, setCreating] = React.useState(false);

  const [statusUrl, setStatusUrl] = React.useState<string>("");

  const load = React.useCallback(async () => {
    setLoading(true);
    const [i, t, s, snap] = await Promise.all([
      api.getIncidents(),
      api.getTemplates("incident"),
      api.getServices(),
      // Snapshot is public and cheap; we only read settings.status_url from it.
      api.getStatus().catch(() => null),
    ]);
    setIncidents(i.incidents); setUpdates(i.updates); setTemplates(t.templates); setServices(s.services);
    const url = snap?.settings?.status_url;
    setStatusUrl(url && url.trim() ? url : (typeof window !== "undefined" ? window.location.origin : ""));
    setLoading(false);
  }, []);
  React.useEffect(() => { load(); }, [load]);

  if (loading) return <PanelLoading />;

  return (
    <div className="panel">
      <PanelHeader
        title="Incidents"
        subtitle="Open a new incident, post updates, and publish each update to Telegram."
        onRefresh={load}
        action={<button className="dash-btn primary" onClick={() => setCreating((v) => !v)}><Plus size={15} /> New incident</button>}
      />

      {creating && (
        <NewIncidentForm
          templates={templates}
          services={services}
          onCancel={() => setCreating(false)}
          onCreated={async () => { setCreating(false); await load(); notify("Incident published"); }}
        />
      )}

      <div className="dash-card-list">
        {incidents.length === 0 && <EmptyState text="No incidents yet." />}
        {incidents.map((inc) => (
          <IncidentEditor
            key={inc.id}
            incident={inc}
            updates={updates.filter((u) => u.incident_id === inc.id)}
            templates={templates}
            statusUrl={statusUrl}
            onChanged={load}
            notify={notify}
          />
        ))}
      </div>
    </div>
  );
}

function NewIncidentForm({
  templates, services, onCancel, onCreated,
}: {
  templates: Template[];
  services: EditableService[];
  onCancel: () => void;
  onCreated: () => void;
}) {
  const [title, setTitle] = React.useState("");
  const [state, setState] = React.useState<IncidentState>("investigating");
  const [message, setMessage] = React.useState("");
  const [label, setLabel] = React.useState("Investigating");
  const [affected, setAffected] = React.useState<string[]>([]);
  const [busy, setBusy] = React.useState(false);

  function applyTemplate(tpl: Template) {
    const d = parseData(tpl.data);
    if (d.state) setState(d.state);
    if (d.label) setLabel(d.label);
    if (d.message) setMessage(d.message);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.createIncident({
        title, state, date: todayDate(), affected,
        update: message ? { label, time: nowTime(), message } : undefined,
      });
      onCreated();
    } finally { setBusy(false); }
  }

  return (
    <form className="side-card dash-form" onSubmit={submit}>
      <div className="dash-template-chips">
        {templates.map((tpl) => (
          <button type="button" key={tpl.id} className="tpl-chip" onClick={() => applyTemplate(tpl)}>{tpl.name}</button>
        ))}
      </div>
      <label>Title<input value={title} onChange={(e) => setTitle(e.target.value)} required placeholder="e.g. Scheduled posting delays" /></label>
      <div className="dash-form-row">
        <label>State
          <select value={state} onChange={(e) => setState(e.target.value as IncidentState)}>
            {INCIDENT_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <label>Update label<input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Investigating" /></label>
      </div>
      <label>Affected services
        <div className="dash-checks">
          {services.map((s) => (
            <label key={s.id} className="dash-check">
              <input
                type="checkbox"
                checked={affected.includes(s.name)}
                onChange={(e) => setAffected((prev) => e.target.checked ? [...prev, s.name] : prev.filter((n) => n !== s.name))}
              />
              {s.name}
            </label>
          ))}
        </div>
      </label>
      <label>First update<textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={3} placeholder="What's happening?" /></label>
      <div className="dash-form-actions">
        <button type="button" className="dash-btn ghost" onClick={onCancel}>Cancel</button>
        <button className="dash-btn primary" disabled={busy || !title}>{busy ? <Loader2 className="spin" size={15} /> : null} Publish incident</button>
      </div>
    </form>
  );
}

function IncidentEditor({
  incident, updates, templates, statusUrl, onChanged, notify,
}: {
  incident: IncidentRow;
  updates: IncidentUpdateRow[];
  templates: Template[];
  statusUrl: string;
  onChanged: () => void;
  notify: (m: string) => void;
}) {
  // Which update rows currently have their Telegram composer expanded.
  const [openTg, setOpenTg] = React.useState<Set<number>>(() => new Set());
  const toggleTg = (id: number) => setOpenTg((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const [message, setMessage] = React.useState("");
  const [label, setLabel] = React.useState("Update");
  const [state, setState] = React.useState<IncidentState>(incident.state);
  const [busy, setBusy] = React.useState(false);

  function applyTemplate(tpl: Template) {
    const d = parseData(tpl.data);
    if (d.state) setState(d.state);
    if (d.label) setLabel(d.label);
    if (d.message) setMessage(d.message);
  }

  async function postUpdate() {
    if (!message) return;
    setBusy(true);
    try {
      await api.postIncidentUpdate(incident.id, { label, time: nowTime(), message, state });
      setMessage("");
      await onChanged();
      notify("Update posted");
    } finally { setBusy(false); }
  }

  async function remove() {
    await api.deleteIncident(incident.id);
    await onChanged();
    notify("Incident deleted");
  }

  return (
    <div className="side-card dash-incident">
      <div className="dash-incident-head">
        <div>
          <span className={`incident-state ${incident.state}`}>{incident.state}</span>
          <h3>{incident.title}</h3>
          <p>{incident.date}</p>
        </div>
        <button className="dash-icon-btn" onClick={remove} aria-label="Delete incident"><Trash2 size={15} /></button>
      </div>

      <div className="incident-timeline">
        {updates.map((u) => {
          const sent = u.telegram_message_id != null;
          const open = openTg.has(u.id);
          return (
            <div className="timeline-item" key={u.id}>
              <span className="timeline-dot" />
              <div style={{ flex: 1 }}>
                <div className="timeline-heading"><strong>{u.label}</strong><span>{u.time}</span></div>
                <p>{u.message}</p>
                <div className="tg-row">
                  <span className={`tg-badge ${sent ? "tg-badge-on" : "tg-badge-off"}`}>
                    {sent ? "✓ Telegram sent" : "○ Telegram not sent"}
                  </span>
                  <button
                    type="button"
                    className="dash-btn ghost tg-toggle"
                    onClick={() => toggleTg(u.id)}
                  >
                    <Send size={13} />
                    {sent
                      ? (open ? "Hide Telegram editor" : "Edit Telegram post")
                      : (open ? "Hide Telegram composer" : "Compose Telegram post")}
                    {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                  </button>
                </div>
                {open && (
                  <TelegramComposer
                    target={{
                      key: `incident-update-${u.id}`,
                      generateDraft: () => draftForIncidentUpdate(incident, u),
                      existing: {
                        html: u.telegram_html,
                        message_id: u.telegram_message_id,
                        sent_at: u.telegram_sent_at,
                        edited_at: u.telegram_edited_at,
                        button_text: u.telegram_button_text,
                        button_url: u.telegram_button_url,
                      },
                      save: (html, btn) => api.saveTelegramDraft(incident.id, u.id, html, btn),
                      send: (html, btn) => api.sendTelegramUpdate(incident.id, u.id, html, btn),
                      edit: (html, btn) => api.editTelegramUpdate(incident.id, u.id, html, btn),
                    }}
                    statusUrl={statusUrl}
                    onChanged={onChanged}
                    notify={notify}
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="dash-update-box">
        <div className="dash-template-chips">
          {templates.map((tpl) => (
            <button type="button" key={tpl.id} className="tpl-chip" onClick={() => applyTemplate(tpl)}>{tpl.name}</button>
          ))}
        </div>
        <div className="dash-form-row">
          <label>Label<input value={label} onChange={(e) => setLabel(e.target.value)} /></label>
          <label>New state
            <select value={state} onChange={(e) => setState(e.target.value as IncidentState)}>
              {INCIDENT_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
        </div>
        <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={2} placeholder="Post an update…" />
        <div className="dash-form-actions">
          <button className="dash-btn primary" onClick={postUpdate} disabled={busy || !message}>
            {busy ? <Loader2 className="spin" size={15} /> : null} Post update
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Maintenance
// ---------------------------------------------------------------------------

function MaintenancePanel({ notify }: PanelProps) {
  const [items, setItems] = React.useState<MaintenanceRow[]>([]);
  const [templates, setTemplates] = React.useState<Template[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [creating, setCreating] = React.useState(false);
  const [statusUrl, setStatusUrl] = React.useState<string>("");
  const [openTg, setOpenTg] = React.useState<Set<number>>(() => new Set());
  const toggleTg = (id: number) => setOpenTg((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const load = React.useCallback(async () => {
    setLoading(true);
    const [m, t, snap] = await Promise.all([
      api.getMaintenance(),
      api.getTemplates("maintenance"),
      api.getStatus().catch(() => null),
    ]);
    setItems(m.maintenance); setTemplates(t.templates);
    const url = snap?.settings?.status_url;
    setStatusUrl(url && url.trim() ? url : (typeof window !== "undefined" ? window.location.origin : ""));
    setLoading(false);
  }, []);
  React.useEffect(() => { load(); }, [load]);

  async function remove(id: number) { await api.deleteMaintenance(id); await load(); notify("Maintenance removed"); }
  async function setState(id: number, state: MaintenanceState) { await api.updateMaintenance(id, { state }); await load(); notify("Status updated"); }

  if (loading) return <PanelLoading />;

  return (
    <div className="panel">
      <PanelHeader
        title="Scheduled maintenance"
        subtitle="Announce maintenance windows on the status page and publish each one to Telegram."
        onRefresh={load}
        action={<button className="dash-btn primary" onClick={() => setCreating((v) => !v)}><Plus size={15} /> New window</button>}
      />
      {creating && (
        <NewMaintenanceForm
          templates={templates}
          onCancel={() => setCreating(false)}
          onCreated={async () => { setCreating(false); await load(); notify("Maintenance scheduled"); }}
        />
      )}
      <div className="dash-card-list">
        {items.length === 0 && <EmptyState text="No maintenance scheduled." />}
        {items.map((m) => {
          const sent = m.telegram_message_id != null;
          const open = openTg.has(m.id);
          const target: TelegramTarget = {
            key: `maintenance-${m.id}`,
            generateDraft: () => draftForMaintenance(m),
            existing: {
              html: m.telegram_html,
              message_id: m.telegram_message_id,
              sent_at: m.telegram_sent_at,
              edited_at: m.telegram_edited_at,
              button_text: m.telegram_button_text,
              button_url: m.telegram_button_url,
            },
            save: (html, btn) => api.saveMaintenanceTelegramDraft(m.id, html, btn),
            send: (html, btn) => api.sendMaintenanceTelegram(m.id, html, btn),
            edit: (html, btn) => api.editMaintenanceTelegram(m.id, html, btn),
          };
          return (
            <div className="side-card dash-incident" key={m.id}>
              <div className="dash-incident-head">
                <div>
                  <span className={`incident-state ${m.state === "completed" ? "resolved" : m.state === "in_progress" ? "monitoring" : "investigating"}`}>{m.state.replace("_", " ")}</span>
                  <h3>{m.title}</h3>
                  {(m.window_start || m.window_end) && <p>{[m.window_start, m.window_end].filter(Boolean).join(" → ")}</p>}
                </div>
                <button className="dash-icon-btn" onClick={() => remove(m.id)} aria-label="Delete"><Trash2 size={15} /></button>
              </div>
              {m.body && <p className="dash-muted">{m.body}</p>}
              <div className="dash-status-row">
                {MAINTENANCE_STATES.map((s) => (
                  <button key={s} className={`status-chip ${m.state === s ? "on" : ""}`} onClick={() => setState(m.id, s)}>{s.replace("_", " ")}</button>
                ))}
              </div>
              <div className="tg-row">
                <span className={`tg-badge ${sent ? "tg-badge-on" : "tg-badge-off"}`}>
                  {sent ? "✓ Telegram sent" : "○ Telegram not sent"}
                </span>
                <button
                  type="button"
                  className="dash-btn ghost tg-toggle"
                  onClick={() => toggleTg(m.id)}
                >
                  <Send size={13} />
                  {sent
                    ? (open ? "Hide Telegram editor" : "Edit Telegram post")
                    : (open ? "Hide Telegram composer" : "Compose Telegram post")}
                  {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                </button>
              </div>
              {open && (
                <TelegramComposer
                  target={target}
                  statusUrl={statusUrl}
                  onChanged={load}
                  notify={notify}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function NewMaintenanceForm({
  templates, onCancel, onCreated,
}: {
  templates: Template[];
  onCancel: () => void;
  onCreated: () => void;
}) {
  const [title, setTitle] = React.useState("");
  const [body, setBody] = React.useState("");
  const [start, setStart] = React.useState("");
  const [end, setEnd] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  function applyTemplate(tpl: Template) {
    const d = parseData(tpl.data);
    if (d.title) setTitle(d.title);
    if (d.body) setBody(d.body);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.createMaintenance({ title, body, window_start: start || null, window_end: end || null, state: "scheduled" });
      onCreated();
    } finally { setBusy(false); }
  }

  return (
    <form className="side-card dash-form" onSubmit={submit}>
      <div className="dash-template-chips">
        {templates.map((tpl) => (
          <button type="button" key={tpl.id} className="tpl-chip" onClick={() => applyTemplate(tpl)}>{tpl.name}</button>
        ))}
      </div>
      <label>Title<input value={title} onChange={(e) => setTitle(e.target.value)} required placeholder="e.g. Database maintenance" /></label>
      <div className="dash-form-row">
        <label>Window start<input value={start} onChange={(e) => setStart(e.target.value)} placeholder="Jul 30, 2:00 AM UTC" /></label>
        <label>Window end<input value={end} onChange={(e) => setEnd(e.target.value)} placeholder="Jul 30, 3:00 AM UTC" /></label>
      </div>
      <label>Details<textarea value={body} onChange={(e) => setBody(e.target.value)} rows={3} placeholder="What will happen during this window?" /></label>
      <div className="dash-form-actions">
        <button type="button" className="dash-btn ghost" onClick={onCancel}>Cancel</button>
        <button className="dash-btn primary" disabled={busy || !title}>{busy ? <Loader2 className="spin" size={15} /> : null} Schedule</button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

const TEMPLATE_TYPES: { id: "incident" | "maintenance" | "service"; label: string }[] = [
  { id: "incident", label: "Incident updates" },
  { id: "maintenance", label: "Maintenance" },
  { id: "service", label: "Service status" },
];

function TemplatesPanel({ notify }: PanelProps) {
  const [templates, setTemplates] = React.useState<Template[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [creating, setCreating] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    const t = await api.getTemplates();
    setTemplates(t.templates); setLoading(false);
  }, []);
  React.useEffect(() => { load(); }, [load]);

  async function remove(id: number) { await api.deleteTemplate(id); await load(); notify("Template deleted"); }

  if (loading) return <PanelLoading />;

  return (
    <div className="panel">
      <PanelHeader
        title="Templates"
        subtitle="Reusable messages you can apply with one tap when posting."
        onRefresh={load}
        action={<button className="dash-btn primary" onClick={() => setCreating((v) => !v)}><Plus size={15} /> New template</button>}
      />
      {creating && (
        <NewTemplateForm onCancel={() => setCreating(false)} onCreated={async () => { setCreating(false); await load(); notify("Template saved"); }} />
      )}
      {TEMPLATE_TYPES.map((tt) => {
        const list = templates.filter((t) => t.type === tt.id);
        return (
          <section className="dash-group" key={tt.id}>
            <h3 className="dash-group-title">{tt.label}</h3>
            <div className="dash-card-list">
              {list.length === 0 && <EmptyState text="No templates in this category." />}
              {list.map((tpl) => {
                const d = parseData(tpl.data);
                return (
                  <div className="side-card dash-template-row" key={tpl.id}>
                    <div>
                      <strong>{tpl.name}</strong>
                      <p className="dash-muted">{d.message || d.body || (d.status ? `Set status → ${d.status}` : "")}</p>
                    </div>
                    <button className="dash-icon-btn" onClick={() => remove(tpl.id)} aria-label="Delete template"><Trash2 size={15} /></button>
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function NewTemplateForm({ onCancel, onCreated }: { onCancel: () => void; onCreated: () => void }) {
  const [type, setType] = React.useState<"incident" | "maintenance" | "service">("incident");
  const [name, setName] = React.useState("");
  const [label, setLabel] = React.useState("Investigating");
  const [message, setMessage] = React.useState("");
  const [state, setState] = React.useState("investigating");
  const [status, setStatus] = React.useState<Status>("degraded");
  const [busy, setBusy] = React.useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    let data: Record<string, unknown> = {};
    if (type === "incident") data = { state, label, message };
    else if (type === "maintenance") data = { state: "scheduled", title: name, body: message };
    else data = { status };
    try {
      await api.createTemplate({ type, name, data });
      onCreated();
    } finally { setBusy(false); }
  }

  return (
    <form className="side-card dash-form" onSubmit={submit}>
      <div className="dash-form-row">
        <label>Type
          <select value={type} onChange={(e) => setType(e.target.value as any)}>
            {TEMPLATE_TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
        </label>
        <label>Name<input value={name} onChange={(e) => setName(e.target.value)} required placeholder="Template name" /></label>
      </div>

      {type === "incident" && (
        <>
          <div className="dash-form-row">
            <label>Label<input value={label} onChange={(e) => setLabel(e.target.value)} /></label>
            <label>State
              <select value={state} onChange={(e) => setState(e.target.value)}>
                {INCIDENT_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
          </div>
          <label>Message<textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={3} /></label>
        </>
      )}
      {type === "maintenance" && (
        <label>Body<textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={3} /></label>
      )}
      {type === "service" && (
        <label>Status
          <select value={status} onChange={(e) => setStatus(e.target.value as Status)}>
            {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
          </select>
        </label>
      )}

      <div className="dash-form-actions">
        <button type="button" className="dash-btn ghost" onClick={onCancel}>Cancel</button>
        <button className="dash-btn primary" disabled={busy || !name}>{busy ? <Loader2 className="spin" size={15} /> : null} Save template</button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

function PanelHeader({
  title, subtitle, onRefresh, action,
}: {
  title: string; subtitle: string; onRefresh: () => void; action?: React.ReactNode;
}) {
  return (
    <div className="panel-header">
      <div>
        <h2>{title}</h2>
        <p>{subtitle}</p>
      </div>
      <div className="panel-header-actions">
        <button className="dash-icon-btn" onClick={onRefresh} aria-label="Refresh"><RefreshCw size={15} /></button>
        {action}
      </div>
    </div>
  );
}

function PanelLoading() {
  return <div className="dash-loading"><Loader2 className="spin" size={20} /> Loading…</div>;
}
function EmptyState({ text }: { text: string }) {
  return <div className="dash-empty">{text}</div>;
}
