// Persist GPU samples coming from remote agents into gpu_devices +
// gpu_metrics, the same way gpuCollector.handleOutput does for the
// hub's own local nvidia-smi sampler.
//
// Why this exists at all: agentIngestWS.handleSample() only emits the
// sample on metricsBus, leaving gpuStreamWS to fan it out live to the
// browser and alertService to evaluate rules. Nothing in v0.3.0
// actually writes the rows into SQLite. Result: a remote host shows
// up in Settings → Hosts ("online", fresh last_seen), but the front
// page hits /api/gpu/devices?host=<id>, gets an empty array, and
// renders "Aucun GPU détecté: vérifiez que nvidia-smi …".
//
// The fix mirrors gpuCollector exactly: upsert the device row on every
// tick (it's idempotent and tiny), buffer the metric row, flush the
// buffer to SQLite every flushIntervalMs. LOCAL samples are filtered
// out because gpuCollector already persists them inline before its
// own `metricsBus.emit` — we'd double-write otherwise.

import { metricsBus, type SampleEvent } from './_metricsBus.js';
import {
  GpuDeviceRepository,
  GpuMetricRepository,
  type GpuMetric,
} from '../database/models/GpuMetric.js';
import { LOCAL_HOST_ID } from '../database/models/Host.js';
import { logger } from '../utils/logger.js';

const FLUSH_INTERVAL_MS = 60_000;

let buffer: GpuMetric[] = [];
let flushTimer: NodeJS.Timeout | null = null;
let listener: ((e: SampleEvent) => void) | null = null;

function onSample(e: SampleEvent): void {
  // gpuCollector.handleOutput persists local samples inline BEFORE
  // emitting on the bus, so skipping them here keeps the device row
  // / metric row write-once.
  if (e.host_id === LOCAL_HOST_ID) return;
  if (!e.samples || e.samples.length === 0) return;

  for (const s of e.samples) {
    GpuDeviceRepository.upsert({
      host_id: e.host_id,
      gpu_index: s.gpu_index,
      name: s.name,
      uuid: s.uuid,
      memory_total: s.memory_total,
      driver_version: s.driver_version,
    });
    buffer.push({
      host_id: e.host_id,
      gpu_index: s.gpu_index,
      timestamp: s.timestamp,
      timestamp_epoch: s.timestamp_epoch,
      temperature: s.temperature,
      utilization: s.utilization,
      memory_used: s.memory_used,
      memory_total: s.memory_total,
      power: s.power,
      fan_speed: s.fan_speed,
      clock_graphics: s.clock_graphics,
      clock_memory: s.clock_memory,
    });
  }
}

function flush(): void {
  if (buffer.length === 0) return;
  const toWrite = buffer;
  buffer = [];
  try {
    GpuMetricRepository.insertMany(toWrite);
    logger.debug('agent', `Flushed ${toWrite.length} agent metric rows to DB`);
  } catch (err) {
    logger.error('agent', 'persistor flush failed:', (err as Error).message);
  }
}

export function startAgentMetricsPersistor(): void {
  if (listener) return;
  listener = onSample;
  metricsBus.on('sample', listener);
  flushTimer = setInterval(flush, FLUSH_INTERVAL_MS);
  logger.success('agent', 'Agent metrics persistor started');
}

export function stopAgentMetricsPersistor(): void {
  if (flushTimer) clearInterval(flushTimer);
  flushTimer = null;
  if (listener) {
    metricsBus.off('sample', listener);
    listener = null;
  }
  flush();
}

// Exposed for the test suite. Lets a test deterministically push a
// sample through the persistor and assert the DB state without
// waiting for the 60 s flush tick.
export const __testOnly = {
  flush,
  onSample,
  peekBufferSize: () => buffer.length,
};
