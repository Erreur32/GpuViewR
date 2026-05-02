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
      out.push(<strong key={`${keyBase}-b${i++}`} style={{ color: 'var(--gv-accent)' }}>{m[2]}</strong>);
    } else if (m[3] !== undefined) {
      out.push(
        <code
          key={`${keyBase}-c${i++}`}
          className="px-1 rounded text-[0.78rem]"
          style={{ background: 'var(--gv-surface-alt)', border: '1px solid var(--gv-border)' }}
        >{m[3]}</code>,
      );
    }
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx < text.length) out.push(text.slice(lastIdx));
  return out;
}

function renderBody(body: string): React.ReactNode {
  const out: React.ReactNode[] = [];
  let listBuf: React.ReactNode[] = [];
  let key = 0;
  const flushList = () => {
    if (listBuf.length) {
      out.push(<ul key={`ul-${key++}`} className="list-disc pl-5 my-1.5 space-y-0.5">{listBuf}</ul>);
      listBuf = [];
    }
  };
  for (const raw of body.split(/\n/)) {
    const line = raw.trimEnd();
    if (line.startsWith('### ')) {
      flushList();
      out.push(<h4 key={`h-${key++}`} className="text-sm font-semibold mt-3 mb-1" style={{ color: 'var(--gv-accent)' }}>{renderInline(line.slice(4), `h${key}`)}</h4>);
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      listBuf.push(<li key={`li-${key++}`} className="text-xs">{renderInline(line.replace(/^[-*]\s+/, ''), `li${key}`)}</li>);
      continue;
    }
    flushList();
    if (line.trim()) {
      out.push(<p key={`p-${key++}`} className="text-xs my-1.5" style={{ color: 'var(--gv-text-muted)' }}>{renderInline(line, `p${key}`)}</p>);
    }
  }
  flushList();
  return <>{out}</>;
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
    if (!result) void check(false);
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
        <div className="flex justify-center">
          <img
            src="/GpuViewR-Ban.png"
            alt="GpuViewR"
            className="rounded-xl max-w-full h-auto"
            style={{ maxHeight: 220, border: '1px solid var(--gv-border)' }}
          />
        </div>

        <div className="text-center">
          <h2 className="text-2xl font-bold leading-tight">GpuViewR</h2>
          <p className="text-sm" style={{ color: 'var(--gv-text-muted)' }}>
            {t('settings.about_tagline')}
          </p>
          <div className="text-xs mt-1" style={{ color: 'var(--gv-text-dim)' }}>
            {t('settings.about_version')}: <span className="font-mono">{result?.currentVersion ?? '-'}</span>
            {result?.latestVersion && result.latestVersion !== result.currentVersion && (
              <> · {t('settings.about_latest')}: <span className="font-mono" style={{ color: 'var(--gv-accent)' }}>{result.latestVersion}</span></>
            )}
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
