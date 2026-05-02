import { CheckCircle2, AlertTriangle, AlertOctagon, Info, X } from 'lucide-react';
import { useToastStore, type ToastKind } from '../../store/toastStore';

const ICONS: Record<ToastKind, JSX.Element> = {
  info: <Info className="w-4 h-4" />,
  success: <CheckCircle2 className="w-4 h-4" />,
  warn: <AlertTriangle className="w-4 h-4" />,
  error: <AlertOctagon className="w-4 h-4" />,
};

const COLORS: Record<ToastKind, string> = {
  info: 'var(--gv-info)',
  success: 'var(--gv-ok)',
  warn: 'var(--gv-warn)',
  error: 'var(--gv-danger)',
};

export default function Toaster() {
  const items = useToastStore((s) => s.items);
  const dismiss = useToastStore((s) => s.dismiss);

  if (items.length === 0) return null;

  return (
    <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 w-[360px] max-w-[calc(100vw-2rem)]">
      {items.map((t) => (
        <div
          key={t.id}
          role="status"
          className="card p-3 toast-enter flex items-start gap-3"
          style={{ borderColor: `color-mix(in srgb, ${COLORS[t.kind]} 35%, var(--gv-border))` }}
        >
          <div className="mt-0.5" style={{ color: COLORS[t.kind] }}>{ICONS[t.kind]}</div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold" style={{ color: 'var(--gv-text)' }}>{t.title}</div>
            {t.message && (
              <div className="text-xs mt-0.5 break-words" style={{ color: 'var(--gv-text-muted)' }}>{t.message}</div>
            )}
          </div>
          <button
            className="btn-ghost !p-1 !rounded-md"
            onClick={() => dismiss(t.id)}
            aria-label="Dismiss"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
