import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../utils/logger.js';
import { AppConfigRepo, ensureAppConfigSchema } from '../database/models/AppConfig.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REPO_OWNER = 'Erreur32';
const REPO_NAME = 'GpuViewR';
const GHCR_IMAGE = 'erreur32/gpuviewr';

const CONFIG_KEY = 'update_check_config';
const CACHE_KEY = 'update_check_cache';

const DEFAULT_FREQUENCY_HOURS = 24;
const DEFAULT_ENABLED = true;
const RELEASE_NOTES_MAX = 800;

export interface UpdateCheckConfig {
  enabled: boolean;
  /** Hours between cached checks. */
  frequencyHours: number;
}

export interface UpdateCheckResult {
  enabled: boolean;
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  dockerReady: boolean;
  releaseNotes: string | null;
  releaseUrl: string | null;
  checkedAt: string;
  message: string;
  /** True when we returned a cached result instead of hitting the network. */
  fromCache: boolean;
  error?: string;
}

interface CachedEnvelope {
  cachedAt: string;
  result: UpdateCheckResult;
}

export const updateService = {
  init(): void {
    ensureAppConfigSchema();
    // Seed default config on first boot
    if (!AppConfigRepo.getJson<UpdateCheckConfig>(CONFIG_KEY)) {
      AppConfigRepo.setJson<UpdateCheckConfig>(CONFIG_KEY, {
        enabled: DEFAULT_ENABLED,
        frequencyHours: DEFAULT_FREQUENCY_HOURS,
      });
    }
    // Invalidate the cache if the running version no longer matches what was
    // cached (e.g. after a version bump): otherwise the panel keeps showing the
    // old "current" / "latest" pair until the cache TTL elapses.
    const cached = AppConfigRepo.getJson<CachedEnvelope>(CACHE_KEY);
    const current = this.getCurrentVersion();
    if (cached && cached.result.currentVersion !== current) {
      AppConfigRepo.set(CACHE_KEY, '');
      logger.info('updates', `Version changed (${cached.result.currentVersion} → ${current}), update cache invalidated.`);
    }
    logger.info('updates', `Update checker ready (enabled=${this.getConfig().enabled}, current=${current})`);
  },

  getConfig(): UpdateCheckConfig {
    return (
      AppConfigRepo.getJson<UpdateCheckConfig>(CONFIG_KEY)
      ?? { enabled: DEFAULT_ENABLED, frequencyHours: DEFAULT_FREQUENCY_HOURS }
    );
  },

  setConfig(patch: Partial<UpdateCheckConfig>): UpdateCheckConfig {
    const current = this.getConfig();
    const merged: UpdateCheckConfig = {
      enabled: patch.enabled ?? current.enabled,
      frequencyHours: clamp(patch.frequencyHours ?? current.frequencyHours, 1, 7 * 24),
    };
    AppConfigRepo.setJson<UpdateCheckConfig>(CONFIG_KEY, merged);
    if (patch.frequencyHours !== undefined || patch.enabled !== undefined) {
      // Invalidate cache so the next check refreshes immediately.
      AppConfigRepo.set(CACHE_KEY, '');
    }
    return merged;
  },

  getCurrentVersion(): string {
    try {
      const pkgPath = path.resolve(__dirname, '..', '..', 'package.json');
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: string };
      return pkg.version || '0.0.0';
    } catch (err) {
      logger.warn('updates', `Cannot read package.json: ${(err as Error).message}`);
      return '0.0.0';
    }
  },

  /** Public version-comparison helper (semver x.y.z, missing parts treated as 0). */
  compareVersions(a: string, b: string): number {
    const pa = a.replace(/^v/, '').split('.').map((n) => Number.parseInt(n, 10) || 0);
    const pb = b.replace(/^v/, '').split('.').map((n) => Number.parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const ai = pa[i] || 0;
      const bi = pb[i] || 0;
      if (ai > bi) return 1;
      if (ai < bi) return -1;
    }
    return 0;
  },

  async check(force = false): Promise<UpdateCheckResult> {
    const config = this.getConfig();
    const currentVersion = this.getCurrentVersion();

    if (!config.enabled) {
      return {
        enabled: false,
        currentVersion,
        latestVersion: null,
        updateAvailable: false,
        dockerReady: false,
        releaseNotes: null,
        releaseUrl: null,
        checkedAt: new Date().toISOString(),
        message: 'Update checking is disabled.',
        fromCache: false,
      };
    }

    if (!force) {
      const cached = AppConfigRepo.getJson<CachedEnvelope>(CACHE_KEY);
      if (cached && cached.cachedAt) {
        const ageMs = Date.now() - new Date(cached.cachedAt).getTime();
        if (ageMs >= 0 && ageMs < config.frequencyHours * 3_600_000) {
          return { ...cached.result, fromCache: true };
        }
      }
    }

    const result = await this.runCheck(currentVersion);
    AppConfigRepo.setJson<CachedEnvelope>(CACHE_KEY, { cachedAt: result.checkedAt, result });
    return result;
  },

  async runCheck(currentVersion: string): Promise<UpdateCheckResult> {
    const headers = buildGithubHeaders();
    const checkedAt = new Date().toISOString();

    const tagResult = await this.fetchLatestTag(headers);
    if (tagResult.kind === 'error') return failResult(currentVersion, checkedAt, tagResult.error);
    if (tagResult.kind === 'empty') return emptyResult(currentVersion, checkedAt);

    const latestVersion = tagResult.tag;
    const updateAvailable = this.compareVersions(latestVersion, currentVersion) > 0;
    const dockerReady = updateAvailable ? await this.dockerImageAvailable(latestVersion) : true;
    const { releaseNotes, releaseUrl } = await this.fetchReleaseDetails(latestVersion, headers);
    const message = buildMessage(currentVersion, latestVersion, updateAvailable, dockerReady);

    logger.info('updates', message);

    return {
      enabled: true,
      currentVersion,
      latestVersion,
      updateAvailable,
      dockerReady,
      releaseNotes,
      releaseUrl,
      checkedAt,
      message,
      fromCache: false,
    };
  },

  // Fetches /tags from GitHub and returns the highest semver-tagged release.
  // Split out so runCheck() stays a flat sequence of awaits (Sonar S3776).
  async fetchLatestTag(headers: Record<string, string>): Promise<
    | { kind: 'tag'; tag: string }
    | { kind: 'empty' }
    | { kind: 'error'; error: string }
  > {
    try {
      const tagsRes = await fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/tags`, { headers });
      if (!tagsRes.ok) return { kind: 'error', error: `GitHub Tags API ${tagsRes.status}` };
      const tags = (await tagsRes.json()) as Array<{ name: string }>;
      const semverTags = tags
        .map((t) => t.name.replace(/^v/, ''))
        .filter((n) => /^\d+\.\d+\.\d+$/.test(n))
        .sort((a, b) => this.compareVersions(b, a));
      if (semverTags.length === 0) return { kind: 'empty' };
      return { kind: 'tag', tag: semverTags[0] };
    } catch (err) {
      return { kind: 'error', error: (err as Error).message };
    }
  },

  async fetchReleaseDetails(
    version: string,
    headers: Record<string, string>,
  ): Promise<{ releaseNotes: string | null; releaseUrl: string }> {
    let releaseNotes: string | null = null;
    let releaseUrl: string | null = null;
    try {
      const relRes = await fetch(
        `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/tags/v${version}`,
        { headers },
      );
      if (relRes.ok) {
        const release = (await relRes.json()) as { body?: string; html_url?: string };
        if (release.body) releaseNotes = trim(release.body, RELEASE_NOTES_MAX);
        if (release.html_url) releaseUrl = release.html_url;
      }
    } catch {
      // ignore: fall back to local CHANGELOG
    }
    return {
      releaseNotes: releaseNotes ?? readChangelogSection(version),
      releaseUrl: releaseUrl ?? `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/tag/v${version}`,
    };
  },

  /** Verify the image tag has been built on GHCR (anonymous pull token). */
  async dockerImageAvailable(version: string): Promise<boolean> {
    try {
      const tokenRes = await fetch(
        `https://ghcr.io/token?scope=repository:${GHCR_IMAGE}:pull&service=ghcr.io`,
      );
      if (!tokenRes.ok) return false;
      const tokenData = (await tokenRes.json()) as { token?: string };
      if (!tokenData.token) return false;

      const manifestRes = await fetch(`https://ghcr.io/v2/${GHCR_IMAGE}/manifests/${version}`, {
        method: 'HEAD',
        headers: {
          Authorization: `Bearer ${tokenData.token}`,
          Accept: 'application/vnd.docker.distribution.manifest.v2+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.oci.image.manifest.v1+json,application/vnd.oci.image.index.v1+json',
        },
      });
      return manifestRes.ok;
    } catch {
      return false;
    }
  },
};

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function buildGithubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'GpuViewR-UpdateChecker/1.0',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (process.env.GITHUB_TOKEN) headers['Authorization'] = `token ${process.env.GITHUB_TOKEN}`;
  return headers;
}

function failResult(currentVersion: string, checkedAt: string, error: string): UpdateCheckResult {
  return {
    enabled: true,
    currentVersion,
    latestVersion: null,
    updateAvailable: false,
    dockerReady: false,
    releaseNotes: null,
    releaseUrl: null,
    checkedAt,
    message: 'Could not reach the update server.',
    fromCache: false,
    error,
  };
}

function emptyResult(currentVersion: string, checkedAt: string): UpdateCheckResult {
  return {
    enabled: true,
    currentVersion,
    latestVersion: null,
    updateAvailable: false,
    dockerReady: false,
    releaseNotes: null,
    releaseUrl: null,
    checkedAt,
    message: 'No published releases yet.',
    fromCache: false,
  };
}

function buildMessage(current: string, latest: string, updateAvailable: boolean, dockerReady: boolean): string {
  if (!updateAvailable) return `You are running the latest version (${current}).`;
  if (dockerReady) return `Update available: ${current} → ${latest}`;
  return `New release ${latest} tagged but the Docker image is not ready yet.`;
}

function trim(s: string, max: number): string {
  if (s.length <= max) return s.trim();
  const cut = s.slice(0, max);
  const lastNl = cut.lastIndexOf('\n');
  return (lastNl > max * 0.6 ? cut.slice(0, lastNl) : cut).trim() + '…';
}

function readChangelogSection(version: string): string | null {
  try {
    const filePath = path.resolve(__dirname, '..', '..', 'CHANGELOG.md');
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf8');
    const header = `## [${version}]`;
    const start = content.indexOf(header);
    if (start === -1) return null;
    const bodyStart = content.indexOf('\n', start) + 1;
    const next = content.indexOf('\n## [', bodyStart);
    const body = (next === -1 ? content.slice(bodyStart) : content.slice(bodyStart, next)).trim();
    return trim(body, RELEASE_NOTES_MAX);
  } catch {
    return null;
  }
}
