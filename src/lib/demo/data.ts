// Deterministic fake data generators for the public demo build.
// Driven by `wall clock` so the dashboard feels alive but never reads
// real hardware, never persists anything, and ships zero secrets.

export interface DemoGpuSpec {
  index: number;
  name: string;
  uuid: string;
  driver_version: string;
  memory_total: number; // MiB
  power_max: number; // W
  pci_bus_id: string;
  pcie_gen_max: number;
  pcie_width_max: number;
  base_util: number;
  base_temp: number;
  amplitude: number;
}

export const DEMO_GPUS: DemoGpuSpec[] = [
  {
    index: 0,
    name: 'NVIDIA GeForce RTX 4090 (Demo)',
    uuid: 'GPU-DEMO-0000-0000-0000-000000000000',
    driver_version: '550.144.03',
    memory_total: 24576,
    power_max: 450,
    pci_bus_id: '00000000:01:00.0',
    pcie_gen_max: 4,
    pcie_width_max: 16,
    base_util: 55,
    base_temp: 62,
    amplitude: 25,
  },
  {
    index: 1,
    name: 'NVIDIA GeForce RTX 3080 (Demo)',
    uuid: 'GPU-DEMO-1111-1111-1111-111111111111',
    driver_version: '550.144.03',
    memory_total: 10240,
    power_max: 320,
    pci_bus_id: '00000000:02:00.0',
    pcie_gen_max: 4,
    pcie_width_max: 16,
    base_util: 35,
    base_temp: 58,
    amplitude: 30,
  },
];

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

// Smooth pseudo-random walk based on layered sines so the chart looks
// like real telemetry without needing a CSPRNG or a stored RNG state.
function wave(t: number, freq: number, phase: number): number {
  return Math.sin(t * freq + phase);
}

export interface DemoSample {
  gpu_index: number;
  name: string;
  uuid: string;
  driver_version: string;
  temperature: number;
  utilization: number | null;
  memory_used: number;
  memory_total: number | null;
  power: number;
  fan_speed: number | null;
  clock_graphics: number | null;
  clock_memory: number | null;
  pci_bus_id: string;
  pcie_gen_current: number;
  pcie_gen_max: number;
  pcie_width_current: number;
  pcie_width_max: number;
  pcie_rx_kbps: number;
  pcie_tx_kbps: number;
  timestamp: string;
  timestamp_epoch: number;
}

export function sampleAt(spec: DemoGpuSpec, epochMs: number): DemoSample {
  const t = epochMs / 1000;
  const u = clamp(spec.base_util + spec.amplitude * (wave(t, 0.05, spec.index) * 0.6 + wave(t, 0.013, spec.index * 1.7) * 0.4), 5, 99);
  const temp = clamp(spec.base_temp + 8 * wave(t, 0.02, spec.index + 1) + u * 0.12, 35, 88);
  const power = clamp(spec.power_max * (0.25 + 0.55 * (u / 100)) + 12 * wave(t, 0.08, spec.index), 30, spec.power_max);
  const fan = clamp(20 + (temp - 40) * 1.6 + 4 * wave(t, 0.04, spec.index), 0, 100);
  const memUsedPct = clamp(0.45 + 0.35 * (wave(t, 0.011, spec.index) * 0.5 + 0.5), 0.2, 0.95);
  const clockG = Math.round(clamp(900 + 1500 * (u / 100) + 80 * wave(t, 0.06, spec.index), 300, 2700));
  const clockM = Math.round(clamp(5000 + 4500 * (u / 100), 405, 10500));
  const pcieRx = Math.round(clamp(50_000 + 6_000_000 * (u / 100) + 1_000_000 * wave(t, 0.09, spec.index), 0, 16_000_000));
  const pcieTx = Math.round(clamp(20_000 + 1_500_000 * (u / 100) + 400_000 * wave(t, 0.07, spec.index), 0, 16_000_000));
  return {
    gpu_index: spec.index,
    name: spec.name,
    uuid: spec.uuid,
    driver_version: spec.driver_version,
    temperature: Math.round(temp),
    utilization: Math.round(u),
    memory_used: Math.round(spec.memory_total * memUsedPct),
    memory_total: spec.memory_total,
    power: Math.round(power * 10) / 10,
    fan_speed: Math.round(fan),
    clock_graphics: clockG,
    clock_memory: clockM,
    pci_bus_id: spec.pci_bus_id,
    pcie_gen_current: spec.pcie_gen_max,
    pcie_gen_max: spec.pcie_gen_max,
    pcie_width_current: spec.pcie_width_max,
    pcie_width_max: spec.pcie_width_max,
    pcie_rx_kbps: pcieRx,
    pcie_tx_kbps: pcieTx,
    timestamp: new Date(epochMs).toISOString(),
    timestamp_epoch: Math.floor(epochMs / 1000),
  };
}

export function buildHistory(spec: DemoGpuSpec, rangeSec: number, bucketSec: number, now = Date.now()) {
  const points = Math.max(1, Math.floor(rangeSec / bucketSec));
  const rows: Array<{
    timestamp_epoch: number;
    temperature: number;
    utilization: number | null;
    memory_used: number;
    memory_total: number | null;
    power: number;
    fan_speed: number | null;
  }> = [];
  for (let i = points - 1; i >= 0; i--) {
    const epochMs = now - i * bucketSec * 1000;
    const s = sampleAt(spec, epochMs);
    rows.push({
      timestamp_epoch: s.timestamp_epoch,
      temperature: s.temperature,
      utilization: s.utilization,
      memory_used: s.memory_used,
      memory_total: s.memory_total,
      power: s.power,
      fan_speed: s.fan_speed,
    });
  }
  return rows;
}

export function bucketForRange(rangeSec: number): number {
  if (rangeSec <= 600) return 1;
  if (rangeSec <= 3_600) return 5;
  if (rangeSec <= 6 * 3_600) return 30;
  if (rangeSec <= 24 * 3_600) return 60;
  if (rangeSec <= 7 * 86_400) return 600;
  return 1_800;
}

export function rangeToSec(range: string): number {
  const m = /^(\d+)([smhdw])$/.exec(range);
  if (!m) return 600;
  const n = parseInt(m[1], 10);
  switch (m[2]) {
    case 's': return n;
    case 'm': return n * 60;
    case 'h': return n * 3600;
    case 'd': return n * 86_400;
    case 'w': return n * 7 * 86_400;
    default: return 600;
  }
}

export function fakeProcesses(gpuIndex: number) {
  const seed = gpuIndex + 1;
  const spec = DEMO_GPUS.find((g) => g.index === gpuIndex) ?? DEMO_GPUS[0];
  return [
    {
      pid: 1024 + seed,
      process_name: 'python3',
      gpu_uuid: spec.uuid,
      used_memory: 4096 + seed * 320,
      gpu_index: gpuIndex,
      type: 'C' as const,
      command: 'python3 train.py --epochs 50 --batch 32',
      cpu_pct: 18 + seed * 4,
      gpu_pct: 62 - seed * 5,
    },
    {
      pid: 2048 + seed,
      process_name: 'ollama',
      gpu_uuid: spec.uuid,
      used_memory: 2200 + seed * 180,
      gpu_index: gpuIndex,
      type: 'C' as const,
      command: 'ollama serve',
      cpu_pct: 9,
      gpu_pct: 24,
    },
    {
      pid: 3072 + seed,
      process_name: 'Xorg',
      gpu_uuid: spec.uuid,
      used_memory: 180,
      gpu_index: gpuIndex,
      type: 'G' as const,
      command: '/usr/lib/xorg/Xorg :0',
      cpu_pct: 1,
      gpu_pct: 2,
    },
  ];
}

export function fakeAlertEvents() {
  const now = Math.floor(Date.now() / 1000);
  return [
    { id: 1, rule_id: 1, rule_name: 'High temperature', gpu_index: 0, metric: 'temperature', threshold: 80, observed: 84, state: 'resolved', message: 'GPU #0 temperature returned to normal', triggered_at: now - 1800, resolved_at: now - 1500 },
    { id: 2, rule_id: 2, rule_name: 'High GPU utilization', gpu_index: 1, metric: 'utilization', threshold: 95, observed: 98, state: 'resolved', message: 'GPU #1 utilization peaked at 98%', triggered_at: now - 7200, resolved_at: now - 7050 },
    { id: 3, rule_id: 3, rule_name: 'Memory pressure', gpu_index: 0, metric: 'memory', threshold: 90, observed: 93, state: 'firing', message: 'GPU #0 memory at 93% capacity', triggered_at: now - 120, resolved_at: null },
  ];
}

export interface DemoRule {
  id: number;
  name: string;
  metric: 'temperature' | 'utilization' | 'memory' | 'power' | 'fan_speed' | 'host_cpu' | 'host_load_1m' | 'host_memory';
  condition: 'above' | 'below';
  threshold: number;
  duration_s: number;
  gpu_index: number | null;
  enabled: 0 | 1;
  notify_browser: 0 | 1;
  notify_sound: 0 | 1;
  notify_webhook: 0 | 1;
  cooldown_s: number;
}

export function fakeAlertRules(): DemoRule[] {
  return [
    { id: 1, name: 'High temperature',     metric: 'temperature', condition: 'above', threshold: 80, duration_s: 30,  gpu_index: null, enabled: 1, notify_browser: 1, notify_sound: 1, notify_webhook: 0, cooldown_s: 300 },
    { id: 2, name: 'GPU utilization peak', metric: 'utilization', condition: 'above', threshold: 95, duration_s: 60,  gpu_index: null, enabled: 1, notify_browser: 0, notify_sound: 0, notify_webhook: 0, cooldown_s: 600 },
    { id: 3, name: 'Memory pressure',      metric: 'memory',      condition: 'above', threshold: 90, duration_s: 30,  gpu_index: 0,    enabled: 1, notify_browser: 1, notify_sound: 1, notify_webhook: 1, cooldown_s: 300 },
    { id: 4, name: 'Host CPU saturation',  metric: 'host_cpu',    condition: 'above', threshold: 90, duration_s: 120, gpu_index: null, enabled: 0, notify_browser: 1, notify_sound: 0, notify_webhook: 0, cooldown_s: 600 },
  ];
}

export function fakeAlertPresets() {
  return [
    { id: 'temp-warning',     name: 'Temperature warning (≥80°C)',  metric: 'temperature', condition: 'above', threshold: 80, duration_s: 30,  cooldown_s: 300, notify_sound: 0 },
    { id: 'temp-critical',    name: 'Temperature critical (≥90°C)', metric: 'temperature', condition: 'above', threshold: 90, duration_s: 15,  cooldown_s: 300, notify_sound: 1 },
    { id: 'util-saturation',  name: 'Utilization saturation (≥98%)', metric: 'utilization', condition: 'above', threshold: 98, duration_s: 120, cooldown_s: 600, notify_sound: 0 },
    { id: 'mem-pressure',     name: 'Memory pressure (≥90%)',       metric: 'memory',      condition: 'above', threshold: 90, duration_s: 30,  cooldown_s: 300, notify_sound: 0 },
    { id: 'power-near-tdp',   name: 'Power near TDP (≥95%)',         metric: 'power',       condition: 'above', threshold: 380, duration_s: 60, cooldown_s: 600, notify_sound: 0 },
    { id: 'fan-runaway',      name: 'Fan runaway (≥95%)',            metric: 'fan_speed',   condition: 'above', threshold: 95, duration_s: 60,  cooldown_s: 600, notify_sound: 0 },
    { id: 'host-cpu-90',      name: 'Host CPU ≥90%',                 metric: 'host_cpu',    condition: 'above', threshold: 90, duration_s: 120, cooldown_s: 600, notify_sound: 0 },
    { id: 'host-mem-90',      name: 'Host memory ≥90%',              metric: 'host_memory', condition: 'above', threshold: 90, duration_s: 120, cooldown_s: 600, notify_sound: 0 },
  ];
}

export function fakeLogs() {
  const now = Math.floor(Date.now() / 1000);
  const scopes = ['gpu', 'auth', 'db', 'mqtt', 'alerts', 'updates'];
  const entries = [
    { ts: now - 30,   level: 'info',    scope: 'gpu',     message: 'Polled 2 GPUs in 18ms' },
    { ts: now - 60,   level: 'success', scope: 'alerts',  message: 'Rule "Memory pressure" cleared on GPU #0' },
    { ts: now - 90,   level: 'warn',    scope: 'alerts',  message: 'Rule "Memory pressure" fired on GPU #0 (observed=93%)' },
    { ts: now - 240,  level: 'warn',    scope: 'mqtt',    message: 'MQTT broker not configured (demo mode)' },
    { ts: now - 360,  level: 'debug',   scope: 'gpu',     message: 'PCIe bandwidth probe: gen4 x16 = 31.5 GB/s peak' },
    { ts: now - 600,  level: 'info',    scope: 'db',      message: 'Retention sweep removed 0 rows older than 14 days' },
    { ts: now - 1200, level: 'info',    scope: 'auth',    message: 'Demo session opened' },
    { ts: now - 1800, level: 'info',    scope: 'updates', message: 'Update check disabled in demo mode' },
  ];
  return { entries, scopes };
}

export function fakeExportsConfig() {
  return {
    prometheus: {
      enabled: true,
      includeSystemStats: true,
    },
    mqtt: {
      enabled: false,
      includeSystemStats: true,
      url: 'mqtt://broker.example.com:1883',
      username: '',
      password: '',
      topicPrefix: 'gpuviewr',
      haDiscovery: false,
      intervalSeconds: 10,
    },
    influxdb: {
      enabled: false,
      includeSystemStats: true,
      url: 'https://influxdb.example.com:8086',
      token: '',
      org: 'demo-org',
      bucket: 'gpuviewr',
      measurement: 'gpu_metrics',
      intervalSeconds: 10,
    },
    webhook: {
      enabled: false,
      includeSystemStats: false,
      type: 'generic' as const,
      mode: 'alerts' as const,
      url: '',
      method: 'POST' as const,
      headers: {} as Record<string, string>,
      intervalSeconds: 30,
      payloadFields: ['gpu_index', 'name', 'utilization', 'memory_used', 'memory_total', 'fan_speed', 'temperature', 'power', 'timestamp'],
      language: 'en' as const,
      token: '',
      chatId: '',
    },
  };
}

export function fakeExportsInfo() {
  return {
    prometheus: {
      enabled: true,
      endpoint: { method: 'GET' as const, path: '/metrics', url: 'https://demo.local:3015/metrics' },
      metrics: [
        { name: 'gpuviewr_utilization_percent',     help: 'GPU utilization in percent',     type: 'gauge' as const, unit: '%' },
        { name: 'gpuviewr_memory_used_mib',         help: 'GPU memory used in MiB',         type: 'gauge' as const, unit: 'MiB' },
        { name: 'gpuviewr_memory_total_mib',        help: 'GPU memory total in MiB',        type: 'gauge' as const, unit: 'MiB' },
        { name: 'gpuviewr_fan_percent',             help: 'GPU fan speed in percent',       type: 'gauge' as const, unit: '%' },
        { name: 'gpuviewr_temperature_celsius',     help: 'GPU temperature in °C',          type: 'gauge' as const, unit: '°C' },
        { name: 'gpuviewr_power_watts',             help: 'GPU power draw in W',            type: 'gauge' as const, unit: 'W' },
      ],
      hostMetrics: [
        { name: 'gpuviewr_host_cpu_percent',  help: 'Host CPU usage in percent', type: 'gauge' as const, unit: '%' },
        { name: 'gpuviewr_host_load_1m',      help: 'Host load avg (1 min)',     type: 'gauge' as const, unit: '' },
        { name: 'gpuviewr_host_memory_percent', help: 'Host memory usage in %', type: 'gauge' as const, unit: '%' },
      ],
    },
    mqtt: {
      enabled: false,
      broker: '(demo)',
      connected: false,
      intervalSeconds: 10,
      stateTopicPattern: 'gpuviewr/gpu/{index}/state',
      resolvedStateTopics: ['gpuviewr/gpu/0/state', 'gpuviewr/gpu/1/state'],
      payloadKeys: ['utilization', 'memory_used', 'memory_total', 'fan_speed', 'temperature', 'power'],
      host: {
        stateTopic: 'gpuviewr/host/state',
        payloadKeys: ['cpu_pct', 'load_1m', 'memory_used_pct'],
      },
      haDiscovery: { enabled: false as const },
    },
    influxdb: {
      enabled: false,
      writeUrl: 'https://influxdb.example.com:8086/api/v2/write?org=demo-org&bucket=gpuviewr',
      measurement: 'gpu_metrics',
      intervalSeconds: 10,
      tagKeys: ['gpu_index', 'name', 'uuid'],
      fieldKeys: ['utilization', 'memory_used', 'memory_total', 'fan_speed', 'temperature', 'power', 'clock_graphics', 'clock_memory'],
      hostFieldKeys: ['cpu_pct', 'load_1m', 'memory_used_pct'],
    },
  };
}

export function fakeSystem() {
  const now = Date.now();
  return {
    host: {
      hostname: 'gpuviewr-demo',
      platform: 'linux',
      arch: 'x64',
      release: '6.1.0-demo',
      uptime: 86_400 * 7 + 3600,
      loadavg: [0.42, 0.38, 0.31],
      os: { name: 'Debian GNU/Linux', version: '12 (bookworm)', pretty: 'Debian GNU/Linux 12 (bookworm)' },
    },
    cpu: {
      model: 'AMD Ryzen 9 7950X 16-Core Processor',
      cores: 32,
      speedMHz: 4500,
      usagePct: 18 + Math.round(20 * Math.abs(Math.sin(now / 30_000))),
    },
    memory: {
      total: 64 * 1024 ** 3,
      free: 28 * 1024 ** 3,
      used: 36 * 1024 ** 3,
      usedPct: 56.25,
    },
    process: {
      nodeVersion: 'v22.11.0',
      pid: 1,
      uptime: 86_400,
      rss: 180 * 1024 * 1024,
    },
    temperatures: fakeHostTemperatures(now),
    gpus: DEMO_GPUS.map((spec) => {
      const s = sampleAt(spec, now);
      const perLane: Record<number, number> = { 1: 0.25, 2: 0.5, 3: 0.985, 4: 1.969, 5: 3.938, 6: 7.563 };
      const bw = (g: number, w: number) => Math.round(perLane[g] * w * 100) / 100;
      return {
        gpu_index: s.gpu_index,
        name: s.name,
        uuid: s.uuid,
        driver_version: s.driver_version,
        memory_total: s.memory_total,
        memory_used: s.memory_used,
        temperature: s.temperature,
        utilization: s.utilization,
        power: s.power,
        fan_speed: s.fan_speed,
        clock_graphics: s.clock_graphics,
        clock_memory: s.clock_memory,
        pci_bus_id: s.pci_bus_id,
        pcie_gen_current: s.pcie_gen_current,
        pcie_gen_max: s.pcie_gen_max,
        pcie_width_current: s.pcie_width_current,
        pcie_width_max: s.pcie_width_max,
        pcie_bandwidth_GBps: bw(spec.pcie_gen_max, spec.pcie_width_max),
        pcie_bandwidth_max_GBps: bw(spec.pcie_gen_max, spec.pcie_width_max),
        pcie_rx_kbps: s.pcie_rx_kbps,
        pcie_tx_kbps: s.pcie_tx_kbps,
      };
    }),
  };
}

// Synthetic host hwmon sensors so the demo's System page shows the new
// thermal panel. Values wave over time so the heatmap and hero glow
// animate alongside the GPU mocks. Mirrors the shape returned by
// server/services/systemTemperatures.ts.
function fakeHostTemperatures(now: number): ReadonlyArray<{
  source: string; label: string; valueC: number; maxC: number | null; critC: number | null;
}> {
  const w = (period: number, phase: number): number =>
    Math.sin((now / 1000) * (2 * Math.PI / period) + phase);
  const round1 = (n: number): number => Math.round(n * 10) / 10;
  // CPU package + 8 cores. One core runs hotter to mimic a single-thread peak.
  const pkg = round1(62 + 14 * w(45, 0));
  const cores = Array.from({ length: 8 }, (_, i) => {
    const base = 48 + (i === 3 ? 18 : 6 * Math.abs(w(20, i * 0.7)));
    const ripple = 4 * w(11 + i, i);
    return { i, valueC: round1(base + ripple) };
  });
  return [
    { source: 'coretemp', label: 'Package id 0', valueC: pkg, maxC: 95, critC: 100 },
    ...cores.map((c) => ({
      source: 'coretemp', label: `Core ${c.i}`, valueC: c.valueC, maxC: 95, critC: 100,
    })),
    { source: 'nvme', label: 'Composite', valueC: round1(43 + 5 * w(60, 1.2)), maxC: 82, critC: 85 },
    { source: 'nvme', label: 'Sensor 1',  valueC: round1(41 + 4 * w(70, 0.4)), maxC: 82, critC: 85 },
    { source: 'nvme', label: 'Sensor 2',  valueC: round1(42 + 4 * w(80, 2.1)), maxC: 82, critC: 85 },
    { source: 'acpitz', label: 'temp1',   valueC: round1(28 + 2 * w(120, 0)), maxC: null, critC: null },
  ];
}

export function fakeDb() {
  return {
    rows: 84_512,
    oldestEpoch: Math.floor(Date.now() / 1000) - 86_400 * 14,
    newestEpoch: Math.floor(Date.now() / 1000),
    sizeBytes: 18_400_000,
    pageCount: 4500,
    pageSize: 4096,
    retentionDays: 14,
    journalMode: 'wal',
  };
}

export function fakeStats(spec: DemoGpuSpec, rangeSec: number) {
  const rows = buildHistory(spec, rangeSec, bucketForRange(rangeSec));
  const reduce = (key: 'temperature' | 'utilization' | 'memory_used' | 'power') => {
    const vals = rows.map((r) => r[key]).filter((v): v is number => v !== null);
    if (!vals.length) return { min: 0, max: 0, avg: 0 };
    const sum = vals.reduce((a, b) => a + b, 0);
    return { min: Math.min(...vals), max: Math.max(...vals), avg: Math.round((sum / vals.length) * 10) / 10 };
  };
  return {
    temperature: reduce('temperature'),
    utilization: reduce('utilization'),
    memory_used: reduce('memory_used'),
    power: reduce('power'),
  };
}

export function fakeChangelog() {
  return {
    content: [
      '# GpuViewR — Demo build',
      '',
      'This is a **public demo** of GpuViewR running entirely in the browser.',
      '',
      'All metrics are synthetic and refresh every second from a local generator.',
      '',
      'For the real, self-hosted version see <https://github.com/Erreur32/GpuViewR>.',
    ].join('\n'),
  };
}

export function fakeUpdateConfig() {
  return {
    config: {
      enabled: false,
      interval_hours: 24,
      include_prereleases: false,
      auto_check: false,
    },
  };
}

export function fakeUpdateResult() {
  return {
    result: {
      checkedAt: Math.floor(Date.now() / 1000),
      currentVersion: '0.0.0-demo',
      latestVersion: '0.0.0-demo',
      isUpToDate: true,
      releaseUrl: 'https://github.com/Erreur32/GpuViewR/releases',
      releaseNotes: 'Update checks are disabled in the demo build.',
    },
  };
}
