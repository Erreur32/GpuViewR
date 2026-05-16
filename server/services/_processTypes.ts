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
}
