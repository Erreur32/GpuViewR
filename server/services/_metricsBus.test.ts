import { test } from 'node:test';
import assert from 'node:assert/strict';
import { metricsBus, type SampleEvent } from './_metricsBus.js';
import type { GpuSample } from './_nvidiaParsers.js';

function makeSample(idx: number): GpuSample {
  return {
    gpu_index: idx,
    name: 'Test GPU',
    uuid: null,
    driver_version: null,
    temperature: 60,
    utilization: 50,
    memory_used: 1024,
    memory_total: 8192,
    power: 100,
    fan_speed: null,
    clock_graphics: null,
    clock_memory: null,
    pci_bus_id: null,
    pcie_gen_current: null,
    pcie_gen_max: null,
    pcie_width_current: null,
    pcie_width_max: null,
    pcie_rx_kbps: null,
    pcie_tx_kbps: null,
    timestamp: '2026-01-01 00:00:00',
    timestamp_epoch: 1735689600,
  };
}

test('metricsBus: emit/on round-trip carries host_id and samples', () => {
  const received: SampleEvent[] = [];
  const listener = (e: SampleEvent) => received.push(e);
  metricsBus.on('sample', listener);
  try {
    metricsBus.emit('sample', { host_id: 'unit-test', samples: [makeSample(0)] });
    assert.equal(received.length, 1);
    assert.equal(received[0].host_id, 'unit-test');
    assert.equal(received[0].samples.length, 1);
    assert.equal(received[0].samples[0].gpu_index, 0);
  } finally {
    metricsBus.off('sample', listener);
  }
});

test('metricsBus: off() prevents subsequent delivery', () => {
  const received: SampleEvent[] = [];
  const listener = (e: SampleEvent) => received.push(e);
  metricsBus.on('sample', listener);
  metricsBus.off('sample', listener);
  metricsBus.emit('sample', { host_id: 'unit-test', samples: [makeSample(0)] });
  assert.equal(received.length, 0);
});

test('metricsBus: getLatestByHost reflects last emit for that host', () => {
  metricsBus.emit('sample', { host_id: 'host-A', samples: [makeSample(0), makeSample(1)] });
  metricsBus.emit('sample', { host_id: 'host-B', samples: [makeSample(7)] });

  const a = metricsBus.getLatestByHost('host-A');
  const b = metricsBus.getLatestByHost('host-B');
  const unknown = metricsBus.getLatestByHost('does-not-exist');

  assert.equal(a.length, 2);
  assert.deepEqual(a.map((s) => s.gpu_index), [0, 1]);
  assert.equal(b.length, 1);
  assert.equal(b[0].gpu_index, 7);
  assert.deepEqual(unknown, []);
});

test('metricsBus: multiple listeners receive each event independently', () => {
  const receivedA: SampleEvent[] = [];
  const receivedB: SampleEvent[] = [];
  const a = (e: SampleEvent) => receivedA.push(e);
  const b = (e: SampleEvent) => receivedB.push(e);
  metricsBus.on('sample', a);
  metricsBus.on('sample', b);
  try {
    metricsBus.emit('sample', { host_id: 'multi', samples: [makeSample(0)] });
    assert.equal(receivedA.length, 1);
    assert.equal(receivedB.length, 1);
  } finally {
    metricsBus.off('sample', a);
    metricsBus.off('sample', b);
  }
});
