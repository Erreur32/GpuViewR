// Server-side formatter for alert webhook payloads.
// Produces a localized, lightly-styled message in two flavours:
// - "discord": Markdown-bold (**value**) consumed by a Discord embed
// - "telegram": HTML-bold (<b>value</b>) consumed by Telegram parse_mode=HTML
// Plain text fallback is also exposed for logs.
//
// Mirrors the wording shown on the AlertsPage "Recent events" list so a
// notification reads the same as the in-app row.

export type AlertLang = 'en' | 'fr';
export type AlertMetric =
  | 'temperature' | 'utilization' | 'memory' | 'power' | 'fan_speed'
  | 'host_cpu' | 'host_load_1m' | 'host_memory'
  | 'process_vram' | 'process_absent';
export type AlertCondition = 'above' | 'below';

export interface AlertEventLite {
  rule_name: string;
  gpu_index: number;
  metric: AlertMetric;
  threshold: number;
  observed: number;
  state: 'firing' | 'resolved';
  /** Process alerts: the rule's match text. */
  process_match?: string | null;
}

interface Phrases {
  metrics: Record<AlertMetric, string>;
  conditions: Record<AlertCondition, string>;
  observed: string;        // "(observed {v})"  / "(observée {v})"
  on_gpu: string;          // "on GPU #{i}"     / "sur GPU #{i}"
  on_host: string;         // "on host"         / "sur l'hôte"
  process: string;         // "process"         / "processus"
  absent: string;          // "no process matching" / "aucun processus correspondant à"
  back: string;            // "is back"         / "est revenu"
  resolved_to_normal: string; // "back to normal" / "revenue à la normale"
  firing_title: string;    // "Alert firing"    / "Alerte déclenchée"
  resolved_title: string;  // "Alert resolved"  / "Alerte résolue"
  host_line: { host: string; cpu: string; load: string; mem: string };
}

export interface HostStatsLite {
  hostname?: string;
  cpu: { usagePct: number };
  load: { '1m': number; '5m': number; '15m': number };
  memory: { usedPct: number };
}

const I18N: Record<AlertLang, Phrases> = {
  en: {
    metrics: {
      temperature: 'Temperature',
      utilization: 'Utilization',
      memory: 'Memory',
      power: 'Power',
      fan_speed: 'Fan',
      host_cpu: 'Host CPU',
      host_load_1m: 'Host load (1 min)',
      host_memory: 'Host RAM',
      process_vram: 'Process GPU memory',
      process_absent: 'Process missing',
    },
    conditions: { above: 'above', below: 'below' },
    observed: 'observed',
    on_gpu: 'on GPU',
    on_host: 'on host',
    process: 'process',
    absent: 'no process matching',
    back: 'is back',
    resolved_to_normal: 'back to normal',
    firing_title: 'Alert firing',
    resolved_title: 'Alert resolved',
    host_line: { host: 'Host', cpu: 'CPU', load: 'Load', mem: 'MEM' },
  },
  fr: {
    metrics: {
      temperature: 'Température',
      utilization: 'Utilisation',
      memory: 'Mémoire',
      power: 'Puissance',
      fan_speed: 'Ventilateur',
      host_cpu: 'CPU hôte',
      host_load_1m: 'Charge hôte (1 min)',
      host_memory: 'RAM hôte',
      process_vram: 'Mémoire GPU du processus',
      process_absent: 'Processus absent',
    },
    conditions: { above: 'au-dessus de', below: 'en dessous de' },
    observed: 'observée',
    on_gpu: 'sur GPU',
    on_host: "sur l'hôte",
    process: 'processus',
    absent: 'aucun processus correspondant à',
    back: 'est revenu',
    resolved_to_normal: 'revenue à la normale',
    firing_title: 'Alerte déclenchée',
    resolved_title: 'Alerte résolue',
    host_line: { host: 'Hôte', cpu: 'CPU', load: 'Charge', mem: 'Mém' },
  },
};

const UNITS: Record<AlertMetric, string> = {
  temperature: '°C',
  utilization: '%',
  memory: '%',
  power: ' W',
  fan_speed: '%',
  host_cpu: '%',
  host_load_1m: '',
  host_memory: '%',
  process_vram: ' MiB',
  process_absent: '',
};

/** "on GPU #0", "on host" or "process "llama-server"". */
function targetLabel(event: AlertEventLite, ph: Phrases): string {
  if (event.metric.startsWith('host_')) return ph.on_host;
  if (event.metric.startsWith('process_')) return `${ph.process} "${event.process_match ?? ''}"`;
  return `${ph.on_gpu} #${event.gpu_index}`;
}

function fmtNum(n: number): string {
  // 1 decimal max, trimmed — same rounding the in-app event message uses.
  return Math.abs(n) >= 100 ? Math.round(n).toString() : n.toFixed(1).replace(/\.0$/, '');
}

interface Marker {
  bold: (s: string) => string;
}

const DISCORD: Marker = { bold: (s) => `**${s}**` };
const TELEGRAM: Marker = { bold: (s) => `<b>${escapeHtml(s)}</b>` };
const PLAIN: Marker = { bold: (s) => s };

function escapeHtml(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function inferCondition(state: 'firing' | 'resolved', observed: number, threshold: number): AlertCondition {
  // The rule's condition isn't carried on the event payload; reconstruct it
  // from the firing direction. Resolved events use the same word as their
  // originating rule.
  if (state === 'firing') return observed >= threshold ? 'above' : 'below';
  return observed >= threshold ? 'below' : 'above';
}

function buildLines(event: AlertEventLite, lang: AlertLang, m: Marker, condition: AlertCondition): {
  title: string;
  description: string;
} {
  // `lang` selects the phrase table; the description string itself is
  // identical across languages once we substitute the localized labels,
  // so we don't branch on `lang` again below.
  const ph = I18N[lang];
  const unit = UNITS[event.metric] ?? '';
  const metricLabel = ph.metrics[event.metric] ?? event.metric;
  const gpu = targetLabel(event, ph);
  if (event.metric === 'process_absent') {
    const match = m.bold(`"${event.process_match ?? ''}"`);
    return event.state === 'firing'
      ? { title: `${ph.firing_title} — ${event.rule_name}`, description: `${ph.absent} ${match}` }
      : { title: `${ph.resolved_title} — ${event.rule_name}`, description: `${ph.process} ${match} ${ph.back}` };
  }
  const observedStr = `${fmtNum(event.observed)}${unit}`;
  const thresholdStr = `${fmtNum(event.threshold)}${unit}`;

  if (event.state === 'firing') {
    const title = `${ph.firing_title} — ${event.rule_name}`;
    const description = `${m.bold(metricLabel)} ${ph.conditions[condition]} ${m.bold(thresholdStr)} (${ph.observed} ${m.bold(observedStr)}) ${m.bold(gpu)}`;
    return { title, description };
  }

  // resolved
  const title = `${ph.resolved_title} — ${event.rule_name}`;
  const description = `${m.bold(metricLabel)} ${ph.resolved_to_normal} ${m.bold(gpu)} (${ph.observed} ${m.bold(observedStr)})`;
  return { title, description };
}

export interface FormattedAlert {
  title: string;
  discord: string;   // description body with **bold**
  telegram: string;  // description body with <b>...</b>
  plain: string;     // for logs / generic fallback
}

function loadStr(s: HostStatsLite): string {
  return `${s.load['1m'].toFixed(2)} / ${s.load['5m'].toFixed(2)} / ${s.load['15m'].toFixed(2)}`;
}

function hostLine(s: HostStatsLite, lang: AlertLang, m: Marker): string {
  const ph = I18N[lang].host_line;
  const sep = lang === 'fr' ? ' : ' : ': ';
  const cpuPct = `${Math.round(s.cpu.usagePct)}%`;
  const memPct = `${Math.round(s.memory.usedPct)}%`;
  const cpu = m.bold(cpuPct);
  const load = m.bold(loadStr(s));
  const mem = m.bold(memPct);
  return `${ph.host}${sep}${ph.cpu} ${cpu} · ${ph.load} ${load} · ${ph.mem} ${mem}`;
}

export function formatAlert(event: AlertEventLite, lang: AlertLang, host?: HostStatsLite): FormattedAlert {
  const condition = inferCondition(event.state, event.observed, event.threshold);
  const d = buildLines(event, lang, DISCORD, condition);
  const tg = buildLines(event, lang, TELEGRAM, condition);
  const p = buildLines(event, lang, PLAIN, condition);
  const dHost = host ? `\n${hostLine(host, lang, DISCORD)}` : '';
  const tgHost = host ? `\n${hostLine(host, lang, TELEGRAM)}` : '';
  const pHost = host ? `\n${hostLine(host, lang, PLAIN)}` : '';
  return {
    title: d.title,
    discord: `${d.description}${dHost}`,
    telegram: `<b>${escapeHtml(tg.title)}</b>\n${tg.description}${tgHost}`,
    plain: `${p.title} — ${p.description}${pHost}`,
  };
}
