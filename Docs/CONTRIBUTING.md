# Contributing to GpuViewR

Thanks for considering a contribution!

## Setup

```bash
git clone https://github.com/Erreur32/GpuViewR.git
cd GpuViewR
nvm use            # Node 22
npm install
cp .env.example .env && nano .env   # set JWT_SECRET
npm run dev
```

## Project structure

- `server/` — Express + WebSocket backend (TypeScript, run via `tsx`)
- `src/`    — React 19 frontend
- `Dockerfile` / `docker-entrypoint.sh` / `docker-compose.yml`
- `update.sh` — auto-update for end users
- `scripts/` — version bump, build check
- `Docs/`   — extra documentation

## Conventions

- ESM only (`type: module` in `package.json`)
- Backend imports use `.js` extensions (Node ESM resolution)
- Tailwind for styles; avoid inline styles unless dynamic
- Keep components ≤ 200 lines; extract subcomponents if larger

## Releasing

```bash
npm run version:patch    # 0.1.0 → 0.1.1
git add -A && git commit -m "chore: bump version to vX.Y.Z"
git tag vX.Y.Z
git push --follow-tags
```

The `docker-publish.yml` workflow builds and pushes multi-arch images on tag.

## Credits

This project is based on the original
[bigsk1/gpu-monitor](https://github.com/bigsk1/gpu-monitor). When in doubt
about defaults (volume layout, ports, schema), keep them compatible to make
migration painless for existing users.
