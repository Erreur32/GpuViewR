// Fleet demo mode — activated by ?fleet=1 in the URL (persisted in
// localStorage). The demo build is then served with 4 fake hosts
// instead of just the local one, with periodic status transitions to
// showcase the multi-host UI: per-host curves on the FleetChart,
// stats grid in HostCard, lagging/offline pill changes, etc.
//
// All synthetic. No network, no real hardware.

import { DEMO_GPUS } from './data';

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
}

const NOW = Math.floor(Date.now() / 1000);

export const DEMO_FLEET_HOSTS: DemoHost[] = [
  {
    id: 'local',
    label: 'demo-hub',
    hostname: 'demo-hub.local',
    kind: 'local',
    status: 'online',
    agent_version: null,
    enrolledAt: NOW - 86400 * 30,
    gpuIndices: [0, 1],
    phaseOffsetMs: 0,
  },
  {
    id: 'a1b2c3d4-rtx-rig-fake-uuid-000000000001',
    label: 'rtx-rig',
    hostname: 'rtx-rig.lan',
    kind: 'agent',
    status: 'online',
    agent_version: '0.3.0',
    enrolledAt: NOW - 86400 * 7,
    gpuIndices: [0],
    phaseOffsetMs: 5000,
  },
  {
    id: 'a1b2c3d4-lab-3-fake-uuid-000000000002',
    label: 'lab-3',
    hostname: 'lab-3.uni',
    kind: 'agent',
    status: 'online',
    agent_version: '0.3.0',
    enrolledAt: NOW - 86400 * 3,
    gpuIndices: [0, 1],
    phaseOffsetMs: 12000,
  },
  {
    id: 'a1b2c3d4-dev-mac-fake-uuid-00000000003',
    label: 'dev-mac',
    hostname: 'thomas-mbp',
    kind: 'agent',
    status: 'lagging',
    agent_version: '0.3.0',
    enrolledAt: NOW - 86400 * 1,
    gpuIndices: [0],
    phaseOffsetMs: 23000,
  },
];

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
    protocol_ver: 1,
    enrolled_at: h.enrolledAt,
    last_seen: h.status === 'offline' ? now - 600 : h.status === 'lagging' ? now - 28 : now - 2,
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

/** Build live samples for one host, phase-shifted so each host's
 *  curves are visually distinct on the combined FleetChart. */
export function liveSamplesForHost(host: DemoHost) {
  const now = Date.now();
  const epoch = Math.floor(now / 1000);
  const iso = new Date(now).toISOString().slice(0, 19).replace('T', ' ');
  return host.gpuIndices.map((idx) => {
    const spec = DEMO_GPUS[idx % DEMO_GPUS.length];
    // Sine waves shifted per host so the FleetChart has distinct curves.
    const wave = Math.sin((now + host.phaseOffsetMs) / 8000);
    const utilization = Math.max(2, Math.min(100, spec.base_util + wave * spec.amplitude));
    const temperature = Math.round(spec.base_temp + wave * (spec.amplitude / 3));
    const power = Math.round(
      Math.max(40, Math.min(spec.power_max, spec.power_max * 0.4 + wave * spec.power_max * 0.4)),
    );
    return {
      gpu_index: idx,
      name: spec.name.replace('(Demo)', `(Demo · ${host.label})`),
      uuid: `${spec.uuid}-${host.label}`,
      driver_version: spec.driver_version,
      temperature,
      utilization,
      memory_used: Math.round(spec.memory_total * (0.3 + Math.abs(wave) * 0.4)),
      memory_total: spec.memory_total,
      power,
      fan_speed: Math.round(40 + Math.abs(wave) * 50),
      clock_graphics: 1500 + Math.round(wave * 500),
      clock_memory: 9000 + Math.round(wave * 800),
      pci_bus_id: spec.pci_bus_id,
      pcie_gen_current: spec.pcie_gen_max,
      pcie_gen_max: spec.pcie_gen_max,
      pcie_width_current: spec.pcie_width_max,
      pcie_width_max: spec.pcie_width_max,
      pcie_rx_kbps: Math.round(Math.abs(wave) * 80_000),
      pcie_tx_kbps: Math.round(Math.abs(wave) * 50_000),
      timestamp: iso,
      timestamp_epoch: epoch,
    };
  });
}
