import React from "react";
import ReactDOM from "react-dom/client";
import { Activity, Check, ChevronDown, Clock3, ExternalLink, ShieldCheck } from "lucide-react";
import { incidents, serviceGroups, type Incident, type Status } from "./statusData";
import "./styles.css";

const statusLabels: Record<Status, string> = {
  operational: "Operational",
  degraded: "Degraded Performance",
  partial: "Partial Outage",
  major: "Major Outage",
  maintenance: "Maintenance"
};

function statusClass(status: Status) {
  return `status-${status}`;
}

function StatusDot({ status }: { status: Status }) {
  return <span className={`status-dot ${statusClass(status)}`} aria-hidden="true" />;
}

function ServiceRow({ name, description, status, uptime }: { name: string; description: string; status: Status; uptime: string }) {
  return (
    <div className="service-row">
      <div className="service-main">
        <StatusDot status={status} />
        <div>
          <h3>{name}</h3>
          <p>{description}</p>
        </div>
      </div>
      <div className="service-meta">
        <span className="uptime">{uptime} uptime</span>
        <span className={`status-label ${statusClass(status)}`}>{statusLabels[status]}</span>
      </div>
    </div>
  );
}

function IncidentCard({ incident }: { incident: Incident }) {
  return (
    <details className="incident-card">
      <summary>
        <div>
          <span className={`incident-state ${incident.state}`}>{incident.state}</span>
          <h3>{incident.title}</h3>
          <p>{incident.date} · {incident.affected.join(", ")}</p>
        </div>
        <ChevronDown size={20} />
      </summary>
      <div className="incident-timeline">
        {incident.updates.map((update) => (
          <div className="timeline-item" key={`${update.label}-${update.time}`}>
            <span className="timeline-dot" />
            <div>
              <div className="timeline-heading"><strong>{update.label}</strong><span>{update.time}</span></div>
              <p>{update.message}</p>
            </div>
          </div>
        ))}
      </div>
    </details>
  );
}

function App() {
  const allStatuses = serviceGroups.flatMap((group) => group.services.map((service) => service.status));
  const overallStatus: Status = allStatuses.includes("major") ? "major" : allStatuses.includes("partial") ? "partial" : allStatuses.includes("degraded") ? "degraded" : allStatuses.includes("maintenance") ? "maintenance" : "operational";

  return (
    <main>
      <header className="site-header">
        <a className="brand" href="#top" aria-label="Vox status home">
          <span className="brand-mark"><Activity size={19} /></span>
          <span>Vox Status</span>
        </a>
        <a className="support-link" href="mailto:support@example.com">Contact Support <ExternalLink size={15} /></a>
      </header>

      <section className="hero" id="top">
        <div className="hero-copy">
          <div className="overall-icon"><ShieldCheck size={28} /></div>
          <h1>{overallStatus === "operational" ? "All systems operational" : statusLabels[overallStatus]}</h1>
          <p>Live availability for Vox, the Telegram platform, and all nine Vox apps.</p>
        </div>
        <div className="last-checked"><Clock3 size={16} /> Last checked just now</div>
      </section>

      <section className="uptime-strip" aria-label="90 day uptime">
        <div><strong>99.98%</strong><span>Average uptime</span></div>
        <div className="bars" aria-hidden="true">
          {Array.from({ length: 48 }).map((_, index) => <span key={index} />)}
        </div>
        <span>Past 90 days</span>
      </section>

      <div className="content-grid">
        <section className="services-column">
          {serviceGroups.map((group) => (
            <div className="service-group" key={group.title}>
              <div className="section-heading">
                <h2>{group.title}</h2>
                <span>{group.services.length} services</span>
              </div>
              <div className="service-list">
                {group.services.map((service) => <ServiceRow key={service.name} {...service} />)}
              </div>
            </div>
          ))}
        </section>

        <aside>
          <div className="side-card current-card">
            <div className="side-icon"><Check size={18} /></div>
            <h2>No active incidents</h2>
            <p>Everything is currently running normally.</p>
          </div>

          <div className="side-card">
            <h2>Incident history</h2>
            <div className="incident-list">
              {incidents.map((incident) => <IncidentCard incident={incident} key={incident.title} />)}
            </div>
          </div>

          <div className="side-card maintenance-card">
            <h2>Scheduled maintenance</h2>
            <p>No maintenance is currently scheduled.</p>
          </div>
        </aside>
      </div>

      <footer>
        <span>© 2026 Vox</span>
        <span>Statuses update automatically through health checks and service heartbeats.</span>
      </footer>
    </main>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode><App /></React.StrictMode>
);
