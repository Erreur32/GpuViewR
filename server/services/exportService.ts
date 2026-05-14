import { connect as mqttConnect, MqttClient } from 'mqtt';
import { randomBytes } from 'node:crypto';
import { type GpuSample } from './gpuCollector.js';
import { metricsBus, type SampleEvent } from './_metricsBus.js';
import { AppConfigRepo, ensureAppConfigSchema } from '../database/models/AppConfig.js';
import { logger } from '../utils/logger.js';
import { formatAlert, type AlertEventLite, type AlertLang } from './alertFormatter.js';
import { getSystemStats } from './systemStats.js';

// ──────────────────────────────────────────────────────────────────────────────
// Exporter "what's published" catalogs
//
// These three constants are the single source of truth for the data each
// exporter publishes. They drive both the actual publishing code (so we don't
// drift) AND the dispatch-info panel surfaced in the UI.
// ──────────────────────────────────────────────────────────────────────────────

export interface PrometheusMetricSpec {
  name: string;
  help: string;
  type: 'gauge' | 'counter';
  unit: string;
}

export const PROMETHEUS_METRICS: readonly PrometheusMetricSpec[] = [
  { name: 'gpuviewr_gpu_temperature_celsius', help: 'GPU core temperature (°C)', type: 'gauge', unit: '°C' },
  { name: 'gpuviewr_gpu_utilization_ratio',   help: 'GPU compute utilization (0-1)', type: 'gauge', unit: 'ratio' },
  { name: 'gpuviewr_gpu_memory_used_bytes',   help: 'GPU memory used (bytes)', type: 'gauge', unit: 'bytes' },
  { name: 'gpuviewr_gpu_memory_total_bytes',  help: 'GPU memory total (bytes)', type: 'gauge', unit: 'bytes' },
  { name: 'gpuviewr_gpu_power_watts',         help: 'GPU power draw (W)', type: 'gauge', unit: 'W' },
  { name: 'gpuviewr_gpu_fan_speed_ratio',     help: 'GPU fan speed (0-1)', type: 'gauge', unit: 'ratio' },
  { name: 'gpuviewr_gpu_clock_graphics_hz',   help: 'GPU graphics clock (Hz)', type: 'gauge', unit: 'Hz' },
  { name: 'gpuviewr_gpu_clock_memory_hz',     help: 'GPU memory clock (Hz)', type: 'gauge', unit: 'Hz' },
] as const;

export const MQTT_PAYLOAD_KEYS = [
  'name', 'temperature', 'utilization', 'memory_used', 'memory_total',
  'power', 'fan_speed', 'clock_graphics', 'clock_memory', 'timestamp',
] as const;

export interface HaSensorSpec { key: string; name: string; unit: string; cls?: string }
export const MQTT_HA_SENSORS: readonly HaSensorSpec[] = [
  { key: 'temperature',    name: 'Temperature',  unit: '°C',  cls: 'temperature' },
  { key: 'utilization',    name: 'Utilization',  unit: '%' },
  { key: 'memory_used',    name: 'Memory used',  unit: 'MiB' },
  { key: 'power',          name: 'Power',        unit: 'W',   cls: 'power' },
  { key: 'fan_speed',      name: 'Fan speed',    unit: '%' },
  { key: 'clock_graphics', name: 'GPU clock',    unit: 'MHz' },
  { key: 'clock_memory',   name: 'Memory clock', unit: 'MHz' },
] as const;

export const INFLUX_TAG_KEYS = ['gpu_index', 'name', 'uuid'] as const;
export const INFLUX_FIELD_KEYS = [
  'temperature', 'utilization', 'memory_used', 'memory_total',
  'power', 'fan_speed', 'clock_graphics', 'clock_memory',
] as const;

// ──────────────────────────────────────────────────────────────────────────────
// Dispatch info — what the UI's "what's being sent" panel renders
// ──────────────────────────────────────────────────────────────────────────────

export interface PrometheusDispatchInfo {
  enabled: boolean;
  endpoint: { method: 'GET'; path: string; url: string };
  metrics: PrometheusMetricSpec[];
  hostMetrics?: PrometheusMetricSpec[];
}
export interface MqttDispatchInfo {
  enabled: boolean;
  broker: string;
  connected: boolean;
  intervalSeconds: number;
  stateTopicPattern: string;
  resolvedStateTopics: string[];
  payloadKeys: readonly string[];
  // Optional host snapshot block: appears only when MqttConfig
  // .includeSystemStats is enabled. Drives the "Host topic / payload"
  // section of the Settings dispatch panel.
  host?: {
    stateTopic: string;
    payloadKeys: readonly string[];
  };
  haDiscovery:
    | { enabled: false }
    | {
        enabled: true;
        configTopicPattern: string;
        sensors: HaSensorSpec[];
        host?: {
          configTopicPattern: string;
          sensors: readonly HaSensorSpec[];
        };
      };
}
export interface InfluxDispatchInfo {
  enabled: boolean;
  writeUrl: string;
  measurement: string;
  intervalSeconds: number;
  tagKeys: readonly string[];
  fieldKeys: readonly string[];
  hostFieldKeys?: readonly string[];
}
export interface DispatchInfo {
  prometheus: PrometheusDispatchInfo;
  mqtt: MqttDispatchInfo;
  influxdb: InfluxDispatchInfo;
}

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

export type ExporterKind = 'prometheus' | 'mqtt' | 'influxdb' | 'webhook';

export interface PrometheusConfig {
  enabled: boolean;
  // Also expose host metrics (CPU usage, load 1/5/15, memory used %)
  // alongside the per-GPU gauges. Off by default so existing scrape
  // configs don't gain new series unannounced.
  includeSystemStats: boolean;
}

// Host-level Prometheus gauges, emitted only when
// PrometheusConfig.includeSystemStats is true.
export const PROMETHEUS_HOST_METRICS: readonly PrometheusMetricSpec[] = [
  { name: 'gpuviewr_host_cpu_usage_ratio',  help: 'Host CPU usage (0-1)', type: 'gauge', unit: 'ratio' },
  { name: 'gpuviewr_host_load_1m',          help: 'Host load average over 1 minute',  type: 'gauge', unit: '' },
  { name: 'gpuviewr_host_load_5m',          help: 'Host load average over 5 minutes', type: 'gauge', unit: '' },
  { name: 'gpuviewr_host_load_15m',         help: 'Host load average over 15 minutes', type: 'gauge', unit: '' },
  { name: 'gpuviewr_host_memory_used_bytes', help: 'Host memory used (bytes)',  type: 'gauge', unit: 'bytes' },
  { name: 'gpuviewr_host_memory_total_bytes',help: 'Host memory total (bytes)', type: 'gauge', unit: 'bytes' },
  { name: 'gpuviewr_host_memory_used_ratio', help: 'Host memory used (0-1)',    type: 'gauge', unit: 'ratio' },
];

export interface MqttConfig {
  enabled: boolean;
  url: string;            // mqtt://host:1883 or mqtts://...
  username?: string;
  password?: string;
  topicPrefix: string;    // e.g. "gpuviewr"
  haDiscovery: boolean;   // publish Home Assistant discovery configs
  intervalSeconds: number;
  // Also publish a host snapshot (CPU / load / memory) on
  // `${topicPrefix}/host/state`. Off by default to keep MQTT
  // strictly GPU-scoped for installs that already monitor the host
  // through other means.
  includeSystemStats: boolean;
}

// Flat host-state payload keys published on `${topicPrefix}/host/state`
// when MqttConfig.includeSystemStats is true.
export const MQTT_HOST_PAYLOAD_KEYS = [
  'hostname', 'uptime',
  'cpu_usage_pct', 'cpu_cores',
  'load_1m', 'load_5m', 'load_15m',
  'memory_total', 'memory_used', 'memory_free', 'memory_used_pct',
  'timestamp',
] as const;

export const MQTT_HOST_HA_SENSORS: readonly HaSensorSpec[] = [
  { key: 'cpu_usage_pct',  name: 'CPU usage',     unit: '%' },
  { key: 'load_1m',        name: 'Load 1 min',    unit: '' },
  { key: 'load_5m',        name: 'Load 5 min',    unit: '' },
  { key: 'load_15m',       name: 'Load 15 min',   unit: '' },
  { key: 'memory_used_pct',name: 'Memory used',   unit: '%' },
];

export interface InfluxConfig {
  enabled: boolean;
  url: string;            // http://host:8086
  token: string;
  org: string;
  bucket: string;
  measurement: string;    // default: gpu_metrics
  intervalSeconds: number;
  // Also write a host-stats point (`<measurement>_host`) on each push
  // with CPU usage, load averages and memory used %. Off by default
  // so existing dashboards don't see new series unannounced.
  includeSystemStats: boolean;
}

export const INFLUX_HOST_FIELD_KEYS = [
  'cpu_usage_pct', 'cpu_cores',
  'load_1m', 'load_5m', 'load_15m',
  'memory_used', 'memory_total', 'memory_used_pct',
] as const;

export type WebhookType = 'generic' | 'discord' | 'telegram';
export type WebhookMode = 'metrics' | 'alerts';

// Single source of truth for the per-sample fields a webhook can carry.
// The UI surfaces these as checkboxes; the dispatcher filters samples
// against `payloadFields` before sending.
export const WEBHOOK_PAYLOAD_FIELDS = [
  'gpu_index', 'name', 'uuid', 'driver_version',
  'temperature', 'utilization',
  'memory_used', 'memory_total',
  'power', 'fan_speed',
  'clock_graphics', 'clock_memory',
  'timestamp', 'timestamp_epoch',
] as const;
export type WebhookPayloadField = (typeof WEBHOOK_PAYLOAD_FIELDS)[number];

export interface WebhookConfig {
  enabled: boolean;
  type: WebhookType;
  mode: WebhookMode;
  url: string;
  method: 'POST' | 'PUT';
  headers: Record<string, string>;
  intervalSeconds: number;
  // Subset of WEBHOOK_PAYLOAD_FIELDS to include per sample (generic/metrics).
  // Empty array = include all (treated as "no filter" for backward compat).
  payloadFields: WebhookPayloadField[];
  // Language used for the alert message body sent to Discord/Telegram.
  // Generic mode also receives a `messages` block in the JSON payload so
  // downstream consumers can show the same wording.
  language: AlertLang;
  // Append a host-stats footer (CPU / load / memory) to the alert
  // message body, and include a `system: { ... }` block in the generic
  // JSON payload. Disable to keep notifications GPU-only.
  includeSystemStats: boolean;
  // Telegram-only
  token?: string;
  chatId?: string;
}

export interface ExportConfigs {
  prometheus: PrometheusConfig;
  mqtt: MqttConfig;
  influxdb: InfluxConfig;
  webhook: WebhookConfig;
}

const CONFIG_KEY = 'export_configs';

const DEFAULTS: ExportConfigs = {
  prometheus: { enabled: false, includeSystemStats: false },
  mqtt: {
    enabled: false,
    url: 'mqtt://localhost:1883',
    username: '',
    password: '',
    topicPrefix: 'gpuviewr',
    haDiscovery: false,
    intervalSeconds: 10,
    includeSystemStats: false,
  },
  influxdb: {
    enabled: false,
    url: 'http://localhost:8086',
    token: '',
    org: '',
    bucket: 'gpuviewr',
    measurement: 'gpu_metrics',
    intervalSeconds: 10,
    includeSystemStats: false,
  },
  webhook: {
    enabled: false,
    type: 'generic',
    mode: 'alerts',
    url: '',
    method: 'POST',
    headers: {},
    intervalSeconds: 30,
    payloadFields: [...WEBHOOK_PAYLOAD_FIELDS],
    language: 'en',
    includeSystemStats: true,
    token: '',
    chatId: '',
  },
};

// ──────────────────────────────────────────────────────────────────────────────
// Service
// ──────────────────────────────────────────────────────────────────────────────

class ExportService {
  // Per-host latest snapshot. Replaces the old flat array so an agent's
  // sample frame can't wipe the local host's samples (and vice-versa).
  // All exporters iterate this map; helpers below flatten or scope to
  // a single host as needed.
  private readonly latestSamplesByHost: Map<string, GpuSample[]> = new Map();
  private mqttClient: MqttClient | null = null;
  private mqttDiscoveryPublished = false;
  private timers: Partial<Record<ExporterKind, NodeJS.Timeout>> = {};

  init(): void {
    ensureAppConfigSchema();
    if (!AppConfigRepo.getJson<ExportConfigs>(CONFIG_KEY)) {
      AppConfigRepo.setJson<ExportConfigs>(CONFIG_KEY, DEFAULTS);
    }
    metricsBus.on('sample', (e: SampleEvent) => {
      this.latestSamplesByHost.set(e.host_id, e.samples);
    });
    // Forward alert events to webhooks configured in "alerts" mode.
    // Lazy import to keep the dependency one-way (alertService -> samples
    // path doesn't loop back through exportService).
    void import('./alertService.js').then(({ alertService }) => {
      alertService.on('event', (event: unknown, rule: unknown) => {
        const c = this.getConfigs();
        if (!c.webhook.enabled || c.webhook.mode !== 'alerts') return;
        // Per-rule opt-out: if the rule was saved with notify_webhook=0 the
        // alert still fires browser/sound notifications but skips the webhook.
        const r = rule as { notify_webhook?: 0 | 1 };
        if (r?.notify_webhook === 0) return;
        this.dispatchWebhookAlert(c.webhook, event, rule).catch((err: Error) =>
          logger.warn('export', `Webhook alert dispatch failed: ${err.message}`),
        );
      });
    });
    this.applyAll();
    logger.info('export', 'Export service initialized');
  }

  getConfigs(): ExportConfigs {
    const stored = AppConfigRepo.getJson<Partial<ExportConfigs>>(CONFIG_KEY) ?? {};
    return {
      prometheus: { ...DEFAULTS.prometheus, ...(stored.prometheus ?? {}) },
      mqtt: { ...DEFAULTS.mqtt, ...(stored.mqtt ?? {}) },
      influxdb: { ...DEFAULTS.influxdb, ...(stored.influxdb ?? {}) },
      webhook: {
        ...DEFAULTS.webhook,
        ...stored.webhook,
        payloadFields: Array.isArray(stored.webhook?.payloadFields)
          ? stored.webhook.payloadFields.filter((f): f is WebhookPayloadField =>
              (WEBHOOK_PAYLOAD_FIELDS as readonly string[]).includes(f))
          : [...WEBHOOK_PAYLOAD_FIELDS],
      },
    };
  }

  /** Returns sanitized config (secrets masked) for the API. */
  getConfigsRedacted(): ExportConfigs {
    const c = this.getConfigs();
    return {
      ...c,
      mqtt: { ...c.mqtt, password: c.mqtt.password ? '••••' : '' },
      influxdb: { ...c.influxdb, token: c.influxdb.token ? '••••' : '' },
      webhook: { ...c.webhook, token: c.webhook.token ? '••••' : '' },
    };
  }

  setConfig<K extends ExporterKind>(kind: K, patch: Partial<ExportConfigs[K]>): ExportConfigs[K] {
    const all = this.getConfigs();
    // Preserve secrets when the UI sends back the masked sentinel.
    if (kind === 'mqtt') {
      const p = patch as Partial<MqttConfig>;
      if (p.password === '••••') delete p.password;
    }
    if (kind === 'influxdb') {
      const p = patch as Partial<InfluxConfig>;
      if (p.token === '••••') delete p.token;
    }
    if (kind === 'webhook') {
      const p = patch as Partial<WebhookConfig>;
      if (p.token === '••••') delete p.token;
    }
    const merged = { ...all[kind], ...patch } as ExportConfigs[K];
    const next = { ...all, [kind]: merged };
    AppConfigRepo.setJson<ExportConfigs>(CONFIG_KEY, next);
    this.applyOne(kind);
    return merged;
  }

  // ── Latest samples accessors ────────────────────────────────────────────

  /** Flattened list of every host's samples in insertion order
   *  (typically 'local' first, then agents). Used by the webhook
   *  payload and any single-host-flavored consumer that doesn't need
   *  per-host segregation. */
  getLatestSamples(): GpuSample[] {
    const all: GpuSample[] = [];
    for (const samples of this.latestSamplesByHost.values()) {
      all.push(...samples);
    }
    return all;
  }

  /** Read-only snapshot map host_id → samples. Used by the Prometheus
   *  renderer to emit per-host labels and the MQTT/Influx publishers
   *  to namespace topics/tags by host. */
  getLatestSamplesByHost(): ReadonlyMap<string, GpuSample[]> {
    return this.latestSamplesByHost;
  }

  /**
   * Describe what each exporter is currently publishing so the Settings UI
   * can show the active endpoint + exact list of metrics/topics/fields.
   * `origin` is the request-side base URL (e.g. "http://gpuviewr.lan:3015"),
   * used to build the Prometheus scrape URL since the server does not know
   * its own externally-visible host on its own.
   */
  getDispatchInfo(origin: string): DispatchInfo {
    const c = this.getConfigs();
    // Reflect the new per-host topic shape: <prefix>/<host_id>/gpu<N>/state.
    // For the Settings UI, list every resolved topic across every host.
    const stateTopicPattern = `${c.mqtt.topicPrefix}/<host_id>/gpu<N>/state`;
    const resolvedStateTopics: string[] = [];
    for (const [host_id, samples] of this.latestSamplesByHost) {
      for (const s of samples) {
        resolvedStateTopics.push(`${c.mqtt.topicPrefix}/${host_id}/gpu${s.gpu_index}/state`);
      }
    }

    const writeUrl = c.influxdb.url
      ? `${c.influxdb.url.replace(/\/$/, '')}/api/v2/write?org=${encodeURIComponent(c.influxdb.org)}&bucket=${encodeURIComponent(c.influxdb.bucket)}&precision=s`
      : '';

    const promPath = '/metrics';
    return {
      prometheus: {
        enabled: c.prometheus.enabled,
        endpoint: {
          method: 'GET',
          path: promPath,
          url: origin ? `${origin.replace(/\/$/, '')}${promPath}` : promPath,
        },
        metrics: [...PROMETHEUS_METRICS],
        hostMetrics: c.prometheus.includeSystemStats ? [...PROMETHEUS_HOST_METRICS] : undefined,
      },
      mqtt: {
        enabled: c.mqtt.enabled,
        broker: c.mqtt.url,
        connected: !!this.mqttClient?.connected,
        intervalSeconds: c.mqtt.intervalSeconds,
        stateTopicPattern,
        resolvedStateTopics,
        payloadKeys: MQTT_PAYLOAD_KEYS,
        host: c.mqtt.includeSystemStats
          ? {
              stateTopic: `${c.mqtt.topicPrefix}/host/state`,
              payloadKeys: MQTT_HOST_PAYLOAD_KEYS,
            }
          : undefined,
        haDiscovery: c.mqtt.haDiscovery
          ? {
              enabled: true,
              configTopicPattern: 'homeassistant/sensor/gpuviewr_gpu<N>_<key>/config',
              sensors: [...MQTT_HA_SENSORS],
              host: c.mqtt.includeSystemStats
                ? {
                    configTopicPattern: 'homeassistant/sensor/gpuviewr_host_<key>/config',
                    sensors: MQTT_HOST_HA_SENSORS,
                  }
                : undefined,
            }
          : { enabled: false },
      },
      influxdb: {
        enabled: c.influxdb.enabled,
        writeUrl,
        measurement: c.influxdb.measurement,
        intervalSeconds: c.influxdb.intervalSeconds,
        tagKeys: INFLUX_TAG_KEYS,
        fieldKeys: INFLUX_FIELD_KEYS,
        hostFieldKeys: c.influxdb.includeSystemStats ? INFLUX_HOST_FIELD_KEYS : undefined,
      },
    };
  }

  // ────────────────────────────────────────────────────────────────────────
  // Apply / lifecycle
  // ────────────────────────────────────────────────────────────────────────

  private applyAll(): void {
    (['mqtt', 'influxdb', 'webhook'] as ExporterKind[]).forEach((k) => this.applyOne(k));
    // Prometheus is pull-based: nothing to schedule.
  }

  private applyOne(kind: ExporterKind): void {
    const c = this.getConfigs();
    if (this.timers[kind]) {
      clearInterval(this.timers[kind] as NodeJS.Timeout);
      delete this.timers[kind];
    }
    if (kind === 'mqtt') {
      this.applyMqtt(c.mqtt);
    } else if (kind === 'influxdb' && c.influxdb.enabled) {
      const ms = Math.max(1, c.influxdb.intervalSeconds) * 1000;
      this.timers.influxdb = setInterval(() => this.pushInflux(c.influxdb), ms);
    } else if (kind === 'webhook' && c.webhook.enabled && c.webhook.mode === 'metrics') {
      // Only schedule periodic pushes in metrics mode. In alerts mode the
      // webhook is fired by the alertService event listener.
      const ms = Math.max(1, c.webhook.intervalSeconds) * 1000;
      this.timers.webhook = setInterval(() => this.pushWebhook(c.webhook), ms);
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // MQTT
  // ────────────────────────────────────────────────────────────────────────

  private applyMqtt(cfg: MqttConfig): void {
    if (this.mqttClient) {
      try { this.mqttClient.end(true); } catch { /* ignore */ }
      this.mqttClient = null;
      this.mqttDiscoveryPublished = false;
    }
    if (!cfg.enabled) return;
    if (!cfg.url) {
      logger.warn('export', 'MQTT enabled but URL is empty; skipping.');
      return;
    }
    try {
      const client = mqttConnect(cfg.url, {
        username: cfg.username || undefined,
        password: cfg.password || undefined,
        reconnectPeriod: 5000,
        clientId: `gpuviewr-${randomBytes(4).toString('hex')}`,
      });
      client.on('connect', () => {
        logger.success('export', `MQTT connected to ${cfg.url}`);
        if (cfg.haDiscovery) this.publishHaDiscovery(cfg);
      });
      client.on('error', (err) => logger.warn('export', `MQTT error: ${err.message}`));
      client.on('close', () => { this.mqttDiscoveryPublished = false; });
      this.mqttClient = client;
      const ms = Math.max(1, cfg.intervalSeconds) * 1000;
      this.timers.mqtt = setInterval(() => this.publishMqtt(cfg), ms);
    } catch (err) {
      logger.warn('export', `MQTT init failed: ${(err as Error).message}`);
    }
  }

  private publishMqtt(cfg: MqttConfig): void {
    if (!this.mqttClient?.connected) return;
    // New per-host topic shape: <prefix>/<host_id>/gpu<N>/state. A
    // mono-host install still gets `<prefix>/local/gpu<N>/state`,
    // which is *almost* compatible with the old `<prefix>/gpu<N>/state`
    // — users with existing HA Discovery wired in must redo it after
    // upgrade. Documented in Docs/MIGRATION.md.
    for (const [host_id, samples] of this.latestSamplesByHost) {
      for (const s of samples) {
        const base = `${cfg.topicPrefix}/${host_id}/gpu${s.gpu_index}`;
        const payload = {
          host_id,
          name: s.name,
          temperature: s.temperature,
          utilization: s.utilization,
          memory_used: s.memory_used,
          memory_total: s.memory_total,
          power: s.power,
          fan_speed: s.fan_speed,
          clock_graphics: s.clock_graphics,
          clock_memory: s.clock_memory,
          timestamp: s.timestamp,
        };
        this.mqttClient.publish(`${base}/state`, JSON.stringify(payload), { retain: true });
      }
    }
    if (cfg.includeSystemStats) {
      const sys = getSystemStats();
      // Keys must stay in sync with MQTT_HOST_PAYLOAD_KEYS.
      const hostPayload = {
        hostname: sys.hostname,
        uptime: sys.uptime,
        cpu_usage_pct: sys.cpu.usagePct,
        cpu_cores: sys.cpu.cores,
        load_1m: sys.load['1m'],
        load_5m: sys.load['5m'],
        load_15m: sys.load['15m'],
        memory_total: sys.memory.total,
        memory_used: sys.memory.used,
        memory_free: sys.memory.free,
        memory_used_pct: sys.memory.usedPct,
        timestamp: new Date().toISOString(),
      };
      this.mqttClient.publish(`${cfg.topicPrefix}/host/state`, JSON.stringify(hostPayload), { retain: true });
    }
  }

  private publishHaDiscovery(cfg: MqttConfig): void {
    if (!this.mqttClient || this.mqttDiscoveryPublished) return;
    const allSamples = this.getLatestSamples();
    if (allSamples.length === 0) {
      setTimeout(() => this.publishHaDiscovery(cfg), 2000);
      return;
    }
    const sensors: Array<{ key: string; name: string; unit: string; cls?: string }> = [
      { key: 'temperature', name: 'Temperature', unit: '°C', cls: 'temperature' },
      { key: 'utilization', name: 'Utilization', unit: '%' },
      { key: 'memory_used', name: 'Memory used', unit: 'MiB' },
      { key: 'power', name: 'Power', unit: 'W', cls: 'power' },
      { key: 'fan_speed', name: 'Fan speed', unit: '%' },
      { key: 'clock_graphics', name: 'GPU clock', unit: 'MHz' },
      { key: 'clock_memory', name: 'Memory clock', unit: 'MHz' },
    ];
    // Per-host × per-GPU HA Discovery. unique_id includes the host_id
    // prefix so HA doesn't collapse two hosts' "GPU 0" into the same
    // entity. Same shape as the state topic written in publishMqtt.
    let count = 0;
    for (const [host_id, samples] of this.latestSamplesByHost) {
      for (const s of samples) {
        count++;
        const stateTopic = `${cfg.topicPrefix}/${host_id}/gpu${s.gpu_index}/state`;
        const hostLabel = host_id === 'local' ? 'local' : host_id.slice(0, 8);
        const device = {
          identifiers: [`gpuviewr_${host_id}_gpu${s.gpu_index}`],
          name: `GpuViewR ${hostLabel} GPU ${s.gpu_index} - ${s.name}`,
          manufacturer: 'NVIDIA',
          model: s.name,
        };
        for (const sensor of sensors) {
          const cfgTopic = `homeassistant/sensor/gpuviewr_${host_id}_gpu${s.gpu_index}_${sensor.key}/config`;
          const cfgPayload = {
            name: `${hostLabel} GPU${s.gpu_index} ${sensor.name}`,
            unique_id: `gpuviewr_${host_id}_gpu${s.gpu_index}_${sensor.key}`,
            state_topic: stateTopic,
            value_template: `{{ value_json.${sensor.key} }}`,
            unit_of_measurement: sensor.unit,
            device_class: sensor.cls,
            state_class: 'measurement',
            device,
          };
          this.mqttClient!.publish(cfgTopic, JSON.stringify(cfgPayload), { retain: true });
        }
      }
    }
    if (cfg.includeSystemStats) this.publishHaDiscoveryHost(cfg);
    this.mqttDiscoveryPublished = true;
    logger.info('export', `MQTT HA discovery published for ${count} GPU(s) across ${this.latestSamplesByHost.size} host(s)`);
  }

  private publishHaDiscoveryHost(cfg: MqttConfig): void {
    if (!this.mqttClient) return;
    const stateTopic = `${cfg.topicPrefix}/host/state`;
    const device = {
      identifiers: ['gpuviewr_host'],
      name: 'GpuViewR Host',
      manufacturer: 'GpuViewR',
    };
    for (const sensor of MQTT_HOST_HA_SENSORS) {
      const cfgTopic = `homeassistant/sensor/gpuviewr_host_${sensor.key}/config`;
      const cfgPayload = {
        name: `Host ${sensor.name}`,
        unique_id: `gpuviewr_host_${sensor.key}`,
        state_topic: stateTopic,
        value_template: `{{ value_json.${sensor.key} }}`,
        unit_of_measurement: sensor.unit || undefined,
        device_class: sensor.cls,
        state_class: 'measurement',
        device,
      };
      this.mqttClient.publish(cfgTopic, JSON.stringify(cfgPayload), { retain: true });
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // InfluxDB v2 line protocol
  // ────────────────────────────────────────────────────────────────────────

  private async pushInflux(cfg: InfluxConfig): Promise<void> {
    if (this.latestSamplesByHost.size === 0) return;
    const lines: string[] = [];
    // Multi-host: add host=<id> tag to every line so dashboards can
    // filter / group by host. The hub-level system stats line stays
    // tagged by os_hostname (was the old `host=` tag).
    for (const [host_id, samples] of this.latestSamplesByHost) {
      for (const s of samples) {
        lines.push(buildInfluxLine(cfg.measurement, host_id, s));
      }
    }
    if (cfg.includeSystemStats) {
      lines.push(buildInfluxHostLine(cfg.measurement, getSystemStats()));
    }
    const body = lines.join('\n');
    const url = `${cfg.url.replace(/\/$/, '')}/api/v2/write?org=${encodeURIComponent(cfg.org)}&bucket=${encodeURIComponent(cfg.bucket)}&precision=s`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Token ${cfg.token}`,
          'Content-Type': 'text/plain; charset=utf-8',
        },
        body,
      });
      if (!res.ok) {
        const text = await res.text();
        logger.warn('export', `InfluxDB write ${res.status}: ${text.slice(0, 200)}`);
      }
    } catch (err) {
      logger.warn('export', `InfluxDB write failed: ${(err as Error).message}`);
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // Webhook
  // ────────────────────────────────────────────────────────────────────────

  private async pushWebhook(cfg: WebhookConfig): Promise<void> {
    const all = this.getLatestSamples();
    if (all.length === 0) return;
    const sys = cfg.includeSystemStats ? getSystemStats() : undefined;
    // Per-host segregation in the payload so receivers can route on
    // host_id without parsing the flat array. Multi-host installs see
    // an extra `samples_by_host` key; the legacy flat `samples` array
    // is kept for forward-compat with v0.2.x integrations.
    const samplesByHost: Record<string, Array<Partial<GpuSample>>> = {};
    for (const [host_id, samples] of this.latestSamplesByHost) {
      samplesByHost[host_id] = samples.map((s) => filterSampleFields(s, cfg.payloadFields));
    }
    const body: Record<string, unknown> = {
      source: 'gpuviewr',
      timestamp: new Date().toISOString(),
      samples: all.map((s) => filterSampleFields(s, cfg.payloadFields)),
      samples_by_host: samplesByHost,
    };
    if (sys) body.system = sys;
    await this.sendWebhook(cfg, body, this.metricsSummary(sys, cfg.language === 'fr' ? 'fr' : 'en'));
  }

  // Build a short, human-readable digest used by Discord embeds and
  // Telegram messages so a "metrics" push reads as a useful summary.
  // Optionally appends a host-stats line (CPU / load / memory) so the
  // notification carries context beyond the GPUs themselves.
  private metricsSummary(sys?: ReturnType<typeof getSystemStats>, lang: AlertLang = 'en'): string {
    if (this.latestSamplesByHost.size === 0) return 'No GPU samples available.';
    const multi = this.latestSamplesByHost.size > 1;
    const gpuLines = this.buildGpuLines(multi);
    if (!sys) return gpuLines;
    return `${gpuLines}\n${formatHostStatsLine(sys, lang)}`;
  }

  private buildGpuLines(multi: boolean): string {
    // For multi-host installs prefix each GPU line with its host id so
    // a Discord message "GPU #0 hot" tells you WHICH host is hot.
    const lines: string[] = [];
    for (const [host_id, samples] of this.latestSamplesByHost) {
      const hostPrefix = multi ? `[${formatHostTag(host_id)}] ` : '';
      for (const s of samples) {
        lines.push(`${hostPrefix}${formatGpuLine(s)}`);
      }
    }
    return lines.join('\n');
  }

  private async dispatchWebhookAlert(cfg: WebhookConfig, event: unknown, rule: unknown): Promise<void> {
    // alertService event payload: { id, rule_name, gpu_index, metric, threshold, observed, state, message, triggered_at }
    const e = event as {
      rule_name: string;
      gpu_index: number;
      metric: string;
      threshold: number;
      observed: number;
      state: 'firing' | 'resolved';
      message: string;
      triggered_at: number;
    };
    const r = rule as { notify_browser?: boolean; notify_sound?: boolean };
    const lang: AlertLang = cfg.language === 'fr' ? 'fr' : 'en';
    const eLite: AlertEventLite = {
      rule_name: e.rule_name,
      gpu_index: e.gpu_index,
      metric: e.metric as AlertEventLite['metric'],
      threshold: e.threshold,
      observed: e.observed,
      state: e.state,
    };
    const sys = cfg.includeSystemStats ? getSystemStats() : undefined;
    const fmt = formatAlert(eLite, lang, sys);
    const body: Record<string, unknown> = {
      source: 'gpuviewr',
      kind: 'alert',
      event: e,
      rule: r,
      timestamp: new Date(e.triggered_at * 1000).toISOString(),
      messages: { language: lang, title: fmt.title, plain: fmt.plain },
    };
    if (sys) body.system = sys;
    const color = e.state === 'firing' ? 0xe74c3c : 0x2ecc71;
    await this.sendWebhookAlert(cfg, body, fmt, color);
  }

  private async sendWebhookAlert(
    cfg: WebhookConfig,
    body: object,
    fmt: ReturnType<typeof formatAlert>,
    color: number,
  ): Promise<void> {
    if (!cfg.url && cfg.type !== 'telegram') {
      logger.warn('export', 'Webhook URL is empty');
      return;
    }
    try {
      let res: Response | null = null;
      if (cfg.type === 'discord') res = await this.sendDiscordAlert(cfg, fmt, color);
      else if (cfg.type === 'telegram') res = await this.sendTelegramAlert(cfg, fmt);
      else res = await this.sendGeneric(cfg, body);
      if (!res) return;
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        const detail = txt ? `: ${txt.slice(0, 200)}` : '';
        throw new Error(`HTTP ${res.status}${detail}`);
      }
    } catch (err) {
      logger.warn('export', `Webhook (${cfg.type}) failed: ${(err as Error).message}`);
      throw err;
    }
  }

  private sendDiscordAlert(cfg: WebhookConfig, fmt: ReturnType<typeof formatAlert>, color: number): Promise<Response> {
    return fetch(cfg.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embeds: [{
          title: fmt.title,
          description: fmt.discord,
          color,
          timestamp: new Date().toISOString(),
        }],
      }),
    });
  }

  private async sendTelegramAlert(cfg: WebhookConfig, fmt: ReturnType<typeof formatAlert>): Promise<Response | null> {
    if (!cfg.token || !cfg.chatId) {
      logger.warn('export', 'Telegram webhook missing token or chatId');
      return null;
    }
    return fetch(`https://api.telegram.org/bot${encodeURIComponent(cfg.token)}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: cfg.chatId,
        text: fmt.telegram,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
  }

  // Generic sender. Routes to type-specific senders for Discord and
  // Telegram, falls back to plain JSON POST/PUT for "generic".
  private async sendWebhook(cfg: WebhookConfig, body: object, summary: string, color = 0x3498db): Promise<void> {
    if (!cfg.url && cfg.type !== 'telegram') {
      logger.warn('export', 'Webhook URL is empty');
      return;
    }
    try {
      const res = await this.dispatchWebhook(cfg, body, summary, color);
      if (!res) return; // type-specific guard already logged
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        const detail = txt ? `: ${txt.slice(0, 200)}` : '';
        throw new Error(`HTTP ${res.status}${detail}`);
      }
    } catch (err) {
      logger.warn('export', `Webhook (${cfg.type}) failed: ${(err as Error).message}`);
      throw err;
    }
  }

  private dispatchWebhook(cfg: WebhookConfig, body: object, summary: string, color: number): Promise<Response | null> {
    if (cfg.type === 'discord') return this.sendDiscord(cfg, summary, color);
    if (cfg.type === 'telegram') return this.sendTelegram(cfg, summary);
    return this.sendGeneric(cfg, body);
  }

  private sendDiscord(cfg: WebhookConfig, summary: string, color: number): Promise<Response> {
    return fetch(cfg.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embeds: [{
          title: 'GpuViewR',
          description: summary,
          color,
          timestamp: new Date().toISOString(),
        }],
      }),
    });
  }

  private async sendTelegram(cfg: WebhookConfig, summary: string): Promise<Response | null> {
    if (!cfg.token || !cfg.chatId) {
      logger.warn('export', 'Telegram webhook missing token or chatId');
      return null;
    }
    return fetch(`https://api.telegram.org/bot${encodeURIComponent(cfg.token)}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: cfg.chatId,
        text: summary,
        parse_mode: 'HTML',
      }),
    });
  }

  private sendGeneric(cfg: WebhookConfig, body: object): Promise<Response> {
    // Strip a user-supplied Content-Type to keep our JSON body intact.
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    for (const [k, v] of Object.entries(cfg.headers ?? {})) {
      if (k.toLowerCase() !== 'content-type') headers[k] = v;
    }
    return fetch(cfg.url, {
      method: cfg.method,
      headers,
      body: JSON.stringify(body),
    });
  }

  /** Test a single exporter with a representative sample. */
  async test(kind: ExporterKind): Promise<{ ok: boolean; message: string }> {
    const c = this.getConfigs();
    try {
      if (kind === 'prometheus') return { ok: true, message: 'Prometheus is pull-based; scrape /metrics to test.' };
      if (kind === 'webhook') return await this.testWebhook(c.webhook);
      if (kind === 'influxdb') return await this.testInflux(c.influxdb);
      if (kind === 'mqtt') return await this.testMqtt(c.mqtt);
      return { ok: false, message: 'Unknown exporter' };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }

  private async testWebhook(w: WebhookConfig): Promise<{ ok: boolean; message: string }> {
    if (w.type === 'telegram') {
      if (!w.token || !w.chatId) return { ok: false, message: 'Telegram webhook needs both token and chatId.' };
    } else if (!w.url) {
      return { ok: false, message: 'Webhook URL is empty.' };
    }
    if (w.mode === 'alerts' || w.type !== 'generic') {
      // Send a synthetic firing alert through the same formatter so the
      // test reflects exactly what a real alert will look like (bolds,
      // language, embed colour).
      const lang: AlertLang = w.language === 'fr' ? 'fr' : 'en';
      const sampleEvent: AlertEventLite = {
        rule_name: lang === 'fr' ? 'Test Utilisation Proc' : 'Test Utilization',
        gpu_index: 0,
        metric: 'utilization',
        threshold: 80,
        observed: 93,
        state: 'firing',
      };
      const sys = w.includeSystemStats ? getSystemStats() : undefined;
      const fmt = formatAlert(sampleEvent, lang, sys);
      const body: Record<string, unknown> = {
        source: 'gpuviewr',
        kind: 'test',
        timestamp: new Date().toISOString(),
        messages: { language: lang, title: fmt.title, plain: fmt.plain },
        event: sampleEvent,
      };
      if (sys) body.system = sys;
      await this.sendWebhookAlert(w, body, fmt, 0xe74c3c);
    } else {
      await this.pushWebhook(w);
    }
    return { ok: true, message: 'Webhook test sent and accepted by the remote endpoint.' };
  }

  /**
   * Send a single synthetic line to InfluxDB and surface the broker's
   * actual response. The previous version delegated to pushInflux(),
   * which logs HTTP errors but doesn't throw and bails early when no
   * samples have been collected yet — making the test a guaranteed
   * "ok" even with a wrong token, missing bucket, or unreachable URL.
   */
  private async testInflux(cfg: InfluxConfig): Promise<{ ok: boolean; message: string }> {
    if (!cfg.url) return { ok: false, message: 'InfluxDB URL is empty.' };
    if (!cfg.token) return { ok: false, message: 'InfluxDB token is missing.' };
    if (!cfg.org || !cfg.bucket) return { ok: false, message: 'InfluxDB org and bucket are required.' };

    const measurement = cfg.measurement || 'gpu_metrics';
    const line = `${measurement},source=gpuviewr_test test_value=1`;
    const writeUrl = `${cfg.url.replace(/\/$/, '')}/api/v2/write?org=${encodeURIComponent(cfg.org)}&bucket=${encodeURIComponent(cfg.bucket)}&precision=s`;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    try {
      const res = await fetch(writeUrl, {
        method: 'POST',
        headers: {
          Authorization: `Token ${cfg.token}`,
          'Content-Type': 'text/plain; charset=utf-8',
        },
        body: line,
        signal: ctl.signal,
      });
      if (res.ok) {
        return { ok: true, message: `InfluxDB accepted the test write (HTTP ${res.status}).` };
      }
      const text = (await res.text()).slice(0, 200);
      return { ok: false, message: `InfluxDB returned HTTP ${res.status}: ${text || res.statusText}` };
    } catch (err) {
      const e = err as Error;
      const msg = e.name === 'AbortError'
        ? 'InfluxDB request timed out after 8s. Check URL and reachability.'
        : `InfluxDB request failed: ${e.message}`;
      return { ok: false, message: msg };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Open a fresh, short-lived connection to the broker with the current
   * credentials and publish one test message. Independent of the
   * long-running client so the user gets a clear pass/fail right after
   * Save (no race against the background reconnect loop) and a
   * meaningful broker error message when credentials/URL are wrong.
   */
  private testMqtt(cfg: MqttConfig): Promise<{ ok: boolean; message: string }> {
    if (!cfg.url) return Promise.resolve({ ok: false, message: 'MQTT URL is empty.' });
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: { ok: boolean; message: string }) => {
        if (settled) return;
        settled = true;
        try { client.end(true); } catch { /* ignore */ }
        resolve(result);
      };
      const client = mqttConnect(cfg.url, {
        username: cfg.username || undefined,
        password: cfg.password || undefined,
        reconnectPeriod: 0,
        connectTimeout: 6000,
      });
      client.once('connect', () => {
        const topic = `${cfg.topicPrefix || 'gpuviewr'}/test`;
        const payload = JSON.stringify({ source: 'gpuviewr', kind: 'test', timestamp: new Date().toISOString() });
        client.publish(topic, payload, { retain: false }, (err) => {
          if (err) finish({ ok: false, message: `Connected, but publish failed: ${err.message}` });
          else finish({ ok: true, message: `Connected to ${cfg.url} and published a test on ${topic}.` });
        });
      });
      client.once('error', (err) => finish({ ok: false, message: `MQTT error: ${err.message}` }));
      setTimeout(() => finish({ ok: false, message: 'Connection timed out after 8s. Check broker URL, port, and credentials.' }), 8000);
    });
  }

  shutdown(): void {
    Object.values(this.timers).forEach((t) => t && clearInterval(t));
    this.timers = {};
    if (this.mqttClient) {
      try { this.mqttClient.end(true); } catch { /* ignore */ }
      this.mqttClient = null;
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function escapeTag(v: string): string {
  return v.replace(/[ ,=]/g, '_');
}

function formatHostTag(host_id: string): string {
  if (host_id === 'local') return 'local';
  return host_id.slice(0, 8);
}

function formatGpuLine(s: GpuSample): string {
  const memTotal = s.memory_total ?? 0;
  const memPct = memTotal > 0 ? Math.round((s.memory_used / memTotal) * 100) : null;
  const memSeg = memPct === null ? '' : ` · MEM ${memPct}%`;
  const util = s.utilization ?? '-';
  return `GPU #${s.gpu_index} ${s.name} · ${util}% · ${s.temperature}°C · ${Math.round(s.power)}W${memSeg}`;
}

function formatHostStatsLine(sys: ReturnType<typeof getSystemStats>, lang: AlertLang): string {
  const fr = lang === 'fr';
  const hostLabel = fr ? 'Hôte' : 'Host';
  const loadLabel = fr ? 'Charge' : 'Load';
  const memLabel = fr ? 'Mém' : 'MEM';
  const load = `${sys.load['1m'].toFixed(2)} / ${sys.load['5m'].toFixed(2)} / ${sys.load['15m'].toFixed(2)}`;
  return `${hostLabel}: CPU ${Math.round(sys.cpu.usagePct)}% · ${loadLabel} ${load} · ${memLabel} ${Math.round(sys.memory.usedPct)}%`;
}

// Keep only the fields the user opted into. An empty selection means
// "no filter" so legacy installs without payloadFields keep their behavior.
function filterSampleFields(sample: GpuSample, fields: WebhookPayloadField[] | undefined): Partial<GpuSample> {
  if (!fields || fields.length === 0) return sample;
  const out: Partial<GpuSample> = {};
  for (const f of fields) {
    if (f in sample) (out as Record<string, unknown>)[f] = (sample as unknown as Record<string, unknown>)[f];
  }
  return out;
}

function buildInfluxHostLine(measurement: string, sys: ReturnType<typeof getSystemStats>): string {
  // Renamed from `host` to `os_host` so the multi-host `host=<id>` tag
  // on the GPU lines doesn't collide / confuse Grafana templating.
  const tags = [`os_host=${escapeTag(sys.hostname || 'unknown')}`];
  const fields: string[] = [
    `cpu_usage_pct=${sys.cpu.usagePct.toFixed(2)}`,
    `cpu_cores=${sys.cpu.cores}i`,
    `load_1m=${sys.load['1m'].toFixed(2)}`,
    `load_5m=${sys.load['5m'].toFixed(2)}`,
    `load_15m=${sys.load['15m'].toFixed(2)}`,
    `memory_used=${sys.memory.used}i`,
    `memory_total=${sys.memory.total}i`,
    `memory_used_pct=${sys.memory.usedPct.toFixed(2)}`,
  ];
  return `${measurement}_host,${tags.join(',')} ${fields.join(',')} ${Math.floor(Date.now() / 1000)}`;
}

function buildInfluxLine(measurement: string, host_id: string, s: GpuSample): string {
  const tags = [
    `host=${escapeTag(host_id)}`,
    `gpu_index=${s.gpu_index}`,
    `name=${escapeTag(s.name)}`,
  ];
  if (s.uuid) tags.push(`uuid=${escapeTag(s.uuid)}`);
  const fields: string[] = [`temperature=${s.temperature}`];
  if (s.utilization !== null) fields.push(`utilization=${s.utilization}`);
  fields.push(`memory_used=${s.memory_used}`);
  if (s.memory_total !== null) fields.push(`memory_total=${s.memory_total}`);
  fields.push(`power=${s.power}`);
  if (s.fan_speed !== null) fields.push(`fan_speed=${s.fan_speed}`);
  if (s.clock_graphics !== null) fields.push(`clock_graphics=${s.clock_graphics}`);
  if (s.clock_memory !== null) fields.push(`clock_memory=${s.clock_memory}`);
  return `${measurement},${tags.join(',')} ${fields.join(',')} ${s.timestamp_epoch}`;
}

// Prometheus label-value escaping: backslash → \\, quote → \", newline → \n.
// Order matters: escape backslashes first, otherwise we'd escape the
// backslashes we just inserted for quotes. String.raw keeps the
// literal backslashes readable instead of doubling each escape.
function escapePromLabel(v: string): string {
  return v
    .replaceAll('\\', String.raw`\\`)
    .replaceAll('"', String.raw`\"`)
    .replaceAll('\n', String.raw`\n`);
}

function promHelpTypeLines(metrics: readonly PrometheusMetricSpec[]): string[] {
  return metrics.flatMap((m) => [
    `# HELP ${m.name} ${m.help}`,
    `# TYPE ${m.name} ${m.type}`,
  ]);
}

function promGpuLines(host_id: string, s: GpuSample): string[] {
  // D3 of the multi-host plan: host="<id>" is the stable UUID. Human
  // labels live on the gpuviewr_host_info side-metric so Grafana can
  // join host="..." * on(host) group_left(label) gpuviewr_host_info.
  const uuidPart = s.uuid ? `,uuid="${escapePromLabel(s.uuid)}"` : '';
  const l = `{host="${escapePromLabel(host_id)}",gpu="${s.gpu_index}",name="${escapePromLabel(s.name)}"${uuidPart}}`;
  const out: string[] = [`gpuviewr_gpu_temperature_celsius${l} ${s.temperature}`];
  if (s.utilization !== null) out.push(`gpuviewr_gpu_utilization_ratio${l} ${(s.utilization / 100).toFixed(4)}`);
  out.push(`gpuviewr_gpu_memory_used_bytes${l} ${s.memory_used * 1024 * 1024}`);
  if (s.memory_total !== null) out.push(`gpuviewr_gpu_memory_total_bytes${l} ${s.memory_total * 1024 * 1024}`);
  out.push(`gpuviewr_gpu_power_watts${l} ${s.power}`);
  if (s.fan_speed !== null) out.push(`gpuviewr_gpu_fan_speed_ratio${l} ${(s.fan_speed / 100).toFixed(4)}`);
  if (s.clock_graphics !== null) out.push(`gpuviewr_gpu_clock_graphics_hz${l} ${s.clock_graphics * 1_000_000}`);
  if (s.clock_memory !== null) out.push(`gpuviewr_gpu_clock_memory_hz${l} ${s.clock_memory * 1_000_000}`);
  return out;
}

function promHostLines(): string[] {
  const sys = getSystemStats();
  // Local-hub stats only — kept under the stable host_id 'local' so it
  // matches the host="local" GPU lines for Grafana joins. Agents push
  // their own system stats in a later jalon.
  const hostLabel = `{host="local",os_hostname="${escapePromLabel(sys.hostname)}"}`;
  return [
    `gpuviewr_host_cpu_usage_ratio${hostLabel} ${(sys.cpu.usagePct / 100).toFixed(4)}`,
    `gpuviewr_host_load_1m${hostLabel} ${sys.load['1m'].toFixed(2)}`,
    `gpuviewr_host_load_5m${hostLabel} ${sys.load['5m'].toFixed(2)}`,
    `gpuviewr_host_load_15m${hostLabel} ${sys.load['15m'].toFixed(2)}`,
    `gpuviewr_host_memory_used_bytes${hostLabel} ${sys.memory.used}`,
    `gpuviewr_host_memory_total_bytes${hostLabel} ${sys.memory.total}`,
    `gpuviewr_host_memory_used_ratio${hostLabel} ${(sys.memory.usedPct / 100).toFixed(4)}`,
  ];
}

/** node_exporter-style info series: one line per host with constant
 *  value=1 and the human label/hostname attached as labels. Lets
 *  dashboards join `gpuviewr_gpu_*{host=...} * on(host) group_left(label)
 *  gpuviewr_host_info`. */
function promHostInfoLines(hostsByPlatform: ReadonlyMap<string, GpuSample[]>): string[] {
  // We don't have HostsRepo data wired in here without a circular
  // dep risk, so we emit the bare minimum (host=<id>) and let agents
  // self-describe via the hello frame. v0.3.1 can enrich this with
  // label/hostname/agent_version pulled from HostsRepo.list().
  const out: string[] = [
    '# HELP gpuviewr_host_info Constant 1 per enrolled host, with metadata labels',
    '# TYPE gpuviewr_host_info gauge',
  ];
  for (const host_id of hostsByPlatform.keys()) {
    out.push(`gpuviewr_host_info{host="${escapePromLabel(host_id)}"} 1`);
  }
  return out;
}

/** Build the Prometheus exposition (text/plain; version=0.0.4). The
 *  multi-host variant emits one series per (host_id, gpu_index) pair
 *  plus a `gpuviewr_host_info{host=...} 1` side-metric per D3. */
export function renderPrometheus(samplesByHost: ReadonlyMap<string, GpuSample[]>, includeHost = false): string {
  const gpuLines: string[] = [];
  for (const [host_id, samples] of samplesByHost) {
    for (const s of samples) gpuLines.push(...promGpuLines(host_id, s));
  }
  const lines: string[] = [
    ...promHelpTypeLines(PROMETHEUS_METRICS),
    ...(includeHost ? promHelpTypeLines(PROMETHEUS_HOST_METRICS) : []),
    ...gpuLines,
    ...(includeHost ? promHostLines() : []),
    ...promHostInfoLines(samplesByHost),
  ];
  return lines.join('\n') + '\n';
}

export const exportService = new ExportService();
