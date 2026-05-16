import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { spawnNvidiaSmi, spawnSyncNvidiaSmi } from '../utils/nvidiaSmi.js';
import { GpuMetricRepository } from '../database/models/GpuMetric.js';
import { AppConfigRepo } from '../database/models/AppConfig.js';
import {
  QUERY_FIELDS,
  num,
  numOrNull,
  nowTimestamp,
  normalizeBusId,
  parsePciThroughput,
  type GpuSample,
  type PcieThroughput,
} from './parsers/nvidia.js';
import { GpuCollectorBase } from './_gpuCollectorBase.js';

// Re-export so existing `import { type GpuSample } from './gpuCollector.js'`
// in alertService / exportService / mockGpu / gpuStreamWS still resolves.
// The canonical home is now parsers/nvidia.ts (shared with the agent).
export type { GpuSample };

class GpuCollector extends GpuCollectorBase {
  private nvidiaSmiAvailable: boolean | null = null;
  // PCIe RX/TX from the most recent `-q -d PCI` call. Keyed two ways:
  //   - by normalized bus id ("00000000:01:00.0") for accurate matching
  //   - by GPU block order ("idx:0", "idx:1", …) as a fallback when the
  //     bus-id format differs subtly between the CSV `pci.bus_id` and the
  //     `-q -d PCI` header (real driver inconsistencies). Refreshed in
  //     parallel with the CSV query each tick; merged in handleOutput().
  private lastPcieThroughput: Map<string, PcieThroughput> = new Map();
  private pcieDiagLogged = false;

  protected checkAvailable(): boolean {
    if (this.nvidiaSmiAvailable !== null) return this.nvidiaSmiAvailable;
    try {
      this.nvidiaSmiAvailable = spawnSyncNvidiaSmi(['--version'], 3000).status === 0;
    } catch {
      this.nvidiaSmiAvailable = false;
    }
    return this.nvidiaSmiAvailable;
  }

  protected unavailableMessage(): string {
    return 'nvidia-smi not available: collector disabled (UI will show no data)';
  }

  protected startedMessage(): string {
    return `Collector started (tick=${config.gpuTickMs}ms)`;
  }

  protected tick(): void {
    // Kick off the PCIe-throughput query in parallel; it lands into
    // this.lastPcieThroughput by the time handleOutput() merges samples.
    // Stale-by-one-tick is fine: the value is already an instantaneous
    // ~20ms NVML sample, not an integral.
    this.refreshPcieThroughput();

    const child = spawnNvidiaSmi([
      `--query-gpu=${QUERY_FIELDS.join(',')}`,
      '--format=csv,noheader,nounits',
    ]);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (err) => logger.error('gpu', 'nvidia-smi spawn failed:', err.message));
    child.on('close', (code) => {
      if (code !== 0) {
        logger.warn('gpu', `nvidia-smi exited ${code}: ${stderr.trim()}`);
        return;
      }
      this.handleOutput(stdout);
    });
  }

  /**
   * `nvidia-smi --query-gpu=` doesn't expose PCIe Tx/Rx throughput; only
   * `nvidia-smi -q -d PCI` does (text output, sourced from NVML's
   * NVML_PCIE_UTIL_RX_BYTES / TX_BYTES counters). Spawn it once per tick,
   * parse per-GPU blocks keyed by Bus Id so we can match them back to the
   * CSV samples that already carry pci_bus_id.
   */
  private refreshPcieThroughput(): void {
    // Earlier versions tried `-q -d PCI`, but PCI is NOT a valid value
    // for nvidia-smi's --display filter (allowed: MEMORY|UTILIZATION|ECC|
    // TEMPERATURE|POWER|CLOCK|COMPUTE|PIDS|PERFORMANCE|SUPPORTED_CLOCKS|
    // PAGE_RETIREMENT|ACCOUNTING|ENCODER_STATS|FBC_STATS|ROW_REMAPPER).
    // It exited non-zero silently and our throughput map stayed empty
    // — the visible "always -" symptom. The unfiltered `-q` dump
    // includes the PCI section per GPU (Tx/Rx Throughput lines), so
    // we use it here. Output is bigger but acceptable at 1Hz.
    const child = spawnNvidiaSmi(['-q']);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (err) => {
      if (!this.pcieDiagLogged) {
        this.pcieDiagLogged = true;
        logger.warn('gpu', `nvidia-smi -q spawn failed (PCIe RX/TX disabled): ${err.message}`);
      }
    });
    child.on('close', (code) => {
      if (code !== 0) {
        if (!this.pcieDiagLogged) {
          this.pcieDiagLogged = true;
          logger.warn('gpu', `nvidia-smi -q exited ${code} (PCIe RX/TX disabled): ${stderr.trim() || '(no stderr)'}`);
        }
        return;
      }
      const map = parsePciThroughput(stdout);
      this.lastPcieThroughput = map;
      if (!this.pcieDiagLogged) {
        this.pcieDiagLogged = true;
        const summary = Array.from(map.entries())
          .map(([k, v]) => `${k}=rx:${v.rxKbps ?? 'null'}/tx:${v.txKbps ?? 'null'}`)
          .join(', ');
        logger.info('gpu', `PCIe throughput map (${map.size} entries): ${summary || '(empty — driver did not report Tx/Rx)'}`);
      }
    });
  }

  private handleOutput(out: string): void {
    const { iso, epoch } = nowTimestamp();
    const samples: GpuSample[] = [];
    for (const line of out.split('\n')) {
      const row = line.trim();
      if (!row) continue;
      const parts = row.split(',').map((p) => p.trim());
      if (parts.length < QUERY_FIELDS.length) continue;
      const busId = parts[12] || null;
      const gpuIdx = num(parts[0]);
      // Try bus-id match first (most accurate); fall back to block order
      // ("idx:N") for drivers where the CSV pci.bus_id and the `-q -d PCI`
      // header use slightly different formats. Both keys are populated by
      // parsePciThroughput().
      const throughput = (busId && this.lastPcieThroughput.get(normalizeBusId(busId)))
        ?? this.lastPcieThroughput.get(`idx:${gpuIdx}`);
      const sample: GpuSample = {
        gpu_index: num(parts[0]),
        name: parts[1] || 'GPU',
        uuid: parts[2] || null,
        driver_version: parts[3] || null,
        temperature: num(parts[4]),
        utilization: numOrNull(parts[5]),
        memory_used: num(parts[6]),
        memory_total: numOrNull(parts[7]),
        power: numOrNull(parts[8]) ?? 0,
        fan_speed: numOrNull(parts[9]),
        clock_graphics: numOrNull(parts[10]),
        clock_memory: numOrNull(parts[11]),
        pci_bus_id: busId,
        pcie_gen_current: numOrNull(parts[13]),
        pcie_gen_max: numOrNull(parts[14]),
        pcie_width_current: numOrNull(parts[15]),
        pcie_width_max: numOrNull(parts[16]),
        pcie_rx_kbps: throughput?.rxKbps ?? null,
        pcie_tx_kbps: throughput?.txKbps ?? null,
        timestamp: iso,
        timestamp_epoch: epoch,
      };
      samples.push(sample);
    }
    this.persistSamples(samples);
  }
}

export const gpuCollector = new GpuCollector();

export function startRetentionJob(): void {
  const oneHour = 60 * 60 * 1000;
  setInterval(() => {
    // Prefer the runtime-configurable retention (Settings UI), fall back to
    // the env-driven default if no value has been set.
    let days = config.retentionDays;
    try {
      // Lazy require to avoid a circular import at module load.
      const stored = AppConfigRepo.get('retention_days');
      const n = stored ? Number.parseInt(stored, 10) : Number.NaN;
      if (Number.isFinite(n) && n > 0) days = n;
    } catch {
      // ignore: keep env default
    }
    const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
    const removed = GpuMetricRepository.pruneOlderThan(cutoff);
    if (removed > 0) logger.info('gpu', `Retention: pruned ${removed} rows older than ${days}d`);
  }, oneHour);
}
