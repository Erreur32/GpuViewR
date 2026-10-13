// Listening port and alias of an LLM server, read from the command line the
// agent already reports. Lets an API client tie a model to the llama.cpp or
// Ollama service it knows by port. Hub-side so it works with older agents.

/** Documented default port of each runtime, used when the flag is absent. */
const DEFAULT_PORTS: Record<string, number> = {
  ollama: 11434,
  llamacpp: 8080,
  vllm: 8000,
  koboldcpp: 5001,
  oobabooga: 7860,
  comfyui: 8188,
  sdwebui: 7860,
  lmstudio: 1234,
};

export interface LlmServerInfo {
  llm_port: number | null;
  /** 'cmdline' = `--port` on the command line, 'default' = runtime default. */
  llm_port_source: 'cmdline' | 'default' | null;
  llm_alias: string | null;
}

/** Value after `<flag>` or in `<flag>=value`, from a space-split cmdline. */
function flagValue(tokens: readonly string[], flags: readonly string[]): string | null {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (flags.includes(t)) return tokens[i + 1] || null;
    const f = flags.find((name) => t.startsWith(`${name}=`));
    if (f) return t.slice(f.length + 1) || null;
  }
  return null;
}

function cleanAlias(v: string | null): string | null {
  if (!v) return null;
  const s = v.replace(/^["']|["']$/g, '');
  return s && s.length <= 200 ? s : null;
}

export function llmServerInfo(runtime: string | null | undefined, command: string | null | undefined): LlmServerInfo {
  if (!runtime) return { llm_port: null, llm_port_source: null, llm_alias: null };
  const tokens = (command ?? '').split(/\s+/).filter(Boolean);
  // Ollama's runner gets a random internal `--port`; the API port is the
  // daemon's (OLLAMA_HOST), never on the runner's command line.
  const raw = runtime === 'ollama' ? null : flagValue(tokens, ['--port']);
  const parsed = raw && /^\d{1,5}$/.test(raw) ? Number.parseInt(raw, 10) : null;
  const alias = cleanAlias(
    (runtime === 'llamacpp' ? flagValue(tokens, ['-a', '--alias']) : null)
    ?? flagValue(tokens, ['--served-model-name']),
  );
  if (parsed && parsed < 65536) return { llm_port: parsed, llm_port_source: 'cmdline', llm_alias: alias };
  // `python -m llama_cpp.server` is classified llamacpp but listens on 8000.
  const fallback = runtime === 'llamacpp' && /\bllama_cpp\.server\b/.test(command ?? '') ? 8000 : DEFAULT_PORTS[runtime];
  return fallback
    ? { llm_port: fallback, llm_port_source: 'default', llm_alias: alias }
    : { llm_port: null, llm_port_source: null, llm_alias: alias };
}
