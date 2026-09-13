// In-memory record of agent WS handshakes that failed authentication
// (bad token, unknown/deleted host_id, disabled host). Purely
// operational: it resets on hub restart and is NOT an audit trail —
// gpu_metrics/alert_events already cover long-term history for known
// hosts (see routes/hosts.ts DELETE comment). This just answers "is
// something still knocking after I deleted/uninstalled it?".

export type RejectionReason = 'unknown_host' | 'bad_token' | 'disabled' | 'missing_credentials';

export interface RejectedAttempt {
  ip: string;
  host_id: string;
  reason: RejectionReason;
  ts: number;
}

export interface RejectedAttemptView extends RejectedAttempt {
  /** True when this host_id logged >= FLOOD_THRESHOLD attempts within
   *  FLOOD_WINDOW_MS — lets the UI distinguish a stray/transient retry
   *  (e.g. an agent still winding down 30s after deletion) from a
   *  botched uninstall stuck in a permanent reconnect loop. */
  flood: boolean;
}

const MAX_ENTRIES = 50;
const RETENTION_MS = 60 * 60 * 1000; // 1h
const FLOOD_WINDOW_MS = 5 * 60 * 1000; // 5min
const FLOOD_THRESHOLD = 5;

let attempts: RejectedAttempt[] = [];

function prune(now: number): void {
  const cutoff = now - RETENTION_MS;
  attempts = attempts.filter((a) => a.ts >= cutoff);
}

export function recordRejection(entry: Omit<RejectedAttempt, 'ts'>): void {
  const now = Date.now();
  prune(now);
  attempts.push({ ...entry, ts: now });
  if (attempts.length > MAX_ENTRIES) attempts = attempts.slice(attempts.length - MAX_ENTRIES);
}

export function listRejections(): RejectedAttemptView[] {
  const now = Date.now();
  prune(now);
  // Most recent first. n <= MAX_ENTRIES (50) so the O(n^2) flood scan
  // is cheap; not worth a smarter grouping structure at this scale.
  return [...attempts]
    .reverse()
    .map((a) => ({
      ...a,
      flood: attempts.filter((o) => o.host_id === a.host_id && now - o.ts <= FLOOD_WINDOW_MS).length >= FLOOD_THRESHOLD,
    }));
}

export function clearRejections(): void {
  attempts = [];
}
