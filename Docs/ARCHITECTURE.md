# Architecture

```
              ┌──────────────────────┐
              │ Hub (vendor-neutral) │  REST + WebSocket + SQLite + UI
              │                      │  no GPU code, no /dev devices
              └──────────▲───────────┘
                         │ WebSocket /agent
        ┌────────────────┼──────────────────┬─────────────────┐
        │                │                  │                 │
  ┌─────┴──────┐   ┌─────┴──────┐   ┌───────┴──────┐   ┌──────┴──────┐
  │ Local      │   │ Linux      │   │ Windows      │   │ macOS       │
  │ sidecar    │   │ agent      │   │ agent        │   │ agent       │
  │ (NVIDIA or │   │ (systemd   │   │ (Scheduled   │   │ (LaunchAgent│
  │  AMD)      │   │  or Docker)│   │  Task)       │   │  powermetrics)
  └────────────┘   └────────────┘   └──────────────┘   └─────────────┘
```

- **The hub speaks no GPU.** Every sample, local or remote, arrives through
  the agent ingest WebSocket. The local sidecar is just another agent that
  enrolls on first boot with the `LOCAL_AGENT_BOOTSTRAP` secret from `.env`.
- **Agents push**, the hub never connects to them: only the hub needs to be
  reachable. Each agent authenticates with its own token (stored hashed on
  the hub), can be disabled or rotated from the UI, and can report to
  several hubs at once.
- **One agent, one bundle**: the agent is a single `agent.mjs` (Node 22)
  shared by every platform. It picks its collectors at boot:

| Platform | GPU metrics | Process list |
|---|---|---|
| Linux NVIDIA | `nvidia-smi` | `nvidia-smi` (compute apps, `-q -d PIDS`, `pmon`) + `/proc` |
| Linux AMD | sysfs `/sys/class/drm` (`rocm-smi` fallback) | DRM fdinfo + `/proc` |
| Windows NVIDIA | `nvidia-smi.exe` | PDH per-process counters, mapped to the NVIDIA card |
| Windows AMD / Intel | PDH counters | PDH per-process counters |
| macOS Apple Silicon | `powermetrics` | not yet |

- **Storage**: one SQLite file (`data/gpuviewr.db`) for users, hosts,
  metrics history, alerts and settings. Retention is configurable.
- **Outputs**: alerts (Discord / Telegram / MQTT / webhook) and exports
  (Prometheus, InfluxDB, MQTT) are computed on the hub, per host.

## Design documents

- [`MULTI_HOST_PLAN.md`](MULTI_HOST_PLAN.md): the original multi-host
  design (v0.3): agent push model, enrollment and tokens, wire protocol.
  Some parts were superseded later, see its status block.
- [`MACOS_AGENT.md`](MACOS_AGENT.md): the macOS / Apple Silicon agent
  design and its validation status.
