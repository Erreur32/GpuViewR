// Asks the LLM servers themselves what they have loaded, instead of
// guessing from command lines:
//   - Ollama  GET  /api/ps   loaded models, size, keep-alive expiry;
//             POST /api/show modelfile, whose `FROM .../blobs/sha256-...`
//                            ties a model name to the blob a runner holds;
//   - llama.cpp and vLLM  GET /v1/models  the name the server answers to.
//
// Endpoints: Ollama's default http://127.0.0.1:11434 plus any URL the
// hub sends for this host (Settings > LLM). An Ollama answer is only used
// when the blob digest matches exactly, so asking the wrong server is
// harmless. llama.cpp / vLLM answers carry no such proof, so their
// `--port` is only tried on 127.0.0.1 when that is the process's own
// network (agent not in Docker, process not in a container: a container's
// port 8080 is usually published under another number, and the host's
// 8080 is someone else). Otherwise a configured URL on the same port, or
// the only configured server for the only unnamed process.
//
// The probe never blocks the collectors: lookups run on a timer, results
// are cached, `enrich()` reads the cache synchronously. Requests are GET
// or a fixed POST to fixed paths, 1.5 s timeout, 256 KiB response cap,
// JSON parsed defensively; nothing from the response is executed.

import type { AgentGpuProcess } from "./processes.js";
import { logger } from "../logger.js";

const TIMEOUT_MS = 1_500;
const MAX_BODY = 256 * 1024;
/** Re-poll period per endpoint. */
const POLL_MS = 15_000;
/** Below this much GPU memory a llama.cpp server holds no weights: it is
 *  asleep (--sleep-idle-seconds) or still loading. */
const IDLE_MIB = 64;
const OLLAMA_DEFAULT = "http://127.0.0.1:11434";
const DEFAULT_PORTS: Record<string, number> = { llamacpp: 8080, vllm: 8000 };

export interface OllamaLoaded {
  name: string;
  /** Epoch seconds the model unloads at, null if it never does. */
  expiresAt: number | null;
}

export interface LlmProbe {
  /** Extra endpoints from the hub (base URLs), replaces the previous set. */
  setEndpoints(urls: readonly string[]): void;
  /** Ollama model name for a blob digest (`sha256:<hex>`), from /api/show. */
  ollamaNameByDigest(digest: string): string | null;
  /** Adds model name / state / expiry from the cache, schedules lookups
   *  for servers seen for the first time. Never throws. */
  enrich(rows: AgentGpuProcess[]): AgentGpuProcess[];
  stop(): void;
}

interface FetchResponse {
  ok: boolean;
  headers: { get(name: string): string | null };
  body?: ReadableStream<Uint8Array> | null;
  text(): Promise<string>;
}
type FetchFn = (url: string, init?: { method?: string; body?: string; headers?: Record<string, string>; signal?: AbortSignal; redirect?: "error" }) => Promise<FetchResponse>;

/** Body as text, refusing more than MAX_BODY bytes even without a
 *  content-length (a hostile local server could stream forever). */
async function readCapped(res: FetchResponse): Promise<string> {
  if (!res.body) {
    const text = await res.text();
    if (text.length > MAX_BODY) throw new Error("response too large");
    return text;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) {
      await reader.cancel().catch(() => undefined);
      throw new Error("response too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** A server-reported name, or null: string, <= 200 chars, no control
 *  characters (it ends up in the UI, history and logs). */
function cleanName(v: unknown): string | null {
  if (typeof v !== "string" || v.length === 0 || v.length > 200) return null;
  return /[\u0000-\u001f\u007f]/.test(v) ? null : v;
}

/** http(s) base URL without trailing slash, or null if not acceptable. */
export function normalizeEndpoint(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
}

/** `--port N` / `--port=N` value of a cmdline, or the runtime default. */
export function serverPort(command: string | null, runtime: string): number | null {
  const m = command ? /(?:^|\s)--port(?:=|\s+)(\d{1,5})(?:\s|$)/.exec(command) : null;
  const port = m ? Number.parseInt(m[1], 10) : DEFAULT_PORTS[runtime];
  return port && port > 0 && port < 65536 ? port : null;
}

/** sha256 digest of the blob a modelfile's FROM line points to. */
export function digestFromModelfile(modelfile: string): string | null {
  const m = /^FROM\s+\S*sha256[-:]([0-9a-f]{64})\s*$/im.exec(modelfile);
  return m ? `sha256:${m[1]}` : null;
}

/** 'idle' for a llama.cpp server holding no weights, 'loaded' for the
 *  LLM servers, null for other runtimes (ComfyUI...). */
function llmState(row: AgentGpuProcess): "loaded" | "idle" | null {
  if (row.llm_runtime === "llamacpp") {
    return row.used_memory + (row.gtt_memory ?? 0) < IDLE_MIB ? "idle" : "loaded";
  }
  return row.llm_runtime === "ollama" || row.llm_runtime === "vllm" ? "loaded" : null;
}

function portOf(base: string): number {
  const u = new URL(base);
  if (u.port) return Number(u.port);
  return u.protocol === "https:" ? 443 : 80;
}

function epochOrNull(iso: unknown): number | null {
  if (typeof iso !== "string") return null;
  const t = Date.parse(iso);
  // Ollama uses year 2318 for keep_alive=-1 (never unloads).
  if (!Number.isFinite(t) || t > Date.now() + 10 * 365 * 86400_000) return null;
  return Math.floor(t / 1000);
}

export interface LlmProbeOptions {
  /** 127.0.0.1 is the host's loopback (agent not in a container). */
  hostNetwork: boolean;
  fetchImpl?: FetchFn;
}

export function createLlmProbe(opts: LlmProbeOptions): LlmProbe {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchFn);
  let extra: string[] = [];
  /** Ollama base URL → loaded models (by blob digest). */
  const ollamaLoaded = new Map<string, Map<string, OllamaLoaded>>();
  /** Model name → blob digest, from /api/show (stable, cached for good). */
  const digestByName = new Map<string, string | null>();
  /** base URL → name served at /v1/models. */
  const servedName = new Map<string, string | null>();
  const lastPoll = new Map<string, number>();
  const inflight = new Set<string>();
  let stopped = false;

  async function getJson(url: string, body?: unknown): Promise<unknown> {
    const res = await fetchImpl(url, {
      method: body === undefined ? "GET" : "POST",
      ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      // A redirect could point anywhere: endpoints are taken as given.
      redirect: "error",
    });
    if (!res.ok) throw new Error("http error");
    const len = Number(res.headers.get("content-length") ?? 0);
    if (len > MAX_BODY) throw new Error("response too large");
    return JSON.parse(await readCapped(res));
  }

  async function pollOllama(base: string): Promise<void> {
    const ps = await getJson(`${base}/api/ps`) as { models?: unknown };
    const models = Array.isArray(ps.models) ? ps.models : [];
    const loaded = new Map<string, OllamaLoaded>();
    for (const raw of models.slice(0, 32)) {
      const m = raw as { name?: unknown; expires_at?: unknown };
      const name = cleanName(m.name);
      if (!name) continue;
      if (!digestByName.has(name)) {
        const show = await getJson(`${base}/api/show`, { model: name }).catch(() => null) as { modelfile?: unknown } | null;
        digestByName.set(name, typeof show?.modelfile === "string" ? digestFromModelfile(show.modelfile) : null);
      }
      const digest = digestByName.get(name);
      if (digest) loaded.set(digest, { name, expiresAt: epochOrNull(m.expires_at) });
    }
    ollamaLoaded.set(base, loaded);
  }

  async function pollServed(base: string): Promise<void> {
    const r = await getJson(`${base}/v1/models`) as { data?: unknown };
    const first = Array.isArray(r.data) ? (r.data[0] as { id?: unknown } | undefined) : undefined;
    servedName.set(base, cleanName(first?.id));
  }

  /** Fire-and-forget poll of `base`, at most once per POLL_MS. */
  function schedule(base: string, kind: "ollama" | "served"): void {
    const now = Date.now();
    if (stopped || inflight.has(base) || now - (lastPoll.get(base) ?? 0) < POLL_MS) return;
    lastPoll.set(base, now);
    inflight.add(base);
    const job = kind === "ollama" ? pollOllama(base) : pollServed(base);
    job.catch((err: Error) => {
      // Unreachable server: forget stale data, retry next period.
      if (kind === "ollama") ollamaLoaded.delete(base);
      else servedName.delete(base);
      logger.debug("llm", `${base} not answering (${err.message})`);
    }).finally(() => inflight.delete(base));
  }

  function ollamaBases(): string[] {
    return [OLLAMA_DEFAULT, ...extra];
  }

  function findLoaded(digest: string): OllamaLoaded | null {
    for (const base of ollamaBases()) {
      const hit = ollamaLoaded.get(base)?.get(digest);
      if (hit) return hit;
    }
    return null;
  }

  /** Served name for a llama.cpp / vLLM process (see header for the
   *  order). `alone` = the only process on this host needing a name. */
  function servedFor(row: AgentGpuProcess, port: number | null, alone: boolean): string | null {
    if (port && opts.hostNetwork && !row.container_id) {
      const local = `http://127.0.0.1:${port}`;
      schedule(local, "served");
      const hit = servedName.get(local);
      if (hit) return hit;
    }
    for (const base of extra) schedule(base, "served");
    const samePort = extra.find((base) => port && portOf(base) === port && servedName.get(base));
    if (samePort) return servedName.get(samePort) ?? null;
    const answering = extra.filter((base) => servedName.get(base));
    return alone && answering.length === 1 ? servedName.get(answering[0]) ?? null : null;
  }

  function blobDigest(command: string | null): string | null {
    const m = command ? /sha256-([0-9a-f]{64})/i.exec(command) : null;
    return m ? `sha256:${m[1].toLowerCase()}` : null;
  }

  return {
    setEndpoints(urls) {
      extra = [...new Set(urls.map(normalizeEndpoint).filter((u): u is string => u !== null))].slice(0, 16);
    },
    ollamaNameByDigest(digest) {
      for (const base of ollamaBases()) schedule(base, "ollama");
      return findLoaded(digest)?.name ?? null;
    },
    enrich(rows) {
      try {
        const needsName = (r: AgentGpuProcess) =>
          (r.llm_runtime === "llamacpp" || r.llm_runtime === "vllm") && (!!r.llm_hint || !r.llm_model);
        const alone = rows.filter(needsName).length === 1;
        return rows.map((row) => {
          if (!row.llm_runtime) return row;
          const out: AgentGpuProcess = { ...row };
          const digest = blobDigest(row.command);
          if (row.llm_runtime === "ollama" || digest) {
            for (const base of ollamaBases()) schedule(base, "ollama");
            const loaded = digest ? findLoaded(digest) : null;
            if (loaded) {
              out.llm_model = loaded.name;
              out.llm_hint = null;
              out.llm_expires_at = loaded.expiresAt;
            }
          }
          if (needsName(row)) {
            const served = servedFor(row, serverPort(row.command, row.llm_runtime as string), alone);
            if (served) {
              out.llm_model = served;
              out.llm_hint = null;
            }
          }
          out.llm_state = llmState(row);
          return out;
        });
      } catch (err) {
        logger.debug("llm", `enrich failed: ${(err as Error).message}`);
        return rows;
      }
    },
    stop() {
      stopped = true;
    },
  };
}
