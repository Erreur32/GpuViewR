# GpuViewR

> **Modern, real-time NVIDIA GPU monitoring dashboard.**
> Built with **React 19 · Vite · TailwindCSS · uPlot · Express 5 · WebSocket · better-sqlite3**.

![GpuViewR](public/gpuviewr.svg)

GpuViewR is a from-scratch reimplementation of GPU monitoring, focused on:

- ⚡ **Real-time** — WebSocket streaming, 1 s tick (no JSON polling)
- 🎨 **Modern UI** — Tailwind, 5 built-in themes (3 dark + 2 light), responsive mobile-first
- 📈 **Fast charts** — uPlot for smooth time-series streaming
- 🔘 **Switchable gauges** — arc rings or Grafana-style horizontal bars
- ✨ **Sparklines** in every gauge card
- 🔔 **Alerts engine** — sustained-duration thresholds, cooldown, browser notifications, optional sound
- 📜 **Filterable server logs** — level / scope / search, live auto-refresh
- 🌍 **i18n** — English / French out of the box, easy to extend
- 🔐 **Authentication** — first user becomes admin (bcrypt + JWT)
- 🔢 **Multi-GPU** — automatic tabs when 2+ devices are detected
- 🐳 **Single Docker image** — multi-arch (amd64 / arm64), Node 22 Alpine
- 🔄 **One-command updates** — `./update.sh` (with `--check` and `--rollback`)

---

## Credits

GpuViewR is a complete rewrite **inspired by and originally based on**
[**bigsk1/gpu-monitor**](https://github.com/bigsk1/gpu-monitor) (MIT License).

The original project provided the foundation: GPU data collection approach via
`nvidia-smi`, the SQLite schema for historical metrics, and the Docker
packaging strategy. GpuViewR keeps the data model compatible so existing
gpu-monitor users can migrate without losing their history (see
[`Docs/MIGRATION.md`](Docs/MIGRATION.md)).

What changed in GpuViewR:

| Original `gpu-monitor` | GpuViewR |
|---|---|
| Bash collection script | TypeScript collector (Node / Express) |
| Polling JSON every 5–30 s | WebSocket streaming every 1 s |
| Monolithic 1183-line HTML | React 19 + Vite + Tailwind components |
| Chart.js 3.7 | uPlot (40 KB, streaming-optimized) |
| No authentication | Login + JWT + bcrypt |
| Single GPU only | Multi-GPU ready |
| One static look | 5 themes + arc/bar gauge toggle |
| No alerts | Full alerts subsystem with sustain + cooldown |
| Manual updates | `update.sh` with backup + rollback |

Original work © bigsk1 — see [LICENSE](LICENSE) for the full notice.

---

## Quick start

### Docker (recommended)

```bash
# 1. Generate a JWT secret
echo "JWT_SECRET=$(openssl rand -base64 32)" > .env

# 2. (Optional) Pin the LAN IP that appears in the boot banner
echo "HOST_IP=$(hostname -I | awk '{print $1}')" >> .env

# 3. Start
docker compose up -d

# 4. Open the dashboard
xdg-open http://localhost:7510
```

The first time you connect, the login page automatically switches to **"Create
admin account"**. The first user you register is granted the `admin` role.
Subsequent registrations create regular `user` accounts.

> Default Docker port is **`7510`** (host) → **`3015`** (container). Override
> the host port with `DASHBOARD_PORT=...` in `.env`.

### Local development (npm)

```bash
git clone https://github.com/Erreur32/GpuViewR.git
cd GpuViewR
nvm use                              # Node 22
npm install
cp .env.example .env && nano .env    # set JWT_SECRET
npm run dev                          # client + server in parallel
```

| Endpoint | URL |
|---|---|
| Frontend (Vite dev) | `http://localhost:5181` |
| Backend API | `http://localhost:3015/api` |
| WebSocket | `ws://localhost:3015/ws/gpu` |

The boot banner prints all four URLs, including a network-reachable variant
based on the detected LAN IP. If the configured port is already in use, the
backend exits with a clear, color-coded message rather than crashing later.

---

## First login — there is no default account

GpuViewR ships **without** any pre-baked credentials, on purpose:

1. The first time you reach `/login`, the API reports `hasUsers: false`.
2. The login form switches into **"Create admin account"** mode.
3. Pick your own `username` (≥ 3 chars) and `password` (≥ 8 chars).
4. The first user is created with role `admin` automatically.
5. Future registrations are regular `user` accounts.

**Lost your password?** The simplest path is to wipe the user store and start
over:

```bash
docker compose down
rm -rf ./data/gpuviewr.db*
docker compose up -d
```

(GPU history is stored in the same SQLite file, so it will be reset too. A
dedicated `npm run reset-password` helper is on the roadmap.)

---

## Configuration

All settings are read from `.env`. See [`.env.example`](.env.example) for the
complete list.

| Variable | Default | Purpose |
|---|---:|---|
| `JWT_SECRET` | — | **Required.** Secret for signing JWTs. Generate with `openssl rand -base64 32`. |
| `PORT` | `3015` | Backend HTTP/WebSocket port (inside the container in Docker). |
| `VITE_PORT` | `5181` | Vite dev server port (npm dev only). |
| `DASHBOARD_PORT` | `7510` | Docker only — host port mapped to the container's `PORT`. |
| `HOST_IP` | _auto_ | LAN IP shown in the banner. Auto-detected if unset. |
| `PUBLIC_URL` | — | If you serve GpuViewR behind a reverse proxy. |
| `TZ` | `Europe/Paris` | Container timezone. |
| `GPU_TICK_MS` | `1000` | How often `nvidia-smi` is sampled. |
| `RETENTION_DAYS` | `7` | How long historical metrics are kept. |
| `DATA_DIR` | `./data` | Where the SQLite DB lives. |

---

## Updating

GpuViewR ships with an `update.sh` helper:

```bash
./update.sh             # backup data, pull latest, restart
./update.sh --check     # report whether a newer image is available
./update.sh --rollback  # restore the previous image AND data backup
```

`update.sh` automatically:

- Tags the current image as `:previous` before pulling
- Tar-gzips the `data/` directory into `backups/data-YYYYMMDD-HHMMSS.tar.gz`
- Trims to the 10 most recent backups
- Prunes dangling images at the end

CI / GitHub: `.github/workflows/docker-publish.yml` builds and pushes
multi-arch images (`linux/amd64`, `linux/arm64`) to GHCR on every push to
`main` and on every `v*.*.*` tag.

---

## Architecture

```
GpuViewR/
├── server/                       # Express + WebSocket backend
│   ├── index.ts                  # entrypoint (banner, port check, routes)
│   ├── config.ts                 # env config
│   ├── database/
│   │   ├── connection.ts         # SQLite (better-sqlite3, WAL mode)
│   │   └── models/
│   │       ├── User.ts
│   │       ├── GpuMetric.ts      # schema-compatible with bigsk1/gpu-monitor
│   │       └── Alert.ts
│   ├── services/
│   │   ├── gpuCollector.ts       # spawn nvidia-smi, parse CSV, persist
│   │   ├── gpuStreamWS.ts        # WebSocket broadcaster (samples + alerts)
│   │   ├── authService.ts        # bcrypt + JWT
│   │   └── alertService.ts       # sustained-duration evaluator with cooldown
│   ├── routes/                   # /api/auth /api/gpu /api/alerts /api/logs /api/health
│   ├── middleware/               # auth, errorHandler
│   └── utils/
│       ├── logger.ts             # ring buffer + console + EventEmitter
│       └── banner.ts             # boot banner + port-availability check
├── src/                          # React 19 frontend
│   ├── main.tsx
│   ├── App.tsx                   # router + auth guard
│   ├── components/
│   │   ├── login/                # LoginPage (auto switches to "Create admin")
│   │   ├── layout/               # Header (sticky), AppLayout (Outlet)
│   │   ├── dashboard/            # GaugeCard, Sparkline, LiveChart, RangeSelector,
│   │   │                          # GpuTabs, StatsSection, Dashboard
│   │   ├── alerts/               # AlertsPage (rules + events + modal editor)
│   │   ├── logs/                 # LogsPage (filters + auto-refresh)
│   │   ├── settings/             # SettingsPage (themes, gauges, language, sound)
│   │   └── ui/                   # Toaster
│   ├── store/                    # zustand: auth, gpu, ui, toast
│   ├── lib/
│   │   ├── api.ts                # fetch wrapper with bearer auth
│   │   ├── themes.ts             # 5 themes via CSS variables
│   │   └── useGpuStream.ts       # WebSocket hook (auto-reconnect with backoff)
│   ├── i18n/                     # react-i18next + locales/{en,fr}.json
│   └── styles/index.css          # tailwind + theme tokens + animations
├── public/                       # static assets (logo, alert sound)
├── Dockerfile                    # multi-stage Node 22 Alpine
├── docker-compose.yml            # runtime: nvidia, GHCR image
├── docker-entrypoint.sh          # drops privileges to "node"
├── update.sh                     # auto-update (backup + rollback)
├── .github/workflows/
│   ├── docker-publish.yml        # multi-arch GHCR build & push
│   └── ci.yml                    # build smoke test
├── scripts/
│   ├── bump-version.js           # bump package.json + Header.tsx + README
│   └── check-docker-build.js     # local image-size sanity check
└── Docs/
    ├── MIGRATION.md              # migrate from bigsk1/gpu-monitor
    └── CONTRIBUTING.md
```

---

## Customizing the look

### Themes

Five themes ship by default: `Midnight`, `Graphite`, `Oceanic` (dark),
`Daylight`, `Paper` (light). Add a new theme by editing
[`src/lib/themes.ts`](src/lib/themes.ts) — each theme is a token map that's
applied to CSS variables on `<html>`:

```ts
export const THEMES: Theme[] = [
  // ...
  {
    id: 'sunset',
    label: 'Sunset',
    mode: 'dark',
    tokens: { /* bg, surface, accent, ok, warn, danger, ... */ },
  },
];
```

The new theme appears in **Settings → Theme** automatically.

### Gauges

Toggle between **arc rings** and **Grafana-style horizontal bars** from the
dashboard toolbar or **Settings → Gauge style**. The choice is persisted
per-browser in `localStorage`.

### Languages

Add a locale in [`src/i18n/locales/`](src/i18n/locales/) and register it in
[`src/i18n/index.ts`](src/i18n/index.ts). Missing keys fall back to English.

---

## Alerts

Define rules in **Alerts → New rule** (admin only). Each rule has:

| Field | Effect |
|---|---|
| Metric | `temperature`, `utilization`, `memory %`, `power`, `fan_speed` |
| Condition | `above` (≥) or `below` (≤) the threshold |
| Threshold | Numeric value |
| Sustained (s) | The threshold must be held for this long before firing |
| Cooldown (s) | Minimum gap between two firings of the same rule |
| GPU index | Empty = applies to all GPUs |
| Notify browser | Native `Notification` API |
| Notify sound | Plays `/alert.mp3` (replace the placeholder for a real tone) |

When a rule fires, GpuViewR pushes a `type: "alert"` frame on the same
WebSocket — the UI shows a toast immediately and (optionally) raises a browser
notification. When the metric returns into range, a `resolved` event is
emitted and a green toast confirms it.

---

## Roadmap

- Per-process GPU usage breakdown (`nvidia-smi --query-compute-apps`)
- Password reset CLI
- CSV export of historical metrics
- PWA (installable on mobile, offline shell)
- Email / webhook alert dispatchers (in addition to in-app + browser)

---

## License

MIT — see [LICENSE](LICENSE). Original copyright © 2024 bigsk1.
