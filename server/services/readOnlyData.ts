import { HostsRepo, LOCAL_HOST_ID, type HostRecord } from '../database/models/Host.js';
import { GpuMetricRepository } from '../database/models/GpuMetric.js';
import { metricsBus } from './_metricsBus.js';
import { agentProcessStore } from './agentProcessStore.js';
import { parseRange } from '../utils/range.js';

// Read-only data shared by /api/v1 and the MCP tools, so both surfaces
// answer from one place. Nothing in here writes or reaches an agent.

/** Same ceiling as the dashboard chart (server/routes/gpu.ts). */
const HISTORY_TARGET_POINTS = 1800;

export function hostOrLocal(raw: unknown): string {
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : LOCAL_HOST_ID;
}

function publicHost(h: HostRecord) {
  const { token_hash: _omit, ...rest } = h;
  return rest;
}

export function listHosts() {
  return HostsRepo.list().map(publicHost);
}

export function healthSummary(version: string) {
  const hosts = HostsRepo.list();
  let gpuCount = 0;
  for (const h of hosts) gpuCount += metricsBus.getLatestByHost(h.id).length;
  const count = (status: string) => hosts.filter((h) => h.status === status).length;
  return {
    status: 'ok',
    version,
    uptime_s: Math.floor(process.uptime()),
    gpu_count: gpuCount,
    hosts_total: hosts.length,
    hosts_online: count('online'),
    hosts_offline: count('offline'),
  };
}

/** Latest sample of every GPU, of one host or (no host) of the whole fleet. */
export function currentGpus(host?: string) {
  const ids = host ? [host] : HostsRepo.list().map((h) => h.id);
  return ids.flatMap((id) => metricsBus.getLatestByHost(id).map((s) => ({ host_id: id, ...s })));
}

export function gpuHistory(host: string, gpuIndex: number, range: string) {
  const seconds = parseRange(range);
  const since = Math.floor(Date.now() / 1000) - seconds;
  const bucketSec = Math.max(1, Math.ceil(seconds / HISTORY_TARGET_POINTS));
  const rows = bucketSec > 1
    ? GpuMetricRepository.historyDownsampled(host, gpuIndex, since, bucketSec)
    : GpuMetricRepository.history(host, gpuIndex, since);
  return { host, gpu_index: gpuIndex, range, count: rows.length, bucket_sec: bucketSec, history: rows };
}

export function gpuStats(host: string, gpuIndex: number, range: string) {
  const since = Math.floor(Date.now() / 1000) - parseRange(range);
  return { host, gpu_index: gpuIndex, range, stats: GpuMetricRepository.stats(host, gpuIndex, since) };
}

/** Processes of one host from its latest agent snapshot, optionally on one GPU. */
export function hostProcesses(host: string, gpuIndex: number | null) {
  const snap = agentProcessStore.get(host);
  if (!snap) return { host, timestamp_epoch: null, count: 0, processes: [], reason: 'no recent process snapshot (agent offline or capability disabled)' };
  const indexByUuid = new Map(metricsBus.getLatestByHost(host).map((s) => [s.uuid, s.gpu_index]));
  const all = snap.processes.map((p) => ({ ...p, gpu_index: indexByUuid.get(p.gpu_uuid) ?? null }));
  const processes = gpuIndex === null ? all : all.filter((p) => p.gpu_index === gpuIndex);
  return { host, timestamp_epoch: snap.ts, count: processes.length, processes };
}

/** Every LLM process across the fleet, from the live snapshots. */
export function fleetLlmProcesses() {
  const rows = [];
  for (const host of HostsRepo.list()) {
    const snap = agentProcessStore.get(host.id);
    if (!snap) continue;
    const samples = metricsBus.getLatestByHost(host.id);
    for (const p of snap.processes) {
      if (!p.llm_runtime) continue;
      const card = samples.find((s) => s.uuid === p.gpu_uuid);
      rows.push({
        host_id: host.id,
        host_label: host.label || host.hostname || host.id,
        gpu_index: card?.gpu_index ?? null,
        gpu_name: card?.name ?? null,
        ...p,
      });
    }
  }
  return rows;
}
