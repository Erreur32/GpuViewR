// Demo bootstrap. Imported only when VITE_DEMO=1 at build time, so the
// real build never ships this code or its fake data.
import { installMockFetch } from './mockApi';
import { installMockWebSocket } from './mockWs';

export function bootstrapDemo(): void {
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
}
