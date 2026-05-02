# Contributing to GpuViewR

Thanks for considering a contribution!

## Setup

```bash
git clone https://github.com/Erreur32/GpuViewR.git
cd GpuViewR
nvm use                              # Node 22
npm install
cp .env.example .env && nano .env    # set JWT_SECRET
npm run dev
```

## Project structure

- `server/`: Express + WebSocket backend (TypeScript, run via `tsx`)
- `src/`: React 19 frontend
- `Dockerfile` / `docker-entrypoint.sh` / `docker-compose.yml`
- `update.sh`: end-user auto-update (pull / backup / restart)
- `scripts/`
  - `update-version.sh`: bump version across the repo (with optional tag-push)
  - `check-docker-build.js`: local sanity build of the Docker image
- `Docs/`: extra documentation

## Conventions

- ESM only (`"type": "module"` in `package.json`)
- Backend imports use `.js` extensions (Node ESM resolution)
- Tailwind for styles; avoid inline styles unless dynamic
- Keep components ≤ 200 lines; extract subcomponents if larger
- All code, comments, README, CHANGELOG, commit messages: **English**

## Releasing a new version

The release flow is automated by `scripts/update-version.sh`. From the repo root:

### Quick path: bump + commit + tag + push in one command

```bash
./scripts/update-version.sh 0.2.0 --tag-push
```

The script will:

1. Update the version in `package.json`, `package-lock.json`,
   `src/components/layout/Header.tsx`, and any matching badges/links in
   `README.md`.
2. Create a `commit-message.txt` template (or warn if it exists but doesn't
   mention the new version).
3. `git add -A`, commit (using `commit-message.txt` if it mentions the new
   version, else a generic `release: vX.Y.Z` fallback).
4. Create the annotated tag `vX.Y.Z`.
5. Push both the branch and the tag to `origin`.

### Manual path: bump first, then commit / tag / push yourself

```bash
./scripts/update-version.sh 0.2.0
# ↑ updates files and generates commit-message.txt

# 1. Edit commit-message.txt with the actual changes for this version.
# 2. Add a new section in CHANGELOG.md.
# 3. Commit + tag + push:
git add -A
git commit -F commit-message.txt
git push
git tag -a v0.2.0 -m "Release v0.2.0"
git push origin v0.2.0
```

Pushing a `v*.*.*` tag triggers the `docker-publish.yml` workflow which
builds and pushes the multi-arch image to GHCR. End users running an older
version will then see the in-app update banner and can run `./update.sh`.

### Convenience npm scripts

```bash
npm run version:bump 0.2.0             # same as ./scripts/update-version.sh 0.2.0
npm run version:tag-push 0.2.0 -- --tag-push   # auto commit + tag + push
```

## Credits

This project is based on the original
[bigsk1/gpu-monitor](https://github.com/bigsk1/gpu-monitor). When in doubt
about defaults (volume layout, schema), keep them compatible to make
migration painless for existing users. The release script and CI workflow
patterns are inspired by [Erreur32/LogviewR](https://github.com/Erreur32/LogviewR).
