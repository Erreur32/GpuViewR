// LLM settings the hub pushes to agents (Settings > LLM):
//   - naming rules, global: "command contains X → runtime Y, model from
//     flag Z", so an operator can name a runtime the agent doesn't know
//     without waiting for a release;
//   - per host: extra LLM server URLs the agent may query (servers in
//     their own network namespace) and an Ollama manifests dir.
//
// Stored as JSON in app_config, validated here (and again on the agent),
// sent in a `config` frame right after `welcome` and whenever it changes.

import { AppConfigRepo, ensureAppConfigSchema } from '../database/models/AppConfig.js';
import { logger } from '../utils/logger.js';

export interface LlmRule {
  match: string;
  runtime: string;
  model_flag?: string;
  model?: string;
}

export interface LlmHostConfig {
  endpoints: string[];
  ollama_manifests_dir: string | null;
}

export const LLM_LIMITS = {
  rules: 50,
  match: 120,
  runtime: 40,
  flag: 40,
  model: 120,
  endpoints: 16,
  url: 300,
  dir: 512,
} as const;

const RULES_KEY = 'llm.rules';
const hostKey = (hostId: string) => `llm.host.${hostId}`;

export class LlmConfigError extends Error {}

function text(v: unknown, max: number, field: string, required: boolean): string | undefined {
  if (v === undefined || v === null || v === '') {
    if (required) throw new LlmConfigError(`${field} is required`);
    return undefined;
  }
  if (typeof v !== 'string') throw new LlmConfigError(`${field} must be a string`);
  const t = v.trim();
  if (t === '' && required) throw new LlmConfigError(`${field} is required`);
  if (t.length > max) throw new LlmConfigError(`${field} is longer than ${max} characters`);
  // No control characters: these strings end up in logs and the UI.
  if (/[\u0000-\u001f\u007f]/.test(t)) throw new LlmConfigError(`${field} contains control characters`);
  return t || undefined;
}

/** Validates a rule list, throws LlmConfigError with a readable reason. */
export function parseRules(raw: unknown): LlmRule[] {
  if (!Array.isArray(raw)) throw new LlmConfigError('rules must be a list');
  if (raw.length > LLM_LIMITS.rules) throw new LlmConfigError(`at most ${LLM_LIMITS.rules} rules`);
  return raw.map((r, i) => {
    if (!r || typeof r !== 'object') throw new LlmConfigError(`rule ${i + 1} is not an object`);
    const o = r as Record<string, unknown>;
    const match = text(o.match, LLM_LIMITS.match, `rule ${i + 1}: match`, true) as string;
    const runtime = text(o.runtime, LLM_LIMITS.runtime, `rule ${i + 1}: runtime`, true) as string;
    const flag = text(o.model_flag, LLM_LIMITS.flag, `rule ${i + 1}: model flag`, false);
    if (flag && (!flag.startsWith('-') || /\s/.test(flag))) {
      throw new LlmConfigError(`rule ${i + 1}: model flag must look like --model`);
    }
    const model = text(o.model, LLM_LIMITS.model, `rule ${i + 1}: model`, false);
    return { match, runtime, ...(flag ? { model_flag: flag } : {}), ...(model ? { model } : {}) };
  });
}

/** Path without trailing slashes. Plain loop, no regex (S8786). */
function trimTrailingSlashes(path: string): string {
  let end = path.length;
  while (end > 0 && path[end - 1] === '/') end--;
  return path.slice(0, end);
}

/** http(s) base URL, no credentials, no query/fragment. */
function parseEndpoint(raw: unknown, i: number): string {
  const v = text(raw, LLM_LIMITS.url, `endpoint ${i + 1}`, true) as string;
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    throw new LlmConfigError(`endpoint ${i + 1} is not a URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new LlmConfigError(`endpoint ${i + 1} must be http or https`);
  if (url.username || url.password) throw new LlmConfigError(`endpoint ${i + 1} must not contain credentials`);
  if (url.search || url.hash) throw new LlmConfigError(`endpoint ${i + 1} must not have a query or fragment`);
  return `${url.protocol}//${url.host}${trimTrailingSlashes(url.pathname)}`;
}

export function parseHostConfig(raw: unknown): LlmHostConfig {
  if (!raw || typeof raw !== 'object') throw new LlmConfigError('config must be an object');
  const o = raw as Record<string, unknown>;
  const list = o.endpoints ?? [];
  if (!Array.isArray(list)) throw new LlmConfigError('endpoints must be a list');
  if (list.length > LLM_LIMITS.endpoints) throw new LlmConfigError(`at most ${LLM_LIMITS.endpoints} endpoints`);
  const endpoints = [...new Set(list.map((u, i) => parseEndpoint(u, i)))];
  const dir = text(o.ollama_manifests_dir, LLM_LIMITS.dir, 'Ollama manifests dir', false);
  if (dir && (!dir.startsWith('/') || dir.split('/').includes('..'))) {
    throw new LlmConfigError('Ollama manifests dir must be an absolute path without ..');
  }
  return { endpoints, ollama_manifests_dir: dir ?? null };
}

let schemaReady = false;
function store(): typeof AppConfigRepo {
  if (!schemaReady) {
    ensureAppConfigSchema();
    schemaReady = true;
  }
  return AppConfigRepo;
}

export const llmConfig = {
  rules(): LlmRule[] {
    return store().getJson<LlmRule[]>(RULES_KEY) ?? [];
  },
  setRules(raw: unknown): LlmRule[] {
    const rules = parseRules(raw);
    store().setJson(RULES_KEY, rules);
    return rules;
  },
  host(hostId: string): LlmHostConfig {
    return store().getJson<LlmHostConfig>(hostKey(hostId)) ?? { endpoints: [], ollama_manifests_dir: null };
  },
  setHost(hostId: string, raw: unknown): LlmHostConfig {
    const cfg = parseHostConfig(raw);
    store().setJson(hostKey(hostId), cfg);
    return cfg;
  },
  /** Payload of the `config` frame for one host. Never throws: a storage
   *  problem must not break the agent handshake, the agent then simply
   *  runs with empty settings. */
  frameFor(hostId: string): { type: 'config'; llm: { rules: LlmRule[]; endpoints: string[]; ollama_manifests_dir: string | null } } {
    try {
      return { type: 'config', llm: { rules: this.rules(), ...this.host(hostId) } };
    } catch (err) {
      logger.warn('llm', `config frame for ${hostId} failed: ${(err as Error).message}`);
      return { type: 'config', llm: { rules: [], endpoints: [], ollama_manifests_dir: null } };
    }
  },
};
