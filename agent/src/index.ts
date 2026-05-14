// Agent bootstrap. Six lines of "real" lifecycle code; the rest is
// scaffolding for graceful shutdown and the MOCK_GPU dev path.

import { loadConfig } from './config.js';
import { logger } from './logger.js';
import { createTransport } from './transport.js';
import { createGpuCollector } from './collectors/gpu.js';
import { buildMockSamples } from './mock.js';

const config = loadConfig();

logger.info('boot', `gpuviewr-agent starting (host_id=${config.hostId}, label=${config.agentLabel ?? '(none)'})`);
logger.info('boot', `Hub URL: ${config.hubUrl}`);
logger.info('boot', `Features: ${JSON.stringify(config.features)}`);
if (config.mockGpu) logger.warn('boot', 'MOCK_GPU=1 — synthetic GPU samples, no nvidia-smi spawn');

const transport = createTransport(config);
transport.start();

let mockTimer: NodeJS.Timeout | null = null;
let gpuHandle: ReturnType<typeof createGpuCollector> | null = null;

if (config.features.gpu) {
  if (config.mockGpu) {
    const emit = () => transport.enqueueSample(buildMockSamples());
    emit();
    mockTimer = setInterval(emit, config.tickMs);
  } else {
    gpuHandle = createGpuCollector({
      nvidiaSmiPath: config.nvidiaSmiPath,
      tickMs: config.tickMs,
      onSample: (samples) => transport.enqueueSample(samples),
    });
    if (!gpuHandle.available()) {
      logger.error('boot', `nvidia-smi not found at ${config.nvidiaSmiPath} — exiting (set MOCK_GPU=1 for dev)`);
      process.exit(1);
    }
    gpuHandle.start();
  }
}

// system/temps/processes collectors are reserved for jalon 5+;
// today the agent only ships GPU samples (the headline feature).
// Other capabilities are negotiated in the hello frame so the hub
// knows what to expect.

function shutdown(signal: string): void {
  logger.info('boot', `Received ${signal}, shutting down...`);
  if (mockTimer) clearInterval(mockTimer);
  gpuHandle?.stop();
  transport.stop();
  // Give the WS close() a moment to flush.
  setTimeout(() => process.exit(0), 200).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
