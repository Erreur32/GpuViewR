// Periodic "is this agent still alive?" check. The handshake itself
// sets status='online' and markSeen() is throttled to 1Hz inside the
// WS dispatcher; this watchdog complements that by flipping the dot
// red when the agent stops sending — including the legitimate cases
// of "OS reboot", "user pulled the network cable", "Docker daemon
// crashed", etc., where the WS close event may not arrive at the hub
// at all.

import { HostsRepo } from '../database/models/Host.js';
import { metricsBus } from './_metricsBus.js';
import { logger } from '../utils/logger.js';

const WATCHDOG_TICK_MS = 5_000;
const OFFLINE_THRESHOLD_S = 30;

export function startHostsWatchdog(): NodeJS.Timeout {
  logger.info('agent', `Hosts watchdog started (tick=${WATCHDOG_TICK_MS}ms, offline-threshold=${OFFLINE_THRESHOLD_S}s)`);
  return setInterval(() => {
    const now = Math.floor(Date.now() / 1000);
    for (const h of HostsRepo.list()) {
      if (h.kind !== 'agent') continue;
      if (h.status === 'disabled' || h.status === 'offline') continue;
      if (h.status === 'pending') continue;
      if (h.last_seen === null) continue;
      const lag = now - h.last_seen;
      if (lag > OFFLINE_THRESHOLD_S) {
        HostsRepo.setStatus(h.id, 'offline');
        metricsBus.emit('host_status', { host_id: h.id, status: 'offline', last_seen: h.last_seen });
        logger.warn('agent', `Host ${h.id} (label=${h.label}) flipped offline (last seen ${lag}s ago)`);
      }
    }
  }, WATCHDOG_TICK_MS);
}
