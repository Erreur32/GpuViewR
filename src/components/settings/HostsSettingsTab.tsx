import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, KeyRound, Trash2, Terminal, Container, Server, AlertTriangle, RefreshCw, DownloadCloud, Power, PowerOff } from 'lucide-react';
import Icon from '../ui/icons/IconRegistry';
import {
  useHostsStore,
  effectiveStatus,
  freshestLastSeen,
  formatRelative,
  LOCAL_HOST_ID,
  CLOCK_SKEW_WARN_S,
  type HostRecord,
  type RejectedAttempt,
} from '../../store/hostsStore';
import { useGpuStore, liveLastSeenFor } from '../../store/gpuStore';
import { useAuthStore } from '../../store/authStore';
import { notify } from '../../store/toastStore';
import { copyText } from '../../lib/clipboard';
import { HOST_PALETTE, resolveHostColor } from '../../lib/hostColors';
import { useDropdown } from '../../lib/useDropdown';
import StatusPill from '../fleet/StatusPill';
import EnrollHostModal from './EnrollHostModal';
import { ModalShell, WarningBanner, CopyValueBlock } from './_modalParts';
import {
  buildInstallCommands,
  defaultModeFor,
  InstallModePicker,
  LABEL_KEY_BY_MODE,
  TAB_LABEL_KEY_BY_MODE,
  type InstallMode,
} from './_installCommands';

// Same constant the footer uses — Vite injects the package.json version
// at build time, so this stays in sync with what the hub actually runs.
const HUB_VERSION = __APP_VERSION__;

export default function HostsSettingsTab() {
  const { t } = useTranslation();
  const isAdmin = useAuthStore((s) => s.user?.role === 'admin');
  const hosts = useHostsStore((s) => s.hosts);
  const refresh = useHostsStore((s) => s.refresh);
  const rejectedAttempts = useHostsStore((s) => s.rejectedAttempts);
  const fetchRejectedAttempts = useHostsStore((s) => s.fetchRejectedAttempts);
  const clockOffsetS = useHostsStore((s) => s.clockOffsetS);
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [rotateFor, setRotateFor] = useState<HostRecord | null>(null);
  const [deleteFor, setDeleteFor] = useState<HostRecord | null>(null);

  useEffect(() => { refresh().catch(() => undefined); }, [refresh]);

  // Page-scoped poll (not part of the global 15s host poll — this
  // signal only matters while an admin is actually looking at this
  // tab, e.g. right after deleting/uninstalling a host).
  useEffect(() => {
    if (!isAdmin) return;
    fetchRejectedAttempts().catch(() => undefined);
    const id = setInterval(() => { fetchRejectedAttempts().catch(() => undefined); }, 15_000);
    return () => clearInterval(id);
  }, [isAdmin, fetchRejectedAttempts]);

  if (!isAdmin) {
    return (
      <div className="card p-6 text-sm" style={{ color: 'var(--gv-text-muted)' }}>
        {t('hosts.admin_only')}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold">{t('hosts.section_title')}</h2>
          <p className="text-xs whitespace-pre-line" style={{ color: 'var(--gv-text-muted)' }}>
            {t('hosts.section_help')}
          </p>
        </div>
        <button type="button" onClick={() => setEnrollOpen(true)} className="btn-primary">
          <Plus size={16} /> {t('hosts.add_host')}
        </button>
      </div>

      {Math.abs(clockOffsetS) > CLOCK_SKEW_WARN_S && <ClockSkewBanner offsetS={clockOffsetS} t={t} />}

      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <colgroup>
              <col />
              {/* Fixed width: "En ligne" / "En retard" / "Hors ligne" must
                  not reflow the sibling columns as the status changes. */}
              <col style={{ width: '7.5rem' }} />
              <col />
              <col />
              <col />
              <col />
            </colgroup>
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wider" style={{ color: 'var(--gv-text-dim)' }}>
                <th className="px-4 py-3 font-medium">{t('hosts.col_label')}</th>
                <th className="px-4 py-3 font-medium">{t('hosts.col_status')}</th>
                <th className="px-4 py-3 font-medium">{t('hosts.col_type')}</th>
                <th className="px-4 py-3 font-medium">{t('hosts.col_agent')}</th>
                <th className="px-4 py-3 font-medium">{t('hosts.col_last_seen')}</th>
                <th className="px-4 py-3 font-medium text-right">{t('hosts.col_actions')}</th>
              </tr>
            </thead>
            <tbody>
              {hosts.map((h, idx) => (
                <HostRow
                  key={h.id}
                  host={h}
                  hostIdx={idx}
                  onRotate={() => setRotateFor(h)}
                  onDelete={() => setDeleteFor(h)}
                />
              ))}
              {hosts.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-center text-sm" style={{ color: 'var(--gv-text-muted)' }}>
                    {t('hosts.empty')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {rejectedAttempts.length > 0 && <RejectedAttemptsPanel attempts={rejectedAttempts} />}

      {enrollOpen && <EnrollHostModal onClose={() => setEnrollOpen(false)} />}
      {rotateFor && (
        <RotateTokenModal host={rotateFor} onClose={() => setRotateFor(null)} />
      )}
      {deleteFor && (
        <DeleteHostModal host={deleteFor} onClose={() => setDeleteFor(null)} />
      )}
    </div>
  );
}

/** Shown when the browser clock and the hub clock disagree by more
 *  than CLOCK_SKEW_WARN_S. Statuses and ages on this page are already
 *  corrected by clockOffsetS; the banner exists so the drift gets fixed
 *  at the source (NTP) instead of staying silently masked. */
function ClockSkewBanner({
  offsetS, t,
}: Readonly<{ offsetS: number; t: (key: string, opts?: Record<string, unknown>) => string }>) {
  const direction = offsetS > 0 ? t('hosts.clock_skew_behind') : t('hosts.clock_skew_ahead');
  return (
    <WarningBanner>
      {t('hosts.clock_skew_warning', { seconds: Math.abs(offsetS), direction })}
    </WarningBanner>
  );
}

function HostRow({
  host, hostIdx, onRotate, onDelete,
}: Readonly<{ host: HostRecord; hostIdx: number; onRotate: () => void; onDelete: () => void }>) {
  const { t } = useTranslation();
  const isLocal = host.id === LOCAL_HOST_ID;
  const receivedAtByHost = useGpuStore((s) => s.receivedAtByHost);
  const clockOffsetS = useHostsStore((s) => s.clockOffsetS);
  const liveLastSeen = liveLastSeenFor(receivedAtByHost, host.id);
  const status = effectiveStatus(host, undefined, liveLastSeen, clockOffsetS);
  const now = Math.floor(Date.now() / 1000);
  // Same rule as effectiveStatus: freshest of the polled (hub clock,
  // shifted into browser clock) and live (browser clock) signals, so
  // the "il y a Xs" label can never disagree with the pill.
  const effectiveLastSeen = freshestLastSeen(host, liveLastSeen, clockOffsetS);
  const lastSeenLabel = effectiveLastSeen === null
    ? '—'
    : t('common.ago_relative', { time: formatRelative(now - effectiveLastSeen) });

  // Show the system hostname (when the schema has it) as the secondary
  // line. Falls back to the truncated id so a freshly-enrolled host
  // still has *something* to identify it. Skip the line entirely if
  // it'd just repeat the label (the local row before hostname is
  // populated, for example).
  const secondaryRaw = host.hostname ?? `${host.id.slice(0, 13)}…`;
  const secondary = secondaryRaw === host.label ? null : secondaryRaw;

  // Reinstall command for the "key" tooltip, matching the host's own
  // install_mode (Windows/binary/Docker) so an admin whose agent is
  // unreachable via auto-update can retype it on the box by hand.
  // The token is a placeholder — the hub only ever stores a bcrypt hash
  // and can't recover the original plaintext (see routes/hosts.ts) — the
  // admin fills in the token they saved at enrollment. No token on hand?
  // Rotate below issues a fresh one.
  const hubHttp = `${globalThis.location.protocol}//${globalThis.location.host}`;
  const reinstallCmd = buildInstallCommands(hubHttp, t('hosts.rotate_tooltip_token_placeholder'))[defaultModeFor(host.install_mode)];
  const rotateTooltip = `${t('hosts.rotate_token')}\n\n${t('hosts.rotate_tooltip_hint')}\n${reinstallCmd}`;

  return (
    <tr className="border-t" style={{ borderColor: 'var(--gv-border)' }}>
      <td className="px-4 py-3">
        <div className="flex items-center gap-1.5">
          <ColorPickerButton host={host} hostIdx={hostIdx} t={t} />
          <span className="font-medium">{host.label}</span>
          {isLocal && <HubBadge t={t} />}
        </div>
        {secondary && (
          <div className="text-xs font-mono" style={{ color: 'var(--gv-text-dim)' }} title={host.id}>
            {secondary}
          </div>
        )}
      </td>
      <td className="px-4 py-3 whitespace-nowrap">
        {/* lastSeenEpoch={null} → render only the status dot + label.
            The dedicated "Last seen" column on this row already shows
            the age, so duplicating it inside the pill would read as
            "22s · En ligne · 22s il y a" — redundant. */}
        <StatusPill status={status} lastSeenEpoch={null} />
      </td>
      <td className="px-4 py-3">
        <InstallTypeCell isLocal={isLocal} installMode={host.install_mode} t={t} />
      </td>
      <td className="px-4 py-3 font-mono text-xs">
        <VersionCell
          isLocal={isLocal}
          agentVersion={host.agent_version}
          installMode={host.install_mode}
          kind={host.kind}
          t={t}
        />
      </td>
      <td className="px-4 py-3 font-mono text-xs" style={{ color: 'var(--gv-text-muted)' }}>
        {lastSeenLabel}
      </td>
      <td className="px-4 py-3">
        <div className="flex justify-end gap-1.5">
          {!isLocal && (
            <>
              <EnabledToggle host={host} t={t} />
              <ForceUpdateButton host={host} t={t} />
              <AutoUpdateToggle host={host} t={t} />
              <IconBtn title={rotateTooltip} onClick={onRotate}>
                <KeyRound size={14} />
              </IconBtn>
              <IconBtn title={t('hosts.delete')} onClick={onDelete} danger>
                <Trash2 size={14} />
              </IconBtn>
            </>
          )}
        </div>
      </td>
    </tr>
  );
}

/** Small colored swatch button that opens a popover to pick this
 *  host's fixed identity color (or reset it back to automatic). The
 *  swatch itself always shows the *effective* color — the admin's
 *  override if set, else the same index-based palette color
 *  FleetChart.tsx would assign — so this row's dot always matches
 *  what the fleet chart actually draws for this host. */
function ColorPickerButton({
  host, hostIdx, t,
}: Readonly<{
  host: HostRecord;
  hostIdx: number;
  t: (key: string, opts?: Record<string, unknown>) => string;
}>) {
  const setColor = useHostsStore((s) => s.setColor);
  const { open, setOpen, rootRef } = useDropdown();
  const [saving, setSaving] = useState(false);
  const effective = resolveHostColor(host, hostIdx);

  const apply = async (color: string | null) => {
    setSaving(true);
    try {
      await setColor(host.id, color);
      notify('success', t('hosts.color_changed'), '');
      setOpen(false);
    } catch (err) {
      notify('error', t('hosts.color_change_failed'), (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="relative shrink-0" ref={rootRef}>
      <button
        type="button"
        title={t('hosts.color_picker')}
        aria-label={t('hosts.color_picker')}
        onClick={() => setOpen(!open)}
        className="w-4 h-4 rounded-full"
        style={{
          background: effective,
          border: '1px solid color-mix(in srgb, var(--gv-border) 60%, black 20%)',
          cursor: 'pointer',
        }}
      />
      {open && (
        <div
          className="absolute z-20 top-full left-0 mt-1.5 p-2 rounded-lg shadow-lg grid grid-cols-6 gap-1.5"
          style={{ background: 'var(--gv-surface)', border: '1px solid var(--gv-border)', width: 168 }}
        >
          {HOST_PALETTE.map((c) => (
            <button
              key={c}
              type="button"
              disabled={saving}
              onClick={() => apply(c)}
              title={c}
              aria-label={c}
              className="w-6 h-6 rounded-full"
              style={{
                background: c,
                outline: host.color === c ? '2px solid var(--gv-text)' : 'none',
                outlineOffset: 1,
                cursor: saving ? 'default' : 'pointer',
              }}
            />
          ))}
          <label
            title={t('hosts.color_custom')}
            className="w-6 h-6 rounded-full overflow-hidden"
            style={{
              border: '1px solid var(--gv-border)',
              cursor: saving ? 'default' : 'pointer',
              // Conic-gradient "rainbow" swatch — the conventional
              // affordance for "pick a custom color" (this dot is a
              // static button, not a reflection of the current value:
              // the main swatch above the popover already shows that).
              background: 'conic-gradient(from 0deg, red, yellow, lime, cyan, blue, magenta, red)',
            }}
          >
            <input
              type="color"
              aria-label={t('hosts.color_custom')}
              disabled={saving}
              value={host.color ?? effective}
              onChange={(e) => apply(e.target.value)}
              className="w-full h-full opacity-0 cursor-pointer"
            />
          </label>
          <button
            type="button"
            disabled={saving || !host.color}
            onClick={() => apply(null)}
            title={t('hosts.color_auto')}
            aria-label={t('hosts.color_auto')}
            className="w-6 h-6 rounded-full flex items-center justify-center text-[9px] font-medium"
            style={{
              border: '1px dashed var(--gv-border)',
              color: 'var(--gv-text-dim)',
              cursor: (saving || !host.color) ? 'default' : 'pointer',
              opacity: host.color ? 1 : 0.4,
            }}
          >
            A
          </button>
        </div>
      )}
    </div>
  );
}

// Install-type pill (Docker / Binaire / unknown). Reads install_mode
// the agent reported in its hello frame. Pre-v0.5.3 agents had no way
// to declare it → null/unknown both render as the muted "?" badge.
// The local hub row sits outside the agent fleet, so we mark it as
// "Hub" rather than guessing an install method.
function InstallTypeCell({
  isLocal, installMode, t,
}: Readonly<{
  isLocal: boolean;
  installMode: 'docker' | 'systemd' | 'windows' | 'macos' | 'unknown' | null;
  t: (key: string, opts?: Record<string, unknown>) => string;
}>) {
  if (isLocal) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs"
            style={{ color: 'var(--gv-text-muted)' }}
            title={t('hosts.type_hub_help')}>
        <Server size={14} /> {t('hosts.type_hub')}
      </span>
    );
  }
  if (installMode === 'docker') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs"
            title={t('hosts.type_docker_help')}>
        <Container size={14} /> {t('hosts.type_docker')}
      </span>
    );
  }
  if (installMode === 'systemd') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs"
            title={t('hosts.type_binary_help')}>
        <Terminal size={14} /> {t('hosts.type_binary')}
      </span>
    );
  }
  if (installMode === 'windows') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs"
            title={t('hosts.type_windows_help')}>
        <Icon name="platform.windows" size={14} /> {t('hosts.type_windows')}
      </span>
    );
  }
  if (installMode === 'macos') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs"
            title={t('hosts.type_macos_help')}>
        <Icon name="platform.macos" size={14} /> {t('hosts.type_macos')}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-xs"
          style={{ color: 'var(--gv-text-dim)' }}
          title={t('hosts.type_unknown_help')}>
      <AlertTriangle size={14} /> {t('hosts.type_unknown')}
    </span>
  );
}

// Distinguishes the host row that is the hub itself (no remote agent —
// the hub collects via local nvidia-smi). Helps the admin see at a
// glance which row they can't enroll/rotate/delete, and matches the
// "This host" wording used elsewhere.
// Version cell content. Extracted so the row renderer doesn't carry a
// nested ternary (SonarCloud S3358) — three mutually exclusive cases
// (local hub / agent with reported version / agent without one) read
// more clearly as guarded early returns.
function VersionCell({
  isLocal, agentVersion, installMode, kind, t,
}: Readonly<{
  isLocal: boolean;
  agentVersion: string | null;
  installMode: 'docker' | 'systemd' | 'windows' | 'macos' | 'unknown' | null;
  kind: string;
  t: (key: string, opts?: Record<string, unknown>) => string;
}>) {
  if (isLocal) {
    return <span title={t('hosts.hub_version_help')}>v{HUB_VERSION}</span>;
  }
  if (agentVersion) {
    const outdated = isAgentOutdated(agentVersion, HUB_VERSION);
    if (!outdated) {
      return <span title={t('hosts.agent_version_help')}>v{agentVersion}</span>;
    }
    return (
      <span className="inline-flex items-center gap-1.5">
        <span style={{ color: 'var(--gv-warn)' }} title={t('hosts.agent_version_help')}>
          v{agentVersion}
        </span>
        <AgentUpdateButton t={t} agentVersion={agentVersion} installMode={installMode} />
      </span>
    );
  }
  return <span style={{ color: 'var(--gv-text-dim)' }}>{kind}</span>;
}

/** Clickable warning shown when an agent is older than the hub.
 *  Click → copies the update one-liner that matches THIS host's
 *  install mode (docker vs systemd). The mode is reported by the
 *  agent in its hello frame (v0.5.3+); legacy / unknown agents get
 *  both recipes shown in the tooltip and the bare-metal one is
 *  copied as a sensible default. Running the bare-metal recipe on a
 *  Docker host creates a "double agent" install — that's exactly
 *  what this per-host selection avoids. */
function pickUpdateCmd(installMode: 'docker' | 'systemd' | 'windows' | 'macos' | 'unknown' | null, hubOrigin: string): {
  primary: string;
  /** Non-null when we are guessing — UI shows both recipes in the tooltip. */
  secondary: string | null;
} {
  const systemdCmd = `sudo curl -fsSL ${hubOrigin}/agent.mjs -o /opt/gpuviewr-agent/agent.mjs && sudo systemctl restart gpuviewr-agent`;
  const dockerCmd = 'cd ~/gpuviewr-agent-* && docker compose pull && docker compose up -d';
  // Windows: hub-pushed auto-update is the path of least friction (the
  // launcher.ps1 supervisor swaps agent.mjs.pending → agent.mjs on the
  // next iteration). If the admin doesn't have auto_update on, the
  // copy-paste form is to re-run the install.ps1 one-liner from the
  // Add Host modal, which re-downloads the bundle.
  const windowsCmd = `iwr ${hubOrigin}/agent.mjs -OutFile $env:ProgramData\\GpuViewR-Agent\\agent.mjs.pending -UseBasicParsing`;
  // macOS: re-download the bundle into the LaunchAgent's install dir,
  // then kick the LaunchAgent so it picks up the new agent.mjs
  // immediately instead of waiting for the next KeepAlive respawn.
  const macosCmd = `curl -fsSL ${hubOrigin}/agent.mjs -o "$HOME/Library/Application Support/GpuViewR-Agent/agent.mjs" && launchctl kickstart -k gui/$(id -u)/com.gpuviewr.agent`;
  if (installMode === 'systemd') return { primary: systemdCmd, secondary: null };
  if (installMode === 'docker') return { primary: dockerCmd, secondary: null };
  if (installMode === 'windows') return { primary: windowsCmd, secondary: null };
  if (installMode === 'macos') return { primary: macosCmd, secondary: null };
  return { primary: systemdCmd, secondary: dockerCmd };
}

function AgentUpdateButton({
  t, agentVersion, installMode,
}: Readonly<{
  t: (key: string, opts?: Record<string, unknown>) => string;
  agentVersion: string;
  installMode: 'docker' | 'systemd' | 'windows' | 'macos' | 'unknown' | null;
}>) {
  const hubOrigin = typeof globalThis.window === 'object' ? globalThis.location.origin : '';
  const { primary, secondary } = pickUpdateCmd(installMode, hubOrigin);
  const tooltipKey = secondary ? 'hosts.agent_outdated_help_both' : 'hosts.agent_outdated_help';
  const tooltip = t(tooltipKey, {
    agent: agentVersion,
    hub: HUB_VERSION,
    cmd: primary,
    cmd_alt: secondary ?? '',
  });
  const onClick = async () => {
    const ok = await copyText(primary);
    if (ok) notify('success', t('hosts.agent_outdated_copied'), primary);
    else notify('error', t('hosts.copy_failed'), t('hosts.copy_failed_hint'));
  };
  return (
    <button
      type="button"
      onClick={onClick}
      title={tooltip}
      aria-label={t('hosts.agent_outdated_badge')}
      className="inline-flex items-center gap-1 px-1 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider"
      style={{
        color: 'var(--gv-warn)',
        background: 'color-mix(in srgb, var(--gv-warn) 14%, transparent)',
        border: '1px solid color-mix(in srgb, var(--gv-warn) 35%, transparent)',
      }}
    >
      <AlertTriangle className="w-2.5 h-2.5" />
      {t('hosts.agent_outdated_pill')}
    </button>
  );
}

/** Semver-ish compare. Returns true if agent < hub. Treats bad/missing
 *  inputs as in-sync (no spurious warnings). Pre-release suffixes
 *  ('-mock', '-rc1') are stripped before compare — they're either
 *  test fixtures or release candidates we don't want to flag.
 *
 *  Implementation note: prefixes / suffixes are stripped with
 *  string ops (slice + indexOf + split) rather than regex to avoid
 *  the SonarCloud S5852 backtracking hotspot — `agent_version` is
 *  user-controllable (comes from agent hello frame stored in DB) so
 *  we don't trust the input length, and any catastrophic-backtracking
 *  pattern would be a free DoS vector on whatever browser tab opens
 *  the Hosts page.
 */
export function isAgentOutdated(agent: string, hub: string): boolean {
  const parse = (v: string): [number, number, number] | null => {
    let clean = v;
    if (clean.startsWith('v')) clean = clean.slice(1);
    const dashAt = clean.indexOf('-');
    if (dashAt >= 0) clean = clean.slice(0, dashAt);
    const parts = clean.split('.').map((p) => Number.parseInt(p, 10));
    if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null;
    return [parts[0], parts[1], parts[2]];
  };
  const a = parse(agent);
  const h = parse(hub);
  if (!a || !h) return false;
  if (a[0] !== h[0]) return a[0] < h[0];
  if (a[1] !== h[1]) return a[1] < h[1];
  return a[2] < h[2];
}

function HubBadge({ t }: Readonly<{ t: (key: string) => string }>) {
  return (
    <span
      className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full font-semibold uppercase tracking-wider"
      style={{
        color: 'var(--gv-info)',
        background: 'color-mix(in srgb, var(--gv-info) 14%, transparent)',
        border: '1px solid color-mix(in srgb, var(--gv-info) 35%, transparent)',
      }}
      title={t('hosts.hub_badge_help')}
    >
      <Server className="w-2.5 h-2.5" />
      {t('hosts.hub_badge')}
    </span>
  );
}

/** Toggle that flips a remote agent's status between 'disabled' and
 *  'offline' — the one control that actually stops the hub from
 *  accepting that agent's data. Disabling also force-closes any
 *  currently-live socket server-side (see setEnabled in hostsStore.ts),
 *  so the cutoff is immediate instead of waiting for the agent's next
 *  rejected reconnect attempt. */
function EnabledToggle({
  host, t,
}: Readonly<{
  host: HostRecord;
  t: (key: string, opts?: Record<string, unknown>) => string;
}>) {
  const setEnabled = useHostsStore((s) => s.setEnabled);
  const enabled = host.status !== 'disabled';
  const onClick = async () => {
    try {
      await setEnabled(host.id, !enabled);
      notify('success', t(enabled ? 'hosts.agent_disabled' : 'hosts.agent_enabled'), '');
    } catch (err) {
      notify('error', t('hosts.agent_enabled_failed'), (err as Error).message);
    }
  };
  return (
    <button
      type="button"
      title={t(enabled ? 'hosts.agent_toggle_on' : 'hosts.agent_toggle_off')}
      onClick={onClick}
      aria-pressed={enabled}
      className="inline-flex items-center justify-center w-8 h-8 rounded-lg transition-colors"
      style={{
        background: enabled ? 'transparent' : 'color-mix(in srgb, var(--gv-danger) 18%, transparent)',
        color: enabled ? 'var(--gv-text-muted)' : 'var(--gv-danger)',
        cursor: 'pointer',
      }}
      onMouseEnter={(e) => {
        if (enabled) e.currentTarget.style.background = 'var(--gv-surface-alt)';
      }}
      onMouseLeave={(e) => {
        if (enabled) e.currentTarget.style.background = 'transparent';
      }}
    >
      {enabled ? <Power size={14} /> : <PowerOff size={14} />}
    </button>
  );
}

/** Toggle that flips hosts.auto_update on the API. Compact icon button
 *  to match Rotate / Delete next to it. Disabled when the agent's
 *  install_mode is anything other than 'systemd' — Docker agents can't
 *  self-replace their bundled binary, and an 'unknown' agent is too
 *  old (pre-v0.5.3) to even handle the agent_update frame. The tooltip
 *  explains the state so admins don't wonder why it's greyed out. */
/** Whether the agent's install_mode supports hub-pushed auto-update.
 *  systemd: renameSync + RestartSec=5 — Linux atomic swap.
 *  windows: agent.mjs.pending + launcher.ps1 supervisor loop swap.
 *  macos: renameSync (APFS) + LaunchAgent KeepAlive respawn.
 *  Anything else (docker, unknown) cannot self-replace its bundle.
 *  Mirrors the check in server/services/agentIngestWS.ts so the UI
 *  state matches what the backend will actually accept. */
function isAgentSelfUpdatable(installMode: string | null | undefined): boolean {
  return installMode === 'systemd' || installMode === 'windows' || installMode === 'macos';
}

function AutoUpdateToggle({
  host, t,
}: Readonly<{
  host: HostRecord;
  t: (key: string, opts?: Record<string, unknown>) => string;
}>) {
  const setAutoUpdate = useHostsStore((s) => s.setAutoUpdate);
  const supported = isAgentSelfUpdatable(host.install_mode);
  const enabled = host.auto_update === 1;
  const titleKey = supported
    ? (enabled ? 'hosts.auto_update_on' : 'hosts.auto_update_off')
    : 'hosts.auto_update_unsupported';
  // Build a multi-line tooltip suffix with the scheduler state when
  // auto_update is on. \n renders as newline in browser native tooltips
  // since Chrome 100+ / Firefox 89+. Falls back gracefully on older
  // browsers (newline shown as space).
  const titleSuffix = (() => {
    if (!supported || !enabled) return '';
    const nowSec = Math.floor(Date.now() / 1000);
    const parts: string[] = [];
    if (host.last_update_check_at) {
      parts.push(`\n${t('hosts.auto_update_last_check', { ago: formatRelative(nowSec - host.last_update_check_at) })}`);
    } else {
      parts.push(`\n${t('hosts.auto_update_never_checked')}`);
    }
    if (host.last_update_pushed_at && host.last_update_pushed_version) {
      parts.push(`\n${t('hosts.auto_update_last_push', {
        version: host.last_update_pushed_version,
        ago: formatRelative(nowSec - host.last_update_pushed_at),
      })}`);
    }
    return parts.join('');
  })();
  const onClick = async () => {
    if (!supported) return;
    try {
      await setAutoUpdate(host.id, !enabled);
      notify('success', t(enabled ? 'hosts.auto_update_disabled' : 'hosts.auto_update_enabled'), '');
    } catch (err) {
      notify('error', t('hosts.auto_update_failed'), (err as Error).message);
    }
  };
  return (
    <button
      type="button"
      title={t(titleKey) + titleSuffix}
      onClick={onClick}
      disabled={!supported}
      aria-pressed={enabled}
      className="inline-flex items-center justify-center w-8 h-8 rounded-lg transition-colors"
      style={{
        background: enabled ? 'color-mix(in srgb, var(--gv-accent) 18%, transparent)' : 'transparent',
        color: !supported
          ? 'var(--gv-text-dim)'
          : (enabled ? 'var(--gv-accent)' : 'var(--gv-text-muted)'),
        cursor: supported ? 'pointer' : 'not-allowed',
        opacity: supported ? 1 : 0.4,
      }}
      onMouseEnter={(e) => {
        if (supported && !enabled) e.currentTarget.style.background = 'var(--gv-surface-alt)';
      }}
      onMouseLeave={(e) => {
        if (!enabled) e.currentTarget.style.background = 'transparent';
      }}
    >
      <RefreshCw size={14} />
    </button>
  );
}

/** Manual "Update now" button: bypasses the auto_update + cooldown +
 *  version-compare gates and asks the hub to push the current bundle
 *  to this agent right now. Only enabled for systemd hosts that are
 *  currently online — Docker bundles are baked in the image (immutable)
 *  and an offline agent has no WS to push down. */
function ForceUpdateButton({
  host, t,
}: Readonly<{
  host: HostRecord;
  t: (key: string, opts?: Record<string, unknown>) => string;
}>) {
  const forceUpdate = useHostsStore((s) => s.forceUpdate);
  const [busy, setBusy] = useState(false);
  const supported = isAgentSelfUpdatable(host.install_mode);
  const online = host.status === 'online';
  const canPush = supported && online && !busy;
  const titleKey = (() => {
    if (!supported) return 'hosts.force_update_unsupported';
    if (!online) return 'hosts.force_update_offline';
    return 'hosts.force_update';
  })();
  const onClick = async () => {
    if (!canPush) return;
    setBusy(true);
    try {
      const { version } = await forceUpdate(host.id);
      notify('success', t('hosts.force_update_sent'), `v${version}`);
    } catch (err) {
      notify('error', t('hosts.force_update_failed'), (err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      title={t(titleKey)}
      onClick={onClick}
      disabled={!canPush}
      className="inline-flex items-center justify-center w-8 h-8 rounded-lg transition-colors"
      style={{
        background: 'transparent',
        color: canPush ? 'var(--gv-text-muted)' : 'var(--gv-text-dim)',
        cursor: canPush ? 'pointer' : 'not-allowed',
        opacity: canPush ? 1 : 0.4,
      }}
      onMouseEnter={(e) => { if (canPush) e.currentTarget.style.background = 'var(--gv-surface-alt)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
    >
      <DownloadCloud size={14} className={busy ? 'animate-pulse' : undefined} />
    </button>
  );
}

function IconBtn({
  children, title, danger, onClick,
}: Readonly<{ children: React.ReactNode; title: string; danger?: boolean; onClick: () => void }>) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="inline-flex items-center justify-center w-8 h-8 rounded-lg transition-colors"
      style={{
        background: 'transparent',
        color: danger ? 'var(--gv-danger)' : 'var(--gv-text-muted)',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--gv-surface-alt)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
    >
      {children}
    </button>
  );
}

function RotateTokenModal({ host, onClose }: Readonly<{ host: HostRecord; onClose: () => void }>) {
  const { t } = useTranslation();
  const rotateToken = useHostsStore((s) => s.rotateToken);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [rotating, setRotating] = useState(false);
  const [copied, setCopied] = useState(false);
  const [mode, setMode] = useState<InstallMode>(() => defaultModeFor(host.install_mode));

  const doRotate = async () => {
    setRotating(true);
    try {
      const token = await rotateToken(host.id);
      setNewToken(token);
    } catch (err) {
      notify('error', t('hosts.rotate_failed'), (err as Error).message);
    } finally {
      setRotating(false);
    }
  };

  // Three install one-liners pre-filled with the new composite
  // token. The hub URL is derived from the current page since the
  // user clicking Rotate is necessarily looking at the hub UI right
  // now — no API round-trip needed. See _installCommands.tsx for
  // the templates (shared with EnrollHostModal).
  const hubHttp = `${globalThis.location.protocol}//${globalThis.location.host}`;
  const cmdByMode = newToken
    ? buildInstallCommands(hubHttp, newToken)
    : { curl: '', docker: '', windows: '', macos: '' };
  const activeCmd = cmdByMode[mode];

  const copy = async () => {
    if (!activeCmd) return;
    const ok = await copyText(activeCmd);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } else {
      notify('error', t('hosts.copy_failed'), t('hosts.copy_failed_hint'));
    }
  };

  return (
    <ModalShell
      title={t('hosts.rotate_title', { label: host.label })}
      hint={newToken ? t('hosts.rotate_done_hint') : t('hosts.rotate_intro')}
      onClose={onClose}
      maxWidth="max-w-2xl"
    >
      <WarningBanner>{t('hosts.rotate_warning')}</WarningBanner>

      {!newToken && (
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn-ghost">{t('common.cancel')}</button>
          <button type="button" onClick={doRotate} disabled={rotating} className="btn-danger">
            {t('hosts.rotate_confirm')}
          </button>
        </div>
      )}

      {newToken && (
        <>
          {/* Re-install command picker — same widget the Add-host
              modal uses. Default selection follows the host's
              reported install_mode so the user sees their own
              platform's command first. */}
          <InstallModePicker mode={mode} onChange={setMode} />

          <CopyValueBlock
            label={t(LABEL_KEY_BY_MODE[mode])}
            value={activeCmd}
            onCopy={copy}
            copied={copied}
            kind="monoWrap"
            sensitive
          />

          {/* Plain token for advanced users who want to wire it
              themselves into custom installers / Ansible / etc. */}
          <details className="text-xs">
            <summary className="cursor-pointer" style={{ color: 'var(--gv-text-muted)' }}>
              {t('hosts.rotate_show_raw_token')}
            </summary>
            <div className="mt-2">
              <CopyValueBlock
                label={t('hosts.new_token')}
                value={newToken}
                onCopy={async () => { await copyText(newToken); }}
                copied={false}
                kind="monoWrap"
                sensitive
              />
            </div>
          </details>

          <div className="flex justify-end">
            <button type="button" onClick={onClose} className="btn-primary">{t('common.done')}</button>
          </div>
        </>
      )}
    </ModalShell>
  );
}

// Confirmation modal for deleting a host. Shows the uninstall command
// up-front so the admin can clean the agent on the remote machine
// BEFORE the hub forgets it — otherwise systemd retries the (rejected)
// connection in a loop until manual intervention.
function DeleteHostModal({ host, onClose }: Readonly<{ host: HostRecord; onClose: () => void }>) {
  const { t } = useTranslation();
  const remove = useHostsStore((s) => s.remove);
  const [mode, setMode] = useState<InstallMode>(() => defaultModeFor(host.install_mode));
  const [copied, setCopied] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Uninstall commands per platform. Linux bash + Docker are
  // one-liners; Windows needs two lines because `iex` can't forward
  // the `-Uninstall` flag — we download the script with iwr then
  // invoke it with the flag, mirroring the hint install.ps1.tpl
  // prints at the end of a successful install.
  const hubHttp = `${globalThis.location.protocol}//${globalThis.location.host}`;
  const cmdByMode: Record<InstallMode, string> = {
    curl: `curl -fsSL ${hubHttp}/install.sh | sudo bash -s -- --uninstall`,
    docker: `docker rm -f gpuviewr-agent`,
    windows: `iwr ${hubHttp}/install.ps1 -OutFile $env:TEMP\\gpvr-uninstall.ps1 -UseBasicParsing\n& $env:TEMP\\gpvr-uninstall.ps1 -Uninstall`,
    macos: `curl -fsSL ${hubHttp}/install.mac.sh | bash -s -- --uninstall`,
  };
  const activeCmd = cmdByMode[mode];

  const copy = async () => {
    const ok = await copyText(activeCmd);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } else {
      notify('error', t('hosts.copy_failed'), t('hosts.copy_failed_hint'));
    }
  };

  const doDelete = async () => {
    setDeleting(true);
    try {
      await remove(host.id);
      notify('success', t('hosts.deleted'), host.label);
      onClose();
    } catch (err) {
      notify('error', t('hosts.delete_failed'), (err as Error).message);
      setDeleting(false);
    }
  };

  return (
    <ModalShell
      title={t('hosts.delete_title', { label: host.label })}
      hint={t('hosts.delete_intro')}
      onClose={onClose}
    >
      <WarningBanner>{t('hosts.delete_warning_orphan')}</WarningBanner>

      <p className="text-sm" style={{ color: 'var(--gv-text-muted)' }}>
        {t('hosts.delete_uninstall_hint')}
      </p>

      {host.install_mode && host.install_mode !== 'unknown' ? (
        <p className="text-xs" style={{ color: 'var(--gv-text-dim)' }}>
          {t('hosts.delete_detected_mode', { mode: t(TAB_LABEL_KEY_BY_MODE[defaultModeFor(host.install_mode)]) })}
        </p>
      ) : (
        <p className="text-xs" style={{ color: 'var(--gv-warn)' }}>
          {t('hosts.delete_unknown_mode_warning')}
        </p>
      )}

      <InstallModePicker mode={mode} onChange={setMode} />

      <CopyValueBlock
        label={t('hosts.uninstall_cmd')}
        value={activeCmd}
        onCopy={copy}
        copied={copied}
        kind="pre"
      />

      <p className="text-xs" style={{ color: 'var(--gv-text-dim)' }}>
        {t('hosts.delete_history_kept')}
      </p>

      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} disabled={deleting} className="btn-ghost">
          {t('common.cancel')}
        </button>
        <button type="button" onClick={doDelete} disabled={deleting} className="btn-danger">
          <Trash2 size={14} /> {t('hosts.delete_confirm')}
        </button>
      </div>
    </ModalShell>
  );
}

function RejectedAttemptsPanel({ attempts }: Readonly<{ attempts: RejectedAttempt[] }>) {
  const { t } = useTranslation();
  const clearRejectedAttempts = useHostsStore((s) => s.clearRejectedAttempts);
  const [clearing, setClearing] = useState(false);

  const doClear = async () => {
    setClearing(true);
    try {
      await clearRejectedAttempts();
    } catch (err) {
      notify('error', t('hosts.rejected_clear_failed'), (err as Error).message);
    } finally {
      setClearing(false);
    }
  };

  const now = Math.floor(Date.now() / 1000);

  return (
    <div className="card p-4 space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold flex items-center gap-1.5">
            <AlertTriangle size={14} style={{ color: 'var(--gv-warn)' }} />
            {t('hosts.rejected_title')}
          </h3>
          <p className="text-xs mt-0.5" style={{ color: 'var(--gv-text-muted)' }}>
            {t('hosts.rejected_help')}
          </p>
        </div>
        <button type="button" onClick={doClear} disabled={clearing} className="btn-ghost text-xs">
          {t('hosts.rejected_clear')}
        </button>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left uppercase tracking-wider" style={{ color: 'var(--gv-text-dim)' }}>
              <th className="px-3 py-1.5 font-medium">{t('hosts.rejected_col_time')}</th>
              <th className="px-3 py-1.5 font-medium">{t('hosts.rejected_col_ip')}</th>
              <th className="px-3 py-1.5 font-medium">{t('hosts.rejected_col_host_id')}</th>
              <th className="px-3 py-1.5 font-medium">{t('hosts.rejected_col_reason')}</th>
            </tr>
          </thead>
          <tbody>
            {attempts.map((a) => (
              <tr
                key={`${a.ts}-${a.ip}-${a.host_id}-${a.reason}`}
                className="border-t"
                style={{ borderColor: 'var(--gv-border)' }}
              >
                <td className="px-3 py-1.5 font-mono" style={{ color: 'var(--gv-text-muted)' }}>
                  {formatRelative(now - Math.floor(a.ts / 1000))}
                </td>
                <td className="px-3 py-1.5 font-mono">{a.ip}</td>
                <td className="px-3 py-1.5 font-mono" title={a.host_id}>
                  {a.host_id.length > 20 ? `${a.host_id.slice(0, 20)}…` : a.host_id}
                </td>
                <td className="px-3 py-1.5">
                  <span>{t(`hosts.rejected_reason_${a.reason}`)}</span>
                  {a.flood && (
                    <span
                      className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase"
                      style={{ background: 'var(--gv-danger)', color: 'white' }}
                      title={t('hosts.rejected_flood_help')}
                    >
                      {t('hosts.rejected_flood_badge')}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
