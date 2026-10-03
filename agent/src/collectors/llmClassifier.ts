// LLM runtime / model classifier. Pure function — no I/O. Takes a
// process command line (full /proc/<pid>/cmdline with NULs as spaces)
// and returns the runtime it belongs to plus the model name when
// extractable from the command line itself.
//
// Designed to be cheap (regex-only) and additive — never throws,
// always returns an object with nullable fields. The agent feeds this
// to every GPU process it sees; processes that don't match any runtime
// get `{ runtime: null, model: null, hint: null }` and the UI renders
// nothing extra.
//
// Coverage focus: the most common local-inference stacks that show up
// on a GPU. ML workloads we deliberately DON'T try to classify
// (CUDA-only training scripts, generic pytorch jobs, custom binaries)
// stay as `null` — better an empty badge than a wrong one.
//
// Why string matching and not e.g. /proc/<pid>/exe symlink reads:
// the command line is already in hand (the agent reads cmdline anyway
// for the "command" column), and exe symlinks are useless for runtimes
// that are launched via wrapper scripts (Python venv, npx, etc.).
//
// Model extraction strategy varies per runtime — see each branch's
// comment for what we look at. Ollama models (and llama.cpp pointed at
// Ollama's store) are content-addressed blob files: the cmdline only
// carries the sha256, the friendly name comes from the resolver in
// ollamaManifests.ts. When a name can't be produced, `hint` tells the
// UI why so it can show the operator what to change.

/** Why the model name shown is not a friendly one. Rendered by the UI
 *  as a warning icon with a "how to fix" tooltip.
 *  - ollama_manifests: Ollama blob digest not found in any manifests
 *    dir the agent could read.
 *  - blob: model loaded from an anonymous content-addressed file
 *    (not an Ollama one), no alias given.
 *  - no_model: runtime recognised but its cmdline names no model. */
export type LLMHint = 'ollama_manifests' | 'blob' | 'no_model';

export interface LLMClassification {
  /** Detected runtime ('ollama', 'llamacpp', 'vllm', etc.) or null
   *  if the command line doesn't match any known LLM stack. */
  runtime: string | null;
  /** Best-effort model identifier. For most runtimes this is the
   *  value of the `--model` / `-m` flag (typically a file path or
   *  HF-style id). Blob digests go through the Ollama resolver and
   *  fall back to `sha256:<prefix>`. Null when no model info is
   *  present in the cmdline at all. */
  model: string | null;
  /** Set when `model` is missing or not human-friendly. */
  hint: LLMHint | null;
}

/** Where a digest was seen, so the resolver can look for the
 *  manifests next to the blob (inside the owning container). */
export interface OllamaDigestContext {
  /** Full blob path from the cmdline (`.../models/blobs/sha256-<hex>`). */
  blobPath: string;
  /** Process holding the blob, when known. */
  pid?: number;
}

/** Pluggable resolvers — let the classifier translate cryptic ids
 *  (blob digests, etc.) into friendly names without doing I/O in
 *  the hot per-PID path. The collector wires these in once at
 *  startup; `classifyLLM` calls them synchronously against an
 *  in-memory cache. */
export interface LLMResolvers {
  /** Map a sha256 digest (`sha256:<hex>`) to an ollama model tag
   *  like `llama3.1:8b`. Return null when unknown. */
  ollamaModelByDigest?: (digest: string, ctx?: OllamaDigestContext) => string | null;
}

interface ModelInfo {
  model: string | null;
  hint: LLMHint | null;
}

/** Operator-defined naming rule, sent by the hub (Settings > LLM).
 *  Checked before the built-in patterns. */
export interface CustomLLMRule {
  /** Case-insensitive substring of the command line. */
  match: string;
  /** Runtime label shown in the badge. */
  runtime: string;
  /** Flag whose value names the model (`--model`), basename kept. */
  model_flag?: string;
  /** Fixed model name, used when model_flag is absent or not found. */
  model?: string;
}

let customRules: CustomLLMRule[] = [];

/** Keeps only well-formed rules (the hub validates too), max 50. */
export function sanitizeCustomRules(raw: unknown): CustomLLMRule[] {
  if (!Array.isArray(raw)) return [];
  const out: CustomLLMRule[] = [];
  for (const r of raw.slice(0, 50)) {
    const rule = r as Record<string, unknown>;
    const text = (v: unknown, max: number) => (typeof v === 'string' && v.trim() !== '' && v.length <= max ? v.trim() : undefined);
    const match = text(rule.match, 120);
    const runtime = text(rule.runtime, 40);
    if (!match || !runtime) continue;
    const flag = text(rule.model_flag, 40);
    const model = text(rule.model, 120);
    out.push({
      match,
      runtime,
      ...(flag?.startsWith('-') ? { model_flag: flag } : {}),
      ...(model ? { model } : {}),
    });
  }
  return out;
}

/** Replaces the operator rules (hub config frame). */
export function setCustomLLMRules(rules: readonly CustomLLMRule[]): void {
  customRules = sanitizeCustomRules(rules);
}

function applyCustomRule(cmd: string): LLMClassification | null {
  const lower = cmd.toLowerCase();
  const rule = customRules.find((r) => lower.includes(r.match.toLowerCase()));
  if (!rule) return null;
  const fromFlag = rule.model_flag ? modelBasename(flagValue(cmd, [rule.model_flag])) : null;
  return { runtime: rule.runtime, model: fromFlag ?? rule.model ?? null, hint: null };
}

interface Pattern {
  runtime: string;
  /** Predicate: does this command line belong to this runtime? */
  matches: (cmd: string) => boolean;
  /** Pull the model id out of the command line. May consult resolvers
   *  for cryptic-id → friendly-name lookups (blob digests). */
  model: (cmd: string, resolvers?: LLMResolvers, pid?: number) => ModelInfo;
}

const NONE: ModelInfo = { model: null, hint: null };

// ---------- model extractors ----------

/** Extract the value following `--<flag>` or `-<flag>` in a space-
 *  separated cmdline. Returns null if the flag is missing or has no
 *  value after it. */
function flagValue(cmd: string, flags: readonly string[]): string | null {
  const tokens = cmd.split(/\s+/);
  for (let i = 0; i < tokens.length - 1; i++) {
    if (flags.includes(tokens[i])) return tokens[i + 1] || null;
    // Also handle --flag=value form.
    for (const f of flags) {
      if (tokens[i].startsWith(`${f}=`)) return tokens[i].slice(f.length + 1) || null;
    }
  }
  return null;
}

/** Executable of a cmdline: the leading quoted path (Windows command
 *  lines quote paths with spaces) or the first token. */
function executable(cmd: string): string {
  const trimmed = cmd.trimStart();
  if (trimmed.startsWith('"')) {
    const end = trimmed.indexOf('"', 1);
    return end > 0 ? trimmed.slice(1, end) : trimmed.slice(1);
  }
  return trimmed.split(/\s+/, 1)[0] ?? '';
}

/** llama.cpp / llama-server / koboldcpp accept `-m <path>` or
 *  `--model <path>`. We surface the basename only so the table doesn't
 *  blow out on long absolute paths. */
function modelBasename(value: string | null): string | null {
  if (!value) return null;
  const lastSlash = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'));
  const name = lastSlash >= 0 ? value.slice(lastSlash + 1) : value;
  return name || null;
}

/** Ollama blob file name: `sha256-<hex>` (>=12 hex tolerated). */
const OLLAMA_BLOB_RE = /sha256-([0-9a-f]{12,})/i;
/** Hugging Face cache blob: bare 64-char hex file name. */
const HF_BLOB_RE = /^[0-9a-f]{64}$/i;
/** `org/repo` from a `.../models--<org>--<repo>/...` Hugging Face cache
 *  path. Plain split, no regex backtracking on long paths. */
function hfCacheRepo(path: string): string | null {
  const segment = path.split(/[\\/]/).find((s) => s.startsWith('models--'));
  const parts = segment?.slice('models--'.length).split('--') ?? [];
  return parts.length >= 2 && parts[0] && parts[1] ? `${parts[0]}/${parts.slice(1).join('--')}` : null;
}

/** Resolve an Ollama blob path. `hit` is the friendly name when the
 *  resolver knows the digest, `short` the `sha256:<prefix>` fallback.
 *  Null when the path isn't an Ollama blob. */
function ollamaBlob(
  path: string,
  resolvers: LLMResolvers | undefined,
  pid: number | undefined,
): { hit: string | null; short: string } | null {
  const m = OLLAMA_BLOB_RE.exec(path);
  if (!m) return null;
  const hit = resolvers?.ollamaModelByDigest?.(`sha256:${m[1]}`, { blobPath: path, pid }) ?? null;
  return { hit, short: `sha256:${m[1].slice(0, 12)}` };
}

// ---------- runtime patterns ----------
//
// Order matters: more specific patterns first. The classifier
// short-circuits on the first hit.

/** Ollama is identified by its executable, not by the word appearing
 *  anywhere: a standalone llama.cpp loading a blob out of Ollama's
 *  store has `ollama` in its model path but is not Ollama. Matches
 *  `ollama`, `ollama.exe`, and binaries shipped under an `ollama/`
 *  dir (`/usr/lib/ollama/llama-server`, the per-model runner). */
function isOllamaExecutable(cmd: string): boolean {
  const exe = executable(cmd);
  return /(?:^|[\\/])ollama(?:\.exe)?$/i.test(exe) || /[\\/]ollama[\\/]/i.test(exe);
}

const PATTERNS: readonly Pattern[] = [
  // Ollama — two flavours:
  //   1. The user-visible CLI: `ollama serve` / `ollama run llama3:8b`
  //   2. The internal runner the daemon spawns per loaded model:
  //      `/usr/bin/ollama runner --model <blob-path>` or the bundled
  //      `/usr/lib/ollama/llama-server --model <blob-path>`.
  // The runner is what actually holds the GPU memory, so the blob-path
  // branch is the common case.
  {
    runtime: 'ollama',
    matches: isOllamaExecutable,
    model: (cmd, resolvers, pid) => {
      const modelFlag = flagValue(cmd, ['--model', '-m']);
      if (modelFlag) {
        const blob = ollamaBlob(modelFlag, resolvers, pid);
        if (blob) return blob.hit ? { model: blob.hit, hint: null } : { model: blob.short, hint: 'ollama_manifests' };
        return { model: modelBasename(modelFlag), hint: null };
      }
      // CLI form: `ollama run <model>`. `ollama serve` names no model
      // and holds no GPU memory, so no hint either.
      const m = /\bollama(?:\.exe)?\s+(?:run|pull|show)\s+(\S+)/i.exec(cmd);
      return { model: m ? m[1] : null, hint: null };
    },
  },

  // vLLM — `vllm serve <model>` (current CLI) or the legacy
  // `python -m vllm.entrypoints.openai.api_server --model <id>`.
  {
    runtime: 'vllm',
    matches: (cmd) => /\bvllm[._]/i.test(cmd)
      || /(?:^|[\\/])vllm$/i.test(executable(cmd))
      || /\bvllm\s+serve\b/i.test(cmd),
    model: (cmd) => {
      const model = flagValue(cmd, ['--model'])
        ?? /\bvllm\s+serve\s+([^-\s]\S*)/i.exec(cmd)?.[1]
        ?? null;
      return { model, hint: model ? null : 'no_model' };
    },
  },

  // llama.cpp: `llama-server`, `llama-cli`, `llamafile`, older builds
  // named `main` / `server`, and the llama-cpp-python server
  // (`python -m llama_cpp.server`). Bare `main`/`server` need a
  // `-m xxx.gguf` to avoid catching unrelated binaries.
  {
    runtime: 'llamacpp',
    matches: (cmd) => /\b(llama-server|llama-cli|llamafile)\b/i.test(cmd)
      || (/\bllama\.cpp\b/i.test(cmd))
      || (/\bllama_cpp\.server\b/i.test(cmd))
      || (/\b(?:main|server)\b.*(?:^|\s)-m\s+\S+\.gguf\b/i.test(cmd)),
    model: llamacppModel,
  },

  // KoboldCpp — Python launcher (`koboldcpp.py --model <path>`) or the
  // bundled standalone exe (`koboldcpp_*.exe`).
  {
    runtime: 'koboldcpp',
    matches: (cmd) => /\bkoboldcpp\b/i.test(cmd),
    model: (cmd) => ({ model: modelBasename(flagValue(cmd, ['--model'])), hint: null }),
  },

  // text-generation-webui (oobabooga). Entry point is `server.py`
  // typically with `--model <name>`, sometimes `--model-dir`.
  {
    runtime: 'oobabooga',
    matches: (cmd) => /text-generation-webui/i.test(cmd)
      || /oobabooga/i.test(cmd)
      || /\bserver\.py\b.*--model\b/i.test(cmd),
    model: (cmd) => ({ model: flagValue(cmd, ['--model']), hint: null }),
  },

  // ComfyUI — `main.py` inside a ComfyUI checkout. The runtime doesn't
  // take a model flag (workflows load models on demand), so model
  // stays null.
  {
    runtime: 'comfyui',
    matches: (cmd) => /comfyui/i.test(cmd),
    model: () => NONE,
  },

  // Automatic1111 Stable Diffusion WebUI — `webui.py` or `launch.py`
  // inside a `stable-diffusion-webui` checkout. Like ComfyUI, no
  // single model flag at startup.
  {
    runtime: 'sdwebui',
    matches: (cmd) => /stable-diffusion-webui/i.test(cmd)
      || (/\bwebui\.py\b/i.test(cmd) && /\bstable[-_]diffusion\b/i.test(cmd)),
    model: () => NONE,
  },

  // LM Studio backend. Ships as `lms` CLI or as the Electron app's
  // helper process. Best-effort match — LM Studio's process tree is
  // less standardized than the others.
  {
    runtime: 'lmstudio',
    matches: (cmd) => /\blm[\s-]?studio\b/i.test(cmd) || /\blms\b.*server/i.test(cmd),
    model: (cmd) => ({ model: modelBasename(flagValue(cmd, ['--model'])), hint: null }),
  },
];

/** llama.cpp model: `-m <file>` basename first. When that file is an
 *  anonymous blob (Ollama store or Hugging Face cache), prefer in turn
 *  the resolved Ollama name, `-hf` repo, `--alias`, the HF cache repo
 *  dir, and only then the short digest with a hint. */
function llamacppModel(cmd: string, resolvers?: LLMResolvers, pid?: number): ModelInfo {
  // `python -m llama_cpp.server`: there `-m` names the Python module.
  const fileFlags = /\bllama_cpp\.server\b/i.test(cmd) ? ['--model'] : ['-m', '--model'];
  const file = flagValue(cmd, fileFlags);
  const hf = modelBasename(flagValue(cmd, ['-hf', '--hf-repo']));
  const alias = flagValue(cmd, ['-a', '--alias']);
  const base = modelBasename(file);
  if (!file || !base) {
    const model = hf ?? alias;
    return { model, hint: model ? null : 'no_model' };
  }
  const blob = ollamaBlob(file, resolvers, pid);
  if (blob?.hit) return { model: blob.hit, hint: null };
  if (!blob && !HF_BLOB_RE.test(base)) return { model: base, hint: null };
  const named = hf ?? alias;
  if (named) return { model: named, hint: null };
  const cacheRepo = hfCacheRepo(file);
  if (cacheRepo) return { model: cacheRepo, hint: null };
  if (blob) return { model: blob.short, hint: 'ollama_manifests' };
  return { model: `sha256:${base.slice(0, 12)}`, hint: 'blob' };
}

/**
 * Classify a GPU process command line into an LLM runtime + model.
 * Pure-ish — the function itself does no I/O; resolvers handle the
 * (cached) lookups. `pid` is only forwarded to the resolvers. Every
 * input maps to a valid LLMClassification object; returns the empty
 * result for null/empty input or for command lines that don't match
 * any pattern.
 */
export function classifyLLM(
  command: string | null | undefined,
  resolvers?: LLMResolvers,
  pid?: number,
): LLMClassification {
  if (!command) return { runtime: null, model: null, hint: null };
  const custom = applyCustomRule(command);
  if (custom) return custom;
  for (const p of PATTERNS) {
    if (p.matches(command)) {
      return { runtime: p.runtime, ...p.model(command, resolvers, pid) };
    }
  }
  return { runtime: null, model: null, hint: null };
}

// Exposed for the test suite.
export const __test = { PATTERNS, flagValue, executable, modelBasename };
