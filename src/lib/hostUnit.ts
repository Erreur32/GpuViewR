// Whether a host's systemd unit predates v0.10.2 and needs
// `install.sh --upgrade`. The agent reports its CAP_SYS_PTRACE state in
// the hello capabilities (agent/src/transport.ts ptraceState); auto-update
// only replaces the bundle, so an old unit stays without it until someone
// with root on the host refreshes it.

/** `capabilities` is the JSON string stored from the agent's hello.
 *  Only an explicit "missing" from a systemd agent counts: an install
 *  made with --no-ptrace reports "declined", older agents report nothing. */
export function isUnitOutdated(capabilities: string | null, installMode: string | null): boolean {
  if (installMode !== 'systemd' || !capabilities) return false;
  try {
    const caps: unknown = JSON.parse(capabilities);
    return typeof caps === 'object' && caps !== null && (caps as { ptrace?: unknown }).ptrace === 'missing';
  } catch {
    return false;
  }
}
