import { HostsRepo, LOCAL_HOST_ID, type HostRecord } from '../database/models/Host.js';
import { GpuDeviceRepository, GpuMetricRepository } from '../database/models/GpuMetric.js';
import { metricsBus } from './_metricsBus.js';
import { agentProcessStore } from './agentProcessStore.js';
import { parseRange } from '../utils/range.js';
import { llmServerInfo } from './llmEndpoint.js';
import { updateService } from './updateService.js';

// Read-only data shared by /api/v1 and the MCP tools, so both surfaces
// answer from one place. Nothing in here writes or reaches an agent.

/** Same ceiling as the dashboard chart (server/routes/gpu.ts). */
const HISTORY_TARGET_POINTS = 1800;

export function hostOrLocal(raw: unknown): string {
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : LOCAL_HOST_ID;
}

function parseJson(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** API shape of a host: `capabilities` stays the stored JSON string (older
 *  clients parse it), `capabilities_object` is the same data as an object. */
function publicHost(h: HostRecord) {
  const { token_hash: _omit, ips, ...rest } = h;
  const caps = parseJson(h.capabilities);
  const ipList = parseJson(ips);
  return {
    ...rest,
    ips: Array.isArray(ipList) ? ipList : [],
    capabilities_object: caps && typeof caps === 'object' && !Array.isArray(caps) ? caps : null,
  };
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
    ...hubUpdate(version),
  };
}

/** Newest published release, from the update checker's cache (Settings >
 *  Updates). Never waits on GitHub: a stale cache is refreshed in the
 *  background and shows up on a later call. */
function hubUpdate(version: string) {
  updateService.refreshInBackground();
  const r = updateService.peek();
  const latest = r?.latestVersion ?? null;
  return {
    update_check_enabled: updateService.getConfig().enabled,
    latest_version: latest,
    update_available: latest !== null && updateService.compareVersions(latest, version) > 0,
    update_checked_at: r?.checkedAt ?? null,
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

/** Min / avg / max of every GPU of the fleet over one window, one row per
 *  (host_id, gpu_index) that has samples in it. */
export function fleetGpuStats(range: string) {
  const since = Math.floor(Date.now() / 1000) - parseRange(range);
  const labels = new Map(HostsRepo.list().map((h) => [h.id, h.label || h.hostname || h.id]));
  const names = new Map(GpuDeviceRepository.list().map((d) => [`${d.host_id}|${d.gpu_index}`, d.name]));
  const stats = GpuMetricRepository.statsAll(since).map(({ host_id, gpu_index, ...aggregates }) => ({
    host_id,
    host_label: labels.get(host_id) ?? null,
    gpu_index,
    gpu_name: names.get(`${host_id}|${gpu_index}`) ?? null,
    ...aggregates,
  }));
  return { range, count: stats.length, stats };
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
        ...llmServerInfo(p.llm_runtime, p.command),
      });
    }
  }
  return rows;
}
