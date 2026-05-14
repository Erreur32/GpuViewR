# Plan d'architecture — GpuViewR Multi-Machine Viewer

> Objet : passer GpuViewR (v0.2.5, mono-host) à un mode où **un dashboard central agrège les métriques GPU/système de N hôtes NVIDIA**, sans casser le déploiement zero-config existant. Cible : v0.3.x.
>
> **Statut : plan d'architecture. Aucun code écrit. Aucune décision UI.**
>
> Ce qui sort du scope (assumé) : tout rendu UI multi-host, dashboards visuels par host, RBAC multi-organisation, sharding de la base SQLite, alerting cross-host transactionnel. La présente note couvre la dorsale et le contrat d'API/transport.

## Décisions arrêtées (avant implémentation)

| # | Sujet | Décision | Cf. |
|---|---|---|---|
| D1 | Approche transport | Agent push WebSocket sortant | §1 |
| D2 | Localisation agent | Sous-package `/agent` du même repo, TypeScript Node 22 | §5 |
| D3 | Label Prometheus | `host="<id>"` (UUID stable) **+** métrique annexe `gpuviewr_host_info{host=<id>, label=<nom>, hostname=<os>} 1` pour le join Grafana | §7, §10 |
| D4 | Portée règles d'alerte | `alert_rules.host_id NULL` = global (wildcard), comme `gpu_index NULL`. `host_id='<id>'` = ciblé | §10 |
| D5 | Buffer agent | RAM only par défaut (ring 3 600 entrées). Persistance disque via `AGENT_BUFFER_PERSIST=1` opt-in | §4, §9 |
| D6 | TLS | Délégué au reverse-proxy (`wss://`). Pas de mTLS ni cert pinning en v0.3 | §3 |
| D7 | Token agent | Opaque random 32+ bytes, bcrypt-hash côté hub. **Pas** un JWT. Espace d'auth disjoint de `JWT_SECRET` | §3 |
| D8 | Identité host | UUIDv4 stable (`host.id`), hostname rapporté informatif uniquement | §2, §10 |
| D9 | Stream WS frontal | Un seul stream multiplexé avec `host_id` dans l'enveloppe. Filtrage `?hosts=A,B` optionnel | §6 |

---

## 1. Arbitrage entre les approches viables — recommandation explicite

| # | Approche | Réseau requis | Install user | Robustesse offline | Maintenance | Aligne avec l'existant |
|---|---|---|---|---|---|---|
| **(a)** | **Agent push WS** : binaire/container léger sur chaque hôte, ouvre une WS sortante vers le hub | **Sortant uniquement** (NAT-friendly) | 1 container ou 1 service systemd + 1 URL + 1 token | Buffer local sur l'agent, replay au reconnect | Faible : un binaire, un protocole | **Très fort** — calque sur `gpuStreamWS.ts` interne |
| (b) | Hub pull (HTTP `/metrics` ou SSH `nvidia-smi`) | Port à ouvrir côté nœud (ou clé SSH partagée) | Plus lourd : exposer un port + ACL ou clé SSH | Hub doit gérer le timeout — pas de buffer côté nœud | Moyen : la conf réseau retombe sur l'utilisateur | Faible — change le sens du flux |
| (c) | Fédération de peers (chaque hôte = GpuViewR complet) | Bidirectionnel, ports HTTP+WS | Très lourd : SQLite + frontend + auth sur chaque nœud | Très bon localement, redondant | **Lourd** : N stacks à updater | Moyen — mais chaque nœud paie le coût d'un dashboard complet pour rien |
| (d) | DCGM exporter + Prometheus + GpuViewR scrape Prom | Port DCGM + Prometheus | Doit déjà avoir Prom dans l'infra | Excellent (Prom gère lui-même) | Délègue à l'écosystème Prom, mais **fait perdre l'identité produit** | Faible — GpuViewR devient un skin sur Prom |

### Recommandation : **(a) Agent push WebSocket**

Justifications décisives :

1. **Cohérence architecturale** : `gpuCollector` émet déjà via `EventEmitter`, `gpuStreamWS` ne fait que router ce flux vers les clients. Un agent qui produit le même type `GpuSample` et se connecte au hub via WS réutilise littéralement le pipeline existant — la mutation du hub se limite à "injecter dans l'event bus comme si c'était un collecteur local".
2. **Friction utilisateur minimale** : aucun port à ouvrir côté nœud, ce qui est crucial en home-lab / labos universitaires derrière NAT. Un `docker run` ou un `systemctl start` suffit.
3. **Robustesse aux nœuds offline** : l'agent peut buffer en RAM (ou sur disque pour les longues coupures) et rejouer à la reconnexion. C'est plus simple à implémenter dans un sens qu'un sens où le hub devrait deviner que le nœud existe.
4. **Solo open-source** : un protocole, un binaire à packager, pas de service discovery, pas de DNS, pas de mTLS obligatoire — le ratio valeur/maintenance est imbattable.

Mention pragmatique : pour les utilisateurs qui ont déjà Prometheus, on peut **garder le mode (d) comme chemin "byo-telemetry" optionnel** plus tard (un host de type `prometheus` qui scrape un endpoint Prom au lieu d'avoir un agent WS). Ce n'est **pas** dans le scope v0.3.0 mais le schéma DB doit le permettre via une colonne `kind` sur la table `hosts`.

Les approches (b) et (c) sont éliminées : (b) renverse le contrôle réseau dans le mauvais sens, (c) multiplie les surfaces d'attaque et la dette d'update.

---

## 2. Impact sur le schéma DB

### Nouvelle table `hosts`

```
hosts (
  id            TEXT PRIMARY KEY,        -- UUIDv4 généré au enrollment
  label         TEXT NOT NULL,           -- nom humain ("rtx-rig", "lab-3")
  hostname      TEXT,                    -- os.hostname() rapporté par l'agent
  kind          TEXT NOT NULL,           -- 'local' | 'agent' | 'prometheus' (réservé)
  endpoint      TEXT,                    -- pour kind='prometheus' plus tard
  token_hash    TEXT NOT NULL,           -- bcrypt du secret d'enrollment
  capabilities  TEXT,                    -- JSON: { gpu:true, system:true, processes:true, temps:true }
  agent_version TEXT,
  protocol_ver  INTEGER NOT NULL DEFAULT 1,
  enrolled_at   INTEGER NOT NULL,
  last_seen     INTEGER,
  status        TEXT NOT NULL DEFAULT 'pending'   -- 'pending' | 'online' | 'offline' | 'disabled'
)
```

`id` est un **UUID stable** (pas le hostname), généré au moment du `POST /api/hosts/enroll`. Le hostname peut changer (rename d'une box, conteneur recréé) sans casser la corrélation historique — c'est crucial (cf. §10).

### Mutation des tables existantes — ajout de `host_id`

Tous les modèles métriques portent un `host_id TEXT NOT NULL` :

- `gpu_metrics` : `host_id TEXT NOT NULL DEFAULT 'local'`
- `gpu_devices` : la PK passe de `(gpu_index)` à `(host_id, gpu_index)` ; `uuid` reste secondaire (deux hôtes peuvent avoir des UUID NVIDIA distincts pour la même position d'index)
- `alert_events` : `host_id TEXT NOT NULL DEFAULT 'local'` — l'événement appartient à un host
- `alert_rules` : `host_id TEXT NULL` — `NULL` = règle globale s'appliquant à tous les hosts, `'<id>'` = ciblée

### Fichiers concernés

- `server/database/connection.ts` (lignes 35-73) — DDL initial + bloc de migration. Suivre le pattern existant déjà utilisé pour la migration `utilization NOT NULL` (l.78-111) : détecter via `PRAGMA table_info('gpu_metrics')` la présence de la colonne `host_id`, et faire la migration `CREATE NEW / INSERT … 'local' / DROP / RENAME` dans une transaction. Recréer les index avec préfixe `host_id` : `idx_gpu_metrics_host_gpu_epoch ON gpu_metrics(host_id, gpu_index, timestamp_epoch)`.
- `server/database/models/GpuMetric.ts` — toutes les méthodes (`insert`, `insertMany`, `history`, `historyDownsampled`, `historyIterate`, `stats`, `pruneOlderThan`) prennent un `host_id` en premier argument. **Compat** : conserver une signature legacy `(gpu_index, …)` qui pré-remplit `'local'` pour ne pas casser le hub mono-host pendant la migration interne.
- `server/database/models/Alert.ts` — `gpu_index INTEGER NOT NULL` reste, on ajoute `host_id` dans `AlertEvent` et optionnellement dans `AlertRule`. La clé de state map de `alertService.ts:91` (`${rule.id}:${sample.gpu_index}`) devient `${rule.id}:${host_id}:${gpu_index}`.
- **Nouveau** : `server/database/models/Host.ts` — repo CRUD + helpers `markSeen(id)`, `setStatus(id, status)`, `findByTokenHash(hash)`.

### Migration des données existantes

Au premier boot v0.3.x sur une base v0.2.5 :

1. Détecter l'absence de la table `hosts` → c'est une install legacy.
2. `INSERT INTO hosts (id, label, kind, …) VALUES ('local', 'local', 'local', …, 'online')`.
3. Migrer `gpu_metrics`/`gpu_devices`/`alert_events` en ajoutant `host_id='local'` pour toutes les lignes existantes (idempotent, pas de perte).
4. Le `gpuCollector` interne continue à écrire avec `host_id='local'` (cf. §6).

L'utilisateur final ne fait **rien** : son install se met à jour, ses graphes historiques sont préservés, et le bouton "Ajouter un host" devient simplement disponible.

---

## 3. Auth & sécurité entre nœuds

### Modèle de token par hôte

Pas de JWT partagé global. Chaque agent dispose d'un **token d'enrollment** distinct (long, ≥ 32 octets random), stocké **haché bcrypt** côté hub (réutiliser `authService.hashPassword` / `verifyPassword` cf. `authService.ts:16-22`). Le token clair n'existe que :

- chez l'utilisateur au moment de l'enrollment (affichage one-shot dans l'UI / réponse API),
- dans la conf de l'agent (`AGENT_TOKEN=…` en env var).

Côté agent, le token est envoyé soit en header `Authorization: Bearer <token>` lors du handshake WS, soit en query string `?token=…` (comme fait déjà `gpuStreamWS.ts:14`).

### Workflow d'enrollment

1. **Admin** côté hub : `POST /api/hosts` `{ label }` → génère `id` UUID + token brut → renvoie `{ id, token }` une seule fois.
2. Admin copie/colle la commande affichée :
   ```
   docker run -e HUB_URL=wss://hub/agent -e AGENT_TOKEN=… -e HOST_ID=… ghcr.io/erreur32/gpuviewr-agent
   ```
3. L'agent se connecte au hub. Le hub vérifie `bcrypt.compare(token, host.token_hash)` ET `host.id === message.host_id` (un token ne peut prouver l'identité que d'**un seul** host).
4. La première trame valide bascule `status` en `online`, met `last_seen` à jour, écrit `agent_version` et `protocol_ver` rapportés par l'agent.

### Rotation

- `POST /api/hosts/:id/rotate-token` : invalide l'ancien hash, en génère un nouveau, le retourne une fois. L'agent doit être reconfiguré (équivalent à un re-enrollment, simple).
- Pas de rotation automatique en v0.3.x — ajoute trop de complexité pour le bénéfice. À planifier post-1.0.

### TLS

- **Recommandation** : ne **pas** réimplémenter TLS dans Node. Déléguer au reverse-proxy (nginx/Caddy/Traefik) que l'utilisateur a déjà devant `PUBLIC_URL`. L'agent se connecte en `wss://`. Cert pinning : refusé pour la v0.3 — trop d'aspérités (rotation cert, Let's Encrypt 90j, etc.) pour un projet solo. Documenter dans `SECURITY.md` que le hub **doit** être derrière TLS en production multi-host.
- En dev/local sans TLS : `ws://` autorisé si le hub écoute sur loopback ou réseau privé. Refuser explicitement `ws://` vers une IP publique via un check de config (whitelist localhost/private CIDR sinon `nodeEnv === 'production'` → erreur).

### Isolation : empêcher un agent compromis de polluer un autre host

Règle d'invariant au niveau hub : **tout `host_id` dans une trame entrante est ignoré ; le hub utilise celui authentifié par le token au handshake**. Concrètement, l'agent peut envoyer `{ type: 'sample', samples: […] }` — il **ne** déclare **pas** `host_id` dans la trame, c'est le hub qui le tague côté serveur à partir de la session WS. Ça défait l'attaque "j'ai compromis l'agent du host A, je publie sous le host_id du host B".

### Lien avec `JWT_SECRET` existant

Le `JWT_SECRET` (cf. `config.ts:5`) reste **strictement pour les sessions utilisateurs UI**. Les tokens d'agent sont **opaques** (random 32+ bytes, pas des JWT signés). Raison : pas besoin de claims (un token = un host_id, déjà résolu en DB) ; et ça évite la confusion "qui peut signer pour qui" si jamais quelqu'un fait fuiter `JWT_SECRET`. Deux espaces d'auth strictement disjoints, c'est plus simple à raisonner.

---

## 4. Transport

### Protocole recommandé : **WebSocket persistant agent → hub**

Pas de surprise au vu de l'archi interne — réutilisation maximale.

### Format de payload (proposé, v1)

Frames émises par l'agent (toutes en JSON, une frame = un objet) :

```
// 1. Handshake (premier message après connection)
{ "type":"hello", "host_id":"<uuid>", "agent_version":"0.3.0",
  "protocol_ver":1, "hostname":"rtx-rig", "capabilities":{ "gpu":true,"system":true,"temps":true,"processes":false } }

// 2. Sample périodique (tick GPU = 1s par défaut)
{ "type":"sample", "ts_epoch":1731600000, "samples":[ <GpuSample sans host_id> … ] }

// 3. Snapshot host (CPU/mem/load) — moins fréquent, p.ex. toutes les 5s
{ "type":"system", "ts_epoch":…, "stats": <SystemStats> }

// 4. Températures hwmon
{ "type":"temps", "ts_epoch":…, "sensors":[…] }

// 5. Processus (sur demande ou périodique selon config)
{ "type":"processes", "ts_epoch":…, "processes":[…] }

// 6. Keep-alive
{ "type":"ping", "ts_epoch":… }
```

Frames hub → agent :

```
{ "type":"welcome", "hub_version":"0.3.0", "protocol_ver":1, "tick_ms":1000 }
{ "type":"config", "patch":{ "tick_ms":2000 } }   // permettre au hub d'ajuster la cadence
{ "type":"pong", "ts_epoch":… }
```

### Réutiliser `GpuSample` ?

**Oui** — c'est le type pivot. Le hub re-publie aux clients UI le même `{ type:'sample', samples:[…], host_id }` en ajoutant juste `host_id` au niveau de l'enveloppe (cf. §6). Pas de duplication de type, et le frontend gagne juste un champ `host_id` à dispatcher.

### Reconnexion, backpressure, time-skew

- **Reconnexion** : exponentiel borné côté agent (1s → 2 → 4 … capé à 30s, jitter ±20%). Au reconnect, replay du buffer local (cf. ci-dessous) puis flux normal.
- **Backpressure** : si `ws.bufferedAmount > N` (p.ex. 1 MiB), agent passe en mode "dégradé" — il drop les trames `processes`/`temps` mais conserve les `sample` GPU (la donnée la plus précieuse). Log warn.
- **Time-skew** : chaque trame transporte `ts_epoch` issu de l'horloge **de l'agent**. Le hub stocke **deux** epochs : `agent_ts_epoch` (rapporté) et `hub_ts_epoch` (réception). Pour les requêtes/graphes le hub utilise `hub_ts_epoch` (cohérence du flux multi-host), `agent_ts_epoch` est conservé pour diagnostic. Recommander NTP dans la doc, mais ne pas l'imposer.
- **Buffering local agent quand le hub est down (D5)** : ring buffer en RAM (taille bornée à 3 600 entrées ≈ 1 h × 1 Hz, ~1.7 MiB pour 4 GPUs) — **mode par défaut**. Persistance disque dans `$DATA_DIR/agent-buffer.jsonl` activée uniquement via `AGENT_BUFFER_PERSIST=1` (opt-in pour les utilisateurs avec hub instable). Le buffer est **append-only**, vidé en FIFO au reconnect. Au-delà de la limite, drop des plus anciennes — métrique 1 h vieille a moins de valeur qu'1 fresh.

### Versioning du protocole

Champ `protocol_ver: 1` dans `hello` et `welcome`. Le hub doit accepter `protocol_ver <= MAX_KNOWN` ; un agent plus récent rétrograde proprement. Toute breaking change → bump à 2, le hub continue à supporter 1 pendant au moins deux versions mineures.

---

## 5. Découpage du code — où vit l'agent ?

### Recommandation : **sous-package `agent/` dans le même repo**, en TypeScript Node 22

Choix radical et explicite : **pas de monorepo**, juste un dossier `/agent` à côté de `/server` et `/src`, avec son propre `package.json` minimal, son `Dockerfile.agent`, et un import sélectif depuis `/server` pour les types et le parsing nvidia-smi.

### Justifications

1. **Cohérence solo-maintenu** : un seul repo = un seul cycle de release, un seul `CHANGELOG.md`, un seul flux CI. Le protocole hub/agent évolue en lockstep — pas de désync de versions.
2. **Réutilisation directe du parsing nvidia-smi** : le code de `gpuCollector.ts` (CSV parser, PCIe parser, normalisation) **est** la valeur ajoutée du projet. Le réécrire en Go ou Python serait dupliquer la dette de parsing (qui a déjà absorbé plusieurs commits de fixes — cf. les commentaires `pcieDiagLogged`, le fallback `idx:N`, etc.). Extraire un sous-module `agent/lib/nvidiaParsers.ts` partagé.
3. **Footprint Node** : oui Node prend ~80 MiB RSS, mais c'est acceptable même sur des nœuds bare-metal modernes ; et l'agent n'a pas besoin de `better-sqlite3` ni `express` ni `react`, juste `ws` et le runtime — `node_modules` < 10 MiB.
4. **Empaquetage** : image Docker **alpine** ou **distroless** (~50 MiB compressé, sans dist UI) ; et pour les machines bare-metal qui ne veulent pas Docker, `node --experimental-sea-config` (Single Executable Application natif Node 22) produit un binaire statique ~50 MiB. Documenter les deux.

### Pourquoi pas Go ou Python ?

- **Go** : binaire 5 MiB, séduisant, mais on perd la réutilisation du parser TypeScript ; et il faudrait maintenir deux implémentations du parsing CSV nvidia-smi → bug surfaces × 2.
- **Python** : runtime à packager (~30 MiB compressé via PyInstaller), parsing à refaire, gain nul.

### Arborescence cible

```
/agent
  package.json              # dépend de "ws" uniquement (+ types depuis ../server)
  Dockerfile
  src/
    index.ts                # bootstrap + lifecycle
    config.ts               # HUB_URL, HOST_ID, AGENT_TOKEN, TICK_MS, FEATURES
    transport.ts            # WebSocket client, reconnect, buffer
    collectors/
      gpu.ts                # importe ../../server/services/_nvidiaParsers (factorisé)
      system.ts             # version allégée de systemStats.ts
      temps.ts              # version allégée de systemTemperatures.ts
      processes.ts          # version allégée de processCollector.ts
  README.md
```

Factorisation côté server (à faire dans un commit préparatoire — cf. §9 jalon 1) :

- Extraire de `server/services/gpuCollector.ts` :
  - `parsePciThroughput`, `normalizeBusId`, `matchKbps`, `QUERY_FIELDS`, le type `GpuSample` → fichier neutre `server/services/_nvidiaParsers.ts` (importable depuis l'agent **et** depuis gpuCollector).
- Idem `server/services/systemStats.ts` (déjà autonome, juste à exposer publiquement) et `systemTemperatures.ts` (idem).

---

## 6. Hub central — adaptation sans casser le mono-host

### Principe : `gpuCollector` reste un fournisseur **parmi d'autres**

Aujourd'hui `gpuCollector` est un singleton qui spawn nvidia-smi localement et émet `'sample'`. Demain on introduit un **niveau d'indirection** : un `MetricsBus` (event bus unique côté hub) que **tous** les producteurs alimentent. Trois producteurs possibles :

1. **Local collector** (l'actuel `gpuCollector`) — tagué `host_id='local'`. Activé si et seulement si `nvidia-smi` est dispo (déjà géré par `nvidiaSmiAvailable`, l.105). Si pas de nvidia-smi local, le hub ne produit rien lui-même — il fait juste l'agrégation.
2. **Agent ingestor** (nouveau) — accepte les WS entrantes sur `/agent` (et **uniquement** pour les hôtes enrôlés avec un token valide). Pour chaque trame `sample` reçue, tag avec `host_id` issu de la session, ré-émission sur le `MetricsBus`.
3. (Réservé) **Prometheus scraper** — futur.

### Patch concret

- `server/services/metricsBus.ts` (nouveau) — un `EventEmitter` typé exposant `emit('sample', { host_id, samples })`, `emit('system', …)`, etc. Tous les abonnés actuels de `gpuCollector` migrent vers ce bus.
- `server/services/gpuCollector.ts` — le `this.emit('sample', samples)` (l.140, 301) devient `metricsBus.emit('sample', { host_id: 'local', samples })`. La signature publique du fichier ne change pas tant qu'on est en mono-host pur.
- `server/services/agentIngestWS.ts` (nouveau) — symétrique de `gpuStreamWS.ts`, mais côté serveur. Mount sur path `/agent`. Auth = vérification du token agent (pas JWT user). Pour chaque message reçu, dispatch sur `metricsBus`.
- `server/services/gpuStreamWS.ts` — `gpuCollector.on('sample', …)` (l.30) devient `metricsBus.on('sample', ({ host_id, samples }) => safeSend(ws, { type:'sample', host_id, samples }))`.
- Le `snapshot` initial envoyé au client (l.23-24) doit lui aussi devenir multi-host : itérer sur les derniers samples connus de chaque host. Maintenir une `Map<host_id, GpuSample[]>` mise à jour à chaque tick — accessible via `metricsBus.getLatestPerHost()`.
- `server/index.ts:117-119` — appeler `setupAgentIngestWS(server)` à côté de `setupGpuWebSocket(server)`. Démarrer `gpuCollector.start()` **uniquement si** nvidia-smi est dispo (le code y est déjà).

### Comportement zero-config inchangé

Une install fresh sur une machine avec nvidia-smi :
- `host_id='local'` créé d'office au boot (cf. §2 migration).
- `gpuCollector` démarre et publie.
- Le client UI reçoit `{ type:'sample', host_id:'local', samples:[…] }` — il peut tout simplement ignorer `host_id` ou le grouper par "local" → l'UI v0.2.5 continue à fonctionner sans toucher au front (modulo un parsing tolérant du nouveau champ).

### Stream multiplexé vs un stream par host

**Recommandation : un seul stream WS frontal multiplexé**, avec `host_id` dans chaque enveloppe. Un client UI a souvent besoin de **tous** les hosts en même temps (tableau de bord global), et démultiplier WS côté navigateur multiplie la surface de bug pour zéro gain perf à l'échelle visée (jusqu'à ~20-50 hosts).

Filtrage : le client peut demander `/ws/gpu?hosts=A,B` au handshake pour ne recevoir qu'un sous-ensemble (économie bande passante mobile). Le hub vérifie l'autorisation et filtre.

---

## 7. Surface API frontale (REST + WS)

### Nouvelles routes — fichier `server/routes/hosts.ts` (nouveau)

```
GET    /api/hosts                       → list (id, label, status, last_seen, agent_version, capabilities)
POST   /api/hosts                       → admin : enroll → renvoie { id, token } une fois
GET    /api/hosts/:id                   → détails complets
PATCH  /api/hosts/:id                   → admin : renommer label, disable, …
DELETE /api/hosts/:id                   → admin : retire l'enrôlement, purge optionnelle des métriques
POST   /api/hosts/:id/rotate-token      → admin : nouvelle valeur opaque
GET    /api/hosts/:id/status            → quick health (online/lag/last_seen seconds)
```

### Routes existantes à étendre

- `server/routes/gpu.ts` :
  - `GET /api/gpu/devices` (l.10) → accepter `?host=<id>`, défaut "tous". Réponse `{ devices: [ { host_id, gpu_index, name, … }, … ] }`.
  - `GET /api/gpu/current` (l.14) → idem.
  - `GET /api/gpu/history` (l.24) → param obligatoire `host` ; sinon erreur 400 (l'utilisateur doit choisir, l'agrégation N-host sur un graphe a peu de sens pour la v1).
  - `GET /api/gpu/history.csv` (l.44) → accepter `host=<id>` ou `host=all` (cf. la convention `gpu=all` déjà en place l.45).
  - `GET /api/gpu/stats` (l.79) → idem.
- `server/routes/system.ts` :
  - `GET /api/system/` (l.88) → soit reste host local par défaut, soit accepte `?host=<id>`. Le champ `host` dans la réponse devient une liste si pas de filtre.
- `server/routes/processes.ts` :
  - `GET /api/processes/` → accepter `?host=<id>`. Si l'agent du host n'a pas `capabilities.processes`, retourner `{ processes: [], reason: 'not-supported' }` plutôt que 404.
- `server/routes/alerts.ts` :
  - Les events listés portent désormais `host_id` — le front pourra grouper. Pas d'autre changement strict (cf. §10 pour la décision règles globales vs par-host).
- `server/routes/metrics.ts` (Prometheus) — **décision D3** :
  - Ajouter le label `host="<id>"` (UUID stable) à toutes les séries `gpuviewr_*`.
  - Émettre **en plus** une série annexe `gpuviewr_host_info{host="<id>", label="<nom>", hostname="<os>"} 1` (pattern idiomatique cf. `node_uname_info`). Grafana joint via `* on (host) group_left (label) gpuviewr_host_info`.
  - Avantage : renommer un host dans GpuViewR ne casse **pas** les queries Grafana de l'utilisateur (l'ID est stable).
  - Important : ça **casse** les dashboards Prom existants en mono-host (qui n'avaient pas de label `host`) ; documenter dans le CHANGELOG.
- `server/routes/health.ts` :
  - Ajouter `hostsTotal`, `hostsOnline`, `hostsLagging` (last_seen > 30s).

### WebSocket frontal

- `/ws/gpu` reste, le format évolue : chaque message `sample` porte `host_id`. Idem `alert`. Ajouter un nouveau type `host_status` `{ host_id, status:'online'|'offline'|'lagging', last_seen }` émis quand le hub détecte un changement (cf. §10 sur la détection offline).
- Query string optionnelle `?hosts=A,B` pour filtrer.

### Hors scope

- Pas de WebSocket dédié `/ws/hosts` — overkill, le canal `host_status` sur `/ws/gpu` suffit.
- Pas d'API d'auto-discovery (mDNS, etc.). L'utilisateur enrolle manuellement, c'est explicite et auditable.

---

## 8. Compat & migration v0.2.5 → v0.3.x

### Stratégie zero-touch côté utilisateur mono-host

1. Boot v0.3.0 sur DB v0.2.5 → migration auto (§2) qui crée `hosts` + remplit `host_id='local'`.
2. `nvidia-smi` détecté → le collector local démarre comme avant.
3. Le frontend v0.3.0 affiche un panneau "Hosts (1)" replié par défaut sur "local" → l'utilisateur ne voit pas de changement majeur.
4. Bouton "Add host" visible dans Settings (admin uniquement) — c'est l'unique nouveauté visible tant que personne n'enrolle.

### Versioning hub ↔ agent

- **Hub** : suit le semver de `package.json` (déjà en place : 0.2.5 → 0.3.0).
- **Agent** : même version que le hub au sein du même repo (un seul tag git → deux images : `ghcr.io/erreur32/gpuviewr:0.3.0` et `…/gpuviewr-agent:0.3.0`).
- **Protocole** : champ `protocol_ver` séparé du semver applicatif. Démarre à 1. Le hub MAJEUR (0.4 → 0.5) peut bumper en 2 ; il continue à supporter v1 pour les agents non encore upgradés pendant un cycle. Une trame `welcome` peut renvoyer `{ deprecated:'protocol_ver=1', migrate_by:'0.5.0' }` pour avertir.

### Migration des dashboards externes (Prometheus, MQTT, Influx)

- Prometheus : nouvelle label `host=`. Document de migration dans `Docs/MIGRATION.md` avec un snippet PromQL d'agrégation (`sum by (gpu) (gpuviewr_gpu_power_watts)`) pour préserver les dashboards existants côté `host="local"`.
- MQTT : ajouter un niveau de topic `gpuviewr/<host>/gpu<N>/state` (préfixe par défaut `gpuviewr/local/gpu0/state` pour rester rétrocompat sur 1 host). Mais un user multi-host **doit** mettre à jour ses templates HA Discovery. À documenter.
- InfluxDB : ajouter tag `host=<label>` aux lignes. Existant tag `gpu_index` reste.

### Cas dégradés à gérer

- Base v0.2.5 sans `gpu_metrics` (install neuve) : aucune migration nécessaire, juste la création du schéma v0.3.x.
- DB partiellement migrée (process crash en plein milieu) : la migration est transactionnelle (`BEGIN; … COMMIT;`) comme l'exemple existant l.85 — `connection.ts` doit ne réessayer que si `hosts` n'existe pas, ou détecter une migration interrompue (présence de `gpu_metrics_new` orphelin → DROP).

---

## 9. Découpage en jalons livrables

5 jalons. Chacun = 1 PR raisonnable, mergeable, testable indépendamment. Pas de jalon UI.

### Jalon 1 — Refactor préparatoire (no-op fonctionnel)

But : sortir les helpers nvidia-smi et système des modules de service pour qu'ils soient réutilisables par l'agent. Aucune feature, aucun changement de comportement.

- Créer `server/services/_nvidiaParsers.ts` : déplacer `QUERY_FIELDS`, `parsePciThroughput`, `normalizeBusId`, `matchKbps`, `num`, `numOrNull`, `nowTimestamp`, et le type `GpuSample`. `gpuCollector.ts` les ré-importe.
- Créer `server/services/_metricsBus.ts` : nouvel `EventEmitter` singleton. Brancher `gpuCollector.emit('sample', …)` dessus avec `host_id='local'` en dur. `gpuStreamWS.ts`, `alertService.ts`, `exportService.ts` migrent leurs `gpuCollector.on('sample', …)` vers `metricsBus.on('sample', ({ host_id, samples }) => …)` — sur ce jalon `host_id` vaut toujours `'local'`.
- Test : tout doit fonctionner exactement comme avant ; ajouter un test unitaire `metricsBus.test.ts`.

Fichiers : `server/services/gpuCollector.ts`, nouveaux `_nvidiaParsers.ts` + `_metricsBus.ts`, `gpuStreamWS.ts`, `alertService.ts`, `exportService.ts`.

### Jalon 2 — Schéma DB multi-host + migration

- Créer `server/database/models/Host.ts` (CRUD + helpers `markSeen`, `setStatus`).
- Étendre `server/database/connection.ts` :
  - DDL `CREATE TABLE hosts`.
  - Bloc de migration `gpu_metrics`/`gpu_devices`/`alert_events` qui ajoute `host_id` avec valeur `'local'` pour les lignes existantes.
  - Recréation des index avec préfixe `host_id`.
  - Insertion de la ligne `hosts ('local', 'local', 'local', …, 'online')`.
- Adapter toutes les méthodes de `GpuMetric.ts` et `Alert.ts` à `host_id` ; pour cette PR, le code applicatif passe `'local'` partout (toujours mono-host fonctionnel).
- Vérifier via test que la migration sur une DB v0.2.5 produit la même `gpu_metrics.count()` qu'avant et que les rows ont bien `host_id='local'`.

Fichiers : `server/database/connection.ts`, `server/database/models/GpuMetric.ts`, `server/database/models/Alert.ts`, **nouveau** `server/database/models/Host.ts`.

### Jalon 3 — API `/api/hosts` + ingestion WS agent

- `server/routes/hosts.ts` (nouveau) : CRUD + enrollment + rotate-token. `requireAdmin` partout sauf `GET /api/hosts/:id/status` (juste `requireAuth`).
- `server/services/agentIngestWS.ts` (nouveau) : WS sur `/agent`. Authentification via token en query string + lookup `Host.findByTokenHash` + `bcrypt.compare`. Sur trame `hello`, vérifier `host_id` du message contre `host_id` de la session. Sur trame `sample`/`system`/`temps`/`processes`, ré-émettre sur `metricsBus` en taguant avec le `host_id` de la session. Marquer `last_seen` à chaque trame (avec un throttle 1 s pour ne pas marteler la DB).
- Watchdog : tick toutes les 5 s, marque `status='offline'` les hosts dont `last_seen < now - 30s`. Émet sur `metricsBus` un événement `host_status_changed` que `gpuStreamWS` propage aux clients.
- Test : connection bidirectionnelle locale (un client WS factice qui se présente comme agent et publie une trame `sample`) → vérification que le `metricsBus` reçoit bien le sample tagué.

Fichiers : nouveaux `server/routes/hosts.ts`, `server/services/agentIngestWS.ts` ; modification `server/index.ts` (lignes 23-33 pour le mount, 117 pour le bootstrap WS).

### Jalon 4 — Agent autonome packagé

- Créer `/agent` avec `package.json` minimal (`ws` + `tsx`), `tsconfig.json` qui pointe `../server/services/_nvidiaParsers.ts` en path mapping.
- `agent/src/index.ts` : config env (`HUB_URL`, `HOST_ID`, `AGENT_TOKEN`, `TICK_MS`, `FEATURES=gpu,system,temps,processes`), démarrage des collecteurs configurés, transport WS.
- `agent/src/transport.ts` : reconnect exponentiel, ring buffer mémoire 3 600 entrées max (cf. D5), replay au reconnect, handshake `hello`/`welcome`. Si `AGENT_BUFFER_PERSIST=1`, miroir append-only dans `$DATA_DIR/agent-buffer.jsonl` avec rotation à 10 MiB.
- `agent/Dockerfile` : multi-stage, runtime sur `node:22-alpine` ou `gcr.io/distroless/nodejs22-debian12`, taille cible < 60 MiB compressé.
- Documenter en bonus la commande `node --experimental-sea-config` pour produire un binaire statique bare-metal.
- Étendre `docker-compose.yml` avec un fichier d'exemple `docker-compose.agent.yml` séparé (l'utilisateur le pose **sur le nœud distant**, pas sur le hub).

Fichiers : nouveau dossier `/agent/**`, nouveau `docker-compose.agent.yml`, mise à jour de `README.md` avec une section "Add a remote host".

### Jalon 5 — Adaptation API frontale + Prometheus + exports

- `server/routes/gpu.ts`, `system.ts`, `processes.ts` : accepter `?host=<id>` (cf. §7).
- `server/routes/metrics.ts` et `server/services/exportService.ts` : ajouter le label `host=` à Prometheus, le tag `host=` à InfluxDB, et un niveau de topic `<host>/` à MQTT. Compat : si un seul host (`local`), garder l'ancien format pour ne pas casser les dashboards des utilisateurs mono-host.
- `server/services/alertService.ts` : la clé d'état devient `${rule.id}:${host_id}:${gpu_index}`. Les events insérés portent `host_id`.
- `server/routes/health.ts` : ajouter `hostsTotal`, `hostsOnline`.
- `Docs/MIGRATION.md` : mode d'emploi v0.2.5 → v0.3.0 + nouveaux formats Prom/MQTT/Influx.

Fichiers : `server/routes/gpu.ts`, `system.ts`, `processes.ts`, `metrics.ts`, `health.ts`, `alerts.ts`, `server/services/exportService.ts`, `server/services/alertService.ts`, `Docs/MIGRATION.md`, `CHANGELOG.md`.

À la fin du jalon 5, on a une **instance multi-host fonctionnelle** : le hub mono-host marche pareil qu'avant, un admin peut enrôler un agent en 30 secondes, et toutes les surfaces (API, exports, alertes) sont host-aware. L'UI peut suivre dans un v0.3.1.

---

## 10. Risques et pièges

### Boucle infinie si un GpuViewR pointe vers lui-même

Risque réel si quelqu'un confond `agent` et `hub` et configure un agent qui pointe `HUB_URL` vers lui-même. **Garde** : au handshake, l'agent log le `host_id` qu'il envoie ; côté hub, refuser un `host_id` qui correspond au host local (cf. §2 : `hosts` contient toujours une ligne `'local'`). Erreur explicite "host_id collides with local host". Pas une boucle vraie (les messages remontent puis sont ignorés), mais on évite la confusion.

### Changement de hostname

`os.hostname()` peut changer (renommage, reconstruction Docker). C'est pour ça que `host.id` est un **UUID stable**, pas le hostname. Le `hostname` rapporté par l'agent est juste **informatif** (affiché dans l'UI, mis à jour à chaque `hello`). Toute la corrélation historique en DB se fait sur `host_id`.

### Cohérence des alerts : globales ou par host ?

**Décision retenue (D4)** : `alert_rules.host_id NULL` = règle globale (s'applique à tous les hosts, comme aujourd'hui `gpu_index NULL` = toutes les GPU), `host_id='<id>'` = règle ciblée. Les events insèrent toujours le `host_id` qui a déclenché. L'état de hystérésis dans `alertService.ts` est keyé par `(rule_id, host_id, gpu_index)` — donc une règle globale peut firer indépendamment sur le host A et le host B (c'est ce qu'on veut). Symétrie complète avec le pattern `gpu_index` existant. Documenter explicitement dans `Docs/MIGRATION.md`.

### Exports (Prometheus/MQTT/Influx/Webhook)

- Prom : nouvelle label `host=` ⇒ **breaking change** Grafana. À annoncer fort dans le CHANGELOG.
- MQTT : nouveau préfixe `gpuviewr/<host>/…`. Idem.
- Webhooks (Discord/Telegram) : la signature `formatAlert` doit injecter le label du host dans le titre. Sinon un user reçoit "GPU #0 temperature firing" sans savoir laquelle de ses 5 machines râle.

### Agent qui spam le hub

Un agent buggé / compromis pourrait envoyer 10k samples/s. **Garde** : rate-limit au niveau de la session WS — p.ex. `100 messages/s` max via une fenêtre glissante. Au-delà, log warn + déconnexion forcée + cooldown reconnect.

### Time-skew massif (NTP désactivé)

Si l'agent a 10 min de retard, ses `sample.ts_epoch` polluent les graphes. Décision : le hub stocke `hub_ts_epoch` comme `timestamp_epoch` faisant foi (cf. §4). Le diagnostic du skew est exposé via `GET /api/hosts/:id/status` (`time_skew_seconds`).

### Drift de schéma agent ↔ hub

Si l'agent envoie un `GpuSample` avec un champ inconnu (parce qu'il est en avance sur le hub), le hub doit **ignorer** silencieusement (forward-compat). Si à l'inverse il manque un champ que le hub attend, le champ est `null`. Pas d'erreur fatale au unmarshal.

### Cohérence WAL SQLite sous charge multi-host

20 hosts × 1 Hz × 4 GPU = 80 inserts/s. La logique de batch existante (`buffer.push` + flush toutes les 60 s, cf. `gpuCollector.ts:85`) reste pertinente — agréger côté hub avant flush, même origine que le code mono-host. Tester avec un script de charge synthétique (mock-agent) avant release.

### Le hub n'est plus juste un dashboard

Multi-host = le hub devient un point de défaillance critique. Documenter que la DB SQLite reste un single-file (pas de cluster), et que la stratégie de backup recommandée (`data/gpuviewr.db` + WAL) reste valide mais doit être plus assidue. Pas de HA dans le scope.

### Permissions Docker socket

Aucune. L'agent ne touche **pas** au Docker socket. Il invoque `nvidia-smi` comme le fait le hub aujourd'hui. Bonus collatéral : l'agent peut tourner non-root si nvidia-smi est lisible.

---

## Hors scope explicite

- Pas d'UI multi-host dans ces PRs ("affichage, on verra plus tard"). Le frontend `src/` n'est pas touché par les jalons 1-5 sauf pour rester tolérant à la présence du champ `host_id` (peut être fait dans un mini-commit séparé : un parser tolérant qui ignore `host_id` en attendant).
- Pas de RBAC inter-organisation (tous les users admin du hub peuvent gérer tous les hosts).
- Pas d'auto-discovery (mDNS/Consul).
- Pas de mTLS / cert pinning (déléguer TLS au reverse-proxy).
- Pas de sharding ou de réplication SQLite.
- Pas d'agrégation de séries cross-host dans `/api/gpu/history` (un graphe = un host à la fois en v1).

---

## 11. Affichage (UI multi-host) — design proposé

Cible : v0.3.1, après le backbone multi-host (jalons 1-5). Pattern : **hybride** (vue flotte + drill-down host), comme Tailscale / Portainer / Coolify.

### 11.1 Trois nouvelles routes / vues

1. **`/fleet` — Vue Fleet (nouvelle)** — première chose qu'un admin voit après login si plus d'un host existe.
   - Bandeau du haut : 3 chiffres agrégés — `Online: 4/5`, `GPUs: 12`, `Power: 1.2 kW`.
   - Grid responsive de cards (1 col mobile / 2 tablet / 3-4 desktop).
   - 1 card = 1 host : label, dot status (vert/jaune/rouge), hostname dim, nb GPUs, GPU la plus chaude (sparkline 60s), power total, last_seen relatif.
   - Clic carte → `/host/:id` (drill-down).
   - Cards offline grisées, badge "offline 6m" sur la dot.

2. **`/host/:id` — Vue Host (Dashboard actuel rebranché)** — c'est `src/components/dashboard/Dashboard.tsx` tel quel, mais bound à un `host_id` via router param.
   - Le `useGpuStream()` filtre sur `host_id` à la souscription WS.
   - Breadcrumb `Fleet > rtx-rig` pour remonter.
   - Sélecteur GPU existant gagne un sélecteur Host à sa gauche (un combo "host · gpu" cohérent).
   - Si `host.status === 'offline'`, overlay non-bloquant "Host offline — last seen 6m ago" mais on continue d'afficher les dernières données connues + bouton "View history".

3. **`/settings/hosts` — Settings → Hosts (admin only)**
   - Table : Label / Status pill / GPUs / Agent version / Last seen / Actions (rename, rotate token, disable, delete).
   - Bouton `+ Add host` ouvre la modal d'enrollment :
     - Champ unique `label` à remplir.
     - Submit → `POST /api/hosts` → la modal mute en "Token (copy now, shown once)" + snippet `docker run …` cliquable copy-to-clipboard.
     - Warning fort en rouge avant la fermeture.
   - Modal "Rotate token" : confirmation + nouveau token affiché une fois.

### 11.2 Header global — indicateur permanent

`src/components/layout/Header.tsx` (déjà existant) gagne un mini-widget cliquable à droite du logo :

```
[●] Fleet 4/5
```

- Dot agrégé : vert si all online, jaune si ≥1 lagging, rouge si ≥1 offline.
- Clic → `/fleet`.
- Caché si un seul host (`local`) existe — l'utilisateur mono-host ne voit aucune nouveauté visuelle.

### 11.3 Composants à créer

| Composant | Rôle | Notes |
|---|---|---|
| `src/components/fleet/FleetView.tsx` | Page `/fleet` | Layout + agrégats + grid |
| `src/components/fleet/HostCard.tsx` | 1 card host | Inclut sparkline temp, status pill |
| `src/components/fleet/StatusPill.tsx` | Dot + label "Online 3s / Lagging 47s / Offline 6m" | Réutilisé partout |
| `src/components/fleet/FleetIndicator.tsx` | Mini widget header | Réagit aux events `host_status` WS |
| `src/components/settings/HostsTable.tsx` | Table dans Settings | Pagination si > 50 hosts |
| `src/components/settings/EnrollHostModal.tsx` | Modal d'enrollment + token display | Copy-to-clipboard avec masque |
| `src/components/settings/RotateTokenModal.tsx` | Confirmation + nouveau token | Pareil que enroll mais sans nouvelle row |

### 11.4 Store / data flow

- Nouveau store Zustand `useHostsStore` (cf. pattern existant dans `src/store/`) : `hosts: Host[]`, `status: Map<host_id, HostStatus>`, `selectedHostId: string | null`.
- Hydratation initiale via `GET /api/hosts` au boot de l'app.
- Souscription WS `/ws/gpu` reçoit désormais des messages `{type:'host_status', host_id, status, last_seen}` qui mutent le store.
- `Dashboard.tsx` lit `selectedHostId` du store ou du router param.

### 11.5 Comportement zero-config mono-host (préservé)

Si `GET /api/hosts` renvoie un seul host avec `kind='local'` :
- Header `FleetIndicator` masqué.
- `/fleet` toujours accessible mais redirige vers `/host/local` (i.e. `/`).
- Aucun "Add host" visible tant que l'utilisateur n'est pas admin (déjà la sémantique actuelle pour Settings).

### 11.6 Mobile

- Cards `/fleet` : grid 1 col, scroll vertical.
- Header `FleetIndicator` : juste la dot + chiffre, pas de mot "Fleet".
- Modal d'enrollment plein écran.
- Drill-down host inchangé (le Dashboard est déjà responsive).

### 11.7 Hors scope UI (v0.3.1)

- Pas de mode "Compare hosts" (overlay multi-séries cross-host) — réservé v0.4.
- Pas de notification toast "host went offline" — c'est un changement de dot, suffisant pour v0.3.
- Pas de groupes / tags de hosts — flat list.
- Pas de carte géo / réseau visualization.

---

## 12. Options de l'agent — env vars supportées

Surface minimale et stable. Tout est documenté dans `agent/README.md`.

### 12.1 Variables requises (handshake)

| Variable | Rôle | Notes |
|---|---|---|
| `HUB_URL` | URL du hub, ex. `wss://hub.example.com/agent` | `ws://` autorisé seulement vers loopback / RFC1918 (cf. §3). Erreur fatale au boot sinon. |
| `HOST_ID` | UUID donné par le hub à l'enrollment | Stable, jamais re-généré. Doit matcher la ligne `hosts` côté hub. |
| `AGENT_TOKEN` | Secret opaque donné par le hub à l'enrollment | Une seule chance de le copier. Comparé via `bcrypt.compare` côté hub. |

### 12.2 Variables optionnelles (comportement)

| Variable | Défaut | Rôle |
|---|---|---|
| `TICK_MS` | `1000` | Cadence du collecteur GPU. Le hub peut le surcharger via trame `config`. |
| `FEATURES` | `gpu,system,temps,processes` | Liste CSV des collecteurs actifs. Désactiver `processes` sur les machines sans `/proc` partagé. |
| `AGENT_BUFFER_PERSIST` | `0` | Cf. D5. Si `1` : miroir append-only dans `$DATA_DIR/agent-buffer.jsonl`, rotation 10 MiB. |
| `AGENT_LABEL` | (none) | Label initial proposé au hub via `hello`. Si le hub a déjà un label défini par admin, le sien gagne. |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error`. Aligné sur le logger du hub. |
| `NVIDIA_SMI_PATH` | `nvidia-smi` | Override si binaire dans un path exotique. Utile WSL2, bare-metal sans `/usr/bin` standard. |
| `HOST_PROC` | `/host/proc` | Résolution noms process sans `pid: host`. Idem hub aujourd'hui. |
| `RECONNECT_MAX_MS` | `30000` | Cap du backoff exponentiel. Min implicite = 1 s, jitter ±20%. |
| `TLS_INSECURE` | `0` | Skip cert verify (dev uniquement). Log `warn` permanent si actif. |
| `HTTPS_PROXY` / `HTTP_PROXY` | (none) | Proxy d'entreprise. Standard Node `undici`, gratis. |

### 12.3 Choix volontaires d'absence

- Pas de `JWT_SECRET` côté agent (D7 : auth opaque, espace disjoint).
- Pas de `RETENTION_DAYS` / `DATA_DIR` côté agent sauf si `AGENT_BUFFER_PERSIST=1` — c'est le hub qui stocke.
- Pas d'auto-update : l'utilisateur fait `docker pull` puis `restart`.
- Pas de switch "dev mode" — soit l'agent tourne, soit il tourne pas.

### 12.4 Comportements implicites au démarrage (non configurables, documentés)

- Si `nvidia-smi` absent → fatal, exit 1 (pas de mode silencieux qui fait croire que tout va bien).
- Si la trame `hello` est rejetée (token invalide, host_id collision) → exit 1, **pas** de retry boucle infinie.
- Si le hub renvoie `protocol_ver` supérieur au `MAX_KNOWN` agent → exit 1, message "upgrade agent".
- Tous les signaux SIGTERM / SIGINT → flush buffer en RAM, ferme proprement WS avec code 1000, exit 0.

---

## 13. Pré-implémentation — vérifications restantes

Triage des "open questions" qui méritent un check avant d'attaquer le jalon 1.

### 13.1 Bloquants (à confirmer avant d'écrire la première ligne)

1. **Performance bcrypt à l'accueil de N agents** — si 20 agents redémarrent simultanément après une panne hub, on enchaîne 20 `bcrypt.compare` synchrones. À ~80 ms chacun = 1.6 s de blocage event loop.
   - Action : bench rapide + cache LRU `token_hash → host_id` après première compare réussie (TTL 1 h, invalidé sur `rotate-token`).
   - Fichier : à ajouter dans `server/services/agentIngestWS.ts` (jalon 3).

2. **`EXPLAIN QUERY PLAN` sur l'index `(host_id, gpu_index, timestamp_epoch)`** — vérifier que les requêtes legacy `WHERE gpu_index=? AND timestamp_epoch>?` (sans `host_id` explicite) gardent un coût acceptable post-migration.
   - Action : passer le suite de tests existante avec `EXPLAIN QUERY PLAN` activé, comparer pré/post-migration sur une DB de prod.
   - Sinon : garder un index secondaire `(gpu_index, timestamp_epoch)` OU injecter `host_id='local'` côté code legacy (mono-host) systématiquement.

3. **Migration idempotente sous crash** — la migration `gpu_metrics → gpu_metrics_new` peut crasher entre les étapes.
   - Action : au boot, DROP `gpu_metrics_new` orphelin avant de retenter. Tester avec `kill -9` simulé en plein milieu.
   - Fichier : `server/database/connection.ts` (jalon 2).

### 13.2 À benchmarker (pas bloquant mais à mesurer avant release)

4. **20 hosts × 4 GPUs × 1 Hz inserts SQLite** — la logique de batch existante (`flushIntervalMs=60s`) doit tenir.
   - Action : mock-agent qui simule 20 hosts. Sinon : `INSERT OR IGNORE` + WAL checkpoint plus agressif.

5. **Bande passante WS** — théorique = ~4 KB/s/host. Confirmer que la sérialisation JSON ne fait pas exploser ça (les floats peuvent prendre 8-10 chars vs 4 octets binaires).
   - Optionnel post-v0.3 : passer en CBOR / MessagePack si > 10 KB/s/host observé.

6. **Footprint mémoire de l'agent** — objectif < 100 MiB RSS. Si > 150 MiB → `--max-old-space-size=80`.

### 13.3 À décider à mi-parcours (pas avant jalon 3)

7. **Capabilities négociées dynamiquement** — un agent peut-il changer `capabilities` en cours de session ?
   - Décision proposée : NON. Figé au `hello`, l'agent reconnecte si ça change. Plus simple.

8. **Comportement quand un host est supprimé côté hub mais que son agent est encore connecté** — fermer net ou laisser tourner ?
   - Décision proposée : fermer net, code `1008 Policy Violation`, l'agent log et exit.

9. **Composition GPU qui change sur un host** (ajout / retrait carte) — `gpu_devices` upsert ou DELETE ?
   - Décision proposée : marquer `removed_at` plutôt que DELETE. Conservation historique. À documenter au jalon 2.

### 13.4 À documenter avant release

10. **Pré-requis hôte distant** — NVIDIA Container Toolkit + `nvidia-smi` + port sortant atteignable. Section README.
11. **Single binary via Node SEA** — vérifier sur Node 22.19+ que `--experimental-sea-config` produit un binaire utilisable sur Debian 12 / Ubuntu 22+. Si ça casse, retomber sur image Docker seule.
12. **Compat reverse-proxy** — nginx/Caddy/Traefik passent les WS upgrades par défaut, mais certains setups custom non. Snippet de config dans la doc.
13. **CI** — ajouter `agent/Dockerfile` à la matrix Snyk Container. Ajouter le typecheck/build de `/agent` à `CI / build`.

### 13.5 Risques résiduels non bloquants (CHANGELOG)

14. Breaking Prom : nouveau label `host=` → dashboards Grafana mono-host à migrer (snippet PromQL dans `Docs/MIGRATION.md`).
15. Breaking MQTT : préfixe `gpuviewr/<host>/...` → templates HA Discovery à recréer.
16. Webhooks Discord/Telegram : titre d'alerte doit injecter le label host. Sinon un user reçoit "GPU #0 temperature firing" sans savoir laquelle de ses 5 machines râle.

---

## 14. Intégration du preview multi-host dans l'app réelle

Cible : v0.3.1, **après** les jalons 1-5 du backbone. Le preview (`src/preview-multi/`, `index.preview.html`, `vite.preview.config.ts`) est un sandbox déconnecté. Pour le brancher pour de vrai, 7 étapes ordonnées par dépendance.

### 14.1 Backbone d'abord

Le preview suppose l'existence de : table `hosts`, `GET /api/hosts`, messages WS `{ type:'host_status', host_id, status }`. Tout ça arrive aux jalons 2-3. **Aucune intégration UI tant que ces APIs ne sont pas là.**

### 14.2 Migration 1-pour-1 des composants

| Preview (sandbox) | Production (vraie app) |
|---|---|
| `src/preview-multi/components/StatusPill.tsx` | `src/components/fleet/StatusPill.tsx` |
| `src/preview-multi/components/HostCard.tsx` | `src/components/fleet/HostCard.tsx` |
| `src/preview-multi/components/FleetIndicator.tsx` | `src/components/layout/FleetIndicator.tsx` (injecté dans `Header.tsx`) |
| `src/preview-multi/components/Sparkline.tsx` | **supprimer** — réutiliser `src/components/dashboard/Sparkline.tsx` qui existe déjà |
| `src/preview-multi/components/EnrollHostModal.tsx` | `src/components/settings/EnrollHostModal.tsx` |
| `src/preview-multi/pages/FleetView.tsx` | `src/components/fleet/FleetPage.tsx` |
| `src/preview-multi/pages/HostsSettings.tsx` | `src/components/settings/HostsSettingsTab.tsx` |

Le code est ~90% transposable tel quel — il respecte déjà les tokens CSS existants (`--gv-*`, `.card`, `.btn-primary`).

### 14.3 Nouveau store Zustand `useHostsStore`

Fichier : `src/store/hostsStore.ts` (~80 lignes). Pattern aligné sur les stores existants.

État :
- `hosts: Host[]` — hydraté au boot via `fetch('/api/hosts')`
- `liveSamples: Map<host_id, GpuSample[]>` — alimenté par le hook WS existant
- `selectedHostId: string | null` — pour le drill-down
- `status: Map<host_id, HostStatus>`

Actions : `refresh()`, `enroll(label)`, `rotate(id)`, `rename(id, label)`, `remove(id, purgeMetrics)`.

### 14.4 Routes React Router

`src/App.tsx` gagne :

```
<Route path="/fleet"          element={<FleetPage/>} />
<Route path="/host/:id"       element={<Dashboard/>} />
<Route path="/settings/hosts" element={<Settings tab="hosts"/>} />
```

`Dashboard.tsx` lit `useParams().id` (ou `useHostsStore(s => s.selectedHostId)`) et passe ce `host_id` aux APIs GPU.

### 14.5 Comportement mono-host (zero-touch)

```
const hostCount = useHostsStore(s => s.hosts.length);
if (hostCount <= 1) return null;            // header indicator caché
// router : /fleet redirige vers /host/local si un seul host
```

L'utilisateur mono-host **ne voit aucune nouveauté** : pas d'indicateur, pas d'onglet Fleet visible. Accessible uniquement si URL tapée à la main.

### 14.6 i18n

L'app utilise `react-i18next`. Toutes les chaînes du preview (~30 strings) doivent passer par `t()` et atterrir dans `src/i18n/locales/{en,fr,...}.json`. Travail mécanique mais à ne pas oublier.

### 14.7 Permissions

`EnrollHostModal`, rotate, delete : visibles seulement si `user.role === 'admin'`. Wrapper standard :

```
const isAdmin = useAuthStore(s => s.user?.role === 'admin');
if (!isAdmin) return <Redirect to="/" />;
```

### 14.8 Sort du sandbox après v0.3.1

**Décision proposée : supprimer** `src/preview-multi/` + `index.preview.html` + `vite.preview.config.ts` + scripts `dev:preview`/`build:preview` une fois la v0.3.1 sortie. Moins de surface à maintenir, le sandbox aura servi.

Option alternative (à réévaluer en v0.3.1) : garder comme outil d'itération design pour évolutions futures sans backend up.

---

## 15. Installation des agents (côté utilisateur final)

Mode d'emploi cible pour `agent/README.md` et la section "Add a remote host" du README principal.

### 15.0 OS supportés

**Pré-requis communs** : NVIDIA drivers installés + `nvidia-smi` accessible (chemin configurable via `NVIDIA_SMI_PATH`), sortant TCP vers le hub.

| OS | Arch | Mode | Statut |
|---|---|---|---|
| Linux glibc (Debian 11+/Ubuntu 22+/RHEL 9+/Rocky/Alma/Fedora 38+/openSUSE) | x86_64 | Docker **ou** systemd binaire SEA | Tier 1 |
| Linux glibc Jetson / Grace | arm64 | Docker **ou** systemd binaire SEA | Tier 1 |
| Windows + WSL2 (driver NVIDIA WSL ≥ 470) | x86_64 | Agent dans WSL2, **pas natif Windows** | Tier 1 |
| Linux musl (Alpine bare-metal) | x86_64 | Docker uniquement (conteneur glibc OK sur hôte musl) | Tier 2 |

**Pas supporté en v0.3** : Windows natif (pas de NVIDIA Container Toolkit, `/proc` absent → processCollector cassé, Service Manager ≠ systemd). macOS (Apple Silicon n'a pas de NVIDIA, support Mac post-Mojave abandonné par NVIDIA).

**Détails techniques** :
- Image Docker multi-arch `linux/amd64` + `linux/arm64`, base distroless ou `node:22-alpine`, taille ~50-60 MiB compressé.
- Binaire SEA prébuilt pour `linux-x64` et `linux-arm64-gnu`, lié glibc 2.31+ (Debian 11 / Ubuntu 22 / RHEL 9).
- L'agent **ne dépend pas** de `better-sqlite3` (pas de SQLite côté agent) — pas de compilation native obligatoire, le binaire SEA est portable entre distros glibc sans rebuild.
- `--gpus all` est obligatoire côté Docker, sinon `nvidia-smi: command not found` dans le conteneur (erreur #1 attendue).

### 15.1 Côté admin (hub) — 3 clics

1. **Settings → Hosts** dans l'UI GpuViewR.
2. **+ Add host**, taper un label (ex. `rtx-rig`), valider.
3. Le hub affiche **une seule fois** : Host ID (UUID), Agent token (secret), snippet `docker run` prêt à coller.

Modal fermée = token définitivement perdu côté hub (seul son hash bcrypt subsiste). Si perdu : bouton `Rotate token` génère un nouveau secret, l'agent doit être reconfiguré.

### 15.2 Côté nœud distant — 3 modes d'install

**Mode 1 : Docker (recommandé, 95% des cas)**

```bash
docker run -d --name gpuviewr-agent \
  --gpus all \
  --restart unless-stopped \
  -e HUB_URL=wss://gpu.example.com/agent \
  -e HOST_ID=550e8400-e29b-41d4-a716-446655440042 \
  -e AGENT_TOKEN=gpvr_<long-token> \
  ghcr.io/erreur32/gpuviewr-agent:latest
```

Pré-requis hôte :
- NVIDIA Container Toolkit installé (`nvidia-ctk --version`)
- Sortant TCP 443 (ou port custom) vers le hub
- `nvidia-smi` fonctionnel dans un conteneur de test (`docker run --rm --gpus all nvidia/cuda:12.4.0-base-ubuntu22.04 nvidia-smi`)

**Mode 2 : Docker Compose**

Fichier `docker-compose.agent.yml` distribué avec le projet :

```yaml
services:
  agent:
    image: ghcr.io/erreur32/gpuviewr-agent:latest
    restart: unless-stopped
    deploy:
      resources:
        reservations:
          devices:
            - capabilities: [gpu]
    environment:
      HUB_URL: ${HUB_URL}
      HOST_ID: ${HOST_ID}
      AGENT_TOKEN: ${AGENT_TOKEN}
      TICK_MS: 1000
      FEATURES: gpu,system,temps,processes
```

Workflow : `.env` + `docker compose -f docker-compose.agent.yml up -d`. Config en clair, redémarrage facile.

**Mode 3 : systemd bare-metal (Node SEA binaire)**

Pour les nœuds sans Docker (HPC universitaire, vieilles box bare-metal) :

```bash
# 1. Télécharger le binaire (~50 MiB)
curl -L -o /usr/local/bin/gpuviewr-agent \
  https://github.com/Erreur32/GpuViewR/releases/download/v0.3.0/gpuviewr-agent-linux-x64
chmod +x /usr/local/bin/gpuviewr-agent

# 2. Env file (mode 600)
cat > /etc/gpuviewr-agent.env <<EOF
HUB_URL=wss://gpu.example.com/agent
HOST_ID=550e8400-...
AGENT_TOKEN=gpvr_...
EOF
chmod 600 /etc/gpuviewr-agent.env

# 3. Service systemd
cat > /etc/systemd/system/gpuviewr-agent.service <<EOF
[Unit]
Description=GpuViewR Agent
After=network-online.target

[Service]
Type=simple
EnvironmentFile=/etc/gpuviewr-agent.env
ExecStart=/usr/local/bin/gpuviewr-agent
Restart=on-failure
RestartSec=5
User=nobody

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now gpuviewr-agent
```

À fournir au release : binaire Node SEA prébuilt pour `linux/amd64`, `linux/arm64`. Pas mac/windows (usage rare pour GPUs distants).

### 15.3 Vérification de connexion

Côté admin : la card du nouveau host passe en vert "Online" dans 1-3 s. Si reste rouge "Offline" :

- Logs agent : `docker logs gpuviewr-agent` ou `journalctl -u gpuviewr-agent -f`
- Erreurs typiques :
  - `ECONNREFUSED` → URL hub fausse ou hub down
  - `1008 Policy Violation` → token invalide ou host_id mismatch → rotate côté admin + reconfigurer
  - `nvidia-smi not found` → NVIDIA Container Toolkit pas installé sur l'hôte
  - `1006 abnormal closure` répété → TLS / proxy bloque les WS upgrades → config reverse-proxy à revoir

### 15.4 Mise à jour

- Docker : `docker pull ghcr.io/erreur32/gpuviewr-agent:latest && docker restart gpuviewr-agent`
- systemd : télécharger le nouveau binaire, `systemctl restart gpuviewr-agent`

Pas d'auto-update intégré (cf. §12.3).

### 15.5 Suppression

1. Côté nœud : `docker rm -f gpuviewr-agent` (ou `systemctl disable --now gpuviewr-agent`).
2. Côté admin UI : Settings → Hosts → ligne → `🗑 Delete` (avec checkbox "purger l'historique").
