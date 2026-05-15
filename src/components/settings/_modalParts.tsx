// Shared building blocks for the host-management modals (Enroll,
// RotateToken, DeleteHost). Each of those modals used to inline the
// same backdrop / header / warning / copy-block markup which SonarCloud
// flagged as duplicated lines across files. Centralising the pieces
// here keeps the visual language consistent and lets us tweak modal
// chrome (focus rings, escape handling, accessibility) once.

import { type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { X, AlertTriangle, Copy } from 'lucide-react';

/** Modal shell with backdrop (click to close), card frame, top-right
 *  close button and title + optional hint header. The children fill
 *  the body — modals supply their own action rows. */
export function ModalShell({
  title, hint, onClose, maxWidth = 'max-w-xl', children,
}: Readonly<{
  title: string;
  hint?: string;
  onClose: () => void;
  /** Tailwind max-width class. Default `max-w-xl` (Enroll); `max-w-lg`
   *  for Rotate, `max-w-xl` for Delete. */
  maxWidth?: string;
  children: ReactNode;
}>) {
  const { t } = useTranslation();
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        aria-label={t('common.close')}
        className="absolute inset-0 cursor-default"
        style={{ background: 'rgba(0,0,0,0.7)' }}
        onClick={onClose}
      />
      <div className={`card w-full ${maxWidth} p-6 flex flex-col gap-4 relative`}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-bold">{title}</h2>
            {hint && (
              <p className="text-sm" style={{ color: 'var(--gv-text-muted)' }}>
                {hint}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-lg inline-flex items-center justify-center"
            style={{ color: 'var(--gv-text-muted)', background: 'var(--gv-surface-alt)' }}
            aria-label={t('common.close')}
          >
            <X size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Warning banner with the AlertTriangle icon and the warn-coloured
 *  background. Used by all three host modals — same styling. */
export function WarningBanner({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <div
      className="rounded-xl p-3 flex items-start gap-2 text-sm"
      style={{
        background: 'color-mix(in srgb, var(--gv-warn) 12%, transparent)',
        border: '1px solid color-mix(in srgb, var(--gv-warn) 35%, transparent)',
        color: 'var(--gv-warn)',
      }}
    >
      <AlertTriangle size={16} className="mt-0.5 flex-shrink-0" />
      <span>{children}</span>
    </div>
  );
}

/** Inline "Copy / Copied" button used in the value-block headers. */
export function CopyButton({ onClick, copied }: Readonly<{ onClick: () => void; copied: boolean }>) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-xs inline-flex items-center gap-1.5"
      style={{ color: copied ? 'var(--gv-ok)' : 'var(--gv-text-muted)' }}
    >
      <Copy size={12} /> {copied ? t('common.copied') : t('common.copy')}
    </button>
  );
}

/** Label + copy-button header above a mono code box. The box itself
 *  renders the value either as a wrapping <div> (for short ids/tokens)
 *  or a horizontally-scrolling <pre> (for multi-line shell commands).
 *  `sensitive` swaps the text colour to warn — for tokens. */
export function CopyValueBlock({
  label, value, onCopy, copied, kind = 'inline', sensitive = false,
}: Readonly<{
  label: string;
  value: string;
  onCopy: () => void;
  copied: boolean;
  /** 'inline' = single-line break-all, 'monoWrap' = same but force-wrap,
   *  'pre' = multi-line scrollable <pre>. */
  kind?: 'inline' | 'monoWrap' | 'pre';
  sensitive?: boolean;
}>) {
  const color = sensitive ? 'var(--gv-warn)' : 'var(--gv-text)';
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <span className="text-xs uppercase tracking-wider" style={{ color: 'var(--gv-text-dim)' }}>
          {label}
        </span>
        <CopyButton onClick={onCopy} copied={copied} />
      </div>
      {kind === 'pre' ? (
        <pre
          className="rounded-xl p-3 text-xs font-mono overflow-x-auto"
          style={{ background: 'var(--gv-surface-alt)', border: '1px solid var(--gv-border)', color }}
        >{value}</pre>
      ) : (
        <div
          className={`rounded-xl px-3 py-2.5 text-xs font-mono ${kind === 'monoWrap' ? 'break-all' : 'overflow-x-auto whitespace-nowrap'}`}
          style={{ background: 'var(--gv-surface-alt)', border: '1px solid var(--gv-border)', color }}
        >
          {value}
        </div>
      )}
    </div>
  );
}
