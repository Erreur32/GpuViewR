# Plan d'intégration: agent GpuViewR sur macOS / Apple Silicon (Metal)

> Statut (mis à jour 2026-09-14): **PR1 à PR4 implémentés** (collector
> `powermetrics` + tests, branchement boot/install_mode, `install.sh.mac.tpl`
> + route hub `/install.mac.sh`, UI hub: icône macOS, 4e mode dans
> `InstallModePicker`, label mémoire "Unified"). PR5 (doc + README + CI
> `macos-14` optionnel) en cours. QA visuelle en navigateur pas encore faite.
> Rédigé le 2026-05-25 par l'agent Plan, complété par implémentation directe
> à partir du 2026-09-14 (pas de relecture/validation préalable séparée,
> plan suivi tel quel).

## 0. Recommandations stratégiques préliminaires (à valider avant d'écrire du code)

**À DÉCIDER 1, Scope matériel**: viser **uniquement Apple Silicon (M1+, arm64)**.
Couvrir les Intel Mac avec dGPU AMD est techniquement faisable
(`powermetrics --samplers gpu_power` fonctionne aussi) mais le marché est résiduel
(Mac Pro 2019, iMac Pro), Apple a coupé NVIDIA après 10.14, et l'architecture
mémoire est différente (VRAM dédiée vs unified). Recommandation: **darwin-arm64
seulement** pour la v1, ouvrir darwin-x64 plus tard si demande utilisateur.
Tous les paths ci-dessous supposent ce choix.

**À DÉCIDER 2, Privilèges**: voir §3. Recommandation forte: **sudoers NOPASSWD
ciblé sur `/usr/bin/powermetrics`** plutôt que LaunchDaemon root.

**À DÉCIDER 3, Distribution**: garder le modèle "bundle unique `agent.mjs`
exécuté par Node système" (cohérent avec Linux/Windows). Pas de binaire
`pkg`/`sea`/`bun compile`. Voir §7.

---

## 1. Architecture cible

### 1.1 Détection de plateforme

Le sélecteur actuel `process.platform === 'win32'` dans
`agent/src/index.ts:78,109,112,165,173` doit être complété par
`process.platform === 'darwin'`. Approche: introduire dans `agent/src/index.ts`
une constante locale `IS_DARWIN`/`IS_WIN`/`IS_LINUX` calculée une fois,
et brancher `resolveVendor` + `buildGpuCollector` dessus.

### 1.2 Nouveau collector

Fichier: `agent/src/collectors/gpuMacosPowermetrics.ts`

Même contrat que les 4 collectors existants (`gpu.ts`, `gpuRocm.ts`,
`gpuAmdgpuSysfs.ts`, `gpuWindowsPdh.ts`), càd export d'un
`createMacosPowermetricsCollector(opts)` retournant
`{ start, stop, available }: GpuCollectorHandle`. Pattern à mimer le plus proche:
**`gpuWindowsPdh.ts`** car même topologie (spawn long-running d'un helper natif
qui pousse du JSON sur stdout que Node parse ligne-par-ligne) plutôt que le
modèle "spawn par tick" de `gpu.ts`. Important car `powermetrics` a un coût de
warmup de ~500ms-1s pour initialiser les samplers et faire un spawn par tick
mangerait toute la batterie d'un laptop.

### 1.3 Branchement dans `resolveVendor` et `buildGpuCollector`

Dans `agent/src/index.ts`:

- Introduire un type `GpuVendor` étendu à `'auto' | 'nvidia' | 'amd' | 'apple'`
  dans `agent/src/config.ts:12`. Le parser `parseGpuVendor` (ligne 48-52)
  reconnaît la valeur `apple`.
- `resolveVendor()` (ligne 150-166): ajouter
  `if (process.platform === 'darwin') return 'apple';` juste après le retour
  explicite de `cfg.gpuVendor`. Apple Silicon n'a pas d'autre GPU pertinent
  à probe; le retour `'apple'` est sûr.
- `buildGpuCollector()` (ligne 168-185): nouvelle branche
  `if (v === 'apple') return createMacosPowermetricsCollector(...)`.
- Le collector de processus (`processes.ts`) est aujourd'hui condamné par
  `process.platform === 'win32'` ligne 109-110 et 112; remplacer la garde
  par `if (process.platform !== 'linux' && config.features.processes)` avec
  un message adapté ("processes disabled on macOS: no /proc, no nvidia-smi
  pmon. GPU sampling continues."). Voir §2.4 pour la stratégie processes Mac.

### 1.4 Install mode

Dans `agent/src/transport.ts:34,40-63`, étendre le type `InstallMode` à
`'docker' | 'systemd' | 'windows' | 'macos' | 'unknown'` et faire que
`detectInstallMode` retourne `'macos'` quand `process.platform === 'darwin'`.
Côté hub, `server/database/models/Host.ts:23` doit accepter la même valeur.
Le typecheck va déjà crier aux 3 endroits où `install_mode` est testé côté hub
(`server/services/agentIngestWS.ts:271,317`); les mettre à jour pour autoriser
auto-update sur macOS (cf. §8).

---

## 2. Stratégie de collection des métriques

### 2.1 Commande powermetrics à utiliser

Forme recommandée pour le long-running spawn:

```
sudo powermetrics --samplers gpu_power,smc -i 1000 -f plist
```

Notes:

- `-f plist` (alias `--format plist`) pousse un plist XML par sample, séparé
  par `\x00` (`NUL`). C'est le format documenté et stable. JSON n'est **pas**
  un format de sortie supporté par powermetrics jusqu'à macOS 14. **Ne pas**
  parser le format texte humain, il a déjà changé entre macOS 12 et 14.
- `-i 1000` = interval ms. Aligné sur `config.tickMs`.
- `--samplers gpu_power` donne: util GPU (`GPU active residency` %),
  fréquence (`GPU HW active frequency`), énergie (`GPU Power` mW). Sur
  M1/M2/M3/M4 la liste exacte de clés varie un poil (M3+ ajoute des résidences
  par cluster); le parser doit être tolérant.
- `--samplers smc` donne les sondes SMC (température CPU/GPU package). Sur M1
  c'est limité, sur M2+/M3+ ça expose `GPU die temperature`.
- **Pas** d'option `-n` pour le long-running; on veut un flux continu, pas N
  samples puis exit.

Le parser plist côté Node: utiliser `node:stream` + un buffer délimité sur
`\x00`, puis un mini-parser plist. Ne **pas** dépendre d'un package npm
(la règle implicite du repo est zéro deps autres que `ws`, cf.
`agent/package.json:18-20`). Plist Apple est XML, un parser regex naïf sur
`<key>...</key><integer>...</integer>` couvre les besoins, et est testable
avec fixtures (cf. §11). Sinon ajouter une dep `fast-plist` ou équivalent
(~30 KB) **est acceptable si justifié** mais demande discussion.

### 2.2 Mapping vers le schéma `GpuSample`

Le contrat est `server/services/parsers/nvidia.ts:26-48`. Mapping recommandé:

| Champ `GpuSample` | Source macOS | Note |
|---|---|---|
| `gpu_index` | `0` | un seul GPU intégré, toujours 0 |
| `name` | `sysctl -n machdep.cpu.brand_string` ou `system_profiler SPDisplaysDataType` | one-shot au boot du collector; ex: "Apple M2 Max" |
| `uuid` | `null` | pas de notion d'UUID GPU sur Apple Silicon |
| `driver_version` | version macOS via `sw_vers -productVersion` | proxy raisonnable, le "driver" c'est le kernel |
| `temperature` | clé `GPU die temperature` du sampler `smc` | en °C; `0` si non dispo (M1, voir §2.3) |
| `utilization` | `100 - (GPU idle residency)` ou `GPU active residency` selon le sampler | en %; entier 0-100 |
| `memory_used` | **À DÉCIDER 4** (voir §2.3) | en MiB |
| `memory_total` | `sysctl hw.memsize` (RAM totale en bytes) / 1024 / 1024 | unified memory: tout est partagé |
| `power` | `GPU Power` du sampler `gpu_power` | mW vers W (diviser par 1000) |
| `fan_speed` | `null` | iMac/Mac Studio ont des ventilos mais pas exposés via powermetrics; SMC oui mais hors scope v1 |
| `clock_graphics` | `GPU HW active frequency` | MHz |
| `clock_memory` | `null` | unified memory pas de clock séparé |
| `pci_bus_id`, `pcie_*` | `null` | non applicable (GPU sur le SoC) |

### 2.3 Question "VRAM" sur unified memory, À DÉCIDER 4

C'est la décision design la plus subtile. Trois options:

**Option A (recommandée)**: `memory_total` = RAM totale du Mac, `memory_used`
= **memory pressure × total** dérivée de `vm_stat` (les pages "wired" +
"compressed" ne sont pas un bon proxy pour la "VRAM utilisée par le GPU").
Inconvénient: la jauge va monter aussi à cause des process CPU, pas seulement
GPU. L'UI montre "Memory" pas "VRAM"; doc claire qu'on parle de la pression
mémoire système.

**Option B**: `memory_total = memory_used = 0` (null), l'UI affiche déjà
`'N/A'` (cf. `HostCard.tsx:248`, `GpuMiniTile.tsx:87`). Plus honnête mais perd
100% de la jauge mémoire sur Mac.

**Option C**: utiliser `ioreg -r -c IOAccelerator` + clé `Device Utilization %`
pour la mémoire GPU réservée; gros boulot de parsing et pas toujours présent.
Skip pour v1.

**Recommandation: A**, et côté UI ajouter un badge "Unified" sur les hosts
dont `install_mode === 'macos'` ou dont la capabilities contient un flag
`unified_memory: true` (à ajouter dans le hello, voir §5).

### 2.4 Processes

Sur macOS, sans accès Metal Performance Shaders Counter (privé Apple, non
utilisable sans signature), on ne peut **pas** lister les PIDs qui utilisent
le GPU avec précision. Options:

- **Option A**: laisser `processes` désactivé sur macOS, exactement comme sur
  Windows aujourd'hui (cf. `agent/src/index.ts:109-111`). Recommandée v1.
- **Option B**: `powermetrics --samplers tasks` donne par-PID GPU ms/s et "GPU
  work time"; format plist également. Faisable mais ajoute beaucoup de
  parsing, et la liste est de toute façon polluée par chaque process qui touche
  WindowServer. À déférer.

**Recommandation: A pour v1.** Le `processHandle = null` + log warn suffit, le
hub gère déjà l'absence (cf. `agentIngestWS.ts:466-468`).

### 2.5 Température si pas de SMC

Sur M1 (premier Apple Silicon), `--samplers smc` ne sort souvent rien.
Acceptable: `temperature = 0` (le schéma exige `number not null`, cf.
`nvidia.ts:31`), pas idéal mais aligné avec `gpuWindowsPdh.ts:188` qui hardcode
aussi `temperature: 0` quand PDH ne le donne pas. Documenter que sur M1 la
temp affiche "0°C" et que c'est attendu.

---

## 3. Question sudo, privilèges

`powermetrics` requiert root (capability `task_for_pid` + accès SMC). Deux
options:

### Option (a), Agent en root via LaunchDaemon

Fichier: `/Library/LaunchDaemons/com.gpuviewr.agent.plist`. Tourne sous uid 0
dès le boot, avant login utilisateur. Simple côté script powermetrics (juste
spawner). Inconvénient: l'**agent entier** tourne en root. Lit du JSON depuis
un hub WebSocket distant en root, mauvaise surface d'attaque. Le bundle peut
être hot-replacé par `agent_update` (cf. `transport.ts:278`), un hub compromis
exécute du code arbitraire en root sur tous les Mac.

### Option (b), Sudoers NOPASSWD ciblé

L'agent tourne en **user** via LaunchAgent (`~/Library/LaunchAgents/`). Au
démarrage il spawne `sudo -n /usr/bin/powermetrics ...`. Le fichier
`/etc/sudoers.d/gpuviewr-agent` créé par l'installer:

```
Cmnd_Alias GPUVIEWR_PMETRICS = /usr/bin/powermetrics --samplers gpu_power* --samplers gpu_power\,smc*
%staff ALL=(root) NOPASSWD: GPUVIEWR_PMETRICS
```

Ou plus strict, réservé à un utilisateur dédié `_gpuviewr` créé par l'installer
(mimique du `gpuviewr-agent` Linux dans `install.sh.tpl:32-33,183-185`).

**Recommandation: (b)**. Surface root limitée à `powermetrics` lui-même
(binaire Apple signé), agent reste user. Pattern classique sur macOS (cf. ce
que fait `iStat Menus` et `stats` open source). L'installer doit `visudo -c`
pour valider la syntaxe avant install.

Côté code agent: spawn devient
`spawn('sudo', ['-n', '/usr/bin/powermetrics', ...args])`. Le `-n`
(non-interactive) fait que si sudoers est mal configuré, sudo échoue
immédiatement au lieu de prompter (qui ne marcherait pas dans un LaunchAgent
headless). Le collector doit détecter ce cas dans `available()` en faisant un
`sudo -n /usr/bin/powermetrics -h` au boot (exit 0 = ok, exit non-zéro avec
stderr contenant "askpass" ou "password is required" = tomber sur un log
error explicite et stopper le collector, comme `gpu.ts:101-103`).

---

## 4. Script d'installation

### 4.1 Structure

Nouveau fichier: `agent/install.sh.mac.tpl` (le `.mac.` pour le distinguer
de l'existant qui est Linux-only, cf. `install.sh.tpl:61` qui die explicitement
sur non-Linux).

**Alternative discutée**: étendre `install.sh.tpl` avec un branch
`case "$(uname -s)" in Linux) ... ;; Darwin) ... ;; esac` au lieu d'un fichier
séparé. Mon avis: **fichier séparé** car le flow est très différent
(LaunchAgent vs systemd, brew vs apt/dnf, sudoers vs systemd hardening).
L'unifier coûte plus en lisibilité qu'il rapporte. La route hub
`agentDistribution.ts` peut servir les deux sous des URLs distinctes
(`/install.sh` Linux, `/install.mac.sh` macOS).

### 4.2 Étapes du script

S'inspirer fortement de `install.sh.tpl:24-275` et `install.ps1.tpl` pour le
pattern Windows (re-install lifecycle, kill old launcher avant re-register,
pattern documenté implicitement dans `install.ps1.tpl:343-367`).

```
1. set -euo pipefail
2. [[ "$(uname -s)" == "Darwin" ]] || die "macOS only. Use install.sh for Linux."
3. ARCH=$(uname -m); [[ "$ARCH" == "arm64" ]] || warn "Intel Mac: powermetrics works, but unified-memory mapping assumes Apple Silicon."
4. Parse --url --token --interval --features --uninstall, same flags shape as install.sh.tpl:48-58.
5. Uninstall path FIRST (à la install.ps1.tpl:68-84):
     launchctl unload ~/Library/LaunchAgents/com.gpuviewr.agent.plist 2>/dev/null
     rm -f ~/Library/LaunchAgents/com.gpuviewr.agent.plist
     rm -rf /usr/local/var/gpuviewr-agent  # ou ${HOME}/Library/Application Support/GpuViewR-Agent
     sudo rm -f /etc/sudoers.d/gpuviewr-agent
     exit 0
6. Token parsing: identique au Linux (install.sh.tpl:90-96).
7. Pre-flight Node 22: command -v node, check major. Si absent, suggérer `brew install node@22`. NE PAS auto-installer brew (intrusif, brew install demande sudo password, gère mal le non-interactif).
8. Pre-flight powermetrics: command -v powermetrics, sinon die.
9. Création du dossier d'install: ${HOME}/Library/Application\ Support/GpuViewR-Agent/ (convention macOS user-scope) OU /usr/local/var/gpuviewr-agent si on veut un install system-wide. Recommandation user-scope car le LaunchAgent tourne sous l'user.
10. Téléchargement du bundle: curl -fsSL "${HTTP_URL%/}/agent.mjs" -o "$INSTALL_DIR/agent.mjs" (identique install.sh.tpl:200).
11. Écriture du sudoers (avec visudo -c en validation):
       echo "..." | sudo tee /etc/sudoers.d/gpuviewr-agent
       sudo visudo -c -f /etc/sudoers.d/gpuviewr-agent || (sudo rm /etc/sudoers.d/gpuviewr-agent; die "sudoers invalid")
       sudo chmod 0440 /etc/sudoers.d/gpuviewr-agent
12. Écriture de l'env file: $INSTALL_DIR/agent.env (KEY=VALUE plain, chmod 600). Le .plist le source via EnvironmentVariables.
13. Génération du .plist (template inline; voir §4.3).
14. launchctl unload (best-effort, ignore-erreur, comme install.ps1.tpl:73) + launchctl load -w ~/Library/LaunchAgents/com.gpuviewr.agent.plist.
15. Print les commandes de tail logs et uninstall (à la install.sh.tpl:271-275).
```

### 4.3 Template LaunchAgent

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.gpuviewr.agent</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>{INSTALL_DIR}/agent.mjs</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HUB_URL</key><string>{WS_URL}/agent</string>
    <key>HOST_ID</key><string>{HOST_ID}</string>
    <key>AGENT_TOKEN</key><string>{SECRET}</string>
    <key>TICK_MS</key><string>{INTERVAL_MS}</string>
    <key>FEATURES</key><string>{FEATURES}</string>
    <key>GPU_VENDOR</key><string>apple</string>
  </dict>
  <key>StandardOutPath</key><string>{INSTALL_DIR}/agent.log</string>
  <key>StandardErrorPath</key><string>{INSTALL_DIR}/agent.log</string>
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
```

Note: `KeepAlive=true` est l'équivalent de `Restart=always` (cf.
`install.sh.tpl:242`). Si l'agent quitte volontairement après un `agent_update`
(cf. `transport.ts:368-369`), launchd le relancera dans la seconde, bon match.

### 4.4 Lifecycle re-install

Comme sur Windows (`install.ps1.tpl:343-367`), il faut `launchctl unload` avant
de réécrire le `.plist`, sinon le nouveau token n'est jamais pris en compte
(le processus existant continue avec l'ancien env). Pattern:

```
launchctl bootout gui/$(id -u)/com.gpuviewr.agent 2>/dev/null || true
launchctl unload ~/Library/LaunchAgents/com.gpuviewr.agent.plist 2>/dev/null || true
sleep 0.5
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.gpuviewr.agent.plist
launchctl kickstart -k gui/$(id -u)/com.gpuviewr.agent
```

Le `kickstart -k` force un restart même si le service est déjà running,
équivalent du `Restart-ScheduledTask` Windows ou `systemctl restart` Linux.

Pour les pièges du flow Linux (voir mémoire `reference_install_quirks`):
retenir au minimum (a) bug du token sans `.` (cf. `install.sh.tpl:90-96`),
(b) tolérance du préfixe `gpvr_` (ligne 94), (c) normalisation `http→ws` et
inverse (ligne 194-195 et 209-210). À répliquer **à l'identique** dans le
script Mac.

### 4.5 Distribution depuis le hub

Le hub sert aujourd'hui `/install.sh` via `server/routes/agentDistribution.ts`.
Ajouter `/install.mac.sh` qui sert le template `agent/install.sh.mac.tpl` avec
la même substitution `__HUB_URL__`. Le hub UI
(`src/components/settings/HostsSettingsTab.tsx`) doit montrer les **trois**
one-liners maintenant (Linux / macOS / Windows). Voir §6.

---

## 5. Schéma DB et payload wire

### 5.1 État actuel

Le contrat `GpuSample` (`server/services/parsers/nvidia.ts:26-48`) a 21
champs. Tous sont nullables sauf `gpu_index`, `name`, `temperature`,
`memory_used`, `power`, `timestamp`, `timestamp_epoch`. Le persistor
(`server/services/agentMetricsPersistor.ts:56-69`) écrit dans `gpu_metrics`
(schema `connection.ts:34-48`), 11 colonnes physiques, le reste (pcie, fan,
uuid) est purement transitoire pour le live.

### 5.2 Ce que l'agent macOS peut renvoyer

| Champ | Mac arm64 fournit ? |
|---|---|
| `gpu_index` | oui (0) |
| `name` | oui (ex: "Apple M2 Max") |
| `uuid` | non (null) |
| `driver_version` | proxy (version macOS) |
| `temperature` | oui sur M2+/M3+, 0 sur M1 |
| `utilization` | oui |
| `memory_used` | oui (selon option §2.3) |
| `memory_total` | oui (hw.memsize) |
| `power` | oui |
| `fan_speed` | non (null) |
| `clock_graphics` | oui |
| `clock_memory` | non (null) |
| `pci_*` | non (null) |

**Aucun nouveau champ n'est strictement nécessaire dans `GpuSample`**. Le
schéma actuel suffit; tout ce qui n'existe pas reste `null`, et le persistor
accepte déjà `null` partout (cf. `GpuMetric.ts:24,48`, seuls `memory_used` et
`power` sont NOT NULL DB-side et l'agent les fournit).

**Pas de migration DB nécessaire.**

### 5.3 Capabilities / hello frame

Pour permettre à l'UI de distinguer un host Mac et afficher "Unified Memory"
plutôt que "VRAM" (voir §6), étendre le hello.capabilities. Aujourd'hui
(`transport.ts:230-237`):

```
capabilities: { gpu, system, temps, processes }
```

Proposition d'ajout:

```
capabilities: { gpu, system, temps, processes, unified_memory?: boolean, gpu_arch?: 'cuda' | 'rocm' | 'metal' | 'wddm' }
```

Le hub stocke déjà ça en string JSON dans `hosts.capabilities`
(`Host.ts:34,84`), donc pas de migration DB. Côté ingest,
`agentIngestWS.ts:497` re-sérialise tel quel. L'UI lit la chaîne et parse au
besoin.

**Alternative plus simple**: utiliser uniquement `install_mode === 'macos'`
(voir §1.4) comme proxy pour "afficher Unified". Moins flexible mais zéro
changement de schéma. **Recommandation: cette alternative pour v1.**

---

## 6. Affichage côté hub

### 6.1 Fichiers à modifier

Tous calculent un ratio `memory_used / memory_total` et l'affichent comme
"VRAM" / "Memory". À Mac-aware-iser:

- `src/components/fleet/HostCard.tsx:140-184,229-253`, agrège
  `vramUsed/vramTotal` au niveau host. Label `fleet.aggregate_vram`. Sur host
  macOS, devrait afficher "Unified" ou un suffixe.
- `src/components/fleet/GpuMiniTile.tsx:26-27,87`, arc gauge "memory".
- `src/components/fleet/FleetPage.tsx:31-32,188,195`, agrégat fleet.
- `src/components/dashboard/Dashboard.tsx:84,149-156`, gauge mémoire
  principale.
- `src/components/dashboard/AllGpusGrid.tsx:39,93`, tile par GPU.
- `src/components/dashboard/MultiGpuChart.tsx:162-163`, chart multi-GPU.
- `src/components/dashboard/LiveChart.tsx:218-295`, courbe historique mémoire.
- `src/components/dashboard/StatsSection.tsx:65-95`, section stats.
- `src/components/dashboard/GpuProcessesTable.tsx:121`, colonne VRAM des
  processes (sera vide sur Mac, OK).
- `src/components/system/SystemPage.tsx:30-31,249-250,343-344`, page system.

### 6.2 Patron suggéré

Plutôt que de toucher 10 composants un par un, introduire un **helper unique**
`src/lib/memoryFormat.ts` (ou étendre un existant) exportant
`formatMemoryLabel(host: HostRecord)` qui retourne `"VRAM"` par défaut,
`"Unified"` si `host.install_mode === 'macos'`. Les composants importent ce
helper et remplacent leur string label hardcodée.

Pour le store frontend (`src/store/gpuStore.ts` probablement, à confirmer), il
faut savoir le `install_mode` du host pour chaque sample affiché, déjà dispo
via `/api/hosts` qui est typé `HostRecord`. Plomberie minimale.

Côté i18n (`src/i18n/locales/fr.json`, `en.json`): ajouter `"unified_memory"`
et `"unified_memory_hint"`. Pas urgent v1; on peut passer "Unified" tel quel.

### 6.3 Settings UI

`src/components/settings/HostsSettingsTab.tsx` montre aujourd'hui les recettes
d'install Linux + Docker + Windows. Ajouter macOS:

```bash
curl -fsSL https://gpu.example.com/install.mac.sh | bash -s -- \
  --url https://gpu.example.com \
  --token <host_id>.<secret>
```

Le composant a déjà la logique multi-recette (cf. clé i18n
`agent_outdated_help_both` dans `fr.json:496`). Étendre l'enum à 4 cases.

---

## 7. Build et distribution

### 7.1 État actuel

`agent/scripts/build.mjs` bundle `agent/src/index.ts` en un **single
`agent.mjs`** via esbuild en mode `platform: node, target: node22, format: esm`.
Le résultat est ~215 KB (cf. `agentIngestWS.ts:179-180`). **Le bundle est
platform-agnostic**, c'est juste du JS qui appelle `spawn(...)`. **Aucun
rebuild par OS n'est nécessaire.**

Le CI actuel (`.github/workflows/ci.yml`, `docker-publish.yml`) build seulement
les images Docker (linux/amd64 + linux/arm64). Le `agent.mjs` est inclus dans
l'image hub et servi via `/agent.mjs` (cf. `BUNDLE_PATH`
`agentIngestWS.ts:180`).

### 7.2 Conséquence pour macOS

**Rien à faire côté build CI**. Le même `agent.mjs` que les Linux/Windows
téléchargent sera téléchargé par les Mac. Seule la **runtime detection**
(`process.platform`) trie qui appelle `nvidia-smi` vs `powermetrics`.

C'est un avantage énorme du design existant: pas de matrice darwin-arm64 /
darwin-x64 / linux-x64 / linux-arm64 / win-x64 à gérer.

### 7.3 Nuance: Node 22 doit être installé sur le Mac

Le `agent.mjs` est du JS bundle, il faut Node 22 system. L'installer Mac doit
(a) détecter Node, (b) si manquant, le pointer vers `brew install node@22` ou
`https://nodejs.org/dist/v22.x/node-v22.x.x.pkg`. Pas d'auto-install via
Homebrew (intrusif, demande mot de passe sudo en interactif).

### 7.4 Test build sur Mac

Aucune CI runner macOS dans le projet aujourd'hui. **Optionnel**: ajouter un
job `build-darwin` dans `.github/workflows/ci.yml` qui tourne sur
`runs-on: macos-14` et fait `cd agent && npm ci && npm run build && node dist/agent.mjs --version`
(vérifie juste que le bundle se charge sur Mac). Coût: minutes GitHub Mac × 10
minutes par PR. **Pas critique v1.**

---

## 8. Auto-update

### 8.1 État actuel

`transport.ts:278-370` (`applyAgentUpdate`) fait un atomic swap du bundle puis
exit(0). Deux paths:

- Linux: `writeFileSync(.new) + fsync + rename(.new vers target) + exit(0)`,
  systemd restart.
- Windows: `writeFileSync(.pending) + fsync + exit(0)`, `launcher.ps1` swap au
  prochain tour de boucle.

### 8.2 Path macOS

LaunchAgent avec `KeepAlive=true` relance le binaire au `exit(0)` dans la
seconde. Le path **Linux** marche tel quel:
`writeFileSync(.new) + fsync + rename(.new vers target) + exit(0)`. Atomic
rename(2) marche sur APFS (le FS macOS) comme sur ext4.

**Modification code agent**: dans `transport.ts:344`
(`const isWin = process.platform === 'win32'`), pas de changement, Mac tombe
dans la branche Linux. Bon par défaut.

**Modification code hub**: `agentIngestWS.ts:271,317` gate l'auto-update à
`install_mode === 'systemd' || 'windows'`. Étendre à `'macos'`:

```
if (host.install_mode !== 'systemd' && host.install_mode !== 'windows' && host.install_mode !== 'macos') return;
```

### 8.3 Gatekeeper et auto-update

L'agent self-réécrit son fichier `.mjs`. Pas de signature à valider (c'est du
JS, pas un binaire Mach-O). Gatekeeper ne s'en mêle pas pour les `.mjs`
exécutés via `node`. **Pas de friction**.

---

## 9. Sécurité, Gatekeeper, sudoers, sandbox

### 9.1 Gatekeeper

L'agent étant du **JS exécuté par le binaire `node` du système**, Gatekeeper
ne bloque rien (c'est `node` qui est exécuté, et lui est déjà autorisé). Si
l'utilisateur installe Node depuis nodejs.org (.pkg), le pkg est notarisé
Apple. Brew compile localement, donc Gatekeeper-clean.

**Aucune signature ad-hoc nécessaire** pour `agent.mjs`.

### 9.2 TCC (Transparency, Consent and Control)

Sur Mac récent (Ventura+), l'accès aux capteurs SMC via `powermetrics` peut
prompter une fenêtre "powermetrics wants to monitor X". Cela arrive UNE FOIS,
la première fois, et seulement si l'agent tourne sous LaunchAgent (user
session). Si on passe par sudo (donc root), pas de prompt TCC.

**Note d'installation**: au premier lancement de l'agent, l'utilisateur
**peut** voir un prompt système. L'installer doit le mentionner explicitement
dans son output final ("If you see a TCC prompt, click Allow.").

### 9.3 sudoers

Cf. §3. Le fichier `/etc/sudoers.d/gpuviewr-agent` doit être chmod 0440
root:wheel, validé via `visudo -c -f`. L'installer doit refuser d'écrire un
sudoers invalide (sinon plus aucune commande sudo ne marche sur la machine,
catastrophe documentée du sudoers cassé).

### 9.4 Network sandbox

Aucun. L'agent ouvre un WS sortant. macOS Application Firewall demande
l'autorisation au premier outbound de Node, si l'utilisateur n'est pas devant
l'écran (Mac mini headless), la connexion peut être bloquée. Workaround:
l'installer peut faire `socketfilterfw --add /usr/local/bin/node` (besoin
sudo). Documenter dans le README, ne pas auto-fixer (intrusif).

### 9.5 Recommandation

**v1**: ne pas signer Apple Developer ID (~99 $/an + complexité), ne pas
tenter de notariser, ne pas toucher au firewall. Doc claire dans le README
qu'on est en mode "self-hosted, expect 1 TCC prompt, expect to allow node in
Firewall once". **À DÉCIDER 5**: confirmer que l'utilisateur accepte ce niveau
de friction "first launch".

---

## 10. Découpage en PRs

**PR1, Collector pur + tests unitaires (1-1.5 j)** — fait, 2026-09-14

- `agent/src/collectors/gpuMacosPowermetrics.ts`
- `agent/src/collectors/gpuMacosPowermetrics.test.ts` avec fixtures plist
  (powermetrics output capturé manuellement sur un Mac)
- `agent/src/collectors/macosSysctl.ts` (helpers `hw.memsize`,
  `machdep.cpu.brand_string`)
- Pas encore de branchement dans `index.ts`. Le collector est isolé, testable
  sur Linux CI via fixtures.

**PR2, Branchement boot + install_mode (0.5 j)** — fait, 2026-09-14

- `agent/src/config.ts`: ajouter `'apple'` au type `GpuVendor`.
- `agent/src/index.ts`: ajouter `'darwin'` dans `resolveVendor`,
  `buildGpuCollector`, et désactiver process collector.
- `agent/src/transport.ts`: ajouter `'macos'` à `InstallMode` + détection.
- `server/database/models/Host.ts`: étendre `InstallMode`.
- `server/services/agentIngestWS.ts`: autoriser auto-update pour macOS.
- Smoke test manuel: `MOCK_GPU=1 node agent.mjs` sur Mac doit booter sans
  crash.

**PR3, Script d'installation Mac (1-1.5 j)** — fait, 2026-09-14

- `agent/install.sh.mac.tpl`
- `server/routes/agentDistribution.ts`: nouvelle route `/install.mac.sh`.
- Tests E2E manuels sur un Mac de dev (uninstall + install + tail logs +
  uninstall): **pas encore faits**, pas de Mac réel disponible dans cette
  session. `tsc --noEmit` + `npm test` (agent) passent, mais le script n'a
  jamais tourné sur un vrai macOS.

**PR4, Hub UI (1 j)** — fait, 2026-09-14, avec un écart volontaire sur le
scope mémoire (voir ci-dessous)

- `src/lib/memoryFormat.ts` helper: fait.
- 10 fichiers `src/components/...` à toucher pour le label "VRAM" vers
  conditional: **réduit à 2** (`HostCard.tsx`, `Dashboard.tsx`), les 8 autres
  utilisaient déjà un label générique déjà traduit ("Memory"/"Mémoire", pas
  littéralement "VRAM"), donc zéro changement visible et zéro prop-drilling
  à ajouter pour eux. Conforme à l'allowance du plan lui-même ("pas urgent
  v1, on peut passer 'Unified' tel quel"). À reconsidérer si l'utilisateur
  veut le traitement complet des 10 fichiers.
- `src/components/settings/HostsSettingsTab.tsx`: recette macOS ajoutée.
- `src/i18n/locales/fr.json` + `en.json`: clés `type_macos*`, `macos_cmd`,
  `install_mode_macos`, `install_macos_hint` ajoutées.
- QA visuelle navigateur (icône, label "Unified", 4e onglet du picker) pas
  encore faite, extension Chrome indisponible au moment de l'implémentation.

**PR5, Doc + CI sanity (0.5 j)** — en cours, 2026-09-14

- Mise à jour `agent/README.md` section "macOS".
- Mise à jour `README.md` racine pour supprimer le "Local GPU monitoring is
  not possible on macOS" (devient possible bare-metal, reste impossible en
  Docker).
- `Docs/MACOS_AGENT.md` (ce fichier) à promouvoir en "implementé" + journal
  des écarts vs plan.
- **Optionnel**: job CI `build-darwin` sur macos-14.

**Optionnel PR6, Processes via `--samplers tasks` (0.5-1 j)** différable, hors
v1.

---

## 11. Stratégie de tests sans Mac

### 11.1 Tests unitaires

Le pattern existant `agent/src/collectors/gpuAmdgpuSysfs.test.ts` est la
référence: lit des **fixtures** texte capturées une fois, vérifie le parsing en
pur.

Pour macOS:

- Capturer manuellement (sur un Mac de dev) 3-5 outputs
  `powermetrics --samplers gpu_power,smc -i 1000 -n 1 --format plist`, stocker
  sous `agent/src/collectors/__fixtures__/powermetrics-m1.plist`,
  `powermetrics-m2max.plist`, `powermetrics-m3pro.plist`.
- Tests: passer chaque fixture au parser, asserter les champs extraits.
- Couvrir aussi les edge cases: fixture sans clé `GPU die temperature` (M1),
  fixture avec valeur `<integer>` vs `<real>`.

### 11.2 Tests d'intégration boot

Mock `child_process.spawn` pour simuler `powermetrics` qui pousse une fixture
sur stdout. Vérifier que `createMacosPowermetricsCollector` appelle bien
`onSample` avec un `GpuSample[]` bien-formé.

Suivre le pattern du test `agentIngestWS.test.ts` pour le wiring WS.

### 11.3 CI

`npm test` actuel (`agent/package.json:15`, `tsx --test src/**/*.test.ts`)
tourne sur Ubuntu. Les tests fixture-based passent partout. **Pas besoin de
runner macOS** pour la PR1 et la PR2.

Le runner macOS n'est nécessaire que pour valider l'install.sh.mac.tpl
bout-en-bout. Faisable manuellement en début + après chaque release; on peut
s'en passer en CI.

### 11.4 Validation finale

Côté humain: avoir 1 Mac Apple Silicon (M1/M2/M3 ou M4) sous la main pour les
PR3-PR5. Si pas dispo, deuxième best: GitHub Actions `runs-on: macos-14` ARM
(gratuit pour public repos, $0.16/min sinon, exposable seulement via
workflow).

---

## 12. Estimation grossière

| PR | Description | Estimation (j-h, dev seul rapide) |
|---|---|---|
| PR1 | Collector + tests fixtures | 1 à 1.5 |
| PR2 | Branchement boot, install_mode | 0.5 |
| PR3 | install.sh.mac.tpl + sudoers + LaunchAgent | 1 à 1.5 |
| PR4 | Hub UI (label memory, settings recette) | 1 |
| PR5 | Doc + cleanup README + CI optionnel | 0.5 |
| **Total v1 (Apple Silicon, sans processes)** | | **~4 à 5 j-homme** |
| PR6 (optionnel) | processes via `--samplers tasks` | +0.5 à 1 |

Risques susceptibles d'inflater l'estimation:

- Parser plist robuste (si on refuse une dep tierce): +0.5 j sur PR1.
- Bug TCC ou sudoers découvert sur un Mac réel: +0.5 j sur PR3.
- Refactor du store frontend pour propager `install_mode` aux composants
  memory: +0.5 j sur PR4.

Plancher réaliste: **4 j**. Plafond: **6 j**.

---

## Points "À DÉCIDER" remontés

1. **Scope**: darwin-arm64 seul vs darwin-arm64 + darwin-x64. Reco: arm64
   seul.
2. **Privilèges**: LaunchDaemon root vs LaunchAgent + sudoers NOPASSWD. Reco:
   sudoers ciblé.
3. **Distribution**: rester sur bundle `agent.mjs` unique vs binaire signé.
   Reco: bundle.
4. **Mapping unified memory**: Option A (pression mémoire via vm_stat) vs B
   (null) vs C (ioreg). Reco: A, avec UI claire.
5. **Friction "first launch"**: accepter prompt TCC + Firewall macOS au
   premier run, ou tenter de scripter? Reco: documenter, ne pas scripter.
6. **CI runner macOS**: ajouter macos-14 job ou pas? Reco: pas en v1.
7. **Processes Mac**: déférer à PR6 ou skip définitivement? Reco: déférer.

---

## Fichiers critiques pour l'implémentation

- `agent/src/index.ts`
- `agent/src/collectors/gpuWindowsPdh.ts` (pattern de référence pour le
  long-running spawn)
- `agent/install.sh.tpl` (pattern installer Linux à transposer)
- `agent/install.ps1.tpl` (pattern lifecycle re-install à transposer)
- `server/services/agentIngestWS.ts` (gates auto-update à étendre)
