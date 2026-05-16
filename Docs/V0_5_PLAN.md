# Plan d'architecture — GpuViewR v0.5.0 (sidecar agent + multi-hub)

> Objet : sortir le hub de toute logique vendor-aware (NVIDIA / AMD), pousser la collecte GPU **exclusivement** dans l'agent, y compris pour le host qui fait tourner le hub lui-même (sidecar local). Cible : v0.5.0.
>
> **Statut : plan d'architecture. Aucun code écrit. À valider point par point avant J1.**
>
> Hors scope : RBAC multi-organisation, sharding SQLite, agent dans un mode pull. La présente note couvre le refactor backend + le packaging Docker + la migration des installs v0.4.x.

---

## Décisions arrêtées (à valider)

| # | Sujet | Décision | Cf. |
|---|---|---|---|
| **D1** | Architecture hub | **Hub 100 % vendor-neutral.** Aucun collecteur GPU dans l'image hub. Tout passe par l'ingest agent WS. | §1, §3 |
| **D2** | Local GPU sur le host master | **Sidecar pattern.** Le compose lance hub + agent local dans la même stack. ~+40 MB RAM, −80 MB image hub. | §1, §4 |
| **D3** | Auto-enrollment du sidecar | **Bootstrap token partagé** via env compose (`LOCAL_AGENT_BOOTSTRAP=$(openssl rand)`). Hub auto-crée la row au 1er frame WS. Pas d'enrollment UI pour le sidecar. | §5 |
| **D4** | Packaging | **Un seul `docker-compose.yaml` au repo** avec deux profiles Docker Compose (`nvidia`, `amd`). install.sh détecte le vendor host et écrit `COMPOSE_PROFILES=<vendor>` dans `.env` — l'utilisateur ne voit qu'un fichier, `docker compose up -d` fait le bon truc. Les fichiers `compose.agent.{nvidia,amd}.yaml` séparés restent pour les agents purement distants. | §4, §6 |
| **D5** | Agent multi-hub | **1 agent peut pousser ses samples vers N hubs en parallèle.** `HUB_URLS=wss://h1,wss://h2` + tokens parallèles. Buffer offline par-hub. Backward-compat avec `HUB_URL` singulier. | §7 |
| **D6** | Migration v0.4.x → v0.5.0 | **Best-effort.** Si la migration est facile à coder, on la fait pour préserver l'historique des early-adopters. Sinon, repartir de zéro est acceptable — base d'utilisateurs encore restreinte. Pas un blocker de release. | §8 |
| **D7** | Sécurité bootstrap token | **LAN-only suffisant pour v0.5.** Le secret partagé reste dans `.env` + docker network interne. Migration vers handshake filesystem (one-shot token file) prévue v0.6 si besoin. | §5 |
| **D8** | Version bump | **Minor : v0.5.0.** Pas v1.0 — le user upgrade `docker compose pull && up -d` continue de marcher (auto-migration). | §8, §9 |

---

## 1. Pourquoi le hub doit perdre son vendor-aware

État v0.4.x :

```
Hub container
├── server/services/gpuCollector.ts          ← nvidia-smi local
├── server/services/rocmGpuCollector.ts      ← rocm-smi local
├── server/services/activeGpuCollector.ts    ← vendor resolver
├── server/services/processCollector.ts      ← nvidia compute procs
├── server/services/rocmProcessCollector.ts  ← rocm compute procs
└── Dockerfile : python3 + libdrm-amdgpu1 baked
```

Les **mêmes fonctions** existent dans `agent/src/collectors/` (gpu, gpuRocm, processes, processesRocm). Les parsers sont partagés depuis v0.4.0 mais l'orchestration est dupliquée.

### Symptômes concrets de la dette

- Hub image trimballe `python3` (~30 MB) + `libdrm-amdgpu1` même quand l'utilisateur déploie sur un host sans GPU local.
- Compose AMD demande un bind-mount `/opt/rocm`, des devices `/dev/kfd` + `/dev/dri`, un GID juggling `video`/`render` côté hub — alors que ces mêmes contraintes sont déjà documentées pour l'agent.
- Le bug "label `48f38404d5f8` au lieu de `jarvis`" venait de cette logique hub-side. La résoudre proprement demande `hostHostname.ts` + des bind-mounts qui n'existeraient pas si le hub était neutre.
- `processCollector` MOCK\_GPU branch appelle `getActiveCollector().getLatest()` → couplage hub ↔ vendor même pour des données synthétiques.

### Ce que le hub garde

Tout ce qui n'est pas vendor-spécifique :

- `agentIngestWS` (WS server pour agents)
- `agentMetricsPersistor` (DB writer)
- `gpuStreamWS` (WS server pour le frontend)
- Routes REST (gpu, processes, system, health, alerts, exports, …)
- DB + auth + alertService + exportService
- UI (dist/)
- L'agent bundle (`agent/dist/agent.mjs`) pour servir `/install.sh` + `/agent.mjs` aux nouveaux remote agents

---

## 2. Schéma cible

```
                                            ┌─────────────────────────┐
                                            │  Hub container          │
                                            │  - REST + WS aggregator │
                                            │  - DB                   │
                                            │  - UI                   │
                                            │  - bundle agent.mjs     │
                                            │    pour /install.sh     │
                                            │  ports: 7510:3015       │
                                            └────────────▲────────────┘
                                                         │
                              docker network "gpuviewr"  │
                  ┌──────────────────────────────────────┼──────────────┐
                  │                                      │              │
        ┌─────────┴──────────────┐         ┌─────────────┴────────────┐
        │ Agent local (sidecar)  │         │ Remote agents (LAN/WAN)  │
        │ - Boot: lit            │         │ - Enroll via UI          │
        │   LOCAL_AGENT_BOOTSTRAP│         │ - Token bcrypt côté hub  │
        │ - Auto-créé côté hub   │         │ - Mode bare-metal        │
        │ - HOST_ID déterministe │         │   (curl install.sh) ou   │
        │   = local-sidecar-     │         │   Docker compose         │
        │     {hostname}         │         │ - 1 agent → N hubs       │
        │ - kind='agent'         │         │   (HUB_URLS array)       │
        │ - Vendor stack         │         │                          │
        │   (NVIDIA ou AMD)      │         │                          │
        └────────────────────────┘         └──────────────────────────┘
```

---

## 3. Modifications hub (J1)

### Fichiers supprimés

- `server/services/gpuCollector.ts`
- `server/services/rocmGpuCollector.ts`
- `server/services/activeGpuCollector.ts`
- `server/services/processCollector.ts`
- `server/services/rocmProcessCollector.ts`
- `server/services/_gpuCollectorBase.ts`
- `server/services/_procUtil.ts`
- `server/utils/nvidiaSmi.ts`
- `server/utils/rocmSmi.ts`
- `server/services/mockGpu.ts` (déplacé côté agent ou supprimé — voir §10)

### Fichiers modifiés

- `server/index.ts` : drop `gpuCollector.start()` + `processCollector.getSnapshot()` côté boot
- `server/routes/gpu.ts` : `/api/gpu/current` lit `metricsBus.getLatestByHost()` au lieu de `getActiveCollector().getLatest()` même pour `LOCAL_HOST_ID`
- `server/routes/processes.ts` : la branche `LOCAL_HOST_ID` lit `agentProcessStore.get()` comme les autres
- `server/routes/system.ts` : `/api/system` reste, lit `os.cpus()` etc. — le hub a quand même ses propres stats CPU/RAM (mais pas GPU)
- `server/routes/health.ts` : `gpuCount` lit la somme des `metricsBus.getLatestByHost()` pour le local-sidecar
- `server/services/gpuStreamWS.ts` : drop `gpuCollector.getLatest()` snapshot — au connect, snapshot lu depuis `metricsBus.getLatestByHost(LOCAL_HOST_ID)` ou équivalent

### Dockerfile hub

```diff
- RUN apt-get install -y python3 libdrm-amdgpu1 …
+ RUN apt-get install -y gosu tzdata wget ca-certificates …
```

Image hub passe de ~250 MB → ~170 MB.

### Validation J1

- `npx tsc --noEmit` clean
- `npm run build` clean
- Hub démarre sans collecteur, `/api/health` retourne `gpuCount: 0`
- Aucun frame de sample n'arrive jusqu'à ce qu'un agent se connecte

---

## 4. Compose files (J3) — **un seul `docker-compose.yaml` au repo via profiles**

Layout final :

```
docker-compose.yaml                      ← hub + agent-nvidia + agent-amd (profiles)
docker-compose.agent.nvidia.yaml         ← agent NVIDIA SEUL pour box remote (curl recipe)
docker-compose.agent.amd.yaml            ← agent AMD SEUL pour box remote (curl recipe)
```

### Mécanique : Docker Compose profiles

Un service avec `profiles: [<name>]` n'est démarré QUE si l'on passe `--profile <name>` à la commande compose, OU si la variable `COMPOSE_PROFILES=<name>` est dans l'env (`.env` au même dossier).

L'utilisateur ne voit qu'un fichier. `install.sh` écrit `COMPOSE_PROFILES=nvidia` (ou `amd`) dans `.env` au moment de l'install → tous les `docker compose up -d` / `pull` / `logs` suivants utilisent le bon profile sans flag à se rappeler.

### Structure de `docker-compose.yaml`

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
      LOCAL_AGENT_BOOTSTRAP: ${LOCAL_AGENT_BOOTSTRAP}
      HOST_IP: ${HOST_IP:-}
      TZ: ${TZ:-Europe/Paris}
      RETENTION_DAYS: ${RETENTION_DAYS:-7}
      HOST_PROC: /host/proc
      HOST_ETC: /host/etc
      # HUB_HOSTNAME: my-server     # optionnel override
    volumes:
      - ./data:/app/data
      - /proc:/host/proc:ro
      - /etc/hostname:/host/etc/hostname:ro
    networks: [gpuviewr]
    healthcheck:
      test: ["CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http://127.0.0.1:3015/api/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 20s

  # NVIDIA sidecar — démarré quand COMPOSE_PROFILES inclut "nvidia"
  agent-nvidia:
    image: ghcr.io/erreur32/gpuviewr-agent:latest
    container_name: gpuviewr-agent-local
    restart: unless-stopped
    profiles: [nvidia]
    depends_on:
      hub:
        condition: service_healthy
    environment:
      HUB_URL: ws://hub:3015/agent
      AGENT_TOKEN: ${LOCAL_AGENT_BOOTSTRAP}
      HOST_ID: local-sidecar-${HUB_HOSTNAME:-master}
      AGENT_LABEL: ${HUB_HOSTNAME:-master}
      GPU_VENDOR: nvidia
      TZ: ${TZ:-Europe/Paris}
    networks: [gpuviewr]
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: all
              capabilities: [gpu, utility]
    runtime: nvidia

  # AMD sidecar — démarré quand COMPOSE_PROFILES inclut "amd"
  agent-amd:
    image: ghcr.io/erreur32/gpuviewr-agent:latest
    container_name: gpuviewr-agent-local
    restart: unless-stopped
    profiles: [amd]
    depends_on:
      hub:
        condition: service_healthy
    environment:
      HUB_URL: ws://hub:3015/agent
      AGENT_TOKEN: ${LOCAL_AGENT_BOOTSTRAP}
      HOST_ID: local-sidecar-${HUB_HOSTNAME:-master}
      AGENT_LABEL: ${HUB_HOSTNAME:-master}
      GPU_VENDOR: amd
      ROCM_SMI_PATH: /opt/rocm/bin/rocm-smi
      LD_LIBRARY_PATH: /opt/rocm/lib:/opt/rocm/lib64
      TZ: ${TZ:-Europe/Paris}
    devices:
      - /dev/kfd
      - /dev/dri
    group_add:
      - "${VIDEO_GID:-44}"
      - "${RENDER_GID:-109}"
    volumes:
      - /opt/rocm:/opt/rocm:ro
    networks: [gpuviewr]

networks:
  gpuviewr:
    driver: bridge
```

### Côté `.env` (généré par install.sh)

```env
JWT_SECRET=…
LOCAL_AGENT_BOOTSTRAP=…
HOST_IP=192.168.32.210
HUB_HOSTNAME=jarvis
DASHBOARD_PORT=7510
TZ=Europe/Paris

# Profile choisi par install.sh — toutes les commandes docker compose
# suivantes utilisent ce profile sans flag à passer.
COMPOSE_PROFILES=amd     # ou: nvidia
```

### Modes d'utilisation (sans flag --profile à retenir)

| Cas | `.env` contient | Effet de `docker compose up -d` |
|---|---|---|
| Master NVIDIA | `COMPOSE_PROFILES=nvidia` | hub + agent-nvidia |
| Master AMD | `COMPOSE_PROFILES=amd` | hub + agent-amd |
| Aggregator-only (no GPU) | `COMPOSE_PROFILES=` (vide) ou ligne absente | hub seul |
| Switch de vendor | éditer `.env` puis `docker compose up -d` | l'ancien agent-* est arrêté, le nouveau démarré |

### Validation Docker

- `runtime: nvidia` n'existe **que dans `agent-nvidia`**, qui n'est jamais activé en mode AMD → pas d'erreur "nvidia runtime not installed" sur un host AMD.
- `devices: /dev/kfd` n'existe **que dans `agent-amd`**, qui n'est jamais activé en mode NVIDIA → pas d'erreur "no such device" sur un host NVIDIA.
- Le container_name `gpuviewr-agent-local` est partagé entre les 2 services mais Docker ne crée que celui actif → pas de conflit.

### Bénéfices

- **Un seul fichier au repo, un seul lien wget pour les users.**
- Compose hub identique quel que soit le vendor.
- Le hub ne mount aucun device — surface d'attaque réduite.
- `depends_on: service_healthy` garantit que l'agent attend que le hub réponde sur `/api/health` avant de se connecter.
- Switcher d'AMD vers NVIDIA = changer une ligne dans `.env` + `docker compose up -d`.

---

## 5. Auto-enrollment du sidecar (J2)

### Flow

1. `install.sh` génère deux secrets : `JWT_SECRET=$(openssl rand -base64 32)` et `LOCAL_AGENT_BOOTSTRAP=$(openssl rand -base64 32)`.
2. Les deux sont injectés dans `.env`.
3. Hub démarre, lit `LOCAL_AGENT_BOOTSTRAP` en config.
4. Agent démarre, lit `AGENT_TOKEN = LOCAL_AGENT_BOOTSTRAP` + `HOST_ID = local-sidecar-{hostname}`.
5. Agent se connecte sur `ws://hub:3015/agent?token=<bootstrap>&host_id=local-sidecar-jarvis`.
6. Hub valide : token == config.localAgentBootstrap → accepte.
7. Si la row `local-sidecar-jarvis` n'existe pas en DB, le hub l'auto-crée avec `kind='agent'`, `label=hostname`, `token_hash=bcrypt(LOCAL_AGENT_BOOTSTRAP)`.
8. Samples arrivent normalement via le pipeline ingest existant.

### Modifications côté hub

`server/services/agentIngestWS.ts` — fonction `authenticateAgent()` :

```diff
+  // Bootstrap path: anyone presenting LOCAL_AGENT_BOOTSTRAP gets a
+  // host row auto-created if missing. Reserved for the sidecar agent
+  // launched by the same docker compose stack.
+  if (token === config.localAgentBootstrap && claimedHostId.startsWith('local-sidecar-')) {
+    let host = HostsRepo.findById(claimedHostId);
+    if (!host) {
+      const hostname = claimedHostId.replace(/^local-sidecar-/, '');
+      HostsRepo.insert({
+        id: claimedHostId,
+        label: hostname,
+        hostname,
+        kind: 'agent',
+        token_hash: await bcrypt.hash(token, 10),
+        capabilities: JSON.stringify({ gpu: true, system: false, temps: false, processes: true }),
+        agent_version: null,
+        status: 'online',
+      });
+      host = HostsRepo.findById(claimedHostId)!;
+      logger.info('agent', `Auto-enrolled sidecar agent: ${claimedHostId}`);
+    }
+    return host;
+  }
```

### Sécurité

- Le bootstrap token est dans `.env` + dans le docker compose network interne. Pour y accéder, il faut déjà avoir un shell sur l'host ou être dans le network → c'est game over de toute façon.
- En v0.6, on peut durcir : hub écrit un one-shot token dans `/app/data/local-agent.token` à chaque boot, agent le consomme et l'efface, échange ensuite contre un AGENT_TOKEN persistant. Documenté dans §11.

---

## 6. install.sh single-entrypoint (J4)

Script servi par le hub (`/install-master.sh`) ou downloadable du repo. Pull **un seul** docker-compose.yaml et écrit le profile vendor dans `.env`.

```bash
#!/bin/bash
# GpuViewR — master install (auto-detect vendor, single compose)
set -e

# 1. Detect vendor (default: aggregator-only if neither found)
VENDOR=""
if command -v nvidia-smi >/dev/null 2>&1; then
  VENDOR=nvidia
elif command -v rocm-smi >/dev/null 2>&1 || [ -x /opt/rocm/bin/rocm-smi ]; then
  VENDOR=amd
else
  echo "Neither nvidia-smi nor rocm-smi found on this host."
  echo "Installing in aggregator-only mode (hub-only, no local GPU)."
  echo "Remote agents can still enrol via the UI to feed this hub."
fi

# 2. Pull the single compose file
mkdir -p ~/gpuviewr && cd ~/gpuviewr
curl -fsSL -o docker-compose.yaml \
  https://raw.githubusercontent.com/Erreur32/GpuViewR/main/docker-compose.yaml

# 3. Generate .env (only if absent — never clobber existing secrets)
if [ ! -f .env ]; then
  cat > .env <<EOF
JWT_SECRET=$(openssl rand -base64 32)
LOCAL_AGENT_BOOTSTRAP=$(openssl rand -base64 32)
HOST_IP=$(hostname -I | awk '{print $1}')
HUB_HOSTNAME=$(hostname)
DASHBOARD_PORT=7510
TZ=$(timedatectl show -p Timezone --value 2>/dev/null || echo Europe/Paris)
COMPOSE_PROFILES=${VENDOR}
EOF
  chmod 600 .env
  echo ".env generated (mode 600)."
else
  echo ".env already exists — leaving untouched."
  echo "If you want to change vendor, edit COMPOSE_PROFILES= line in .env."
fi

# 4. Up
docker compose up -d

# 5. Hint
IP=$(hostname -I | awk '{print $1}')
echo ""
echo "Hub: http://${IP}:7510   — first user becomes admin."
[ -n "$VENDOR" ] && echo "Sidecar agent: ${VENDOR} (active via COMPOSE_PROFILES)"
```

Usage one-liner :

```bash
curl -fsSL https://raw.githubusercontent.com/Erreur32/GpuViewR/main/install.sh | bash
```

Pour switcher de vendor après coup, le user édite `.env` :

```bash
# .env
COMPOSE_PROFILES=nvidia    # était: amd
```

Puis `docker compose up -d` — l'ancien sidecar est arrêté, le nouveau démarre.

---

## 7. Agent multi-hub (J5) — 1 agent → N hubs

### Cas d'usage

- **Failover** : hub primary down → l'agent continue de pousser vers le standby.
- **Box GPU partagée** : ton dashboard perso (à la maison) ET le dashboard équipe (au bureau) voient la même machine.
- **Test/staging** : le staging hub reçoit les mêmes samples que le prod, gratos.

### Config étendue

| Variable | Singulier (existant) | Pluriel (nouveau) |
|---|---|---|
| `HUB_URL` | `wss://h1/agent` | — |
| `HUB_URLS` | — | `wss://h1/agent,wss://h2/agent` |
| `HOST_ID` | `uuid-h1` | — |
| `HOST_IDS` | — | `uuid-h1,uuid-h2` |
| `AGENT_TOKEN` | `token-h1` | — |
| `AGENT_TOKENS` | — | `token-h1,token-h2` |

Backward-compat : le singulier reste prioritaire si présent. Sinon le pluriel est splité sur la virgule.

### Refactor `agent/src/transport.ts`

Aujourd'hui :

```typescript
const ws = new WebSocket(config.hubUrl, { ... });
const buffer: BufferableFrame[] = [];
```

Demain :

```typescript
interface HubConnection {
  url: string;
  hostId: string;
  token: string;
  ws: WebSocket | null;
  buffer: BufferableFrame[];   // buffer par-hub : un down ne bloque pas les autres
  reconnectDelay: number;
}

const hubs: HubConnection[] = config.hubs.map(h => ({ ...h, ws: null, buffer: [], reconnectDelay: RECONNECT_MIN_MS }));

function enqueueSample(samples) {
  for (const hub of hubs) {
    hub.buffer.push({ type: 'sample', samples });
    while (hub.buffer.length > BUFFER_MAX) hub.buffer.shift();
    if (hub.ws?.readyState === WebSocket.OPEN) flushHub(hub);
  }
}
```

### Bénéfice immédiat

- Le sidecar local d'une box (multi-master test) peut pointer vers son hub local PLUS un hub central de monitoring sans doubler le coût.
- Implementation est ~3-4h pour le refactor + tests.

### Décision validée

D5 : oui, on l'inclut dans v0.5.0 — ça reste indépendant du reste, peut être fait en parallèle (#31 n'a pas de blockedBy).

---

## 8. Migration v0.4.x → v0.5.0 (J6) — **best-effort, non bloquant**

Décision D6 : la migration n'est PAS un blocker de release. La base d'utilisateurs v0.4.x est restreinte (sortie il y a < 24h au moment de l'écriture de ce plan). Si la migration est triviale, on la fait. Sinon, le user repart de zéro :

```bash
# Sur Jarvis / deb13 : reset clean si la migration foire
docker compose down -v   # ⚠️ supprime les volumes y compris la DB
rm -rf ./data
docker compose up -d
```

### Implémentation (si on le fait quand même)

Au boot du hub v0.5.0, dans `runMigrations()`, **avant** que `agentIngestWS` accepte des connexions (sinon le sidecar auto-enrolment race avec la migration) :

```typescript
const localRow = db.prepare("SELECT * FROM hosts WHERE id = 'local'").get();
if (localRow) {
  const newId = `local-sidecar-${localRow.hostname || 'master'}`;

  // Idempotent : si la cible existe déjà (cas où la migration a tourné
  // sans aller au bout), on saute.
  const existsTarget = db.prepare("SELECT 1 FROM hosts WHERE id = ?").get(newId);
  if (!existsTarget) {
    db.prepare(`
      INSERT INTO hosts (id, label, hostname, kind, endpoint, token_hash, capabilities,
                         agent_version, protocol_ver, enrolled_at, last_seen, status)
      VALUES (?, ?, ?, 'agent', NULL, NULL, ?, NULL, ?, ?, ?, 'pending')
    `).run(newId, localRow.label, localRow.hostname,
           localRow.capabilities, localRow.protocol_ver,
           localRow.enrolled_at, localRow.last_seen);
  }

  // Reparent les FKs — UPDATEs idempotents
  db.prepare("UPDATE gpu_devices  SET host_id = ? WHERE host_id = 'local'").run(newId);
  db.prepare("UPDATE gpu_metrics  SET host_id = ? WHERE host_id = 'local'").run(newId);
  db.prepare("UPDATE alert_events SET host_id = ? WHERE host_id = 'local'").run(newId);

  db.prepare("DELETE FROM hosts WHERE id = 'local'").run();
  logger.info('migration', `v0.4 → v0.5: migrated 'local' → '${newId}'`);
}
```

### Risques résiduels

- **Hostname différent** entre la row existante et le sidecar courant (admin a renommé la machine entre v0.4.1 et v0.5.0) → on prend `localRow.hostname` (l'historique). Le sidecar nouvellement enregistré avec un hostname différent crée alors une 2e row distincte. Acceptable pour le moment, l'admin peut delete une des deux via la UI.
- **Schema ALTER** : si on a oublié une table avec `host_id`, l'UPDATE manque. À balayer dans le code AVANT de releaser pour s'assurer qu'il n'y en a pas plus que les 3 listées.

### Test minimal

- Snapshot DB v0.4.1 (juste copier `~/gpuviewr/data/gpuviewr.db` d'un install qui tourne)
- Boot v0.5.0 sur cette DB
- Vérifier : row `local-sidecar-XXX` existe, plus de row `local`, count `gpu_metrics WHERE host_id='local'` = 0
- `/api/gpu/devices?host=local-sidecar-XXX` retourne les devices historiques

### Si on saute la migration

Documenter clairement dans CHANGELOG + README upgrade note :

> **Breaking-but-trivial** : v0.5.0 change l'identifiant interne du local host (`local` → `local-sidecar-{hostname}`). Si vous tenez à votre historique des métriques, faites un dump SQL avant de pull la nouvelle image. Sinon, `docker compose down -v && up -d` repart propre.

---

## 9. Release plan (J7)

### Bump version

`v0.4.2 → v0.5.0` (minor — pas breaking pour l'utilisateur final via Docker, mais l'archi interne change).

### CHANGELOG entrée

```
## [0.5.0] - 202X-XX-XX

### Changed (breaking pour les builds bare-metal)
- Hub is now fully vendor-neutral. The bundled image no longer
  includes python3 or libdrm-amdgpu1. Local GPU monitoring requires
  the sidecar agent (auto-installed by the new compose files).

### Added
- compose.nvidia.yaml + compose.amd.yaml ship the hub + sidecar
  agent in a single stack. install.sh detects vendor and picks one.
- Sidecar agent auto-enrolls via LOCAL_AGENT_BOOTSTRAP shared secret.
- Agents can connect to N hubs in parallel (HUB_URLS=ws://h1,ws://h2).

### Migrated
- DB row id='local' (kind='local') is auto-renamed to
  id='local-sidecar-{hostname}' (kind='agent') on first boot.
  Historical gpu_metrics / alert_events preserved.
```

### Workflow `update-version.sh 0.5.0 --tag-push` comme d'habitude.

---

## 10. Mock mode (`MOCK_GPU=1`) — déplacement

Aujourd'hui : `mockGpu.ts` côté hub génère `buildFakeSamples()`, appelé par `gpuCollector.mockTick()`. Avec le hub vendor-neutral, ces fonctions n'ont plus de caller hub-side.

**Solution** : déplacer `mockGpu.ts` (+ `mockAgentSeeder.ts`) dans le bundle agent. Le sidecar lance un mock-mode quand `MOCK_GPU=1`, exactement comme l'agent le fait déjà aujourd'hui (`config.mockGpu`). Le hub n'a plus de connaissance du mock — il reçoit des frames d'agent et c'est tout.

`mockAgentSeeder` reste côté hub uniquement pour seeder les hosts fake en mode `dev:mock` (pour la page Hosts vide). Il ne génère plus de samples — c'est le sidecar agent en mock-mode qui les produit.

---

## 11. Questions ouvertes (à trancher ou différer)

| # | Question | Impact | Proposition |
|---|---|---|---|
| Q1 | Doit-on supporter l'install.sh **côté Windows / macOS** ? | bash-only aujourd'hui | Non, v0.5 reste Linux. PowerShell port en v0.6 si demandé. |
| Q2 | Si l'utilisateur n'a NI nvidia-smi NI rocm-smi sur le host master, install.sh fait quoi ? | Cas du hub-only (aggregator) | Affiche un msg "no GPU detected, falling back to aggregator-only mode" et installe `docker-compose.yaml` sans sidecar. |
| Q3 | Le sidecar local génère-t-il un `HOST_ID` UUID ou utilise le hostname ? | Tracking historique | Hostname (`local-sidecar-{hostname}`) — si tu renames ton host, tu casses l'historique. C'est OK, c'est rare et documenté. Alternative : générer un UUID stocké dans `/app/data/local-agent.id`. |
| Q4 | Sécurité v0.6 du bootstrap | Toujours secret dans `.env` | Filesystem handshake : hub écrit `data/local-agent.token` (mode 600), agent lit + delete + échange contre un AGENT_TOKEN persistant. Pas en v0.5. |
| Q5 | Agent multi-hub : un seul vendor déclaré, ou différent par hub ? | Niche | Un seul vendor par agent. Si tu veux 2 vendors sur le même host (Intel iGPU + NVIDIA dGPU), lance 2 agents avec des `HOST_ID` distincts. |

---

## 12. Validation par jalon

Chaque J* doit passer ces gates avant de fermer :

| Gate | J1 | J2 | J3 | J4 | J5 | J6 | J7 |
|---|---|---|---|---|---|---|---|
| Typecheck (`npx tsc --noEmit`) | ✓ | ✓ | — | — | ✓ | ✓ | ✓ |
| Build hub (`npm run build`) | ✓ | ✓ | — | — | — | ✓ | ✓ |
| Build agent (`npm run build:agent`) | — | — | — | — | ✓ | — | ✓ |
| Tests serveur (`npx tsx --test server/...`) | ✓ | ✓ | — | — | — | ✓ | ✓ |
| Tests agent (`cd agent && npx tsx --test`) | — | — | — | — | ✓ | — | ✓ |
| Smoke test sur Jarvis (AMD master) | — | — | ✓ | ✓ | — | ✓ | ✓ |
| Smoke test sur deb13 (NVIDIA master) | — | — | ✓ | ✓ | — | ✓ | ✓ |
| SonarCloud quality gate | — | — | — | — | — | — | ✓ |
| CodeQL + Snyk | — | — | — | — | — | — | ✓ |

---

## 13. Estimation d'effort

| Jalon | Effort | Risque |
|---|---|---|
| J1 — Hub cleanup | 3-4 h | Faible — du delete + ajustement de routes |
| J2 — Bootstrap token | 2 h | Moyen — bien tester l'auto-enrollment race conditions |
| J3 — Compose files | 1 h | Faible — copy-paste depuis l'existant |
| J4 — install.sh | 1-2 h | Faible — bash classique |
| J5 — Multi-hub agent | 3-4 h | Moyen — refactor transport.ts, attention aux race conditions buffer/reconnect |
| J6 — DB migration | 2 h | Élevé — c'est là qu'on peut casser les installs existantes. Tests exhaustifs requis. |
| J7 — Docs + release | 1 h | Faible |
| **Total** | **~13-16 h** | |

---

## 14. Décisions ouvertes pour validation utilisateur

Avant de lancer J1, valider chaque ligne de la table "Décisions arrêtées" en §0. Si une décision change (ex: D7 sécurité forte d'office), ça peut décaler J2 et J7.
