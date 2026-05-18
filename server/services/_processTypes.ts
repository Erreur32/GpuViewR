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
}
