export type Status = "operational" | "beta" | "degraded" | "partial" | "major" | "maintenance";

export type Service = {
  name: string;
  description: string;
  status: Status;
  uptime: string;
};

export type ServiceGroup = {
  title: string;
  services: Service[];
};

export type IncidentUpdate = {
  label: string;
  time: string;
  message: string;
};

export type Incident = {
  title: string;
  state: "investigating" | "monitoring" | "resolved";
  date: string;
  affected: string[];
  updates: IncidentUpdate[];
};

export const serviceGroups: ServiceGroup[] = [
  {
    title: "Vox Platform",
    services: [
      { name: "Telegram Bot", description: "Commands, posting, and bot responses", status: "operational", uptime: "99.99%" },
      { name: "Telegram Mini App", description: "Dashboard and post management", status: "operational", uptime: "99.98%" },
      { name: "Vox API", description: "Core backend services", status: "operational", uptime: "99.99%" },
      { name: "Scheduled Posting", description: "Queued and recurring posts", status: "operational", uptime: "99.97%" }
    ]
  },
  {
    title: "Vox Apps",
    services: [
      { name: "Lunixia", description: "iOS and iPadOS services", status: "operational", uptime: "99.99%" },
      { name: "Lunelia", description: "iOS and iPadOS services", status: "operational", uptime: "99.99%" },
      { name: "Lurelia", description: "iOS and iPadOS services", status: "operational", uptime: "99.98%" },
      { name: "Loomey", description: "iOS and iPadOS services", status: "operational", uptime: "99.99%" },
      { name: "Limily", description: "iOS and iPadOS services", status: "degraded", uptime: "99.97%" },
      { name: "Markly", description: "iOS and iPadOS services", status: "operational", uptime: "99.99%" },
      { name: "Tally", description: "iOS and iPadOS services", status: "operational", uptime: "99.99%" },
      { name: "Project", description: "iOS and iPadOS services", status: "operational", uptime: "99.99%" },
      { name: "Lunely", description: "iOS and iPadOS services", status: "operational", uptime: "99.98%" }
    ]
  },
  {
    title: "Shared Services",
    services: [
      { name: "Database", description: "Application data and persistence", status: "operational", uptime: "99.99%" },
      { name: "Authentication", description: "Account sign-in and sessions", status: "operational", uptime: "99.99%" },
      { name: "Cloud Sync", description: "Cross-device data synchronization", status: "operational", uptime: "99.98%" },
      { name: "Push Notifications", description: "App and system notifications", status: "operational", uptime: "99.96%" },
      { name: "AI Services", description: "AI-powered app features", status: "operational", uptime: "99.95%" },
      { name: "Media Uploads", description: "Images and file attachments", status: "operational", uptime: "99.99%" }
    ]
  }
];

export const incidents: Incident[] = [
  {
    title: "Scheduled posting delays",
    state: "resolved",
    date: "July 8, 2026",
    affected: ["Scheduled Posting"],
    updates: [
      { label: "Resolved", time: "4:42 PM", message: "Queued posts are sending normally and the delayed queue has been cleared." },
      { label: "Monitoring", time: "4:18 PM", message: "A worker restart restored normal processing. We are monitoring the queue." },
      { label: "Investigating", time: "3:51 PM", message: "Some scheduled posts are being delivered later than expected." }
    ]
  }
];
