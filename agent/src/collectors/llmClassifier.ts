// LLM runtime / model classifier. Pure function — no I/O. Takes a
// process command line (full /proc/<pid>/cmdline with NULs as spaces)
// and returns the runtime it belongs to plus the model name when
// extractable from the command line itself.
//
// Designed to be cheap (regex-only) and additive — never throws,
// always returns an object with nullable fields. The agent feeds this
// to every GPU process it sees; processes that don't match any runtime
// get `{ runtime: null, model: null }` and the UI renders nothing
// extra.
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
// comment for what we look at. For Ollama specifically, models live in
// content-addressed blob files; the raw cmdline gives us the sha256
// hash, not the friendly model name. We surface the hash truncated to
// 12 chars as a placeholder; resolving it to "llama3.1:8b" would
// require reading the host's `~/.ollama/manifests/` tree, which we
// don't currently have access to from the agent container.

export interface LLMClassification {
  /** Detected runtime ('ollama', 'llamacpp', 'vllm', etc.) or null
   *  if the command line doesn't match any known LLM stack. */
  runtime: string | null;
  /** Best-effort model identifier. For most runtimes this is the
   *  value of the `--model` / `-m` flag (typically a file path or
   *  HF-style id). For Ollama, the resolver tries to translate the
   *  blob's sha256 digest to a friendly name (`llama3.1:8b`) by
   *  reading the ollama manifests dir — see ollamaManifests.ts.
   *  Falls back to `sha256:<prefix>` when no resolver is wired or
   *  the digest isn't in any indexed manifest. Null when no model
   *  info is present in the cmdline at all. */
  model: string | null;
}

/** Pluggable resolvers — let the classifier translate cryptic ids
 *  (blob digests, etc.) into friendly names without doing I/O in
 *  the hot per-PID path. The collector wires these in once at
 *  startup; `classifyLLM` calls them synchronously against an
 *  in-memory cache. */
export interface LLMResolvers {
  /** Map a sha256 digest (`sha256:<hex>`) to an ollama model tag
   *  like `llama3.1:8b`. Return null when unknown. */
  ollamaModelByDigest?: (digest: string) => string | null;
}

interface Pattern {
  runtime: string;
  /** Predicate: does this command line belong to this runtime? */
  matches: (cmd: string) => boolean;
  /** Pull the model id out of the command line. Returns null when
   *  no model is named (e.g. `ollama serve` with no model argument).
   *  May consult resolvers for cryptic-id → friendly-name lookups
   *  (Ollama blob digests today). */
  model: (cmd: string, resolvers?: LLMResolvers) => string | null;
}

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

/** Ollama models live at `.../models/blobs/sha256-<hex>`. The cmdline
 *  contains the path; we extract the FULL digest (for the resolver
 *  lookup) and return either the resolved friendly name when known,
 *  or the truncated `sha256:<prefix>` form as a fallback. */
function ollamaModelFromBlobPath(path: string, resolvers?: LLMResolvers): string | null {
  // Match the full sha256 hex run (>=12 chars; ollama uses 64-char
  // hex but we tolerate truncations seen in some logs).
  const m = /sha256-([0-9a-f]{12,})/i.exec(path);
  if (!m) return null;
  const fullDigest = `sha256:${m[1]}`;
  const resolved = resolvers?.ollamaModelByDigest?.(fullDigest);
  if (resolved) return resolved;
  return `sha256:${m[1].slice(0, 12)}`;
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

// ---------- runtime patterns ----------
//
// Order matters: more specific patterns first. The classifier
// short-circuits on the first hit so e.g. `python -m vllm.something`
// is caught by the vllm branch before the generic python fallback
// (we currently have no generic python branch — kept for future).

const PATTERNS: readonly Pattern[] = [
  // Ollama — two flavours:
  //   1. The user-visible CLI: `ollama serve` / `ollama run llama3:8b`
  //   2. The internal runner the daemon spawns per loaded model:
  //      `/usr/bin/ollama runner --ollama-engine --model <blob-path>`
  // The runner is what actually holds the GPU memory and shows up in
  // nvidia-smi / rocm-smi, so the blob-path branch is the common case.
  {
    runtime: 'ollama',
    matches: (cmd) => /\bollama\b/i.test(cmd),
    model: (cmd, resolvers) => {
      // Runner form first — blob path with sha256.
      const modelFlag = flagValue(cmd, ['--model', '-m']);
      if (modelFlag) {
        const fromBlob = ollamaModelFromBlobPath(modelFlag, resolvers);
        if (fromBlob) return fromBlob;
        return modelBasename(modelFlag);
      }
      // CLI form: `ollama run <model>` — the model is the second token
      // after the binary.
      const m = /\bollama\s+(?:run|pull|show)\s+(\S+)/i.exec(cmd);
      return m ? m[1] : null;
    },
  },

  // vLLM — typically launched as `python -m vllm.entrypoints.openai.api_server
  // --model meta-llama/Llama-3-8B-Instruct ...`
  {
    runtime: 'vllm',
    matches: (cmd) => /\bvllm[._]/i.test(cmd) || /\bvllm\b.*--model\b/i.test(cmd),
    model: (cmd) => flagValue(cmd, ['--model']),
  },

  // llama.cpp / llama-server. The official binary names are
  // `llama-server`, `llama-cli`, `main`, `server` (older builds), and
  // `llama-bench`. We match on the binary name plus an `-m` or
  // `--model` flag to avoid catching unrelated `main` binaries.
  {
    runtime: 'llamacpp',
    matches: (cmd) => /\b(llama-server|llama-cli|llamafile)\b/i.test(cmd)
      || (/\bllama\.cpp\b/i.test(cmd))
      || (/\b(?:main|server)\b.*(?:^|\s)-m\s+\S+\.gguf\b/i.test(cmd)),
    model: (cmd) => modelBasename(flagValue(cmd, ['-m', '--model'])),
  },

  // KoboldCpp — Python launcher (`koboldcpp.py --model <path>`) or the
  // bundled standalone exe (`koboldcpp_*.exe`).
  {
    runtime: 'koboldcpp',
    matches: (cmd) => /\bkoboldcpp\b/i.test(cmd),
    model: (cmd) => modelBasename(flagValue(cmd, ['--model'])),
  },

  // text-generation-webui (oobabooga). Entry point is `server.py`
  // typically with `--model <name>`, sometimes `--model-dir`.
  {
    runtime: 'oobabooga',
    matches: (cmd) => /text-generation-webui/i.test(cmd)
      || /oobabooga/i.test(cmd)
      || /\bserver\.py\b.*--model\b/i.test(cmd),
    model: (cmd) => flagValue(cmd, ['--model']),
  },

  // ComfyUI — `main.py` inside a ComfyUI checkout. The runtime doesn't
  // take a model flag (workflows load models on demand), so model
  // stays null.
  {
    runtime: 'comfyui',
    matches: (cmd) => /comfyui/i.test(cmd),
    model: () => null,
  },

  // Automatic1111 Stable Diffusion WebUI — `webui.py` or `launch.py`
  // inside a `stable-diffusion-webui` checkout. Like ComfyUI, no
  // single model flag at startup.
  {
    runtime: 'sdwebui',
    matches: (cmd) => /stable-diffusion-webui/i.test(cmd)
      || (/\bwebui\.py\b/i.test(cmd) && /\bstable[-_]diffusion\b/i.test(cmd)),
    model: () => null,
  },

  // LM Studio backend. Ships as `lms` CLI or as the Electron app's
  // helper process. Best-effort match — LM Studio's process tree is
  // less standardized than the others.
  {
    runtime: 'lmstudio',
    matches: (cmd) => /\blm[\s-]?studio\b/i.test(cmd) || /\blms\b.*server/i.test(cmd),
    model: (cmd) => modelBasename(flagValue(cmd, ['--model'])),
  },
];

/**
 * Classify a GPU process command line into an LLM runtime + model.
 * Pure-ish — the function itself does no I/O; resolvers handle the
 * (cached) lookups. Every input maps to a valid LLMClassification
 * object; returns the empty result for null/empty input or for
 * command lines that don't match any pattern.
 */
export function classifyLLM(command: string | null | undefined, resolvers?: LLMResolvers): LLMClassification {
  if (!command) return { runtime: null, model: null };
  for (const p of PATTERNS) {
    if (p.matches(command)) {
      return { runtime: p.runtime, model: p.model(command, resolvers) };
    }
  }
  return { runtime: null, model: null };
}

// Exposed for the test suite.
export const __test = { PATTERNS, flagValue, ollamaModelFromBlobPath, modelBasename };
