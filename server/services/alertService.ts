import { EventEmitter } from 'node:events';
import {
  AlertEventRepo,
  AlertRuleRepo,
  ensureAlertSchema,
  HOST_METRICS,
  type AlertEvent,
  type AlertRule,
  type AlertMetric,
} from '../database/models/Alert.js';
import { gpuCollector, type GpuSample } from './gpuCollector.js';
import { getSystemStats } from './systemStats.js';
import { logger } from '../utils/logger.js';

// Synthetic gpu_index used in event rows for host-scoped alerts so the
// (rule, sample) state map key stays unique without leaking into the
// real per-GPU dimension.
const HOST_PSEUDO_INDEX = -1;

interface RuleState {
  /** epoch (s) at which the threshold first became crossed; 0 = not crossed */
  crossedSince: number;
  /** epoch (s) at which we last fired: for cooldown */
  lastFired: number;
  /** currently in firing state */
  firing: boolean;
}

class AlertService extends EventEmitter {
  private readonly state = new Map<string, RuleState>();
  private cachedRules: AlertRule[] = [];
  private cacheTime = 0;
  private readonly cacheTtl = 5_000;

  init(): void {
    ensureAlertSchema();
    gpuCollector.on('sample', (samples: GpuSample[]) => this.evaluate(samples));
    logger.success('alert', 'Alert evaluator hooked');
    // Retention: prune events older than 30 days every hour
    setInterval(() => {
      const cutoff = Math.floor(Date.now() / 1000) - 30 * 86400;
      const removed = AlertEventRepo.pruneOlderThan(cutoff);
      if (removed > 0) logger.info('alert', `Pruned ${removed} old alert events`);
    }, 3600_000);
  }

  invalidateCache(): void {
    this.cacheTime = 0;
  }

  private rules(): AlertRule[] {
    const now = Date.now();
    if (now - this.cacheTime > this.cacheTtl) {
      this.cachedRules = AlertRuleRepo.enabled();
      this.cacheTime = now;
    }
    return this.cachedRules;
  }

  private evaluate(samples: GpuSample[]): void {
    const rules = this.rules();
    if (rules.length === 0) return;
    const now = Math.floor(Date.now() / 1000);
    // Cache the host snapshot once per tick so multiple host-scoped
    // rules see a consistent reading.
    let hostSample: HostSample | null = null;
    for (const rule of rules) {
      if (HOST_METRICS.has(rule.metric)) {
        hostSample ??= buildHostSample();
        this.evaluateOne(rule, hostSample, now);
        continue;
      }
      for (const sample of samples) {
        this.evaluateOne(rule, sample, now);
      }
    }
  }

  // Per (rule, sample) tick. Split out of evaluate() so the outer loop
  // stays a flat 2-level iteration (Sonar S3776). Sample is either a
  // real GpuSample or the synthetic HostSample built once per tick.
  private evaluateOne(rule: AlertRule, sample: EvalSample, now: number): void {
    if (rule.gpu_index !== null && rule.gpu_index !== sample.gpu_index) return;
    const observed = readMetric(sample, rule.metric);
    if (observed === null) return;

    const crossed = rule.condition === 'above'
      ? observed >= rule.threshold
      : observed <= rule.threshold;

    const key = `${rule.id}:${sample.gpu_index}`;
    const st: RuleState = this.state.get(key) ?? { crossedSince: 0, lastFired: 0, firing: false };

    if (crossed) this.handleCrossed(rule, sample, observed, st, now);
    else this.handleCleared(rule, sample, observed, st);

    this.state.set(key, st);
  }

  private handleCrossed(rule: AlertRule, sample: EvalSample, observed: number, st: RuleState, now: number): void {
    if (st.crossedSince === 0) st.crossedSince = now;
    const sustained = now - st.crossedSince >= rule.duration_s;
    const cooled = now - st.lastFired >= rule.cooldown_s;
    if (!sustained) return;
    if (st.firing && !cooled) return;
    this.fire(rule, sample, observed, 'firing');
    st.firing = true;
    st.lastFired = now;
  }

  private handleCleared(rule: AlertRule, sample: EvalSample, observed: number, st: RuleState): void {
    if (st.firing) {
      this.fire(rule, sample, observed, 'resolved');
      st.firing = false;
    }
    st.crossedSince = 0;
  }

  private fire(rule: AlertRule, sample: EvalSample, observed: number, state: 'firing' | 'resolved'): void {
    // Host-scoped rules don't carry a meaningful gpu_index — surface
    // them as "host" in the message so the AlertsPage and webhook
    // formatter don't show "GPU #-1".
    const target = HOST_METRICS.has(rule.metric) ? 'host' : `GPU #${sample.gpu_index}`;
    const message = state === 'firing'
      ? `${rule.name}: ${rule.metric} ${rule.condition} ${rule.threshold} (observed ${round(observed)}) on ${target}`
      : `${rule.name} resolved on ${target} (observed ${round(observed)})`;
    const event = AlertEventRepo.insert({
      rule_id: rule.id,
      rule_name: rule.name,
      gpu_index: sample.gpu_index,
      metric: rule.metric,
      threshold: rule.threshold,
      observed,
      state,
      triggered_at: Math.floor(Date.now() / 1000),
      message,
    });
    logger.warn('alert', message);
    this.emit('event', event, rule);
  }

  recent(limit = 50): AlertEvent[] {
    return AlertEventRepo.list(limit);
  }
}

// Host metrics are read from a synthetic "sample" that wraps the latest
// systemStats snapshot — see buildHostSample() — so the same readMetric
// call site can dispatch on metric type without a separate code path.
interface HostSample {
  gpu_index: number;
  host_cpu: number;
  host_load_1m: number;
  host_memory: number;
}

type EvalSample = GpuSample | HostSample;

function isHostSample(s: EvalSample): s is HostSample {
  return 'host_cpu' in s;
}

function buildHostSample(): HostSample {
  const sys = getSystemStats();
  return {
    gpu_index: HOST_PSEUDO_INDEX,
    host_cpu: sys.cpu.usagePct,
    host_load_1m: sys.load['1m'],
    host_memory: sys.memory.usedPct,
  };
}

function readMetric(sample: EvalSample, metric: AlertMetric): number | null {
  if (isHostSample(sample)) {
    if (metric === 'host_cpu') return sample.host_cpu;
    if (metric === 'host_load_1m') return sample.host_load_1m;
    if (metric === 'host_memory') return sample.host_memory;
    return null;
  }
  switch (metric) {
    case 'temperature': return sample.temperature;
    case 'utilization': return sample.utilization;
    case 'memory': {
      if (sample.memory_total && sample.memory_total > 0) {
        return (sample.memory_used / sample.memory_total) * 100;
      }
      return sample.memory_used;
    }
    case 'power': return sample.power;
    case 'fan_speed': return sample.fan_speed;
    default: return null;
  }
}

function round(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 1 });
}

export const alertService = new AlertService();
