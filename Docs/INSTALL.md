# Installing the hub

The hub is the dashboard: web UI, REST + WebSocket API, SQLite history.
It runs as a single Docker image (`linux/amd64` + `linux/arm64`) and can
monitor the GPUs of the machine it runs on through a sidecar agent in the
same compose stack. To monitor other machines, see
[Remote hosts](REMOTE_HOSTS.md).

- [Quick install](#quick-install)
- [Manual install](#manual-install)
- [Update](#update)
- [Supported hub platforms](#supported-hub-platforms)
- [Compose examples](#compose-examples)
- [Prerequisites](#prerequisites)
- [Hub on macOS (Docker Desktop)](#hub-on-macos-docker-desktop)
- [First login](#first-login)
- [Configuration](#configuration)
- [Ollama model names](#ollama-model-names)
- [Hidden GPU processes and model names](#hidden-gpu-processes-and-model-names)
- [Troubleshooting](#troubleshooting)

## Quick install

**`cd` to where you want it first**: the script drops `docker-compose.yaml`
and `.env` in the current directory.

```bash
mkdir -p /opt/gpuviewr && cd /opt/gpuviewr
curl -fsSL https://raw.githubusercontent.com/Erreur32/GpuViewR/main/install.sh | bash
```

`install.sh` detects your GPU vendor (NVIDIA / AMD / none), pulls
`docker-compose.yaml`, generates a `.env` (random JWT and bootstrap
secrets, LAN IP) and starts the stack. Open `http://<your-host-ip>:7510`,
the first user becomes admin.

Vendor detection, written to `COMPOSE_PROFILES` in `.env`:

| Host | Result |
|---|---|
| `nvidia-smi` + NVIDIA Container Toolkit (Docker `nvidia` runtime) | `nvidia` |
| `nvidia-smi` but no toolkit | hub only, with the command to fix it |
| `rocm-smi`, or an `amdgpu` card without ROCm, and `/dev/kfd` | `amd` |
| `amdgpu` card but no `/dev/kfd` | hub only, with a hint |
| no GPU | hub only (aggregator) |

Install the missing piece and re-run `install.sh`: it switches the profile
on.

- Run from a session landing dir (`/`, `$HOME`, `/root`, `/tmp`), the
  script falls back to `$HOME/gpuviewr`. Set `GPUVIEWR_INSTALL_DIR=/custom/path`
  to force a target.
- Re-running it on an existing install is safe: it keeps your `.env`
  (secrets stay), pulls the latest compose file and restarts the stack.

## Manual install

If you'd rather not pipe curl into bash:

```bash
mkdir -p ~/gpuviewr && cd ~/gpuviewr

curl -fsSL -o docker-compose.yaml \
  https://raw.githubusercontent.com/Erreur32/GpuViewR/main/docker-compose.yaml

cat > .env <<EOF
JWT_SECRET=$(openssl rand -base64 32)
LOCAL_AGENT_BOOTSTRAP=$(openssl rand -base64 32)
HOST_IP=$(hostname -I | awk '{print $1}')
HUB_HOSTNAME=$(hostname)
DASHBOARD_PORT=7510
TZ=Europe/Paris
COMPOSE_PROFILES=nvidia     # or: amd, or empty (= aggregator-only)
EOF
chmod 600 .env

docker compose up -d
```

`docker-compose.yaml` defines a vendor-neutral `hub` (always started) and
`agent-nvidia` / `agent-amd` sidecars gated by `COMPOSE_PROFILES`. Only the
matching sidecar runs.

## Update

```bash
cd ~/gpuviewr
docker compose pull && docker compose up -d
```

The UI shows a banner when a new release is available. Agents with
auto-update enabled follow the hub automatically, see
[Remote hosts](REMOTE_HOSTS.md#auto-update).

## Supported hub platforms

The hub image is published for `linux/amd64` and `linux/arm64`, so it runs
on regular x86 servers as well as ARM boards (Raspberry Pi 4/5 on a 64-bit
OS, Ampere, etc.).

| Host | Local GPU monitoring | Compose example |
|---|---|---|
| Linux + NVIDIA GPU | Yes, needs the NVIDIA Container Toolkit | [NVIDIA](#nvidia-hub--local-gpu) |
| Linux + AMD GPU | Yes, needs the `amdgpu` driver (ROCm optional) | [AMD](#amd-hub--local-gpu) |
| Linux, no GPU | No, aggregator only | [Hub only](#hub-only-aggregator) |
| macOS, Docker Desktop (Intel / Apple Silicon) | No, aggregator only ([details](#hub-on-macos-docker-desktop)) | [Hub only](#hub-only-aggregator) |
| Windows | No documented hub. Docker Desktop on WSL2 should run it as an aggregator, untested. Monitor Windows machines with the [Windows agent](REMOTE_HOSTS.md) | [Hub only](#hub-only-aggregator) |

`install.sh` only covers Linux. Intel GPUs and Apple Silicon are monitored
through agents, not the hub sidecar.

## Compose examples

Standalone files, one per case, tested with `docker compose config`. The
hub-only file was also started and reached `healthy`. They match the
services in the official [`docker-compose.yaml`](../docker-compose.yaml),
without the `COMPOSE_PROFILES` switch and the optional Ollama mount.
Put the file next to a `.env` and run `docker compose up -d`.

`.env` for every case:

```bash
JWT_SECRET=<openssl rand -base64 32>
LOCAL_AGENT_BOOTSTRAP=<openssl rand -base64 32>   # leave empty for hub only
HUB_HOSTNAME=my-server
DASHBOARD_PORT=7510
TZ=Europe/Paris
```

### Hub only (aggregator)

No local GPU. The dashboard shows remote machines enrolled from
**Settings → Hosts → Add host**.

```yaml
services:
  hub:
    image: ghcr.io/erreur32/gpuviewr:latest
    container_name: gpuviewr-hub
    restart: unless-stopped
    ports:
      - "${DASHBOARD_PORT:-7510}:3015"
    environment:
      JWT_SECRET: ${JWT_SECRET}
      LOCAL_AGENT_BOOTSTRAP: ${LOCAL_AGENT_BOOTSTRAP:-}
      PORT: 3015
      DASHBOARD_PORT: ${DASHBOARD_PORT:-7510}
      CONTAINER_NAME: gpuviewr-hub
      HOST_IP: ${HOST_IP:-}
      TZ: ${TZ:-Europe/Paris}
      RETENTION_DAYS: ${RETENTION_DAYS:-7}
      HOST_PROC: /host/proc
      HOST_ETC: /host/etc
    volumes:
      - ./data:/app/data
      - /proc:/host/proc:ro
      - /etc/hostname:/host/etc/hostname:ro
    networks: [gpuviewr]
    cap_drop: [ALL]
    cap_add: [CHOWN, SETUID, SETGID, DAC_OVERRIDE, FOWNER]
    security_opt:
      - no-new-privileges:true
    healthcheck:
      test: ["CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http://127.0.0.1:3015/api/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 20s

networks:
  gpuviewr:
    driver: bridge
```

### NVIDIA hub + local GPU

Requires the [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html)
on the host (`docker run --rm --gpus all ubuntu nvidia-smi` must work).

```yaml
services:
  hub:
    image: ghcr.io/erreur32/gpuviewr:latest
    container_name: gpuviewr-hub
    restart: unless-stopped
    ports:
      - "${DASHBOARD_PORT:-7510}:3015"
    environment:
      JWT_SECRET: ${JWT_SECRET}
      LOCAL_AGENT_BOOTSTRAP: ${LOCAL_AGENT_BOOTSTRAP:-}
      PORT: 3015
      DASHBOARD_PORT: ${DASHBOARD_PORT:-7510}
      CONTAINER_NAME: gpuviewr-hub
      HOST_IP: ${HOST_IP:-}
      TZ: ${TZ:-Europe/Paris}
      RETENTION_DAYS: ${RETENTION_DAYS:-7}
      HOST_PROC: /host/proc
      HOST_ETC: /host/etc
    volumes:
      - ./data:/app/data
      - /proc:/host/proc:ro
      - /etc/hostname:/host/etc/hostname:ro
    networks: [gpuviewr]
    cap_drop: [ALL]
    cap_add: [CHOWN, SETUID, SETGID, DAC_OVERRIDE, FOWNER]
    security_opt:
      - no-new-privileges:true
    healthcheck:
      test: ["CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http://127.0.0.1:3015/api/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 20s

  agent:
    image: ghcr.io/erreur32/gpuviewr-agent:latest
    container_name: gpuviewr-hub-agent
    restart: unless-stopped
    cap_add: [SYS_PTRACE]
    depends_on:
      hub:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "node", "-e", "process.exit(Date.now()-require('fs').statSync('/tmp/.gpuviewr-agent-alive').mtimeMs<60000?0:1)"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 30s
    networks: [gpuviewr]
    environment:
      HUB_URL: ws://hub:3015/agent
      AGENT_TOKEN: ${LOCAL_AGENT_BOOTSTRAP}
      HOST_ID: local
      AGENT_LABEL: ${HUB_HOSTNAME:-master}
      GPU_VENDOR: nvidia
      HOST_PROC: /host/proc
      TZ: ${TZ:-Europe/Paris}
    volumes:
      - /proc:/host/proc:ro
    runtime: nvidia
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: all
              capabilities: [gpu, utility]

networks:
  gpuviewr:
    driver: bridge
```

### AMD hub + local GPU

Requires the `amdgpu` driver. Without ROCm at `/opt/rocm`, drop that volume:
GPU metrics and the process list still work (the list then comes from DRM
fdinfo only, without per-process CU occupancy). If
`getent group video render` does not show `44` / `109`, set `VIDEO_GID` /
`RENDER_GID` in `.env`.

```yaml
services:
  hub:
    image: ghcr.io/erreur32/gpuviewr:latest
    container_name: gpuviewr-hub
    restart: unless-stopped
    ports:
      - "${DASHBOARD_PORT:-7510}:3015"
    environment:
      JWT_SECRET: ${JWT_SECRET}
      LOCAL_AGENT_BOOTSTRAP: ${LOCAL_AGENT_BOOTSTRAP:-}
      PORT: 3015
      DASHBOARD_PORT: ${DASHBOARD_PORT:-7510}
      CONTAINER_NAME: gpuviewr-hub
      HOST_IP: ${HOST_IP:-}
      TZ: ${TZ:-Europe/Paris}
      RETENTION_DAYS: ${RETENTION_DAYS:-7}
      HOST_PROC: /host/proc
      HOST_ETC: /host/etc
    volumes:
      - ./data:/app/data
      - /proc:/host/proc:ro
      - /etc/hostname:/host/etc/hostname:ro
    networks: [gpuviewr]
    cap_drop: [ALL]
    cap_add: [CHOWN, SETUID, SETGID, DAC_OVERRIDE, FOWNER]
    security_opt:
      - no-new-privileges:true
    healthcheck:
      test: ["CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http://127.0.0.1:3015/api/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 20s

  agent:
    image: ghcr.io/erreur32/gpuviewr-agent:latest
    container_name: gpuviewr-hub-agent
    restart: unless-stopped
    cap_add: [SYS_PTRACE]
    depends_on:
      hub:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "node", "-e", "process.exit(Date.now()-require('fs').statSync('/tmp/.gpuviewr-agent-alive').mtimeMs<60000?0:1)"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 30s
    networks: [gpuviewr]
    environment:
      HUB_URL: ws://hub:3015/agent
      AGENT_TOKEN: ${LOCAL_AGENT_BOOTSTRAP}
      HOST_ID: local
      AGENT_LABEL: ${HUB_HOSTNAME:-master}
      GPU_VENDOR: amd
      ROCM_SMI_PATH: /opt/rocm/bin/rocm-smi
      LD_LIBRARY_PATH: /opt/rocm/lib:/opt/rocm/lib64
      HOST_PROC: /host/proc
      TZ: ${TZ:-Europe/Paris}
    devices:
      - /dev/kfd
      - /dev/dri
    group_add:
      - "${VIDEO_GID:-44}"
      - "${RENDER_GID:-109}"
    volumes:
      - /opt/rocm:/opt/rocm:ro
      - /proc:/host/proc:ro

networks:
  gpuviewr:
    driver: bridge
```

## Prerequisites

- Docker Engine 23+ with the Compose v2 plugin
- **NVIDIA**: [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html)
- **AMD**: amdgpu kernel driver loaded. ROCm at `/opt/rocm` is optional: it
  adds per-process CU occupancy to the process list (GPU metrics and the
  list itself read `/sys/class/drm/` and DRM fdinfo directly)

## Hub on macOS (Docker Desktop)

The hub runs on Docker Desktop for Mac (Intel and Apple Silicon) in
**aggregator-only mode**: it shows remote machines, not the Mac itself.
Docker Desktop exposes no GPU to containers (no NVIDIA runtime, no
`/dev/kfd` / `/dev/dri`, no Metal). To monitor the Mac's own Apple Silicon
GPU, install the bare-metal macOS agent instead, see
[Remote hosts](REMOTE_HOSTS.md#macos-apple-silicon).

`install.sh` is Linux-only (it uses `hostname -I`), so set it up by hand:

```bash
mkdir -p ~/gpuviewr && cd ~/gpuviewr
curl -fsSL https://raw.githubusercontent.com/Erreur32/GpuViewR/main/docker-compose.yaml -o docker-compose.yaml

cat > .env <<'EOF'
JWT_SECRET=
LOCAL_AGENT_BOOTSTRAP=
HOST_IP=
HUB_HOSTNAME=
DASHBOARD_PORT=7510
TZ=Europe/Paris
COMPOSE_PROFILES=
EOF

# Fill the dynamic values
sed -i '' "s|^JWT_SECRET=.*|JWT_SECRET=$(openssl rand -base64 32)|" .env
sed -i '' "s|^HOST_IP=.*|HOST_IP=$(ipconfig getifaddr en0)|" .env
sed -i '' "s|^HUB_HOSTNAME=.*|HUB_HOSTNAME=$(hostname -s)|" .env

docker compose up -d
```

Open `http://localhost:7510` and enroll your machines from
**Settings → Hosts → Add host**. Keep `COMPOSE_PROFILES` empty: `nvidia` or
`amd` would start a sidecar that cannot reach any GPU on macOS.

## First login

GpuViewR ships **without** default credentials.

1. Open the dashboard. On an empty database the login page becomes
   **"Create admin account"**.
2. Pick a username (3+ characters) and a password (8+ characters).
3. The first user is `admin`. Only an admin can create further accounts.

**Lost your password?** Wipe the database and start over (GPU history lives
in the same SQLite file and is reset too):

```bash
docker compose down
rm -rf ./data/gpuviewr.db*
docker compose up -d
```

## Configuration

All settings are read from the `.env` next to `docker-compose.yaml`
(generated by `install.sh`).

| Variable | Default | Purpose |
|---|---:|---|
| `JWT_SECRET` | _required_ | Secret for signing JWTs. Generated by install.sh. |
| `LOCAL_AGENT_BOOTSTRAP` | _generated_ | Shared secret between the hub and the local sidecar agent. Leave empty to disable the sidecar (aggregator-only mode). |
| `COMPOSE_PROFILES` | _set by install.sh_ | `nvidia` / `amd` / empty. Picks the local sidecar's vendor. |
| `DASHBOARD_PORT` | `7510` | Host port mapped to the container's `3015`. |
| `HOST_IP` | _auto_ | LAN IP shown in the boot banner. |
| `HUB_HOSTNAME` | _auto_ | Name shown in the UI for the local host. Wins over `/etc/hostname` detection. |
| `TZ` | `Europe/Paris` | Container timezone. |
| `RETENTION_DAYS` | `7` | How long historical metrics stay in SQLite. |
| `PUBLIC_URL` | _none_ | Public URL when the hub sits behind a reverse proxy. |
| `VIDEO_GID` / `RENDER_GID` | `44` / `109` | AMD only. Override if `getent group video render` shows other numbers (ROCm sometimes moves `render` to 992). |
| `AUTO_UPDATE_CHECK_INTERVAL_MS` | 1 hour | How often the hub checks connected agents for a pending update. |
| `AUTO_UPDATE_COOLDOWN_MS` | 5 minutes | Minimum delay between two update pushes to the same agent. |
| `OLLAMA_DIR` | _none_ | Host Ollama directory, mounted read-only into the sidecar. See [Ollama model names](#ollama-model-names). |

Agent-side variables are listed in [`agent/README.md`](../agent/README.md#configuration-environment-variables).

## Ollama model names

An Ollama runner command line only holds the weights blob digest
(`sha256:c8985d236593`). To show the real name (`llama3.1:8b`), the agent
reads the Ollama manifests and maps each digest to its `model:tag`.

Most setups need nothing: the agent looks for the manifests next to the blob
the runner has open, inside the runner's container and at the matching host
directory (a Docker bind mount of `~/.ollama` is followed through
`/proc/<pid>/mountinfo`), so an Ollama in its own container or with a custom
`OLLAMA_MODELS` is found too. That needs `CAP_SYS_PTRACE`, granted by the
systemd installer and the Docker compose files, and a manifests directory
readable by the agent user. The steps below are only for when the badge
still shows a digest with a warning icon (typically a Docker agent with
Ollama outside its container, or Ollama data in a Docker named volume).

Find the Ollama directory on the host (the one holding `models/manifests`):

| Ollama install | Directory |
|---|---|
| Official Linux script (systemd, `ollama` user) | `/usr/share/ollama/.ollama` |
| Run as root | `/root/.ollama` |
| Run as a normal user | `~/.ollama` |
| `OLLAMA_MODELS` set | its parent: the manifests are in `$OLLAMA_MODELS/manifests` |

**Docker sidecar (hub `docker-compose.yaml`)**

1. Add the directory to `.env`:
   ```bash
   OLLAMA_DIR=/usr/share/ollama/.ollama
   ```
2. In `docker-compose.yaml`, uncomment this line under `volumes:` of your
   sidecar (`agent-nvidia` or `agent-amd`):
   ```yaml
   - ${OLLAMA_DIR:-/usr/share/ollama/.ollama}:/host/ollama:ro
   ```
   `OLLAMA_MANIFESTS_DIR: /host/ollama/models/manifests` is already set.
3. `docker compose up -d` to recreate the container.

For a standalone agent compose file (`docker-compose.agent.*.yaml`), add both
the volume and `OLLAMA_MANIFESTS_DIR: /host/ollama/models/manifests` yourself.

**systemd agent**: the agent runs as the `gpuviewr-agent` user, so the
manifests directory must be readable by it (`/root/.ollama` or a private
home are not). If auto-detection misses it, add
`OLLAMA_MANIFESTS_DIR=<dir>/models/manifests` to `/etc/gpuviewr-agent.env`,
give `gpuviewr-agent` read access to that directory, then
`systemctl restart gpuviewr-agent`. Variables added there survive a re-run
of the installer.

**Check**: the badge shows the name after the next refresh. A model pulled
just now is retried within a minute. With no readable manifests, the agent
keeps showing the digest, nothing else breaks.

## Hidden GPU processes and model names

The process table flags two situations with a warning icon. Click it for
the fix matching the host.

**"N MiB of VRAM in use are not explained by the processes below"**: the
card has memory in use that no listed process accounts for, and the agent
was refused some `/proc/<pid>/fdinfo` reads. On AMD, fdinfo is the only way
to see GPU clients that don't use ROCm (`/dev/kfd`), such as a llama.cpp
Vulkan server: `rocm-smi` never lists them.

| Agent | Cause | Fix |
|---|---|---|
| systemd, installed before v0.10.2 | no `CAP_SYS_PTRACE`, processes of root or of containers are unreadable | run `--upgrade` (below) |
| Docker | `cap_add: [SYS_PTRACE]` missing | add it to the agent service, `docker compose up -d` |
| Docker, capability present | AppArmor blocks processes started directly on the host | use the systemd agent on that host |

Refresh an existing systemd agent (bundle + unit). It reads
`/etc/gpuviewr-agent.env`, so the host keeps its identity and settings and
no token is needed:

```bash
curl -fsSL http://<hub>:7510/install.sh | sudo bash -s -- --upgrade
```

The agent's auto-update only replaces its bundle, so this is the way unit
changes reach installs made with an older installer. Add `--url <hub>` to
point the agent at another hub. An install made with `--no-ptrace` stays
without the capability.

`CAP_SYS_PTRACE` lets the agent read other users' `/proc` entries (including
their environment). The unit filters out the syscalls that would let it act
on another process (`ptrace`, `process_vm_*`, `pidfd_getfd`). To install
without the capability, pass `--no-ptrace` to the installer: the agent then
lists only GPU processes it can read.

**Warning icon next to a model name**:

- `sha256:...`: Ollama model not resolved, see [Ollama model names](#ollama-model-names).
- Anonymous blob or no model: the command line carries no readable name.
  For llama.cpp, add `--alias <name>` or load a named `.gguf` with `-m`.

## Troubleshooting

**"No GPU detected" in the UI**: the local sidecar didn't connect.

```bash
docker compose logs gpuviewr-hub | grep -iE 'vendor|agent'
docker compose logs gpuviewr-hub-agent | tail -20
```

- `COMPOSE_PROFILES` empty in `.env`: no sidecar started. `install.sh`
  leaves it empty (and clears a stale value) when the GPU's sidecar can't
  start, see the [detection table](#quick-install). Fix what it reported,
  then re-run `install.sh`.
- AMD: `rocm-smi` exits 0 with empty output: permissions on `/dev/kfd` or
  `LD_LIBRARY_PATH`. The compose defaults work on Debian; override
  `VIDEO_GID` / `RENDER_GID` if `getent group video render` shows other
  numbers.
- NVIDIA: the container can't see `nvidia-smi`: the NVIDIA Container
  Toolkit is not installed on the host.

**The UI shows a container id instead of the hostname**: the
`/etc/hostname` bind-mount didn't take effect. Run `docker compose down && up -d`
after pulling the latest compose file, or set `HUB_HOSTNAME=<your-name>`
in `.env`.

**Stale session after resetting `data/`**: the browser holds a JWT signed
by the old `JWT_SECRET`. The UI detects it and redirects to
`/login?expired=1`; if not, clear the site's localStorage and reload.
