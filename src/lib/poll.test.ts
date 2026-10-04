import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { pollWhileVisible } from './poll.js';

/** Minimal `document` stand-in: a hidden flag and one event type. */
function fakeDocument() {
  const listeners = new Set<() => void>();
  const doc = {
    hidden: false,
    addEventListener: (_type: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_type: string, fn: () => void) => listeners.delete(fn),
    setHidden(hidden: boolean) {
      doc.hidden = hidden;
      for (const fn of listeners) fn();
    },
    listenerCount: () => listeners.size,
  };
  (globalThis as { document?: unknown }).document = doc;
  return doc;
}

/** Let the awaited fn() and the chained setTimeout settle. */
const flush = () => new Promise<void>((r) => setImmediate(r));

test('pollWhileVisible: runs every ms while visible', async () => {
  fakeDocument();
  mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const stop = pollWhileVisible(() => { calls++; }, 1000);
  mock.timers.tick(1000); await flush();
  mock.timers.tick(1000); await flush();
  assert.equal(calls, 2);
  stop();
  mock.timers.reset();
});

test('pollWhileVisible: no calls while hidden, one right away when visible again', async () => {
  const doc = fakeDocument();
  mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const stop = pollWhileVisible(() => { calls++; }, 1000);
  doc.setHidden(true);
  mock.timers.tick(10_000); await flush();
  assert.equal(calls, 0);
  doc.setHidden(false); await flush();
  assert.equal(calls, 1);
  mock.timers.tick(1000); await flush();
  assert.equal(calls, 2);
  stop();
  mock.timers.reset();
});

test('pollWhileVisible: a throwing fn keeps the loop alive', async () => {
  fakeDocument();
  mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const stop = pollWhileVisible(() => { calls++; throw new Error('hub down'); }, 1000);
  mock.timers.tick(1000); await flush();
  mock.timers.tick(1000); await flush();
  assert.equal(calls, 2);
  stop();
  mock.timers.reset();
});

test('pollWhileVisible: cleanup stops the loop and drops the listener', async () => {
  const doc = fakeDocument();
  mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const stop = pollWhileVisible(() => { calls++; }, 1000);
  stop();
  mock.timers.tick(5000); await flush();
  doc.setHidden(true); doc.setHidden(false); await flush();
  assert.equal(calls, 0);
  assert.equal(doc.listenerCount(), 0);
  mock.timers.reset();
});
