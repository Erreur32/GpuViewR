# Read-only API and MCP

Both are off by default. An admin turns them on in **Settings > API** and **Settings > MCP**, and creates
access tokens there (`gvk_...`, shown once, stored as a SHA-256 hash). One token opens both surfaces, and
can only read.

## REST API (`/api/v1`)

`Authorization: Bearer gvk_...`, GET only (anything else answers 405).

| Endpoint | Returns |
|---|---|
| `/api/v1/health` | hub version, uptime, GPU and host counts |
| `/api/v1/hosts` | monitored machines |
| `/api/v1/gpus?host=<id>` | latest reading of every GPU (whole fleet without `host`) |
| `/api/v1/gpus/history?host=<id>&gpu=0&range=1h` | time series, at most ~1800 points |
| `/api/v1/gpus/stats?host=<id>&gpu=0&range=24h` | min / avg / max |
| `/api/v1/processes?host=<id>&gpu=0` | processes on the GPUs of a host |
| `/api/v1/llm` | LLM processes of the whole fleet |

`range` accepts `live`, `90s`, `15m`, `6h`, `7d`.

## MCP (`/mcp`)

Streamable HTTP, POST only, stateless. Same bearer token. Tools: `get_health`, `list_hosts`, `list_gpus`,
`get_gpu_history`, `get_gpu_stats`, `list_processes`, `list_llm_processes` (all annotated `readOnlyHint`).

```bash
claude mcp add --transport http gpuviewr https://<hub>/mcp --header "Authorization: Bearer gvk_..."
```

Requests carrying a foreign `Origin` header are refused (DNS rebinding guard).
