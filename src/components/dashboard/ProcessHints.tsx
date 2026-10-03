import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { TriangleAlert, ClipboardCopy, Check } from 'lucide-react';

/** Why the agent couldn't name a model (agent/src/collectors/llmClassifier.ts LLMHint). */
export const LLM_HINTS = ['ollama_manifests', 'blob', 'no_model'] as const;
export type LlmHint = (typeof LLM_HINTS)[number];

/** Hub-computed "some GPU processes are hidden" block (server/routes/processes.ts). */
export interface HiddenProcesses {
  denied_pids: number;
  has_ptrace: boolean;
  install_mode: string;
  unaccounted_mib: number;
}

const DOCS_URL = 'https://github.com/Erreur32/GpuViewR/blob/main/Docs/INSTALL.md#hidden-gpu-processes-and-model-names';

/** Refreshes an installed systemd agent (bundle + unit, which grants
 *  CAP_SYS_PTRACE) from its existing env file, no token needed. */
function systemdUpgradeCmd(): string {
  const hub = typeof globalThis.window === 'object' ? globalThis.location.origin : '<hub-url>';
  return `curl -fsSL ${hub}/install.sh | sudo bash -s -- --upgrade`;
}

const DOCKER_PTRACE_SNIPPET = 'cap_add:\n  - SYS_PTRACE';

const SYSTEMD_OLLAMA_ENV = 'OLLAMA_MANIFESTS_DIR=/path/to/.ollama/models/manifests';

const DOCKER_OLLAMA_SNIPPET = [
  'volumes:',
  '  - /path/to/.ollama:/host/ollama:ro',
  'environment:',
  '  OLLAMA_MANIFESTS_DIR: /host/ollama/models/manifests',
].join('\n');

const WARN = 'var(--gv-warn)';

function CommandBlock({ text }: Readonly<{ text: string }>) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked (http): the text stays selectable */ }
  };
  return (
    <div className="relative mt-1 mb-2">
      <pre
        className="text-[10px] font-mono p-2 pr-8 rounded overflow-x-auto whitespace-pre"
        style={{ background: 'var(--gv-surface-alt)', border: '1px solid var(--gv-border)', color: 'var(--gv-text)' }}
      >
        {text}
      </pre>
      <button
        type="button"
        className="btn-ghost !p-1 absolute top-1 right-1"
        onClick={copy}
        title={copied ? t('common.copied') : t('dashboard.hint_copy')}
        aria-label={t('dashboard.hint_copy')}
      >
        {copied ? <Check className="w-3 h-3" /> : <ClipboardCopy className="w-3 h-3" />}
      </button>
    </div>
  );
}

function DocsLink() {
  const { t } = useTranslation();
  return (
    <a href={DOCS_URL} target="_blank" rel="noreferrer noopener" className="underline" style={{ color: 'var(--gv-accent)' }}>
      {t('dashboard.hint_docs')}
    </a>
  );
}

function Panel({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <div
      className="mt-1.5 p-2.5 rounded text-[11px] leading-relaxed"
      style={{
        color: 'var(--gv-text)',
        background: `color-mix(in srgb, ${WARN} 7%, transparent)`,
        border: `1px solid color-mix(in srgb, ${WARN} 30%, transparent)`,
      }}
    >
      {children}
    </div>
  );
}

/** Fix steps for a hidden-processes notice, picked from how the agent
 *  was installed and whether it already holds CAP_SYS_PTRACE. */
function HiddenFix({ hidden }: Readonly<{ hidden: HiddenProcesses }>) {
  const { t } = useTranslation();
  if (hidden.has_ptrace) {
    return <p>{t('dashboard.hidden_fix_apparmor')}</p>;
  }
  if (hidden.install_mode === 'docker') {
    return (
      <>
        <p>{t('dashboard.hidden_fix_docker')}</p>
        <CommandBlock text={DOCKER_PTRACE_SNIPPET} />
      </>
    );
  }
  if (hidden.install_mode === 'systemd') {
    return (
      <>
        <p>{t('dashboard.hidden_fix_systemd')}</p>
        <CommandBlock text={systemdUpgradeCmd()} />
      </>
    );
  }
  return <p>{t('dashboard.hidden_fix_generic')}</p>;
}

/** Banner above the process table: VRAM is in use that the listed
 *  processes don't explain while the agent was refused some pids. */
export function HiddenProcessesNotice({ hidden }: Readonly<{ hidden: HiddenProcesses }>) {
  const { t } = useTranslation();
  return (
    <details className="mb-3 text-xs">
      <summary className="cursor-pointer flex items-center gap-1.5" style={{ color: WARN }}>
        <TriangleAlert className="w-3.5 h-3.5 flex-shrink-0" />
        {t('dashboard.hidden_title', { mib: hidden.unaccounted_mib.toLocaleString() })}
      </summary>
      <Panel>
        <HiddenFix hidden={hidden} />
        <DocsLink />
      </Panel>
    </details>
  );
}

function hintTitle(hint: LlmHint, t: (k: string) => string): string {
  const key = `dashboard.llm_hint_${hint}`;
  return [t(key), t('dashboard.hint_click')].join('\n');
}

/** Warning icon next to an LLM model name the agent couldn't make
 *  human-friendly. Hover shows the cause, click toggles the fix. */
export function LlmHintIcon({ hint, open, onToggle }: Readonly<{ hint: LlmHint; open: boolean; onToggle: () => void }>) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      className="inline-flex items-center"
      style={{ color: WARN }}
      onClick={onToggle}
      title={hintTitle(hint, t)}
      aria-label={t(`dashboard.llm_hint_${hint}`)}
      aria-expanded={open}
    >
      <TriangleAlert className="w-3.5 h-3.5" />
    </button>
  );
}

/** Fix steps for an LLM model-name hint. */
export function LlmHintPanel({ hint }: Readonly<{ hint: LlmHint }>) {
  const { t } = useTranslation();
  return (
    <Panel>
      <p className="mb-1">{t(`dashboard.llm_hint_${hint}`)}</p>
      {hint === 'ollama_manifests' ? (
        <>
          <p>{t('dashboard.llm_fix_ollama_systemd')}</p>
          <CommandBlock text={systemdUpgradeCmd()} />
          <p>{t('dashboard.llm_fix_ollama_systemd_env')}</p>
          <CommandBlock text={SYSTEMD_OLLAMA_ENV} />
          <p>{t('dashboard.llm_fix_ollama_docker')}</p>
          <CommandBlock text={DOCKER_OLLAMA_SNIPPET} />
        </>
      ) : (
        <>
          <p>{t('dashboard.llm_fix_alias')}</p>
          <CommandBlock text="--alias my-model-name" />
        </>
      )}
      <DocsLink />
    </Panel>
  );
}
