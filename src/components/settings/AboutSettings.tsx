import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Github, ExternalLink, ChevronDown, Loader2 } from 'lucide-react';
import { api } from '../../lib/api';
import { useUpdateStore } from '../../store/updateStore';

interface VersionBlock { version: string; date: string; body: string; }

const VERSION_HEADER_RE = /##\s*\[([^\]]+)\]\s*-\s*(\d{4}-\d{2}-\d{2})/g;

function parseVersions(raw: string): VersionBlock[] {
  const sections: VersionBlock[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  VERSION_HEADER_RE.lastIndex = 0;
  while ((match = VERSION_HEADER_RE.exec(raw)) !== null) {
    const prev = sections.at(-1);
    if (prev) prev.body = raw.slice(lastIndex, match.index).trim();
    sections.push({ version: match[1], date: match[2], body: '' });
    lastIndex = match.index + match[0].length;
  }
  const last = sections.at(-1);
  if (last) last.body = raw.slice(lastIndex).trim();
  return sections;
}

const INLINE_RE = /(\*\*([^*]+)\*\*|`([^`]+)`)/g;

function renderInline(text: string, keyBase: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let lastIdx = 0;
  let i = 0;
  let m: RegExpExecArray | null;
  INLINE_RE.lastIndex = 0;
  while ((m = INLINE_RE.exec(text)) !== null) {
    if (m.index > lastIdx) out.push(text.slice(lastIdx, m.index));
    if (m[2] !== undefined) {
      out.push(
        <strong key={`${keyBase}-b${i++}`} className="font-semibold" style={{ color: 'var(--gv-warn)' }}>{m[2]}</strong>,
      );
    } else if (m[3] !== undefined) {
      out.push(
        <code
          key={`${keyBase}-c${i++}`}
          className="px-1.5 py-0.5 rounded font-mono text-[0.75rem]"
          style={{
            background: 'var(--gv-surface-alt)',
            border: '1px solid var(--gv-border)',
            color: 'var(--gv-ok)',
          }}
        >{m[3]}</code>,
      );
    }
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx < text.length) out.push(text.slice(lastIdx));
  return out;
}

interface RenderState {
  out: React.ReactNode[];
  listBuf: React.ReactNode[];
  fenceBuf: string[] | null;
  key: number;
}

function flushList(s: RenderState): void {
  if (!s.listBuf.length) return;
  s.out.push(<ul key={`ul-${s.key++}`} className="list-disc pl-5 my-2 space-y-1">{s.listBuf}</ul>);
  s.listBuf = [];
}

function flushFence(s: RenderState): void {
  if (!s.fenceBuf) return;
  s.out.push(
    <pre
      key={`pre-${s.key++}`}
      className="rounded-lg p-3 my-3 overflow-x-auto text-xs font-mono"
      style={{
        background: 'var(--gv-surface-alt)',
        border: '1px solid var(--gv-border)',
        borderLeft: '3px solid var(--gv-accent)',
        color: 'var(--gv-text)',
      }}
    ><code>{s.fenceBuf.join('\n')}</code></pre>,
  );
  s.fenceBuf = null;
}

// Returns true when the line consumed a structural marker (fence toggle,
// fence body, heading, hr, list item) — i.e. handled and the caller can
// move on. Falls through to paragraph rendering otherwise.
function consumeStructural(line: string, s: RenderState): boolean {
  if (line.startsWith('```')) {
    if (s.fenceBuf) flushFence(s);
    else { flushList(s); s.fenceBuf = []; }
    return true;
  }
  if (s.fenceBuf) { s.fenceBuf.push(line); return true; }
  if (line.startsWith('### ')) {
    flushList(s);
    s.out.push(
      <h4
        key={`h3-${s.key++}`}
        className="text-sm font-semibold mt-3 mb-1.5 pb-0.5"
        style={{
          color: 'var(--gv-accent)',
          borderBottom: '1px solid color-mix(in srgb, var(--gv-accent) 25%, transparent)',
        }}
      >{renderInline(line.slice(4), `h3${s.key}`)}</h4>,
    );
    return true;
  }
  if (line.startsWith('#### ')) {
    flushList(s);
    s.out.push(
      <h5 key={`h4-${s.key++}`} className="text-xs font-semibold mt-2 mb-1" style={{ color: 'var(--gv-ok)' }}>
        {renderInline(line.slice(5), `h4${s.key}`)}
      </h5>,
    );
    return true;
  }
  if (line.trim() === '---') {
    flushList(s);
    s.out.push(<hr key={`hr-${s.key++}`} style={{ borderColor: 'var(--gv-border)' }} className="my-3" />);
    return true;
  }
  if (/^[-*]\s+/.test(line)) {
    s.listBuf.push(
      <li key={`li-${s.key++}`} className="text-xs leading-relaxed" style={{ color: 'var(--gv-text)' }}>
        {renderInline(line.replace(/^[-*]\s+/, ''), `li${s.key}`)}
      </li>,
    );
    return true;
  }
  return false;
}

function renderBody(body: string): React.ReactNode {
  const s: RenderState = { out: [], listBuf: [], fenceBuf: null, key: 0 };
  for (const raw of body.split(/\n/)) {
    const line = raw.trimEnd();
    if (consumeStructural(line, s)) continue;
    flushList(s);
    if (line.trim()) {
      s.out.push(
        <p key={`p-${s.key++}`} className="text-xs my-1.5 leading-relaxed" style={{ color: 'var(--gv-text-muted)' }}>
          {renderInline(line, `p${s.key}`)}
        </p>,
      );
    }
  }
  flushList(s);
  flushFence(s);
  return <>{s.out}</>;
}

export default function AboutSettings() {
  const { t } = useTranslation();
  const { result, hydrate, check } = useUpdateStore();
  const [raw, setRaw] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(0);
  // Changelog is opened by default in the About tab so the user lands
  // on the release notes immediately. They can still collapse it.
  const [open, setOpen] = useState(true);

  useEffect(() => {
    hydrate();
    if (!result) check(false).catch(() => { /* ignore */ });
  }, [hydrate, check, result]);

  useEffect(() => {
    if (!open || raw !== null) return;
    let cancelled = false;
    setLoading(true);
    api<{ content: string }>('/info/changelog')
      .then((r) => { if (!cancelled) { setRaw(r.content); setSelected(0); } })
      .catch(() => { if (!cancelled) setRaw(''); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, raw]);

  const versions = useMemo(() => (raw ? parseVersions(raw) : []), [raw]);
  const current = versions[selected];

  return (
    <div className="space-y-6">
      <section className="card p-5 space-y-4">
        <div className="flex items-center gap-4 flex-wrap">
          <img
            src={`${import.meta.env.BASE_URL}GPUViewR.png`}
            alt="GpuViewR logo"
            width={72}
            height={72}
            className="rounded-xl flex-shrink-0"
            style={{ background: 'var(--gv-surface-alt)', padding: 4, border: '1px solid var(--gv-border)' }}
          />
          <div className="flex-1 min-w-0">
            <h2 className="text-2xl font-bold leading-tight" style={{ color: 'var(--gv-text)' }}>GpuViewR</h2>
            <p className="text-sm" style={{ color: 'var(--gv-text-muted)' }}>
              {t('settings.about_tagline')}
            </p>
            <div className="text-xs mt-1" style={{ color: 'var(--gv-text-dim)' }}>
              {t('settings.about_version')}: <span className="font-mono" style={{ color: 'var(--gv-text)' }}>{result?.currentVersion ?? '-'}</span>
              {result?.latestVersion && result.latestVersion !== result.currentVersion && (
                <> · {t('settings.about_latest')}: <span className="font-mono font-semibold" style={{ color: 'var(--gv-accent)' }}>{result.latestVersion}</span></>
              )}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-center gap-1.5">
          <a href="https://github.com/Erreur32/GpuViewR/releases" target="_blank" rel="noreferrer">
            <img alt="Release" src="https://img.shields.io/github/v/release/Erreur32/GpuViewR?style=for-the-badge&logo=github&logoColor=white&label=Release&color=111827" />
          </a>
          <img alt="Docker" src="https://img.shields.io/badge/Docker-Ready-1f2937?style=for-the-badge&logo=docker&logoColor=38bdf8" />
          <img alt="NVIDIA" src="https://img.shields.io/badge/NVIDIA-GPU-111827?style=for-the-badge&logo=nvidia&logoColor=76b900" />
          <a href="https://github.com/Erreur32/GpuViewR/blob/main/LICENSE" target="_blank" rel="noreferrer">
            <img alt="License" src="https://img.shields.io/badge/License-MIT-111827?style=for-the-badge&color=111827&labelColor=111827&logoColor=white" />
          </a>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-1.5">
          <a href="https://scorecard.dev/viewer/?uri=github.com/Erreur32/GpuViewR" target="_blank" rel="noreferrer">
            <img alt="OSSF Scorecard" src="https://img.shields.io/ossf-scorecard/github.com/Erreur32/GpuViewR?style=for-the-badge&label=Scorecard" />
          </a>
          <a href="https://github.com/Erreur32/GpuViewR/security/code-scanning" target="_blank" rel="noreferrer">
            <img alt="CodeQL" src="https://img.shields.io/badge/CodeQL-active-brightgreen?style=for-the-badge&logo=github" />
          </a>
          <a href="https://sonarcloud.io/summary/overall?id=Erreur32_GpuViewR2" target="_blank" rel="noreferrer">
            <img alt="SonarCloud" src="https://img.shields.io/sonar/quality_gate/Erreur32_GpuViewR2?server=https%3A%2F%2Fsonarcloud.io&style=for-the-badge&logo=sonarcloud&logoColor=white&label=Sonar" />
          </a>
        </div>

        <p className="text-sm" style={{ color: 'var(--gv-text-muted)' }}>{t('settings.about_description')}</p>

        <ul className="text-xs grid sm:grid-cols-2 gap-y-1 gap-x-4 pl-4 list-disc" style={{ color: 'var(--gv-text-muted)' }}>
          <li>{t('settings.about_feat_realtime')}</li>
          <li>{t('settings.about_feat_multigpu')}</li>
          <li>{t('settings.about_feat_alerts')}</li>
          <li>{t('settings.about_feat_exports')}</li>
          <li>{t('settings.about_feat_themes')}</li>
          <li>{t('settings.about_feat_i18n')}</li>
        </ul>

        <div className="flex flex-wrap items-center gap-3 text-xs">
          <span style={{ color: 'var(--gv-text-dim)' }}>{t('settings.about_author')}</span>
          <a className="inline-flex items-center gap-1 hover:underline" style={{ color: 'var(--gv-accent)' }}
             href="https://github.com/Erreur32" target="_blank" rel="noreferrer">
            <Github className="w-3.5 h-3.5" /> Erreur32
          </a>
          <span style={{ color: 'var(--gv-text-dim)' }}>·</span>
          <a className="inline-flex items-center gap-1 hover:underline" style={{ color: 'var(--gv-accent)' }}
             href="https://github.com/Erreur32/GpuViewR" target="_blank" rel="noreferrer">
            <ExternalLink className="w-3.5 h-3.5" /> {t('settings.about_repo')}
          </a>
          <span style={{ color: 'var(--gv-text-dim)' }}>·</span>
          <span>MIT License</span>
        </div>
      </section>

      <section className="card p-5 space-y-3">
        <button
          type="button"
          className="w-full flex items-center justify-between text-left"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
        >
          <span className="font-semibold">{t('settings.about_changelog')}</span>
          <ChevronDown className={`w-4 h-4 transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
        {open && (
          <div className="space-y-2">
            {loading && (
              <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--gv-text-muted)' }}>
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> {t('common.loading')}
              </div>
            )}
            {!loading && versions.length === 0 && (
              <p className="text-xs" style={{ color: 'var(--gv-text-muted)' }}>{t('settings.about_changelog_empty')}</p>
            )}
            {!loading && versions.length > 0 && current && (
              <>
                <div className="flex items-center gap-2">
                  <span className="text-xs" style={{ color: 'var(--gv-text-dim)' }}>{t('settings.about_changelog_version')}</span>
                  <select
                    value={selected}
                    onChange={(e) => setSelected(Number(e.target.value))}
                    className="px-2 py-1 rounded text-xs font-mono"
                    style={{ background: 'var(--gv-surface-alt)', border: '1px solid var(--gv-border)', color: 'var(--gv-text)' }}
                  >
                    {versions.map((v, i) => (
                      <option key={v.version} value={i}>
                        {v.version}{v.date ? `  ${v.date}` : ''}
                      </option>
                    ))}
                  </select>
                </div>
                <div
                  className="rounded-lg p-3 max-h-[420px] overflow-y-auto"
                  style={{ background: 'var(--gv-surface-alt)', border: '1px solid var(--gv-border)' }}
                >
                  <div className="text-sm font-bold mb-1" style={{ color: 'var(--gv-accent)' }}>v{current.version}</div>
                  {current.date && <div className="text-xs mb-2" style={{ color: 'var(--gv-text-dim)' }}>{current.date}</div>}
                  {renderBody(current.body)}
                </div>
              </>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
