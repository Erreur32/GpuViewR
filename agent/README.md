# GpuViewR Agent

Lightweight remote collector for the GpuViewR fleet. Lives on each machine you want to monitor and pushes `nvidia-smi` samples to a central hub over an outbound WebSocket.

> v0.3.0 — GPU samples only. `system / temps / processes` capabilities are negotiated in the hello frame but ship as no-ops on the wire side until jalon 5 of the multi-host plan ([Docs/MULTI_HOST_PLAN.md](../Docs/MULTI_HOST_PLAN.md)).

## Quick start (curl install.sh, recommended)

The hub serves a one-liner installer at `/install.sh`. Run as root on
the remote machine after `Settings → Hosts → + Add host` on the hub:

```bash
curl -fsSL https://gpu.example.com/install.sh | sudo bash -s -- \
  --url https://gpu.example.com \
  --token <host_id>.<secret>
```

The script:

- detects distro (Debian 11+/Ubuntu 22+/Rocky/Alma/RHEL 9+/Fedora),
- installs Node 22 via NodeSource if missing,
- creates a `gpuviewr-agent` system user and `/opt/gpuviewr-agent/`,
- downloads the agent bundle from `${HUB_URL}/agent.mjs`,
- writes `/etc/gpuviewr-agent.env` (mode 0600) and `/etc/systemd/system/gpuviewr-agent.service`,
- starts the unit (`systemctl enable --now gpuviewr-agent`).

Tail the agent's connect handshake:

```bash
journalctl -u gpuviewr-agent -f
```

Uninstall later:

```bash
curl -fsSL https://gpu.example.com/install.sh | sudo bash -s -- --uninstall
```

## Quick start (Docker)

1. **On the hub**: `Settings → Hosts → + Add host`. Type a label, hit Generate. The modal shows your `HOST_ID` + `AGENT_TOKEN` **once**. Copy them.

2. **On the remote machine**:

```bash
docker run -d --name gpuviewr-agent \
  --gpus all \
  --restart unless-stopped \
  -e HUB_URL=wss://gpu.example.com/agent \
  -e HOST_ID=550e8400-e29b-41d4-a716-446655440042 \
  -e AGENT_TOKEN=gpvr_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx \
  ghcr.io/erreur32/gpuviewr-agent:latest
```

The card on the hub's `/fleet` view turns green within 1–3 seconds.

### Pre-requisites on the remote host

- NVIDIA Container Toolkit installed ([install guide](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html))
- `docker run --rm --gpus all nvidia/cuda:12.4.0-base-ubuntu22.04 nvidia-smi` returns the GPU list
- Outbound TCP to the hub (port 443 if `wss://` behind a reverse proxy)

## Docker Compose

A drop-in `docker-compose.agent.nvidia.yaml` lives at the project root. Copy it to the remote host with a tiny `.env`:

```env
HUB_URL=wss://gpu.example.com/agent
HOST_ID=550e8400-e29b-41d4-a716-446655440042
AGENT_TOKEN=gpvr_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Then:

```bash
docker compose -f docker-compose.agent.nvidia.yaml up -d
docker compose -f docker-compose.agent.nvidia.yaml logs -f
```

## Bare-metal (Node 22)

If you don't have Docker on the host (HPC, locked-down CI runner, etc.):

```bash
# 1. Install Node 22+ (nvm, Debian backports, NodeSource, …)
node --version  # >=22

# 2. Clone or download just the /agent folder + server/services/_nvidiaParsers.ts
git clone --depth 1 https://github.com/Erreur32/GpuViewR.git
cd GpuViewR/agent
npm ci --omit=dev

# 3. Run
HUB_URL=wss://gpu.example.com/agent \
HOST_ID=... \
AGENT_TOKEN=... \
npm start
```

For a long-running install, wrap it in a systemd unit (sample under `Docs/MULTI_HOST_PLAN.md` §15.2 mode 3).

## Windows (NVIDIA only, GPU stats only)

The agent runs on Windows 10/11 with the standard NVIDIA driver — GPU samples stream to the hub exactly like on Linux. Process list and CPU stats are **not** collected (no `/proc`, and `nvidia-smi pmon` isn't supported on the WDDM driver model). AMD on Windows is not supported (no `rocm-smi` equivalent).

PowerShell as **Administrator**:

```powershell
# 1. Install Node 22+ from https://nodejs.org (msi installer)
node --version  # >=22

# 2. Grab the prebuilt bundle
mkdir C:\ProgramData\GpuViewR-Agent
cd C:\ProgramData\GpuViewR-Agent
Invoke-WebRequest https://gpu.example.com/agent.mjs -OutFile agent.mjs

# 3. Run (token from "Settings → Hosts → + Add host" on the hub)
$env:HUB_URL  = "wss://gpu.example.com/agent"
$env:HOST_ID  = "<uuid from the hub>"
$env:AGENT_TOKEN = "<secret from the hub>"
node agent.mjs
```

To run on boot, register it as a Scheduled Task with trigger _At startup_, action `node.exe`, argument `C:\ProgramData\GpuViewR-Agent\agent.mjs`, and the three env vars baked into the task definition (Task Scheduler GUI → Actions → New → Environment).

## Configuration — environment variables

### Required

| Var           | Description                                                                                                                                         |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HUB_URL`     | Full WS URL, e.g. `wss://gpu.example.com/agent`. `ws://` is allowed only against loopback / RFC1918 private ranges; against a public host it warns. |
| `HOST_ID`     | UUID issued by the hub at enrollment. **Never** put `local` here — that ID is reserved for the hub's own collector.                                 |
| `AGENT_TOKEN` | Opaque secret issued by the hub at enrollment. Stored as a bcrypt hash on the hub. Shown to you exactly once.                                       |

### Optional

| Var                    | Default                      | Description                                                                                                                                                                                                                                                              |
| ---------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `TICK_MS`              | `1000`                       | nvidia-smi sample interval (the cheap `--query-gpu` call).                                                                                                                                                                                                               |
| `PCIE_TICK_MS`         | `5000`                       | Refresh cadence for the expensive `nvidia-smi -q` (PCIe RX/TX). Decoupled from `TICK_MS` because the full-driver dump is ~5x more costly to spawn and PCIe throughput moves slowly. Raise to lower CPU further; lower toward `TICK_MS` if you need 1 Hz PCIe sparklines. |
| `FEATURES`             | `gpu,system,temps,processes` | CSV of collectors to advertise in the hello frame. In v0.3.0 only `gpu` actually publishes; the others are reserved.                                                                                                                                                     |
| `LOG_LEVEL`            | `info`                       | `debug` / `info` / `warn` / `error`.                                                                                                                                                                                                                                     |
| `NVIDIA_SMI_PATH`      | `nvidia-smi`                 | Override if the binary lives elsewhere (WSL2, exotic packaging).                                                                                                                                                                                                         |
| `RECONNECT_MAX_MS`     | `30000`                      | Cap on the exponential reconnect backoff.                                                                                                                                                                                                                                |
| `AGENT_BUFFER_PERSIST` | `0`                          | Reserved for v0.3.1 (disk-mirrored ring buffer).                                                                                                                                                                                                                         |
| `AGENT_LABEL`          | _(none)_                     | Optional hostname hint sent in the hello frame. The hub-assigned label wins if both are set.                                                                                                                                                                             |
| `TLS_INSECURE`         | `0`                          | Disable cert verification. Dev only.                                                                                                                                                                                                                                     |
| `MOCK_GPU`             | `0`                          | Emit synthetic samples instead of calling `nvidia-smi`. Useful for hub-side end-to-end testing without a real GPU.                                                                                                                                                       |
| `HOSTNAME`             | _(none)_                     | Standard; whatever Docker / systemd / the OS sets. Sent informationally in hello.                                                                                                                                                                                        |
| `HEARTBEAT_FILE`       | `/tmp/.gpuviewr-agent-alive` | Path touched on every successful WS frame send. The compose `healthcheck:` block reads this file's mtime via `node -e`. Override only if you also update the matching path in the compose healthcheck command, the two must stay in sync.                                |

## Verifying the connection

On the hub:

```bash
curl -H "Authorization: Bearer $JWT" https://gpu.example.com/api/hosts | jq
```

Look for your `HOST_ID` with `status: "online"` and a recent `last_seen`.

## Troubleshooting

| Symptom                                                  | Likely cause                                                                                                                   |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `Fatal close code 4001` repeated then exit               | `HOST_ID` or `AGENT_TOKEN` wrong, or the host was deleted on the hub. Re-enroll.                                               |
| `nvidia-smi not found at nvidia-smi — exiting`           | NVIDIA Container Toolkit missing or the binary is at a non-standard path. Test with `docker exec gpuviewr-agent nvidia-smi`.   |
| Stuck reconnecting, no welcome                           | `HUB_URL` typo, or the hub's `/agent` endpoint isn't proxied through your reverse proxy. WS upgrade headers must pass through. |
| Hub shows `lagging` then `offline` while the agent is up | Clock drift > 30s; install NTP. The watchdog is keyed off `last_seen` reported by the hub.                                     |
| `1008 Policy Violation` close                            | Hub's rate limit (100 msg/s/session) tripped. Don't spam frames — `TICK_MS` should stay ≥ 100.                                 |

## Building the Docker image yourself

The Dockerfile expects the **project root** as its build context (not `agent/`), because it copies `server/services/_nvidiaParsers.ts` to keep the parser shared:

```bash
docker build -f agent/Dockerfile -t gpuviewr-agent:dev .
```

The final image is ~70 MB compressed: distroless Node 22 + a single bundled `agent.mjs` + the `ws` library. No shell, no nvidia-smi inside (it comes from the host via the Container Toolkit).

## Versioning

The agent's semver is tied to the hub's — the same git tag publishes both `ghcr.io/erreur32/gpuviewr:X.Y.Z` and `ghcr.io/erreur32/gpuviewr-agent:X.Y.Z`. The wire protocol has its own `protocol_ver` field (currently `1`) advertised in the welcome / hello frames so a newer hub can keep supporting an older agent for at least one minor cycle.
