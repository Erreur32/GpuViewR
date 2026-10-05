// Fleet demo mode — activated by ?fleet=1 in the URL (persisted in
// localStorage). The demo build is then served with 5 fake hosts
// instead of just the local one, with periodic status transitions to
// showcase the multi-host UI: per-host curves on the FleetChart,
// stats grid in HostCard, lagging/offline pill changes, etc.
//
// All synthetic. No network, no real hardware.

import { DEMO_GPUS, sampleAt } from './data';

const STORAGE_KEY = 'gpuviewr.demo.fleet';

export function isFleetDemo(): boolean {
  try {
    const params = new URLSearchParams(globalThis.location.search);
    const param = params.get('fleet');
    if (param === '1') {
      localStorage.setItem(STORAGE_KEY, '1');
      return true;
    }
    if (param === '0') {
      localStorage.removeItem(STORAGE_KEY);
      return false;
    }
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function setFleetDemo(enabled: boolean): void {
  try {
    if (enabled) localStorage.setItem(STORAGE_KEY, '1');
    else localStorage.removeItem(STORAGE_KEY);
  } catch { /* ignore */ }
}

export interface DemoHost {
  id: string;
  label: string;
  hostname: string | null;
  kind: 'local' | 'agent';
  status: 'online' | 'lagging' | 'offline';
  agent_version: string | null;
  enrolledAt: number;
  // GPU specs assigned to this host. Picked from DEMO_GPUS so the live
  // sample shape stays identical to single-host demo.
  gpuIndices: number[];
  // Per-host "amplitude" offset so curves don't all overlap perfectly.
  phaseOffsetMs: number;
  // Varied across hosts (rather than one hardcoded value for every
  // agent) so the demo fleet actually showcases the per-mode icon /
  // label / update-recipe branching in HostsSettingsTab and HostCard.
  installMode: 'docker' | 'systemd' | 'windows' | 'macos' | null;
}

const NOW = Math.floor(Date.now() / 1000);

/** How long ago each demo status was last heard from. */
const LAST_SEEN_AGE_S: Record<DemoHost['status'], number> = { online: 2, lagging: 28, offline: 600 };

/** Agents run the hub's own release, as after an auto-update. */
const DEMO_AGENT_VERSION = __APP_VERSION__.replace(/-demo$/, '');

export const DEMO_FLEET_HOSTS: DemoHost[] = [
  {
    id: 'local',
    label: 'demo-hub',
    hostname: 'demo-hub.local',
    kind: 'local',
    status: 'online',
    agent_version: null,
    enrolledAt: NOW - 86400 * 30,
    gpuIndices: [0, 1, 2, 3],
    phaseOffsetMs: 0,
    installMode: null,
  },
  {
    id: 'a1b2c3d4-rtx-rig-fake-uuid-000000000001',
    label: 'rtx-rig',
    hostname: 'rtx-rig.lan',
    kind: 'agent',
    status: 'online',
    agent_version: DEMO_AGENT_VERSION,
    enrolledAt: NOW - 86400 * 7,
    gpuIndices: [0],
    phaseOffsetMs: 5000,
    installMode: 'systemd',
  },
  {
    id: 'a1b2c3d4-lab-3-fake-uuid-000000000002',
    label: 'lab-3',
    hostname: 'lab-3.uni',
    kind: 'agent',
    status: 'online',
    agent_version: DEMO_AGENT_VERSION,
    enrolledAt: NOW - 86400 * 3,
    gpuIndices: [1, 2],
    phaseOffsetMs: 12000,
    installMode: 'docker',
  },
  {
    id: 'a1b2c3d4-dev-mac-fake-uuid-00000000003',
    label: 'dev-mac',
    hostname: 'thomas-mbp',
    kind: 'agent',
    status: 'lagging',
    agent_version: DEMO_AGENT_VERSION,
    enrolledAt: NOW - 86400 * 1,
    gpuIndices: [0],
    phaseOffsetMs: 23000,
    installMode: 'macos',
  },
  {
    id: 'a1b2c3d4-gaming-pc-fake-uuid-0000000004',
    label: 'gaming-pc',
    hostname: 'GAMING-PC',
    kind: 'agent',
    status: 'online',
    agent_version: DEMO_AGENT_VERSION,
    enrolledAt: NOW - 86400 * 2,
    gpuIndices: [3],
    phaseOffsetMs: 31000,
    installMode: 'windows',
  },
];

export function findDemoHost(id: string | null): DemoHost | undefined {
  return DEMO_FLEET_HOSTS.find((h) => h.id === id);
}

/** Build a fake host record matching the HostRecord shape in
 *  src/store/hostsStore.ts so /api/hosts can return them as-is. */
export function fakeFleetHosts() {
  const now = Math.floor(Date.now() / 1000);
  return DEMO_FLEET_HOSTS.map((h) => ({
    id: h.id,
    label: h.label,
    hostname: h.hostname,
    kind: h.kind,
    endpoint: null,
    capabilities: h.kind === 'agent' ? '{"gpu":true,"system":true,"temps":true,"processes":true}' : null,
    agent_version: h.agent_version,
    install_mode: h.installMode,
    auto_update: 0,
    protocol_ver: 1,
    enrolled_at: h.enrolledAt,
    last_seen: now - LAST_SEEN_AGE_S[h.status],
    status: h.status,
  }));
}

export function fakeFleetHealth() {
  const now = Math.floor(Date.now() / 1000);
  let online = 0, lagging = 0, offline = 0;
  for (const h of DEMO_FLEET_HOSTS) {
    if (h.status === 'online') online++;
    else if (h.status === 'lagging') lagging++;
    else if (h.status === 'offline') offline++;
  }
  return {
    ok: true,
    nodeEnv: 'demo',
    mockGpu: true,
    version: '0.0.0-demo',
    uptime: Math.floor(performance.now() / 1000),
    hostsTotal: DEMO_FLEET_HOSTS.length,
    hostsOnline: online,
    hostsLagging: lagging,
    hostsOffline: offline,
    timestamp: new Date(now * 1000).toISOString(),
  };
}

/** Build live samples for one host: each card follows its own profile
 *  (sampleAt), phase-shifted per host so the FleetChart curves differ. */
export function liveSamplesForHost(host: DemoHost) {
  const now = Date.now();
  const epoch = Math.floor(now / 1000);
  const iso = new Date(now).toISOString().slice(0, 19).replace('T', ' ');
  return host.gpuIndices.map((idx) => {
    const spec = DEMO_GPUS[idx % DEMO_GPUS.length];
    return {
      ...sampleAt(spec, now + host.phaseOffsetMs),
      gpu_index: idx,
      name: spec.name.replace('(Demo)', `(Demo · ${host.label})`),
      uuid: `${spec.uuid}-${host.label}`,
      timestamp: iso,
      timestamp_epoch: epoch,
    };
  });
}
