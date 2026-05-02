import { create } from 'zustand';

export type ToastKind = 'info' | 'success' | 'warn' | 'error';

export interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  message?: string;
  durationMs: number;
}

interface ToastState {
  items: Toast[];
  push: (t: Omit<Toast, 'id'>) => number;
  dismiss: (id: number) => void;
}

let counter = 1;

export const useToastStore = create<ToastState>((set, get) => ({
  items: [],
  push: (t) => {
    const id = counter++;
    const toast: Toast = { id, ...t };
    set({ items: [...get().items, toast] });
    if (t.durationMs > 0) {
      setTimeout(() => get().dismiss(id), t.durationMs);
    }
    return id;
  },
  dismiss: (id) => set({ items: get().items.filter((x) => x.id !== id) }),
}));

export function notify(kind: ToastKind, title: string, message?: string, durationMs = 5000): number {
  return useToastStore.getState().push({ kind, title, message, durationMs });
}
