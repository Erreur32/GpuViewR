import {
  currentGpus, fleetLlmProcesses, gpuHistory, gpuStats, healthSummary,
  hostOrLocal, hostProcesses, listHosts,
} from './readOnlyData.js';
import { readVersion } from '../utils/version.js';
import { logger } from '../utils/logger.js';

// Minimal read-only MCP server (Streamable HTTP, stateless, JSON replies).
// Only initialize, ping, tools/list and tools/call exist; every tool reads.

export const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;

type Json = Record<string, unknown>;

interface Tool {
  name: string;
  description: string;
  inputSchema: Json;
  run: (args: Json) => unknown;
}

const hostProp = { type: 'string', description: 'Host id (see list_hosts). Defaults to the local host.' };
const gpuProp = { type: 'integer', minimum: 0, description: 'GPU index on that host. Defaults to 0.' };
const rangeProp = (def: string) => ({ type: 'string', description: `Window such as 90s, 15m, 6h, 7d. Defaults to ${def}.` });

function intArg(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : fallback;
}
function strArg(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : fallback;
}

const TOOLS: Tool[] = [
  {
    name: 'get_health',
    description: 'Hub status: version, uptime, number of GPUs and hosts online/offline.',
    inputSchema: { type: 'object', properties: {} },
    run: () => healthSummary(readVersion()),
  },
  {
    name: 'list_hosts',
    description: 'Every monitored machine with its status, agent version and last seen time.',
    inputSchema: { type: 'object', properties: {} },
    run: () => ({ hosts: listHosts() }),
  },
  {
    name: 'list_gpus',
    description: 'Latest reading of every GPU (temperature, utilization, VRAM, power, fan, clocks). One host, or the whole fleet when host is omitted.',
    inputSchema: { type: 'object', properties: { host: { type: 'string', description: 'Host id; omit for all hosts.' } } },
    run: (a) => ({ gpus: currentGpus(typeof a.host === 'string' && a.host.trim() !== '' ? a.host.trim() : undefined) }),
  },
  {
    name: 'get_gpu_history',
    description: 'Time series of one GPU, downsampled to at most ~1800 points.',
    inputSchema: { type: 'object', properties: { host: hostProp, gpu: gpuProp, range: rangeProp('1h') } },
    run: (a) => gpuHistory(hostOrLocal(a.host), intArg(a.gpu, 0), strArg(a.range, '1h')),
  },
  {
    name: 'get_gpu_stats',
    description: 'Min / avg / max of one GPU over a window.',
    inputSchema: { type: 'object', properties: { host: hostProp, gpu: gpuProp, range: rangeProp('24h') } },
    run: (a) => gpuStats(hostOrLocal(a.host), intArg(a.gpu, 0), strArg(a.range, '24h')),
  },
  {
    name: 'list_processes',
    description: 'Processes using the GPUs of one host (pid, name, VRAM, LLM runtime and model when detected).',
    inputSchema: { type: 'object', properties: { host: hostProp, gpu: { ...gpuProp, description: 'Only this GPU index; omit for all.' } } },
    run: (a) => hostProcesses(hostOrLocal(a.host), typeof a.gpu === 'number' ? intArg(a.gpu, 0) : null),
  },
  {
    name: 'list_llm_processes',
    description: 'Every local LLM process in the fleet (Ollama, llama.cpp, vLLM, ...) with its model, host and GPU.',
    inputSchema: { type: 'object', properties: {} },
    run: () => ({ processes: fleetLlmProcesses() }),
  },
];

export const MCP_TOOLS = TOOLS.map(({ name, description }) => ({ name, description }));

const ok = (id: unknown, result: unknown) => ({ jsonrpc: '2.0', id, result });
const fail = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

function callTool(id: unknown, params: Json) {
  const tool = TOOLS.find((t) => t.name === params.name);
  if (!tool) return fail(id, -32602, `Unknown tool: ${String(params.name)}`);
  const args = params.arguments && typeof params.arguments === 'object' ? (params.arguments as Json) : {};
  try {
    return ok(id, { content: [{ type: 'text', text: JSON.stringify(tool.run(args)) }] });
  } catch (err) {
    // Generic text: a raw error could carry SQL or file paths.
    logger.warn('mcp', `tool ${tool.name} failed: ${(err as Error).message}`);
    return ok(id, { isError: true, content: [{ type: 'text', text: 'Tool failed, see the hub logs' }] });
  }
}

/** One JSON-RPC message in, the reply out (null for a notification). */
export function handleMcpMessage(msg: unknown): Json | null {
  if (!msg || typeof msg !== 'object' || (msg as Json).jsonrpc !== '2.0' || typeof (msg as Json).method !== 'string') {
    return fail((msg as Json | null)?.id, -32600, 'Invalid Request');
  }
  const { id, method, params } = msg as { id?: unknown; method: string; params?: Json };
  if (id === undefined) return null; // notification (notifications/initialized, ...)
  switch (method) {
    case 'initialize': {
      const asked = params?.protocolVersion;
      const protocolVersion = SUPPORTED_PROTOCOLS.find((v) => v === asked) ?? SUPPORTED_PROTOCOLS[0];
      return ok(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'gpuviewr', version: readVersion() },
        instructions: 'Read-only view of a GpuViewR GPU fleet. Start with list_hosts, then list_gpus.',
      });
    }
    case 'ping':
      return ok(id, {});
    case 'tools/list':
      return ok(id, {
        tools: TOOLS.map(({ name, description, inputSchema }) => ({
          name, description, inputSchema, annotations: { readOnlyHint: true, openWorldHint: false },
        })),
      });
    case 'tools/call':
      return callTool(id, params ?? {});
    default:
      return fail(id, -32601, `Method not found: ${method}`);
  }
}
