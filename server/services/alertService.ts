import { EventEmitter } from 'node:events';
import {
  AlertEventRepo,
  AlertRuleRepo,
  ensureAlertSchema,
  type AlertEvent,
  type AlertRule,
  type AlertMetric,
} from '../database/models/Alert.js';
import { gpuCollector, type GpuSample } from './gpuCollector.js';
import { logger } from '../utils/logger.js';

interface RuleState {
  /** epoch (s) at which the threshold first became crossed; 0 = not crossed */
  crossedSince: number;
  /** epoch (s) at which we last fired: for cooldown */
  lastFired: number;
  /** currently in firing state */
  firing: boolean;
}

class AlertService extends EventEmitter {
  private state = new Map<string, RuleState>();
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
    for (const rule of rules) {
      for (const sample of samples) {
        this.evaluateOne(rule, sample, now);
      }
    }
  }

  // Per (rule, sample) tick. Split out of evaluate() so the outer loop
  // stays a flat 2-level iteration (Sonar S3776).
  private evaluateOne(rule: AlertRule, sample: GpuSample, now: number): void {
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

  private handleCrossed(rule: AlertRule, sample: GpuSample, observed: number, st: RuleState, now: number): void {
    if (st.crossedSince === 0) st.crossedSince = now;
    const sustained = now - st.crossedSince >= rule.duration_s;
    const cooled = now - st.lastFired >= rule.cooldown_s;
    if (!sustained) return;
    if (st.firing && !cooled) return;
    this.fire(rule, sample, observed, 'firing');
    st.firing = true;
    st.lastFired = now;
  }

  private handleCleared(rule: AlertRule, sample: GpuSample, observed: number, st: RuleState): void {
    if (st.firing) {
      this.fire(rule, sample, observed, 'resolved');
      st.firing = false;
    }
    st.crossedSince = 0;
  }

  private fire(rule: AlertRule, sample: GpuSample, observed: number, state: 'firing' | 'resolved'): void {
    const message = state === 'firing'
      ? `${rule.name}: ${rule.metric} ${rule.condition} ${rule.threshold} (observed ${round(observed)}) on GPU #${sample.gpu_index}`
      : `${rule.name} resolved on GPU #${sample.gpu_index} (observed ${round(observed)})`;
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

function readMetric(sample: GpuSample, metric: AlertMetric): number | null {
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
