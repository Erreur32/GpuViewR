import { AppConfigRepo } from '../database/models/AppConfig.js';

// On/off switches for the read-only API and the MCP endpoint. Both are
// off until an admin turns them on in Settings.

export type AccessSurface = 'api' | 'mcp';

const KEY: Record<AccessSurface, string> = { api: 'access.api_enabled', mcp: 'access.mcp_enabled' };

export const accessSettings = {
  isEnabled(surface: AccessSurface): boolean {
    return AppConfigRepo.get(KEY[surface]) === '1';
  },
  setEnabled(surface: AccessSurface, enabled: boolean): void {
    AppConfigRepo.set(KEY[surface], enabled ? '1' : '0');
  },
};
