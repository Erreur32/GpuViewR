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

- `server/`: hub backend, Express + WebSocket (TypeScript, run via `tsx`)
- `src/`: React 19 frontend; `src/lib/demo/` is the in-browser fake backend of the public demo
- `agent/`: the agent (Linux systemd / Docker, Windows, macOS), bundled into a single `agent.mjs`; installers in `agent/install*.tpl`
- `Dockerfile` / `docker-entrypoint.sh` / `docker-compose*.yaml` (hub with optional sidecar profiles, plus the NVIDIA and AMD agent variants)
- `scripts/`
  - `update-version.sh`: bump the version across the repo
  - `check-docker-build.js`: local sanity build of the Docker image
- `Docs/`: extra documentation, see [`Docs/README.md`](README.md)

## Checks before opening a PR

```bash
npx tsc --noEmit && npm run build && npm test          # hub + frontend
npm run typecheck --prefix agent && npm test --prefix agent && npm run build --prefix agent
npm run dev:mock     # synthetic GPUs, no hardware needed
npm run dev:demo     # the public demo build (fake backend in the browser)
```

CI runs the build, CodeQL, SonarCloud and Snyk on every PR. Keep the
SonarCloud quality gate green.

## Conventions

- ESM only (`"type": "module"` in `package.json`)
- Backend imports use `.js` extensions (Node ESM resolution)
- Tailwind for styles; avoid inline styles unless dynamic
- Keep components ≤ 200 lines; extract subcomponents if larger
- All code, comments, README, CHANGELOG, commit messages: **English**

## Releasing a new version

Changes land on `main` through pull requests, release commits included.
Docs-only changes need no version bump.

```bash
git checkout -b release/vX.Y.Z
./scripts/update-version.sh X.Y.Z
```

The script updates the version in `package.json`, `package-lock.json`,
`agent/package.json`, `agent/package-lock.json`, `README.md` and
`sonar-project.properties`, and prepares `commit-message.txt`. The UI
reads its version from `package.json` at build time (`__APP_VERSION__`),
never hardcode it.

Then:

1. Add the `## [X.Y.Z] - YYYY-MM-DD` section to `CHANGELOG.md` (the GitHub
   Release body is extracted from it, a missing section means an empty
   release).
2. Edit `commit-message.txt`.
3. Run `npm ci` at the root and in `agent/` to catch lockfile drift, plus
   the checks above.
4. `git add -A && git commit -F commit-message.txt`, push the branch, open
   the PR.
5. Once merged and SonarCloud is green on `main`, tag the merge commit:

```bash
git tag -a vX.Y.Z -m "Release vX.Y.Z" <merge-commit>
git push origin vX.Y.Z
```

What runs where:

- **Push to `main`**: `docker-publish.yml` publishes `ghcr.io/erreur32/gpuviewr:latest`
  and `ghcr.io/erreur32/gpuviewr-agent:latest`. Hubs that pull `:latest`
  then push the new agent bundle to connected agents (`agent_update` over
  the WebSocket), so agents usually update before the tag exists.
- **Tag `vX.Y.Z`**: `docker-publish.yml` adds the `:X.Y.Z` image tags and
  `release.yml` creates the GitHub Release from the CHANGELOG section.
  Users on an older version see the in-app update banner
  (`docker compose pull && docker compose up -d`).

`./scripts/update-version.sh X.Y.Z --tag-push` still exists (bump, commit,
tag and push in one go) but skips the PR, keep it for emergencies.

## Credits

This project is based on the original
[bigsk1/gpu-monitor](https://github.com/bigsk1/gpu-monitor). When in doubt
about defaults (volume layout, schema), keep them compatible to make
migration painless for existing users. The release script and CI workflow
patterns are inspired by [Erreur32/LogviewR](https://github.com/Erreur32/LogviewR).
