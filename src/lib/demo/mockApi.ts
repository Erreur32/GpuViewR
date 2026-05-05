// Browser-side mock for /api/* in the public demo build.
// All write endpoints are no-ops that return shapes the UI expects, so
// nothing leaves the tab and nothing is persisted server-side.
import {
  DEMO_GPUS,
  bucketForRange,
  buildHistory,
  fakeAlertEvents,
  fakeAlertPresets,
  fakeAlertRules,
  fakeChangelog,
  fakeDb,
  fakeExportsConfig,
  fakeExportsInfo,
  fakeLogs,
  fakeProcesses,
  fakeStats,
  fakeSystem,
  fakeUpdateConfig,
  fakeUpdateResult,
  rangeToSec,
  sampleAt,
  type DemoRule,
} from './data';

const realFetch = globalThis.fetch.bind(globalThis);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function gpuParam(url: URL): number {
  return Math.max(0, Number.parseInt(url.searchParams.get('gpu') || '0', 10) || 0);
}

function specOrDefault(idx: number) {
  return DEMO_GPUS.find((g) => g.index === idx) ?? DEMO_GPUS[0];
}

// Mutable in-memory state so toggling alert rules / installing presets
// feels real for the duration of the demo session. Cleared on reload.
let demoRules: DemoRule[] = fakeAlertRules();
let demoEvents: ReturnType<typeof fakeAlertEvents> = fakeAlertEvents();
let demoExports = fakeExportsConfig();
let demoUpdateConfig = fakeUpdateConfig().config;

interface RouteCtx {
  url: URL;
  method: string;
  body: unknown;
}

type RuleBody = Partial<DemoRule> & {
  enabled?: number | boolean;
  notify_browser?: number | boolean;
  notify_sound?: number | boolean;
  notify_webhook?: number | boolean;
};

function toBit(v: unknown): 0 | 1 | undefined {
  if (v === undefined) return undefined;
  return v ? 1 : 0;
}

function applyRulePatch(prev: DemoRule, body: RuleBody): DemoRule {
  return {
    ...prev,
    ...body,
    enabled: toBit(body.enabled) ?? prev.enabled,
    notify_browser: toBit(body.notify_browser) ?? prev.notify_browser,
    notify_sound: toBit(body.notify_sound) ?? prev.notify_sound,
    notify_webhook: toBit(body.notify_webhook) ?? prev.notify_webhook,
  } as DemoRule;
}

function handleAuth(ctx: RouteCtx): Response | null {
  if (ctx.url.pathname === '/api/auth/status') {
    return json({ hasUsers: true });
  }
  if (ctx.url.pathname === '/api/auth/login' && ctx.method === 'POST') {
    return json({ token: 'demo.token', user: { id: 1, username: 'demo', role: 'admin' } });
  }
  if (ctx.url.pathname === '/api/auth/register' && ctx.method === 'POST') {
    return json({ token: 'demo.token', user: { id: 1, username: 'demo', role: 'admin' } });
  }
  return null;
}

function handleHealthSystem(ctx: RouteCtx): Response | null {
  if (ctx.url.pathname === '/api/health') {
    return json({
      ok: true,
      nodeEnv: 'demo',
      mockGpu: true,
      version: '0.0.0-demo',
      uptime: Math.floor(performance.now() / 1000),
    });
  }
  if (ctx.url.pathname === '/api/system') return json(fakeSystem());
  if (ctx.url.pathname === '/api/system/db') return json(fakeDb());
  if (ctx.url.pathname === '/api/system/db/retention' && ctx.method === 'PUT') {
    return json({ retentionDays: (ctx.body as { days?: number })?.days ?? 14 });
  }
  if (ctx.url.pathname === '/api/system/db/purge') return json({ removed: 0 });
  if (ctx.url.pathname === '/api/info/changelog') return json(fakeChangelog());
  return null;
}

function handleGpu(ctx: RouteCtx): Response | null {
  if (ctx.url.pathname === '/api/gpu/history') {
    const idx = gpuParam(ctx.url);
    const range = ctx.url.searchParams.get('range') || '10m';
    const rangeSec = rangeToSec(range);
    const bucketSec = bucketForRange(rangeSec);
    const history = buildHistory(specOrDefault(idx), rangeSec, bucketSec);
    return json({ gpuIndex: idx, range, count: history.length, bucketSec, history });
  }
  if (ctx.url.pathname === '/api/gpu/stats') {
    const idx = gpuParam(ctx.url);
    const rangeSec = rangeToSec(ctx.url.searchParams.get('range') || '10m');
    return json({ gpuIndex: idx, range: ctx.url.searchParams.get('range'), stats: fakeStats(specOrDefault(idx), rangeSec) });
  }
  if (ctx.url.pathname === '/api/processes') {
    const idx = gpuParam(ctx.url);
    const processes = fakeProcesses(idx);
    return json({ timestamp_epoch: Math.floor(Date.now() / 1000), count: processes.length, processes });
  }
  return null;
}

function handleAlerts(ctx: RouteCtx): Response | null {
  const p = ctx.url.pathname;
  if (p === '/api/alerts/rules') {
    if (ctx.method === 'GET') return json({ rules: demoRules });
    if (ctx.method === 'POST') {
      const body = (ctx.body as RuleBody) ?? {};
      const newId = Math.max(0, ...demoRules.map((r) => r.id)) + 1;
      const newRule = applyRulePatch(
        { ...demoRules[0], id: newId, name: 'New rule' },
        body,
      );
      newRule.id = newId;
      demoRules = [...demoRules, newRule];
      return json({ rule: newRule });
    }
  }
  const ruleMatch = /^\/api\/alerts\/rules\/(\d+)$/.exec(p);
  if (ruleMatch) {
    const id = Number.parseInt(ruleMatch[1], 10);
    if (ctx.method === 'PATCH') {
      const body = (ctx.body as RuleBody) ?? {};
      demoRules = demoRules.map((r) => (r.id === id ? applyRulePatch(r, body) : r));
      const rule = demoRules.find((r) => r.id === id);
      if (!rule) return json({ error: 'Not found' }, 404);
      return json({ rule });
    }
    if (ctx.method === 'DELETE') {
      demoRules = demoRules.filter((r) => r.id !== id);
      return json({ ok: true });
    }
  }
  if (p === '/api/alerts/presets') return json({ presets: fakeAlertPresets() });
  if (p === '/api/alerts/presets/install' && ctx.method === 'POST') {
    const ids = (ctx.body as { ids?: string[] })?.ids ?? [];
    return json({ created: ids.length });
  }
  if (p === '/api/alerts/events') {
    if (ctx.method === 'GET') return json({ events: demoEvents });
    if (ctx.method === 'DELETE') {
      const count = demoEvents.length;
      demoEvents = [];
      return json({ ok: true, count });
    }
  }
  const eventMatch = /^\/api\/alerts\/events\/(\d+)$/.exec(p);
  if (eventMatch && ctx.method === 'DELETE') {
    const id = Number.parseInt(eventMatch[1], 10);
    const before = demoEvents.length;
    demoEvents = demoEvents.filter((e) => e.id !== id);
    return json({ ok: before !== demoEvents.length });
  }
  return null;
}

function handleExports(ctx: RouteCtx): Response | null {
  const p = ctx.url.pathname;
  if (p === '/api/exports') return json(demoExports);
  if (p === '/api/exports/info') return json(fakeExportsInfo());
  const m = /^\/api\/exports\/([a-z]+)(?:\/(test))?$/.exec(p);
  if (m) {
    const kind = m[1] as keyof typeof demoExports;
    if (m[2] === 'test') return json({ ok: true, message: '[demo] dispatch simulated successfully' });
    if (ctx.method === 'PUT') {
      const patch = (ctx.body as Record<string, unknown>) ?? {};
      demoExports = { ...demoExports, [kind]: { ...demoExports[kind], ...patch } };
      return json({ ok: true });
    }
  }
  return null;
}

function handleLogsUpdates(ctx: RouteCtx): Response | null {
  if (ctx.url.pathname === '/api/logs') return json(fakeLogs());
  if (ctx.url.pathname === '/api/updates/config') {
    if (ctx.method === 'GET') return json({ config: demoUpdateConfig });
    if (ctx.method === 'PUT') {
      const body = (ctx.body as { config?: typeof demoUpdateConfig }) ?? {};
      if (body.config) demoUpdateConfig = { ...demoUpdateConfig, ...body.config };
      return json({ config: demoUpdateConfig });
    }
  }
  if (ctx.url.pathname === '/api/updates/check') return json(fakeUpdateResult());
  return null;
}

const handlers = [handleAuth, handleHealthSystem, handleGpu, handleAlerts, handleExports, handleLogsUpdates];

function parseBody(init?: RequestInit): unknown {
  if (!init || typeof init.body !== 'string') return null;
  try { return JSON.parse(init.body); } catch { return null; }
}

function resolveUrl(input: RequestInfo | URL): URL {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  return new URL(raw, globalThis.location.origin);
}

export function installMockFetch(): void {
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let url: URL;
    try { url = resolveUrl(input); } catch { return realFetch(input as RequestInfo, init); }
    if (!url.pathname.startsWith('/api/')) return realFetch(input as RequestInfo, init);
    const ctx: RouteCtx = {
      url,
      method: (init?.method || 'GET').toUpperCase(),
      body: parseBody(init),
    };
    for (const h of handlers) {
      const r = h(ctx);
      if (r) return Promise.resolve(r);
    }
    return json({ error: `[demo] ${ctx.method} ${url.pathname} not implemented` }, 404);
  };
}

// Live snapshot used by the WebSocket stub so charts and badges share the
// same generator and stay in sync visually.
export function liveSamples() {
  const now = Date.now();
  return DEMO_GPUS.map((spec) => sampleAt(spec, now));
}
