import { useState } from 'react';
import { X, Copy, AlertTriangle } from 'lucide-react';

type Stage = 'form' | 'token';

const FAKE_TOKEN = 'gpvr_4f8b2e9c1a6d7e3f5b8a9c0d2e4f6a8b1c3d5e7f9a0b2c4d6e8f0a1b3c5d7e9f';
const FAKE_ID = '550e8400-e29b-41d4-a716-446655440042';

type Props = Readonly<{ onClose: () => void }>;

export default function EnrollHostModal({ onClose }: Props) {
  const [stage, setStage] = useState<Stage>('form');
  const [label, setLabel] = useState('');
  const [copied, setCopied] = useState<'token' | 'cmd' | null>(null);

  const dockerCmd = `docker run -d --name gpuviewr-agent \\\n  --gpus all \\\n  -e HUB_URL=wss://gpu.example.com/agent \\\n  -e HOST_ID=${FAKE_ID} \\\n  -e AGENT_TOKEN=${FAKE_TOKEN} \\\n  ghcr.io/erreur32/gpuviewr-agent:latest`;

  const copy = (text: string, kind: 'token' | 'cmd') => {
    navigator.clipboard.writeText(text);
    setCopied(kind);
    setTimeout(() => setCopied(null), 1500);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.7)' }}
      onClick={onClose}
    >
      <div
        className="card w-full max-w-xl p-6 flex flex-col gap-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-bold">
              {stage === 'form' ? 'Add a remote host' : 'Host enrolled'}
            </h2>
            <p className="text-sm" style={{ color: 'var(--gv-text-muted)' }}>
              {stage === 'form'
                ? 'A token will be generated. Copy it now — it is shown only once.'
                : 'Save these credentials and start your agent.'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-lg inline-flex items-center justify-center"
            style={{ color: 'var(--gv-text-muted)', background: 'var(--gv-surface-alt)' }}
          >
            <X size={16} />
          </button>
        </div>

        {stage === 'form' && (
          <>
            <div className="flex flex-col gap-2">
              <label className="text-xs uppercase tracking-wider" style={{ color: 'var(--gv-text-dim)' }}>
                Label
              </label>
              <input
                type="text"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="e.g. lab-3"
                className="input"
                autoFocus
              />
              <p className="text-xs" style={{ color: 'var(--gv-text-dim)' }}>
                Human-readable name. Can be renamed later. The host ID (UUID) stays stable.
              </p>
            </div>

            <div className="flex justify-end gap-2">
              <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
              <button
                type="button"
                onClick={() => setStage('token')}
                disabled={!label.trim()}
                className="btn-primary"
              >
                Generate token
              </button>
            </div>
          </>
        )}

        {stage === 'token' && (
          <>
            <div
              className="rounded-xl p-3 flex items-start gap-2 text-sm"
              style={{
                background: 'color-mix(in srgb, var(--gv-warn) 12%, transparent)',
                border: '1px solid color-mix(in srgb, var(--gv-warn) 35%, transparent)',
                color: 'var(--gv-warn)',
              }}
            >
              <AlertTriangle size={16} className="mt-0.5 flex-shrink-0" />
              <span>This token will <strong>not be shown again</strong>. Copy it now or rotate later.</span>
            </div>

            <FieldBlock
              label="Host ID"
              value={FAKE_ID}
              onCopy={() => copy(FAKE_ID, 'cmd')}
              copied={false}
              monoWrap
            />

            <FieldBlock
              label="Agent token"
              value={FAKE_TOKEN}
              onCopy={() => copy(FAKE_TOKEN, 'token')}
              copied={copied === 'token'}
              sensitive
            />

            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <span className="text-xs uppercase tracking-wider" style={{ color: 'var(--gv-text-dim)' }}>
                  Docker command
                </span>
                <button
                  type="button"
                  onClick={() => copy(dockerCmd, 'cmd')}
                  className="text-xs inline-flex items-center gap-1.5"
                  style={{ color: copied === 'cmd' ? 'var(--gv-ok)' : 'var(--gv-text-muted)' }}
                >
                  <Copy size={12} /> {copied === 'cmd' ? 'Copied' : 'Copy'}
                </button>
              </div>
              <pre
                className="rounded-xl p-3 text-xs font-mono overflow-x-auto"
                style={{
                  background: 'var(--gv-surface-alt)',
                  border: '1px solid var(--gv-border)',
                  color: 'var(--gv-text)',
                }}
              >{dockerCmd}</pre>
            </div>

            <div className="flex justify-end">
              <button type="button" onClick={onClose} className="btn-primary">Done</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function FieldBlock({
  label, value, onCopy, copied, monoWrap, sensitive,
}: Readonly<{
  label: string; value: string; onCopy: () => void; copied: boolean; monoWrap?: boolean; sensitive?: boolean;
}>) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <span className="text-xs uppercase tracking-wider" style={{ color: 'var(--gv-text-dim)' }}>{label}</span>
        <button
          type="button"
          onClick={onCopy}
          className="text-xs inline-flex items-center gap-1.5"
          style={{ color: copied ? 'var(--gv-ok)' : 'var(--gv-text-muted)' }}
        >
          <Copy size={12} /> {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <div
        className={`rounded-xl px-3 py-2.5 text-xs font-mono ${monoWrap ? 'break-all' : 'overflow-x-auto whitespace-nowrap'}`}
        style={{
          background: 'var(--gv-surface-alt)',
          border: '1px solid var(--gv-border)',
          color: sensitive ? 'var(--gv-warn)' : 'var(--gv-text)',
        }}
      >
        {value}
      </div>
    </div>
  );
}
