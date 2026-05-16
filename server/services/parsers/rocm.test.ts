import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mapRocmCardToSample,
  mapRocmInfoToSamples,
  parseRocmClock,
  parseRocmInfo,
  parseRocmPids,
  rocmDeviceName,
  rocmUuidFromBus,
} from './rocm.js';

// Real dumps captured on a Strix Halo / Radeon 8060S box (Jarvis,
// gfx1151). Pasted verbatim so any regression in rocm-smi's JSON shape
// surfaces here instead of in production.
const FIXTURE_INFO_FULL = JSON.stringify({
  card0: {
    'Device Name': 'N/A',
    'Device ID': '0x1586',
    'Device Rev': '0xc1',
    'GUID': '64506',
    'Unique ID': '0x0',
    'VBIOS version': '113-STRXLGEN-001',
    'Temperature (Sensor edge) (C)': '27.0',
    'sclk clock speed:': '(605Mhz)',
    'sclk clock level:': '1',
    'Performance Level': 'auto',
    'Current Socket Graphics Package Power (W)': '4.041',
    'GPU use (%)': '0',
    'GPU Memory Allocated (VRAM%)': '0',
    'Memory Activity': 'N/A',
    'PCI Bus': '0000:C5:00.0',
    'Card Series': 'N/A',
    'Card Model': '0x1586',
    'Card Vendor': 'Advanced Micro Devices, Inc. [AMD/ATI]',
    'Card SKU': 'STRXLGEN',
    'GFX Version': 'gfx1151',
    'VRAM Total Memory (B)': '51539607552',
    'VRAM Total Used Memory (B)': '163110912',
    'GTT Total Memory (B)': '38654705664',
    'GTT Total Used Memory (B)': '14757888',
  },
  system: { 'Driver version': '6.12.88+deb13-amd64' },
});

const FIXTURE_INFO_EMPTY_CARD = JSON.stringify({
  card0: {},
  system: { 'Driver version': '6.12.88+deb13-amd64' },
});

test('rocmDeviceName: known device id wins over gfx fallback', () => {
  assert.equal(rocmDeviceName('0x1586', 'gfx1151'), 'AMD Radeon 8060S (Strix Halo)');
});

test('rocmDeviceName: unknown device id falls back to gfx version', () => {
  assert.equal(rocmDeviceName('0xdead', 'gfx1100'), 'AMD GPU (gfx1100)');
});

test('rocmDeviceName: no info at all → generic', () => {
  assert.equal(rocmDeviceName(undefined, undefined), 'AMD GPU');
});

test('rocmUuidFromBus: normalizes to filesystem-safe identifier', () => {
  assert.equal(rocmUuidFromBus('0000:C5:00.0'), 'ROCm-0000_c5_00_0');
});

test('rocmUuidFromBus: undefined → stable sentinel', () => {
  assert.equal(rocmUuidFromBus(undefined), 'ROCm-unknown');
});

test('parseRocmClock: parens + Mhz suffix', () => {
  assert.equal(parseRocmClock('(605Mhz)'), 605);
});

test('parseRocmClock: bare number with MHz also works', () => {
  assert.equal(parseRocmClock('1500 MHz'), 1500);
});

test('parseRocmClock: garbage/N/A → null', () => {
  assert.equal(parseRocmClock('N/A'), null);
  assert.equal(parseRocmClock(undefined), null);
});

test('parseRocmInfo: extracts card + driver, ignores unknown keys', () => {
  const info = parseRocmInfo(FIXTURE_INFO_FULL);
  assert.equal(info.cards.length, 1);
  assert.equal(info.cards[0].index, 0);
  assert.equal(info.driverVersion, '6.12.88+deb13-amd64');
});

test('parseRocmInfo: malformed JSON → empty result, no throw', () => {
  const info = parseRocmInfo('not json {{{');
  assert.deepEqual(info, { cards: [], driverVersion: null });
});

test('parseRocmInfo: empty input → empty result', () => {
  assert.deepEqual(parseRocmInfo(''), { cards: [], driverVersion: null });
});

test('mapRocmCardToSample: converts bytes to MiB, parses clocks', () => {
  const info = parseRocmInfo(FIXTURE_INFO_FULL);
  const sample = mapRocmCardToSample(info.cards[0], info.driverVersion);

  assert.equal(sample.gpu_index, 0);
  assert.equal(sample.name, 'AMD Radeon 8060S (Strix Halo)');
  assert.equal(sample.uuid, 'ROCm-0000_c5_00_0');
  assert.equal(sample.driver_version, '6.12.88+deb13-amd64');
  assert.equal(sample.temperature, 27.0);
  assert.equal(sample.utilization, 0);
  assert.equal(sample.memory_total, 49152); // 48 GiB → MiB
  assert.equal(sample.memory_used, 155);    // 163_110_912 / 1_048_576
  assert.equal(sample.power, 4.041);
  assert.equal(sample.clock_graphics, 605);
  assert.equal(sample.clock_memory, null);  // no mclk on APU
  assert.equal(sample.pci_bus_id, '0000:C5:00.0');
  assert.equal(sample.fan_speed, null);
  assert.equal(sample.pcie_gen_current, null);
  assert.equal(sample.pcie_rx_kbps, null);
});

test('mapRocmCardToSample: empty card defaults are sane (no NaN)', () => {
  const info = parseRocmInfo(FIXTURE_INFO_EMPTY_CARD);
  const sample = mapRocmCardToSample(info.cards[0], info.driverVersion);
  // The schema treats temperature and power as non-null numbers,
  // so missing fields must coalesce to 0, not NaN.
  assert.equal(sample.temperature, 0);
  assert.equal(sample.power, 0);
  assert.equal(sample.memory_used, 0);
  assert.equal(sample.memory_total, null);
  assert.equal(sample.utilization, null);
});

test('mapRocmInfoToSamples: handles multi-card sort by index', () => {
  const raw = JSON.stringify({
    card1: { 'PCI Bus': '0000:01:00.0', 'Device ID': '0x744c', 'GFX Version': 'gfx1100' },
    card0: { 'PCI Bus': '0000:00:00.0', 'Device ID': '0x1586', 'GFX Version': 'gfx1151' },
    system: { 'Driver version': '1.2.3' },
  });
  const info = parseRocmInfo(raw);
  const samples = mapRocmInfoToSamples(info);
  assert.equal(samples.length, 2);
  assert.equal(samples[0].gpu_index, 0);
  assert.equal(samples[0].name, 'AMD Radeon 8060S (Strix Halo)');
  assert.equal(samples[1].gpu_index, 1);
  assert.equal(samples[1].name, 'AMD Radeon RX 7900 series');
});

test('parseRocmPids: the real Jarvis dump (two hold-host processes)', () => {
  const raw = JSON.stringify({
    system: {
      PID7050: 'hold-host, 1, 415301632, 0, unknown',
      PID7049: 'hold-host, 1, 415301632, 0, unknown',
    },
  });
  const procs = parseRocmPids(raw);
  // Insertion order from rocm-smi is not guaranteed (PID7050 came
  // before PID7049 in the real dump). Sort before asserting.
  procs.sort((a, b) => a.pid - b.pid);
  assert.equal(procs.length, 2);
  assert.equal(procs[0].pid, 7049);
  assert.equal(procs[0].process_name, 'hold-host');
  assert.equal(procs[0].gpu_count, 1);
  assert.equal(procs[0].vram_used_bytes, 415301632);
  assert.equal(procs[0].sdma_used_bytes, 0);
  assert.equal(procs[0].cu_occupancy, null);
});

test('parseRocmPids: UNKNOWN (uppercase) also coerces to null', () => {
  const raw = JSON.stringify({ system: { PID42: 'foo, 1, 1024, 0, UNKNOWN' } });
  const [proc] = parseRocmPids(raw);
  assert.equal(proc.cu_occupancy, null);
});

test('parseRocmPids: numeric CU occupancy is preserved', () => {
  const raw = JSON.stringify({ system: { PID42: 'foo, 1, 1024, 0, 73' } });
  const [proc] = parseRocmPids(raw);
  assert.equal(proc.cu_occupancy, 73);
});

test('parseRocmPids: empty stdout (no GPU procs) → empty array', () => {
  assert.deepEqual(parseRocmPids(''), []);
  assert.deepEqual(parseRocmPids('   '), []);
});

test('parseRocmPids: malformed JSON → empty array, no throw', () => {
  assert.deepEqual(parseRocmPids('{ not json'), []);
});

test('parseRocmPids: ignores keys that are not PID<n>', () => {
  const raw = JSON.stringify({
    system: {
      PID7049: 'foo, 1, 1024, 0, unknown',
      garbage: 'ignored',
      'PID-bad': 'ignored too',
    },
  });
  const procs = parseRocmPids(raw);
  assert.equal(procs.length, 1);
  assert.equal(procs[0].pid, 7049);
});

test('parseRocmPids: process name with trailing whitespace gets trimmed', () => {
  const raw = JSON.stringify({ system: { PID1: 'hold-host    , 1, 1024, 0, unknown' } });
  const [proc] = parseRocmPids(raw);
  assert.equal(proc.process_name, 'hold-host');
});
