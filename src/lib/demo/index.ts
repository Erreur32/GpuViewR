// Demo bootstrap. Imported only when VITE_DEMO=1 at build time, so the
// real build never ships this code or its fake data.
import { installMockFetch } from './mockApi';
import { installMockWebSocket } from './mockWs';
import { isFleetDemo } from './mockFleet';

export function bootstrapDemo(): void {
  // Reads ?fleet=1 / ?fleet=0 query param and persists in localStorage,
  // so the multi-host showcase mode survives navigation. Single mode
  // is the default and is what the public live demo link opens with.
  const fleet = isFleetDemo();
  installMockFetch();
  installMockWebSocket();
  // Auto-login so the public demo skips the login screen entirely.
  // The token is purely cosmetic — the mock fetch ignores it.
  try {
    if (!localStorage.getItem('gpuviewr.token')) {
      localStorage.setItem('gpuviewr.token', 'demo.token');
      localStorage.setItem('gpuviewr.user', JSON.stringify({ id: 1, username: 'demo', role: 'admin' }));
    }
  } catch {
    /* private mode / SSR — ignore */
  }
  // Fleet demo entry — when the visitor lands on the base URL with
  // ?fleet=1, jump straight to /fleet so the multi-host UI is the
  // first thing they see. Done before React mounts so there's no flash
  // of the single-host dashboard.
  if (fleet) redirectToFleetIfAtRoot();
}

function redirectToFleetIfAtRoot(): void {
  try {
    const base = (import.meta.env.BASE_URL || '/').replace(/\/$/, '');
    const path = globalThis.location.pathname.replace(/\/$/, '');
    // Only redirect when the visitor is at the base (no explicit route).
    // Visiting /<base>/host/<id> with ?fleet=1 should NOT bounce.
    if (path === base || path === '') {
      globalThis.history.replaceState(null, '', `${base}/fleet${globalThis.location.search}${globalThis.location.hash}`);
    }
  } catch {
    /* ignore — fall back to default routing */
  }
}
