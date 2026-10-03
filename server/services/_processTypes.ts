// Shared process type used by the WS ingest path (agentIngestWS,
// agentProcessStore) and the /api/processes route. Previously lived
// in server/services/processCollector.ts; moved here when the hub
// stopped owning a local process collector (v0.5.0).

export type GpuProcessType = 'C' | 'G' | 'G+C' | null;

export interface GpuProcess {
  pid: number;
  process_name: string;
  gpu_uuid: string;
  used_memory: number; // MiB
  type: GpuProcessType;
  command: string | null;
  cpu_pct: number | null;
  gpu_pct: number | null;
  // LLM-aware classification (v0.7.3+). Both fields are populated by
  // the agent on a best-effort basis from the process command line —
  // see agent/src/collectors/llmClassifier.ts. The hub passes them
  // through unchanged; the UI renders a small runtime badge + model
  // tooltip when present.
  llm_runtime?: string | null;   // 'ollama' | 'llamacpp' | 'vllm' | …
  llm_model?: string | null;     // best-effort model id (path basename or sha256:prefix)
  llm_hint?: 'ollama_manifests' | 'blob' | 'no_model' | null; // why llm_model isn't friendly
  // v0.11.0, from the agent: model state reported by the LLM server
  // itself ('idle' = llama.cpp asleep), Ollama unload time, system memory
  // mapped to the GPU (AMD APUs, Intel iGPUs) and the container id.
  llm_state?: 'loaded' | 'idle' | null;
  llm_expires_at?: number | null;     // epoch seconds
  gtt_memory?: number | null;         // MiB
  container_engine?: string | null;   // 'docker' | 'podman' | 'containerd' | 'k8s'
  container_id?: string | null;       // 12 hex chars
}

/** Agent-reported process visibility (AMD fdinfo scan). See
 *  agent/src/collectors/processes.ts ProcessVisibility. */
export interface ProcessVisibility {
  denied_pids: number;
  has_ptrace: boolean;
  install_mode: string;
}
