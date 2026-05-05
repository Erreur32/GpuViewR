import { useEffect, useRef } from 'react';
import { useAuthStore } from '../store/authStore';
import { useGpuStore, type GpuSample } from '../store/gpuStore';
import { useUiStore } from '../store/uiStore';
import { notify } from '../store/toastStore';

interface AlertWsEvent {
  id: number;
  rule_name: string;
  gpu_index: number;
  metric: string;
  threshold: number;
  observed: number;
  state: 'firing' | 'resolved';
  message: string;
  triggered_at: number;
}

interface WsPayload {
  type: 'snapshot' | 'sample' | 'alert';
  samples?: GpuSample[];
  event?: AlertWsEvent;
  notify_browser?: boolean;
  notify_sound?: boolean;
}

const ASSET_BASE = import.meta.env.BASE_URL;

let alertSound: HTMLAudioElement | null = null;
function playAlertSound() {
  try {
    if (!alertSound) {
      alertSound = new Audio(`${ASSET_BASE}alert.mp3`);
      alertSound.volume = 0.45;
    }
    alertSound.currentTime = 0;
    void alertSound.play();
  } catch {
    /* ignore */
  }
}

function maybeNotifyBrowser(title: string, body: string) {
  if (typeof Notification === 'undefined') return;
  if (Notification.permission === 'granted') {
    try { new Notification(title, { body, icon: `${ASSET_BASE}GPUViewR.png` }); } catch { /* ignore */ }
  }
}

export function useGpuStream(): void {
  const token = useAuthStore((s) => s.token);
  const ingest = useGpuStore((s) => s.ingest);
  const setConnected = useGpuStore((s) => s.setConnected);
  const soundEnabled = useUiStore((s) => s.soundEnabled);
  const wsRef = useRef<WebSocket | null>(null);
  const retryRef = useRef<number>(0);

  useEffect(() => {
    if (!token) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (stopped) return;
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const url = `${proto}://${window.location.host}/ws/gpu?token=${encodeURIComponent(token)}`;
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => { retryRef.current = 0; setConnected(true); };
      ws.onmessage = (ev) => {
        try {
          const payload = JSON.parse(String(ev.data)) as WsPayload;
          if ((payload.type === 'snapshot' || payload.type === 'sample') && payload.samples?.length) {
            ingest(payload.samples);
          } else if (payload.type === 'alert' && payload.event) {
            const e = payload.event;
            const kind = e.state === 'firing' ? 'warn' : 'success';
            notify(kind, `${e.rule_name} · GPU #${e.gpu_index}`, e.message);
            if (payload.notify_browser) maybeNotifyBrowser(e.rule_name, e.message);
            if (payload.notify_sound && soundEnabled && e.state === 'firing') playAlertSound();
          }
        } catch {
          /* ignore malformed messages */
        }
      };
      ws.onclose = () => {
        setConnected(false);
        if (stopped) return;
        const delay = Math.min(1000 * 2 ** retryRef.current, 15_000);
        retryRef.current++;
        timer = setTimeout(connect, delay);
      };
      ws.onerror = () => ws.close();
    };
    connect();

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      wsRef.current?.close();
      setConnected(false);
    };
  }, [token, ingest, setConnected, soundEnabled]);
}
