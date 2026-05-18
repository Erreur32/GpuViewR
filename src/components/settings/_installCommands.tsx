// Shared install-command helpers used by the Add-host and
// Rotate-token modals. Both surfaces hand the operator a ready-to-
// paste shell snippet for the three supported install modes
// (Linux bash, Docker, Windows PowerShell); keeping the templates
// in one place stops the two modals from drifting out of sync (and
// silences SonarCloud's duplicated-lines threshold on these
// settings files).
//
// The token shape that lands here is always the `host_id.secret`
// composite — the backend has emitted it that way since v0.6.4 for
// both the enrollment and rotate-token responses. The install.sh /
// install-agent.sh / install.ps1 scripts all parse the composite
// back into HOST_ID + AGENT_TOKEN on the receiving side.

import { Terminal, Container, Monitor } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export type InstallMode = 'curl' | 'docker' | 'windows';

export interface InstallCommandSet {
  curl: string;
  docker: string;
  windows: string;
}

/** Generate the three install one-liners for a `host_id.secret`
 *  composite token + a hub HTTP base URL (e.g.
 *  `http://192.168.32.210:7510`). Multi-line PowerShell snippet for
 *  Windows since `iex` can't forward args; the other two are POSIX
 *  shell one-liners with backslash continuations for readability. */
export function buildInstallCommands(hubHttp: string, token: string): InstallCommandSet {
  return {
    curl: `curl -fsSL ${hubHttp}/install.sh | sudo bash -s -- \\\n  --url ${hubHttp} \\\n  --token ${token}`,
    docker: `curl -fsSL ${hubHttp}/install-agent.sh | bash -s -- \\\n  --hub ${hubHttp} \\\n  --token ${token}`,
    windows: `Set-ExecutionPolicy Bypass -Scope Process -Force\n$env:GPVR_HUB_URL = '${hubHttp}'\n$env:GPVR_TOKEN   = '${token}'\niex (iwr "$env:GPVR_HUB_URL/install.ps1" -UseBasicParsing).Content`,
  };
}

/** i18n key for the CopyValueBlock label that names the active
 *  install command. Matches existing keys in
 *  `src/i18n/locales/{en,fr}.json` (`hosts.curl_cmd`, etc.). */
export const LABEL_KEY_BY_MODE: Record<InstallMode, string> = {
  curl: 'hosts.curl_cmd',
  docker: 'hosts.docker_cmd',
  windows: 'hosts.windows_cmd',
};

/** Map an agent's reported install_mode (the wire-side string) to
 *  the modal toggle's UI mode. Falls back to 'curl' (bash binary on
 *  Linux, the most common deployment) when the agent never reported
 *  one or reports a mode this UI doesn't surface yet. */
export function defaultModeFor(installMode: string | null | undefined): InstallMode {
  if (installMode === 'docker') return 'docker';
  if (installMode === 'windows') return 'windows';
  return 'curl';
}

/** Segmented toggle for the three install modes. Pure presentational
 *  — the parent owns the `mode` state and decides what to do with
 *  the active selection (typically: render `commands[mode]` in a
 *  CopyValueBlock). */
export function InstallModePicker({
  mode, onChange,
}: Readonly<{ mode: InstallMode; onChange: (m: InstallMode) => void }>) {
  const { t } = useTranslation();
  return (
    <div className="seg" role="toolbar" aria-label={t('hosts.install_mode_label')}>
      <button
        type="button"
        className="seg-btn inline-flex items-center gap-1.5"
        aria-pressed={mode === 'curl'}
        onClick={() => onChange('curl')}
      >
        <Terminal size={14} /> {t('hosts.install_mode_curl')}
      </button>
      <button
        type="button"
        className="seg-btn inline-flex items-center gap-1.5"
        aria-pressed={mode === 'docker'}
        onClick={() => onChange('docker')}
      >
        <Container size={14} /> {t('hosts.install_mode_docker')}
      </button>
      <button
        type="button"
        className="seg-btn inline-flex items-center gap-1.5"
        aria-pressed={mode === 'windows'}
        onClick={() => onChange('windows')}
      >
        <Monitor size={14} /> {t('hosts.install_mode_windows')}
      </button>
    </div>
  );
}
