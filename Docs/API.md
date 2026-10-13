# Read-only API and MCP

Both are off by default. An admin turns them on in **Settings > API** and **Settings > MCP**, and creates
access tokens there (`gvk_...`, shown once, stored as a SHA-256 hash). One token opens both surfaces, and
can only read.

## REST API (`/api/v1`)

`Authorization: Bearer gvk_...`, GET only (anything else answers 405).

| Endpoint | Returns |
|---|---|
| `/api/v1/health` | hub version, uptime, GPU and host counts, latest published release |
| `/api/v1/hosts` | monitored machines, with real hostname and LAN IPs |
| `/api/v1/gpus?host=<id>` | latest reading of every GPU (whole fleet without `host`) |
| `/api/v1/gpus/history?host=<id>&gpu=0&range=1h` | time series, at most ~1800 points |
| `/api/v1/gpus/stats?host=<id>&gpu=0&range=24h` | min / avg / max |
| `/api/v1/gpus/stats/all?range=24h` | min / avg / max of every GPU of the fleet, one call |
| `/api/v1/processes?host=<id>&gpu=0` | processes on the GPUs of a host |
| `/api/v1/llm` | LLM processes of the whole fleet, with server port and alias |

`range` accepts `live`, `90s`, `15m`, `6h`, `7d`.

Fields are only ever added, never renamed or removed.

### `/api/v1/hosts`

Besides the stored columns (`id`, `label`, `kind`, `status`, `agent_version`, `install_mode`, `last_seen`, ...):

| Field | Since | Meaning |
|---|---|---|
| `hostname` | | Real machine name reported by the agent (v0.13.0+). `null` when unknown, for example a Docker agent without the `/etc/hostname:/host/etc/hostname:ro` mount (or `AGENT_HOSTNAME` env). Older agents may report a container id. |
| `ips` | 0.13.0 | LAN IPv4s of the machine, refreshed on every agent ping (15 s). Loopback, link-local, `172.17.x`, `docker0`, `br-*`, `veth*`, `virbr*` and Hyper-V / VirtualBox / VMware host-only adapters are left out. A Docker agent reads them from the host through `/host/proc/1/net`. `[]` until a v0.13.0+ agent connects. |
| `remote_addr` | 0.13.0 | Address the agent's WebSocket comes from, as seen by the hub (first `X-Forwarded-For` hop behind a proxy). Fallback when `ips` is empty. |
| `capabilities` | | Unchanged: the agent capabilities as a JSON **string**. |
| `capabilities_object` | 0.13.0 | The same data as an object, `null` before the first hello. |

```json
{
  "hosts": [
    {
      "id": "3f2c9a1e-...",
      "label": "Deb13",
      "hostname": "deb13",
      "kind": "agent",
      "endpoint": null,
      "capabilities": "{\"gpu\":true,\"system\":true,\"temps\":true,\"processes\":true,\"ptrace\":\"granted\"}",
      "agent_version": "0.13.0",
      "install_mode": "systemd",
      "auto_update": 1,
      "protocol_ver": 1,
      "enrolled_at": 1758000000,
      "last_seen": 1760350000,
      "status": "online",
      "last_update_check_at": 1760349000,
      "last_update_pushed_at": null,
      "last_update_pushed_version": null,
      "color": null,
      "remote_addr": "192.168.32.209",
      "ips": ["192.168.32.209"],
      "capabilities_object": { "gpu": true, "system": true, "temps": true, "processes": true, "ptrace": "granted" }
    }
  ]
}
```

### `/api/v1/gpus/stats/all`

Same aggregates as `/api/v1/gpus/stats` (`temp_*`, `util_*`, `mem_*`, `pow_*`, `fan_*` with `_min`, `_avg`, `_max`)
for every GPU that has samples in the window, flat, one row each:
`{ "range": "24h", "count": 3, "stats": [{ "host_id", "host_label", "gpu_index", "gpu_name", "samples", "temp_min", ... }] }`.

### `/api/v1/llm`

Each row also carries:

| Field | Meaning |
|---|---|
| `llm_port` | Port the model server listens on: `--port` from its command line, else the runtime default (Ollama 11434, llama.cpp 8080, `llama_cpp.server` and vLLM 8000, KoboldCpp 5001, LM Studio 1234, ...). For a process in a container (`container_id` set) it is the port inside the container. `null` when unknown. |
| `llm_port_source` | `cmdline` or `default`. Ollama is always `default`: its runner's `--port` is internal, the API port lives in `OLLAMA_HOST`. |
| `llm_alias` | `--alias` / `-a` (llama.cpp) or `--served-model-name` (vLLM, SGLang), else `null`. |

### `/api/v1/health`

| Field | Meaning |
|---|---|
| `update_check_enabled` | Settings > Updates switch. |
| `latest_version` | Newest published release from the update checker cache, `null` when off or never checked. |
| `update_available` | `true` when `latest_version` is newer than `version`. |
| `update_checked_at` | ISO time of that check. |

The call never waits on GitHub: a stale cache (older than the configured frequency) is refreshed in the background
and shows up on a later call.

## MCP (`/mcp`)

Streamable HTTP, POST only, stateless. Same bearer token. Tools: `get_health`, `list_hosts`, `list_gpus`,
`get_gpu_history`, `get_gpu_stats`, `get_fleet_gpu_stats`, `list_processes`, `list_llm_processes` (all annotated `readOnlyHint`).

```bash
claude mcp add --transport http gpuviewr https://<hub>/mcp --header "Authorization: Bearer gvk_..."
```

Requests carrying a foreign `Origin` header are refused (DNS rebinding guard).
