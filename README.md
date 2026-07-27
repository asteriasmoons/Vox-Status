# Vox Status Page

A responsive status website for Vox, the Telegram platform, and the nine Vox iOS/iPadOS apps — plus a private, mobile-friendly **dashboard** for posting updates.

- **Public page** (`/`) — live service statuses, incident history, and scheduled maintenance.
- **Dashboard** (`/dashboard`) — password-protected. Change service statuses, open and update incidents, schedule maintenance, and manage reusable templates. Changes publish to the public page immediately.

## Architecture

| Layer | Tech |
| --- | --- |
| Frontend | React 18 + TypeScript + Vite (`src/`) |
| API + auth | Cloudflare Worker (`worker/index.ts`) |
| Data | Cloudflare D1 (SQLite) — schema in `schema.sql` |
| Sessions | Cloudflare KV (`SESSIONS` binding) |

The Worker serves the built site as static assets and handles `/api/*`. The public page fetches `/api/status`; if the API is ever unreachable it falls back to the static snapshot in `src/statusData.ts`.

## Run locally

```bash
npm install
npm run db:init:local     # apply schema.sql to a local D1 copy
npm run build             # build the site into dist/
npm run dev:worker        # Worker + static assets at http://localhost:8787
```

`npm run dev` still runs the Vite dev server alone (public page only, using the static fallback data).

## One-time cloud setup

The D1 database and KV namespace are **already provisioned** and their IDs are filled into `wrangler.toml`:

- D1 `vox-status` → `7e540e75-650c-485d-b086-dd3685e29ec8`
- KV `SESSIONS` → `b6ddfe706a484b429642a3147cfc1d6e`

The remote database has also been initialised with `schema.sql` and seed data. Two steps remain, and both must be run from your machine (they need the Wrangler CLI and can't be done for you):

1. **Set the dashboard password** (this is your login):

   ```bash
   npx wrangler secret put DASHBOARD_PASSWORD
   ```

2. **Deploy:**

   ```bash
   npm run deploy       # builds the site and runs `wrangler deploy`
   ```

If you ever need to re-apply the schema to the remote database (this **drops and recreates** all tables):

```bash
npm run db:init
```

## Using the dashboard

Open `/dashboard`, sign in with your `DASHBOARD_PASSWORD`, then:

- **Services** — tap any status chip to publish a service's state instantly; edit uptime inline. Service templates give one-tap presets.
- **Incidents** — open a new incident (with affected services and a first update), or post follow-up updates to existing ones. Incident templates pre-fill the label, state, and message.
- **Maintenance** — schedule maintenance windows and move them through scheduled → in progress → completed.
- **Templates** — create and delete reusable messages for all three types.

## Available scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Vite dev server (public page only) |
| `npm run dev:worker` | Full app (API + site) via Wrangler |
| `npm run build` | Type-check and build into `dist/` |
| `npm run deploy` | Build and deploy the Worker |
| `npm run db:create` | Create the D1 database (already done) |
| `npm run kv:create` | Create the KV namespace (already done) |
| `npm run db:init` | Apply `schema.sql` to the **remote** D1 (destructive) |
| `npm run db:init:local` | Apply `schema.sql` to the **local** D1 |
| `npm run set:password` | Set the `DASHBOARD_PASSWORD` secret |

## Notes

- The static data in `src/statusData.ts` is now only a build-time fallback; the live source of truth is D1.
- Sessions live in KV and expire after 12 hours. Signing out clears them immediately.
- Change the seeded support email either in the dashboard's data or via the `settings` table (`support_email`).
