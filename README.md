# GpuViewR, NVIDIA & AMD GPU Dashboard

<div align="center">

<img src="public/GpuViewR-Ban.png" alt="GpuViewR" width="628" height="458" />

[![Release](https://img.shields.io/github/v/release/Erreur32/GpuViewR?style=for-the-badge&logo=github&logoColor=white&label=Release&color=111827)](https://github.com/Erreur32/GpuViewR/releases)
![Docker](https://img.shields.io/badge/Docker-Ready-1f2937?style=for-the-badge&logo=docker&logoColor=38bdf8)
![NVIDIA](https://img.shields.io/badge/NVIDIA-GPU-111827?style=for-the-badge&logo=nvidia&logoColor=76b900)
![AMD](https://img.shields.io/badge/AMD-ROCm-111827?style=for-the-badge&logo=amd&logoColor=ed1c24)
![macOS](https://img.shields.io/badge/macOS-Apple_Silicon-111827?style=for-the-badge&logo=apple&logoColor=white)
[![License](https://img.shields.io/badge/License-MIT-111827?style=for-the-badge&color=111827&labelColor=111827&logoColor=white)](LICENSE)

[![OSSF Scorecard](https://img.shields.io/ossf-scorecard/github.com/Erreur32/GpuViewR?style=for-the-badge&label=Scorecard)](https://scorecard.dev/viewer/?uri=github.com/Erreur32/GpuViewR)
[![CodeQL](https://img.shields.io/badge/CodeQL-active-brightgreen?style=for-the-badge&logo=github)](https://github.com/Erreur32/GpuViewR/security/code-scanning)
[![Snyk](https://img.shields.io/github/actions/workflow/status/Erreur32/GpuViewR/snyk.yml?style=for-the-badge&logo=snyk&logoColor=white&label=Snyk&color=111827)](https://github.com/Erreur32/GpuViewR/actions/workflows/snyk.yml)
[![SonarCloud](https://img.shields.io/sonar/quality_gate/Erreur32_GpuViewR2?server=https%3A%2F%2Fsonarcloud.io&style=for-the-badge&logo=sonarcloud&logoColor=white&label=Sonar)](https://sonarcloud.io/summary/overall?id=Erreur32_GpuViewR2)

**Real-time GPU monitoring dashboard, NVIDIA + AMD, single Docker image.**

</div>

> 🧠 **Built for AI / LLM workloads** (Ollama, llama.cpp, vLLM, ComfyUI,
> LM Studio, ...): VRAM, utilization, temperature and per-process usage
> across your whole fleet, in real time. Works just as well for gaming and
> render boxes.

<div align="center">

<table>
<tr>
<td align="center" width="20%" height="64"><img src="public/icons/nvidia.svg" height="48" alt="NVIDIA" /></td>
<td align="center" width="20%" height="64"><img src="public/icons/amd.svg" height="48" alt="AMD" /></td>
<td align="center" width="20%" height="64"><img src="public/icons/linux.svg" height="48" alt="Linux" /></td>
<td align="center" width="20%" height="64"><img src="public/icons/windows.svg" height="48" alt="Windows" /></td>
<td align="center" width="20%" height="64"><img src="public/icons/apple.svg" height="48" alt="macOS" /></td>
</tr>
<tr>
<td align="center" valign="top"><b>NVIDIA</b><br/><sub>nvidia-smi + pmon</sub></td>
<td align="center" valign="top"><b>AMD</b><br/><sub>ROCm / sysfs amdgpu</sub></td>
<td align="center" valign="top"><b>Linux</b><br/><sub>systemd / Docker</sub></td>
<td align="center" valign="top"><b>Windows</b><br/><sub>Scheduled Task - PDH</sub></td>
<td align="center" valign="top"><b>macOS</b><br/><sub>Apple Silicon - LaunchAgent</sub></td>
</tr>
</table>

**One dashboard for a mixed fleet**: NVIDIA, AMD and Intel GPUs on Linux,
Windows and macOS, each host with its own colour on every chart.

</div>

<div align="center">

[**Live demo**](https://erreur32.github.io/GpuViewR/) · [**Multi-host demo**](https://erreur32.github.io/GpuViewR/fleet?fleet=1) (synthetic data, runs entirely in the browser)

[Install](#install) · [Add a machine](#add-a-machine) · [Documentation](#documentation) · [Contributing](Docs/CONTRIBUTING.md)

</div>

---

<div align="center">

<img src="public/chrome-capture-2026-10-02.png" alt="GpuViewR dashboard screenshot" />

</div>

## Features

- **NVIDIA, AMD, Intel**: auto-detected, multi-GPU per host
- **Multi-host**: one hub, lightweight agents on Linux (systemd or Docker), Windows and macOS; an agent can also report to several hubs
- **Per-process view**: VRAM, GPU and CPU per process, with LLM runtime and model detection
- **Alerts**: sustain + cooldown, Discord / Telegram / MQTT / webhook
- **Exports**: Prometheus, InfluxDB, MQTT
- **Agent auto-update** from the hub, opt-in per host
- **Single Docker image**, multi-arch (amd64 / arm64), English / French UI

## Install

```bash
mkdir -p /opt/gpuviewr && cd /opt/gpuviewr
curl -fsSL https://raw.githubusercontent.com/Erreur32/GpuViewR/main/install.sh | bash
```

The script detects your GPU vendor, writes `docker-compose.yaml` and a
`.env` with random secrets, and starts the stack. Open
`http://<your-host-ip>:7510`: the first account you create is admin.

Update: `docker compose pull && docker compose up -d`.

Prefer writing the compose file yourself? Ready-to-use examples (hub only,
NVIDIA, AMD) and the supported hub platforms:
[Docs/INSTALL.md#compose-examples](Docs/INSTALL.md#compose-examples).

Requires Docker with Compose v2, plus the NVIDIA Container Toolkit for
NVIDIA GPUs. Manual install, macOS (Docker Desktop), configuration and
troubleshooting: [Docs/INSTALL.md](Docs/INSTALL.md).

## Add a machine

In the hub: **Settings → Hosts → + Add host**. The dialog gives a
ready-to-paste install command for Linux, Docker, Windows or macOS. See
[Docs/REMOTE_HOSTS.md](Docs/REMOTE_HOSTS.md) for each platform, multi-hub
and auto-update.

## Documentation

| | |
|---|---|
| [Install & configuration](Docs/INSTALL.md) | Hub install, update, first login, `.env` reference, troubleshooting |
| [Remote hosts](Docs/REMOTE_HOSTS.md) | Linux, Docker, Windows, macOS agents, multi-hub, auto-update |
| [Agent reference](agent/README.md) | Every agent install mode and environment variable |
| [Architecture](Docs/ARCHITECTURE.md) | How hub and agents fit together, collectors per platform |
| [Migration](Docs/MIGRATION.md) | Coming from bigsk1/gpu-monitor, upgrade notes |
| [Changelog](CHANGELOG.md) | Every release |

## Help wanted

- **macOS**: the Apple Silicon agent has only been tested on synthetic
  data. Have an M-series Mac? A two-minute capture helps:
  [Help the macOS agent](agent/README.md#help-the-macos-agent).
- **Windows with an AMD or Intel GPU**: please report whether GPU %
  moves under load (the fix is only confirmed on NVIDIA so far).

Planned: a filesystem handshake to replace the sidecar's bootstrap secret,
the macOS process list, RBAC.

## Contributing

See [Docs/CONTRIBUTING.md](Docs/CONTRIBUTING.md). Quick local dev with
fake GPUs:

```bash
npm install
npm run dev:mock     # dashboard on http://localhost:5181, API on :3015
```

License: MIT (see [LICENSE](LICENSE)).
