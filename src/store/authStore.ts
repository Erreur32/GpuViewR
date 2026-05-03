import { create } from 'zustand';
import { api } from '../lib/api';

export interface AuthUser {
  id: number;
  username: string;
  role: 'admin' | 'user';
}

interface AuthState {
  token: string | null;
  user: AuthUser | null;
  hasUsers: boolean;
  loading: boolean;
  error: string | null;

  hydrate: () => void;
  fetchStatus: () => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, password: string) => Promise<void>;
  logout: () => void;
}

// Read auth from localStorage synchronously so the very first render
// already knows whether the user is logged in. Without this the auth
// gate flashes <Navigate to="/login"> before hydrate() completes, which
// loses the original target route on a hard refresh of /settings, /alerts…
const isBrowser = typeof globalThis.window === 'object';
const initialToken = isBrowser ? localStorage.getItem('gpuviewr.token') : null;
const initialUserRaw = isBrowser ? localStorage.getItem('gpuviewr.user') : null;

export const useAuthStore = create<AuthState>((set, get) => ({
  token: initialToken,
  user: initialUserRaw ? (JSON.parse(initialUserRaw) as AuthUser) : null,
  hasUsers: true,
  loading: false,
  error: null,

  hydrate: () => {
    const token = localStorage.getItem('gpuviewr.token');
    const userRaw = localStorage.getItem('gpuviewr.user');
    if (token) set({ token, user: userRaw ? JSON.parse(userRaw) : null });
  },

  fetchStatus: async () => {
    try {
      const r = await api<{ hasUsers: boolean }>('/auth/status');
      set({ hasUsers: r.hasUsers });
    } catch {
      // ignore: if API unreachable the login page will surface it
    }
  },

  login: async (username, password) => {
    set({ loading: true, error: null });
    try {
      const r = await api<{ token: string; user: AuthUser }>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      });
      localStorage.setItem('gpuviewr.token', r.token);
      localStorage.setItem('gpuviewr.user', JSON.stringify(r.user));
      set({ token: r.token, user: r.user, loading: false });
    } catch (err) {
      set({ error: (err as Error).message, loading: false });
      throw err;
    }
  },

  register: async (username, password) => {
    set({ loading: true, error: null });
    try {
      const r = await api<{ token: string; user: AuthUser }>('/auth/register', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      });
      localStorage.setItem('gpuviewr.token', r.token);
      localStorage.setItem('gpuviewr.user', JSON.stringify(r.user));
      set({ token: r.token, user: r.user, hasUsers: true, loading: false });
    } catch (err) {
      set({ error: (err as Error).message, loading: false });
      throw err;
    }
  },

  logout: () => {
    localStorage.removeItem('gpuviewr.token');
    localStorage.removeItem('gpuviewr.user');
    set({ token: null, user: null });
  },
}));
