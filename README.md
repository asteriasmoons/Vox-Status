# Vox Status Page

A responsive status website for Vox, the Telegram platform, and the nine Vox iOS/iPadOS apps.

## Run locally

```bash
npm install
npm run dev
```

## Build for deployment

```bash
npm install
npm run build
```

Deploy the generated `dist` folder to Railway, Vercel, Netlify, Cloudflare Pages, or any static host.

## Update service statuses

Edit `src/statusData.ts`.

Each service supports:

- `operational`
- `degraded`
- `partial`
- `major`
- `maintenance`

The overall banner is calculated automatically from the individual service statuses.

## Keep it updated automatically

The included page is frontend-only. For real automation, have your backend write a JSON status feed or expose health endpoints. Recommended checks:

- `/health` for the Vox API
- `/health/database`
- `/health/telegram`
- `/health/scheduler`
- Heartbeat pings from background workers after each successful cycle

Then replace the imported static data with a fetch to your status endpoint. Manual incidents should still be created for app bugs that cannot be detected by an HTTP health check.

## Before deployment

Change the support email in `src/main.tsx` from `support@example.com` to the real Vox support address.
