import { connect as mqttConnect, MqttClient } from 'mqtt';
import { randomBytes } from 'node:crypto';
import { gpuCollector, type GpuSample } from './gpuCollector.js';
import { AppConfigRepo, ensureAppConfigSchema } from '../database/models/AppConfig.js';
import { logger } from '../utils/logger.js';

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
}
export interface MqttDispatchInfo {
  enabled: boolean;
  broker: string;
  connected: boolean;
  intervalSeconds: number;
  stateTopicPattern: string;
  resolvedStateTopics: string[];
  payloadKeys: readonly string[];
  haDiscovery:
    | { enabled: false }
    | {
        enabled: true;
        configTopicPattern: string;
        sensors: HaSensorSpec[];
      };
}
export interface InfluxDispatchInfo {
  enabled: boolean;
  writeUrl: string;
  measurement: string;
  intervalSeconds: number;
  tagKeys: readonly string[];
  fieldKeys: readonly string[];
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
}

export interface MqttConfig {
  enabled: boolean;
  url: string;            // mqtt://host:1883 or mqtts://...
  username?: string;
  password?: string;
  topicPrefix: string;    // e.g. "gpuviewr"
  haDiscovery: boolean;   // publish Home Assistant discovery configs
  intervalSeconds: number;
}

export interface InfluxConfig {
  enabled: boolean;
  url: string;            // http://host:8086
  token: string;
  org: string;
  bucket: string;
  measurement: string;    // default: gpu_metrics
  intervalSeconds: number;
}

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
  prometheus: { enabled: false },
  mqtt: {
    enabled: false,
    url: 'mqtt://localhost:1883',
    username: '',
    password: '',
    topicPrefix: 'gpuviewr',
    haDiscovery: false,
    intervalSeconds: 10,
  },
  influxdb: {
    enabled: false,
    url: 'http://localhost:8086',
    token: '',
    org: '',
    bucket: 'gpuviewr',
    measurement: 'gpu_metrics',
    intervalSeconds: 10,
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
    token: '',
    chatId: '',
  },
};

// ──────────────────────────────────────────────────────────────────────────────
// Service
// ──────────────────────────────────────────────────────────────────────────────

class ExportService {
  private latestSamples: GpuSample[] = [];
  private mqttClient: MqttClient | null = null;
  private mqttDiscoveryPublished = false;
  private timers: Partial<Record<ExporterKind, NodeJS.Timeout>> = {};

  init(): void {
    ensureAppConfigSchema();
    if (!AppConfigRepo.getJson<ExportConfigs>(CONFIG_KEY)) {
      AppConfigRepo.setJson<ExportConfigs>(CONFIG_KEY, DEFAULTS);
    }
    gpuCollector.on('sample', (samples: GpuSample[]) => {
      this.latestSamples = samples;
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
        ...(stored.webhook ?? {}),
        payloadFields: Array.isArray(stored.webhook?.payloadFields)
          ? (stored.webhook!.payloadFields.filter((f): f is WebhookPayloadField =>
              (WEBHOOK_PAYLOAD_FIELDS as readonly string[]).includes(f as string)))
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

  // ── Latest samples accessor used by the Prometheus pull endpoint ─────────
  getLatestSamples(): GpuSample[] {
    return this.latestSamples;
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
    const sampleIndices = this.latestSamples.map((s) => s.gpu_index);

    const stateTopicPattern = `${c.mqtt.topicPrefix}/gpu<N>/state`;
    const resolvedStateTopics = sampleIndices.map(
      (i) => `${c.mqtt.topicPrefix}/gpu${i}/state`,
    );

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
      },
      mqtt: {
        enabled: c.mqtt.enabled,
        broker: c.mqtt.url,
        connected: !!this.mqttClient?.connected,
        intervalSeconds: c.mqtt.intervalSeconds,
        stateTopicPattern,
        resolvedStateTopics,
        payloadKeys: MQTT_PAYLOAD_KEYS,
        haDiscovery: c.mqtt.haDiscovery
          ? {
              enabled: true,
              configTopicPattern: 'homeassistant/sensor/gpuviewr_gpu<N>_<key>/config',
              sensors: [...MQTT_HA_SENSORS],
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
    if (!this.mqttClient || !this.mqttClient.connected) return;
    for (const s of this.latestSamples) {
      const base = `${cfg.topicPrefix}/gpu${s.gpu_index}`;
      // Keys must stay in sync with MQTT_PAYLOAD_KEYS (drives the Settings
      // "what's being sent" panel).
      const payload = {
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

  private publishHaDiscovery(cfg: MqttConfig): void {
    if (!this.mqttClient || this.mqttDiscoveryPublished) return;
    // Wait until we have at least one sample to know how many GPUs to advertise.
    if (this.latestSamples.length === 0) {
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
    for (const s of this.latestSamples) {
      const stateTopic = `${cfg.topicPrefix}/gpu${s.gpu_index}/state`;
      const device = {
        identifiers: [`gpuviewr_gpu${s.gpu_index}`],
        name: `GpuViewR GPU ${s.gpu_index} - ${s.name}`,
        manufacturer: 'NVIDIA',
        model: s.name,
      };
      for (const sensor of sensors) {
        const cfgTopic = `homeassistant/sensor/gpuviewr_gpu${s.gpu_index}_${sensor.key}/config`;
        const cfgPayload = {
          name: `GPU${s.gpu_index} ${sensor.name}`,
          unique_id: `gpuviewr_gpu${s.gpu_index}_${sensor.key}`,
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
    this.mqttDiscoveryPublished = true;
    logger.info('export', `MQTT HA discovery published for ${this.latestSamples.length} GPU(s)`);
  }

  // ────────────────────────────────────────────────────────────────────────
  // InfluxDB v2 line protocol
  // ────────────────────────────────────────────────────────────────────────

  private async pushInflux(cfg: InfluxConfig): Promise<void> {
    if (this.latestSamples.length === 0) return;
    const lines = this.latestSamples.map((s) => buildInfluxLine(cfg.measurement, s));
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
    if (this.latestSamples.length === 0) return;
    const body = {
      source: 'gpuviewr',
      timestamp: new Date().toISOString(),
      samples: this.latestSamples.map((s) => filterSampleFields(s, cfg.payloadFields)),
    };
    await this.sendWebhook(cfg, body, this.metricsSummary());
  }

  // Build a short, human-readable digest used by Discord embeds and
  // Telegram messages so a "metrics" push reads as a useful summary.
  private metricsSummary(): string {
    if (this.latestSamples.length === 0) return 'No GPU samples available.';
    return this.latestSamples
      .map((s) => {
        const memTotal = s.memory_total ?? 0;
        const memPct = memTotal > 0 ? Math.round((s.memory_used / memTotal) * 100) : null;
        const memSeg = memPct !== null ? ` · MEM ${memPct}%` : '';
        return `GPU #${s.gpu_index} ${s.name} · ${s.utilization ?? '-'}% · ${s.temperature}°C · ${Math.round(s.power)}W${memSeg}`;
      })
      .join('\n');
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
    const body = {
      source: 'gpuviewr',
      kind: 'alert',
      event: e,
      rule: r,
      timestamp: new Date(e.triggered_at * 1000).toISOString(),
    };
    const summary = `${e.state === 'firing' ? '🚨' : '✅'} ${e.rule_name} (GPU #${e.gpu_index}) — ${e.metric} ${e.observed} ${e.state === 'firing' ? '>=' : '<'} ${e.threshold}`;
    await this.sendWebhook(cfg, body, summary, e.state === 'firing' ? 0xe74c3c : 0x2ecc71);
  }

  // Generic sender. Routes to type-specific senders for Discord and
  // Telegram, falls back to plain JSON POST/PUT for "generic".
  private async sendWebhook(cfg: WebhookConfig, body: object, summary: string, color = 0x3498db): Promise<void> {
    if (!cfg.url && cfg.type !== 'telegram') {
      logger.warn('export', 'Webhook URL is empty');
      return;
    }
    try {
      let res: Response;
      if (cfg.type === 'discord') {
        res = await fetch(cfg.url, {
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
      } else if (cfg.type === 'telegram') {
        if (!cfg.token || !cfg.chatId) {
          logger.warn('export', 'Telegram webhook missing token or chatId');
          return;
        }
        res = await fetch(`https://api.telegram.org/bot${encodeURIComponent(cfg.token)}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: cfg.chatId,
            text: summary,
            parse_mode: 'HTML',
          }),
        });
      } else {
        // Strip a user-supplied Content-Type to keep our JSON body intact.
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        for (const [k, v] of Object.entries(cfg.headers ?? {})) {
          if (k.toLowerCase() !== 'content-type') headers[k] = v;
        }
        res = await fetch(cfg.url, {
          method: cfg.method,
          headers,
          body: JSON.stringify(body),
        });
      }
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}${txt ? `: ${txt.slice(0, 200)}` : ''}`);
      }
    } catch (err) {
      logger.warn('export', `Webhook (${cfg.type}) failed: ${(err as Error).message}`);
      throw err;
    }
  }

  /** Test a single exporter with a representative sample. */
  async test(kind: ExporterKind): Promise<{ ok: boolean; message: string }> {
    const c = this.getConfigs();
    try {
      if (kind === 'prometheus') {
        return { ok: true, message: 'Prometheus is pull-based; scrape /metrics to test.' };
      }
      if (kind === 'webhook') {
        const w = c.webhook;
        if (w.type === 'telegram') {
          if (!w.token || !w.chatId) return { ok: false, message: 'Telegram webhook needs both token and chatId.' };
        } else if (!w.url) {
          return { ok: false, message: 'Webhook URL is empty.' };
        }
        // Send a representative payload regardless of the configured mode.
        if (w.mode === 'alerts' || w.type !== 'generic') {
          await this.sendWebhook(w, {
            source: 'gpuviewr',
            kind: 'test',
            timestamp: new Date().toISOString(),
            samples: this.latestSamples.slice(0, 1),
          }, `🧪 GpuViewR webhook test — ${this.latestSamples.length} GPU(s) reporting.`);
        } else {
          await this.pushWebhook(w);
        }
        return { ok: true, message: 'Webhook test sent and accepted by the remote endpoint.' };
      }
      if (kind === 'influxdb') {
        if (!c.influxdb.token || !c.influxdb.org) return { ok: false, message: 'InfluxDB token/org missing.' };
        await this.pushInflux(c.influxdb);
        return { ok: true, message: 'InfluxDB test write sent.' };
      }
      if (kind === 'mqtt') {
        if (!this.mqttClient || !this.mqttClient.connected) return { ok: false, message: 'MQTT client not connected.' };
        this.publishMqtt(c.mqtt);
        return { ok: true, message: 'MQTT test publish sent.' };
      }
      return { ok: false, message: 'Unknown exporter' };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
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

function buildInfluxLine(measurement: string, s: GpuSample): string {
  const tags = [
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

/** Build the Prometheus exposition (text/plain; version=0.0.4). */
export function renderPrometheus(samples: GpuSample[]): string {
  const lines: string[] = [];
  // HELP/TYPE block driven by PROMETHEUS_METRICS so the dispatch-info panel
  // and the actual exposition stay in lockstep.
  for (const m of PROMETHEUS_METRICS) {
    lines.push(`# HELP ${m.name} ${m.help}`);
    lines.push(`# TYPE ${m.name} ${m.type}`);
  }

  // Prometheus label-value escaping: backslash → \\, quote → \", newline → \n.
  // Order matters: escape backslashes first, otherwise we'd escape the
  // backslashes we just inserted for quotes.
  const escapeLabel = (v: string) =>
    v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
  const labels = (s: GpuSample) =>
    `{gpu="${s.gpu_index}",name="${escapeLabel(s.name)}"${s.uuid ? `,uuid="${escapeLabel(s.uuid)}"` : ''}}`;

  for (const s of samples) {
    const l = labels(s);
    lines.push(`gpuviewr_gpu_temperature_celsius${l} ${s.temperature}`);
    if (s.utilization !== null) lines.push(`gpuviewr_gpu_utilization_ratio${l} ${(s.utilization / 100).toFixed(4)}`);
    lines.push(`gpuviewr_gpu_memory_used_bytes${l} ${s.memory_used * 1024 * 1024}`);
    if (s.memory_total !== null) lines.push(`gpuviewr_gpu_memory_total_bytes${l} ${s.memory_total * 1024 * 1024}`);
    lines.push(`gpuviewr_gpu_power_watts${l} ${s.power}`);
    if (s.fan_speed !== null) lines.push(`gpuviewr_gpu_fan_speed_ratio${l} ${(s.fan_speed / 100).toFixed(4)}`);
    if (s.clock_graphics !== null) lines.push(`gpuviewr_gpu_clock_graphics_hz${l} ${s.clock_graphics * 1_000_000}`);
    if (s.clock_memory !== null) lines.push(`gpuviewr_gpu_clock_memory_hz${l} ${s.clock_memory * 1_000_000}`);
  }
  return lines.join('\n') + '\n';
}

export const exportService = new ExportService();
