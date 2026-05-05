// Drop-in WebSocket replacement for the demo build. Mirrors enough of the
// real API surface (open/close/onmessage/readyState) for `useGpuStream` to
// work unchanged, but emits synthetic samples instead of opening a socket.
import { liveSamples } from './mockApi';

const TICK_MS = 1000;

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly url: string;
  readyState = MockWebSocket.CONNECTING;
  binaryType: BinaryType = 'blob';
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;

  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(url: string) {
    this.url = url;
    queueMicrotask(() => this.boot());
  }

  private boot() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.(new Event('open'));
    this.emit('snapshot');
    this.timer = setInterval(() => this.emit('sample'), TICK_MS);
  }

  private emit(type: 'snapshot' | 'sample') {
    if (this.readyState !== MockWebSocket.OPEN) return;
    const samples = liveSamples();
    const ev = new MessageEvent('message', {
      data: JSON.stringify({ type, samples }),
    });
    this.onmessage?.(ev);
  }

  send() { /* no-op in demo */ }

  close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.(new CloseEvent('close'));
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    const fn = typeof listener === 'function' ? listener : listener.handleEvent.bind(listener);
    if (type === 'open') this.onopen = fn as (ev: Event) => void;
    else if (type === 'message') this.onmessage = fn as (ev: MessageEvent) => void;
    else if (type === 'close') this.onclose = fn as (ev: CloseEvent) => void;
    else if (type === 'error') this.onerror = fn as (ev: Event) => void;
  }

  removeEventListener() { /* no-op */ }
}

export function installMockWebSocket(): void {
  (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket =
    MockWebSocket as unknown as typeof WebSocket;
}
