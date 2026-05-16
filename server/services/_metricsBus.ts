// Internal event bus for GPU samples, decoupled from any specific producer.
//
// Today : the only producer is the local `gpuCollector` (host_id='local').
// Tomorrow (jalon 3): the agent WS ingestor will also publish here, tagging
// each frame with the host_id resolved from the authenticated session — so
// every downstream consumer (WS broadcast, alerts, exports) sees a unified
// stream of "samples from somewhere", without caring whether the sample
// came from local nvidia-smi or a remote agent.

import { EventEmitter } from 'node:events';
import type { GpuSample } from './parsers/nvidia.js';

export interface SampleEvent {
  host_id: string;
  samples: GpuSample[];
}

export interface HostStatusEvent {
  host_id: string;
  status: 'online' | 'lagging' | 'offline' | 'disabled' | 'pending';
  last_seen: number | null;
}

export type SampleListener = (event: SampleEvent) => void;
export type HostStatusListener = (event: HostStatusEvent) => void;

class MetricsBus {
  private readonly emitter = new EventEmitter();
  private readonly latestByHost = new Map<string, GpuSample[]>();

  on(event: 'sample', listener: SampleListener): this;
  on(event: 'host_status', listener: HostStatusListener): this;
  on(event: 'sample' | 'host_status', listener: SampleListener | HostStatusListener): this {
    this.emitter.on(event, listener);
    return this;
  }

  off(event: 'sample', listener: SampleListener): this;
  off(event: 'host_status', listener: HostStatusListener): this;
  off(event: 'sample' | 'host_status', listener: SampleListener | HostStatusListener): this {
    this.emitter.off(event, listener);
    return this;
  }

  emit(event: 'sample', payload: SampleEvent): boolean;
  emit(event: 'host_status', payload: HostStatusEvent): boolean;
  emit(event: 'sample' | 'host_status', payload: SampleEvent | HostStatusEvent): boolean {
    if (event === 'sample') {
      const e = payload as SampleEvent;
      this.latestByHost.set(e.host_id, e.samples);
    }
    return this.emitter.emit(event, payload);
  }

  /** Latest known samples for a given host, or [] if none seen yet. */
  getLatestByHost(host_id: string): GpuSample[] {
    return this.latestByHost.get(host_id) ?? [];
  }

  /** Read-only snapshot of every host's last frame — used by the v0.3.1
   *  fleet view to bootstrap a freshly connected UI client. */
  getAllLatest(): ReadonlyMap<string, GpuSample[]> {
    return this.latestByHost;
  }
}

export const metricsBus = new MetricsBus();
