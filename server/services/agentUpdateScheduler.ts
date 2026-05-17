// Periodic scheduler that pushes hub-side bundle updates to connected
// systemd agents that opted into auto_update.
//
// Background: until v0.6.5 the only trigger for an auto-update was the
// WS hello frame (cf. agentIngestWS.maybePushAutoUpdate, called from
// handleHello). That meant a stable, long-connected agent NEVER picked
// up a new hub version — the "Update now" button was the only way to
// force a stable agent forward. This scheduler closes that gap.
//
// Design notes:
//  - Reuses maybePushAutoUpdate so the four gate checks (opt-in,
//    install_mode=systemd, isOlder, cooldown) stay in one place and
//    can't drift between the welcome path and the periodic path.
//  - last_update_check_at is written on every tick that *considers* a
//    host, even when no push happens — that's what the UI tooltip
//    surfaces as "last checked Xm ago".
//  - last_update_pushed_at / last_update_pushed_version are written by
//    maybePushAutoUpdate itself only on a successful push.
//  - First tick is delayed 30 s after boot so we don't hammer fresh
//    agents that are still completing their initial welcome handshake.
//  - Interval configurable via AUTO_UPDATE_CHECK_INTERVAL_MS env (in
//    milliseconds). Default 1 h is a tradeoff: too short = log noise +
//    needless DB writes, too long = stale fleet after a hub upgrade.

import { WebSocket } from 'ws';
import { logger } from '../utils/logger.js';
import { HostsRepo } from '../database/models/Host.js';
import { liveAgentSockets, maybePushAutoUpdate } from './agentIngestWS.js';

const CHECK_INTERVAL_MS = (() => {
  const raw = Number.parseInt(process.env.AUTO_UPDATE_CHECK_INTERVAL_MS ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 60 * 60_000;
})();

/** Boot-time grace period before the first tick. Lets fresh agents
 *  settle into their welcome handshake (and the welcome-time push
 *  fire normally) before we layer the periodic path on top. */
const FIRST_TICK_DELAY_MS = 30_000;

let intervalTimer: NodeJS.Timeout | null = null;
let firstTickTimer: NodeJS.Timeout | null = null;

function tick(hubVersion: string): void {
  const now = Math.floor(Date.now() / 1000);
  let considered = 0;
  for (const host of HostsRepo.list()) {
    // Only hosts that have opted in AND can actually swap their binary
    // are worth considering. Same gates as maybePushAutoUpdate; we
    // pre-filter here to avoid the DB write below on hosts that would
    // bail out in the first line of the inner function anyway.
    if (host.kind !== 'agent') continue;
    if (!host.auto_update) continue;
    if (host.install_mode !== 'systemd') continue;
    const ws = liveAgentSockets.get(host.id);
    if (!ws || ws.readyState !== WebSocket.OPEN) continue;
    considered++;
    // Record that we looked, regardless of whether the inner gates
    // (isOlder, cooldown) decide to push.
    HostsRepo.update(host.id, { last_update_check_at: now });
    maybePushAutoUpdate(ws, host, hubVersion);
  }
  if (considered > 0) {
    logger.debug('autoUpdate', `Scheduler tick: ${considered} host(s) considered (interval=${CHECK_INTERVAL_MS / 1000}s)`);
  }
}

export function startAutoUpdateScheduler(hubVersion: string): void {
  if (intervalTimer || firstTickTimer) return;
  logger.info(
    'autoUpdate',
    `Scheduler armed (first tick in ${FIRST_TICK_DELAY_MS / 1000}s, then every ${CHECK_INTERVAL_MS / 1000}s)`,
  );
  firstTickTimer = setTimeout(() => {
    firstTickTimer = null;
    tick(hubVersion);
    intervalTimer = setInterval(() => tick(hubVersion), CHECK_INTERVAL_MS);
    // Unref so the timer doesn't keep the event loop alive on shutdown.
    intervalTimer.unref?.();
  }, FIRST_TICK_DELAY_MS);
  firstTickTimer.unref?.();
}

export function stopAutoUpdateScheduler(): void {
  if (firstTickTimer) {
    clearTimeout(firstTickTimer);
    firstTickTimer = null;
  }
  if (intervalTimer) {
    clearInterval(intervalTimer);
    intervalTimer = null;
  }
}
