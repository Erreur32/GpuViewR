# Security Policy

## Supported versions

Only the latest minor release line of GpuViewR receives security fixes.
Older tags are kept for historical reference and will not be patched.

| Version  | Supported          |
| -------- | ------------------ |
| `0.1.x`  | :white_check_mark: |
| `< 0.1`  | :x:                |

## Reporting a vulnerability

Please **do not** open a public GitHub issue for a suspected
vulnerability.

1. Use GitHub's private vulnerability reporting:
   <https://github.com/Erreur32/GpuViewR/security/advisories/new>
2. Or e-mail the maintainer at **dev@echosystem.fr** with:
   - Affected version / commit hash
   - Reproduction steps or proof-of-concept
   - Expected vs. observed behavior
   - Your assessment of impact (RCE, auth bypass, info leak, ...)

You can expect:

- An acknowledgement within **5 business days**
- A status update within **15 business days**
- A coordinated public disclosure once a fix is released, with credit
  to the reporter unless anonymity is requested

## Scope

In scope:

- The Express backend (`server/`), the WebSocket stream, the SQLite
  storage layer, the Prometheus / MQTT / InfluxDB / webhook exporters
- The React frontend (`src/`)
- The published Docker image `ghcr.io/erreur32/gpuviewr`
- The release pipeline (`.github/workflows/`)

Out of scope:

- Issues that require physical access or root on the host
- Findings on third-party services GpuViewR talks to (your MQTT
  broker, your Influx instance, etc.)
- Self-XSS without authentication bypass
- Denial-of-service through excessive load on a single instance

## Hardening recommendations for operators

- Always set a strong, random `JWT_SECRET` (the container refuses to
  start without one).
- Run the dashboard behind HTTPS (reverse proxy: Caddy, Traefik,
  nginx, Nginx Proxy Manager).
- Restrict access to the `/metrics` endpoint at the proxy layer if
  your Prometheus scraper does not live on the same network.
- Keep the container image up to date — pull a fresh tag on each
  release and rebuild.
