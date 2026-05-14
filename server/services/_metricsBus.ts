// Internal event bus for GPU samples, decoupled from any specific producer.
//
// Today : the only producer is the local `gpuCollector` (host_id='local').
// Tomorrow (jalon 3): the agent WS ingestor will also publish here, tagging
// each frame with the host_id resolved from the authenticated session — so
// every downstream consumer (WS broadcast, alerts, exports) sees a unified
// stream of "samples from somewhere", without caring whether the sample
// came from local nvidia-smi or a remote agent.

import { EventEmitter } from 'node:events';
import type { GpuSample } from './_nvidiaParsers.js';

export interface SampleEvent {
  host_id: string;
  samples: GpuSample[];
}

export type SampleListener = (event: SampleEvent) => void;

class MetricsBus {
  private readonly emitter = new EventEmitter();
  private readonly latestByHost = new Map<string, GpuSample[]>();

  on(event: 'sample', listener: SampleListener): this {
    this.emitter.on(event, listener);
    return this;
  }

  off(event: 'sample', listener: SampleListener): this {
    this.emitter.off(event, listener);
    return this;
  }

  emit(event: 'sample', payload: SampleEvent): boolean {
    if (event === 'sample') {
      this.latestByHost.set(payload.host_id, payload.samples);
    }
    return this.emitter.emit(event, payload);
  }

  /** Latest known samples for a given host, or [] if none seen yet. */
  getLatestByHost(host_id: string): GpuSample[] {
    return this.latestByHost.get(host_id) ?? [];
  }

  /** Read-only snapshot of every host's last frame — used by jalon 6
   *  WS broadcast to bootstrap a freshly connected UI client. */
  getAllLatest(): ReadonlyMap<string, GpuSample[]> {
    return this.latestByHost;
  }
}

export const metricsBus = new MetricsBus();
