// Ollama manifest resolver. Maps the sha256 blob digest the agent
// sees in the Ollama runner cmdline (e.g.
// `/usr/bin/ollama runner --model /root/.ollama/models/blobs/sha256-a3de86cd1c13...`)
// to a human-friendly model name (e.g. `llama3.1:8b`).
//
// Why a resolver and not in-line filesystem reads from the
// classifier: the classifier (llmClassifier.ts) runs once per GPU
// process per tick, anything > O(1) there blows up CPU. We do the
// scan once at agent boot, cache it in a Map, and refresh on a
// long interval (5 min default — manifests barely change). Stale
// data for a few minutes after `ollama pull` is acceptable for a
// monitoring tool.
//
// Manifest layout (Ollama v0.1+):
//
//   <root>/manifests/registry.ollama.ai/library/<model>/<tag>
//
// Each tag file is a JSON manifest with:
//   {
//     "schemaVersion": 2,
//     "config": { ..., "digest": "sha256:abc..." },
//     "layers": [
//       { "mediaType": "application/vnd.ollama.image.model",
//         "digest": "sha256:XYZ", "size": ... },
//       ...
//     ]
//   }
//
// We index by the model-layer digest (the big file holding actual
// weights — same hash that ends up on disk as
// blobs/sha256-XYZ). That's the digest the runner process opens
// and the one we extract from the cmdline.
//
// Discovery: the script tries these locations in order and uses
// the first one that exists. Operators can pin it via
// `OLLAMA_MANIFESTS_DIR=`.
//
//   1. $OLLAMA_MANIFESTS_DIR   (explicit override)
//   2. /host/ollama/models/manifests  (docker bind-mount of ~/.ollama)
//   3. /usr/share/ollama/.ollama/models/manifests
//                              (systemd `ollama` user default)
//   4. $HOME/.ollama/models/manifests (per-user install)
//   5. /root/.ollama/models/manifests (root user, ollama-as-root install)
// Each root is also tried without the `models/` segment.
//
// That static dir misses Ollama running in its own container, or with
// a custom OLLAMA_MODELS. So on a digest miss, resolve() also looks
// next to the blob itself: `<models>/blobs/sha256-…` sits beside
// `<models>/manifests`. Tried through `<hostProc>/<pid>/root` (the
// runner's own mount namespace, needs ptrace access like fdinfo), then
// mapped to our namespace via mountinfo (a Docker bind mount of
// ~/.ollama resolves to its host dir, which unlike the container's
// /root is usually readable), then as a plain path.

import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';
import { logger } from '../logger.js';
import type { OllamaDigestContext } from './llmClassifier.js';

interface OllamaManifestLayer {
  mediaType?: string;
  digest?: string;
}

interface OllamaManifest {
  layers?: OllamaManifestLayer[];
}

export interface OllamaResolver {
  /** Look up a `sha256:<hex>` digest. Returns a friendly model name
   *  like `llama3.1:8b` when known, null when the digest doesn't
   *  match any manifest (or no manifests dir was found). `ctx` enables
   *  the lookup next to the blob (see header). */
  resolve(digest: string, ctx?: OllamaDigestContext): string | null;
  /** Force a re-scan. The collector lifecycle in index.ts calls
   *  this on startup once, then a setInterval keeps it warm. */
  refresh(): void;
  /** Number of `digest → name` entries currently in the cache. Used
   *  by the boot log so operators can confirm discovery worked. */
  size(): number;
  /** Resolved manifests dir for the boot log, or null when none of
   *  the candidate locations existed. */
  manifestsDir(): string | null;
  /** Dir sent by the hub, null to drop it. Re-indexes right away. */
  setHubDir(dir: string | null): void;
}

const MODEL_MEDIA_TYPE = 'application/vnd.ollama.image.model';

/** Manifests dir set from the hub (Settings > LLM), tried first. */
let hubManifestsDir: string | null = null;

/** Order matters — first existing dir wins. Tweak via env if your
 *  ollama install lives somewhere else. */
function candidateManifestsDirs(): string[] {
  const env = process.env.OLLAMA_MANIFESTS_DIR?.trim();
  const out: string[] = [];
  if (hubManifestsDir) out.push(hubManifestsDir);
  if (env) out.push(env);
  // Ollama keeps manifests under <home>/.ollama/models/manifests. The
  // bare <home>/.ollama/manifests forms are kept for older setups that
  // pointed OLLAMA_MODELS straight at .ollama.
  const roots = ['/host/ollama', '/usr/share/ollama/.ollama'];
  if (process.env.HOME) roots.push(`${process.env.HOME}/.ollama`);
  roots.push('/root/.ollama');
  for (const root of roots) out.push(`${root}/models/manifests`, `${root}/manifests`);
  return out;
}

function discover(): string | null {
  for (const dir of candidateManifestsDirs()) {
    try {
      if (existsSync(dir) && statSync(dir).isDirectory()) return dir;
    } catch {
      // permission denied / broken symlink — try the next candidate
    }
  }
  return null;
}

/** Recursively walk a manifests root collecting tag files. Each
 *  tag file lives at depth ≥ 3 under the root (registry / library /
 *  model / tag). We don't enforce a fixed depth in case Ollama
 *  changes the layout — just keep recursing until we hit a regular
 *  file. */
// Bounds for the walk. The blob-side lookup walks a dir taken from a
// process command line, which any local user can craft: no symlink
// following (loops), and caps on depth, file count and file size.
const WALK_MAX_DEPTH = 6;
const WALK_MAX_FILES = 5_000;
const MANIFEST_MAX_BYTES = 256 * 1024;

function walkTagFiles(root: string, acc: string[] = [], depth = 0): string[] {
  if (depth > WALK_MAX_DEPTH) return acc;
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return acc;
  }
  for (const name of entries) {
    if (acc.length >= WALK_MAX_FILES) break;
    const full = join(root, name);
    let st;
    try {
      st = lstatSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walkTagFiles(full, acc, depth + 1);
    } else if (st.isFile() && st.size <= MANIFEST_MAX_BYTES) {
      acc.push(full);
    }
  }
  return acc;
}

/** Derive a friendly model name from a tag file path. The path
 *  shape is `<root>/<registry>/<library>/<model>/<tag>` — we want
 *  `<model>:<tag>` and prefix with the namespace only when it
 *  isn't the boring default `library`. */
function nameFromTagPath(root: string, full: string): string | null {
  if (!full.startsWith(root)) return null;
  const rel = full.slice(root.length).replace(/^[\\/]+/, '');
  const parts = rel.split(/[\\/]+/);
  // Expect: [ registry, library, model, tag ]
  if (parts.length < 4) return null;
  const namespace = parts[parts.length - 3];
  const model = parts[parts.length - 2];
  const tag = parts[parts.length - 1];
  const base = `${model}:${tag}`;
  // Ollama uses `library` for the default registry namespace —
  // hide it to match what the user types (`ollama run llama3`,
  // not `ollama run library/llama3`).
  return namespace === 'library' ? base : `${namespace}/${base}`;
}

/** Parse one manifest JSON, return the model-layer digest if any. */
function modelDigestFromManifest(text: string): string | null {
  let parsed: OllamaManifest;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed.layers)) return null;
  for (const l of parsed.layers) {
    if (l?.mediaType === MODEL_MEDIA_TYPE && typeof l.digest === 'string') {
      return l.digest;
    }
  }
  return null;
}

function buildIndex(root: string): Map<string, string> {
  const idx = new Map<string, string>();
  const files = walkTagFiles(root);
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const digest = modelDigestFromManifest(text);
    if (!digest) continue;
    const name = nameFromTagPath(root, file);
    if (!name) continue;
    // Two lookup keys: full digest (`sha256:abc...`) and the
    // 12-char short form the classifier surfaces in its model
    // field for unresolved entries. The collector pipeline always
    // calls resolve() with the full digest now, but the short
    // form helps if anyone ever wires a hash from another source.
    idx.set(digest, name);
    const shortIdx = digest.indexOf(':');
    if (shortIdx > 0) {
      const shortHex = digest.slice(shortIdx + 1).slice(0, 12);
      idx.set(`sha256:${shortHex}`, name);
    }
  }
  return idx;
}

/** Min delay before re-reading the manifests next to a blob that
 *  missed a digest (fresh `ollama pull`, or the dirs were unreadable). */
const BLOB_DIR_RETRY_MS = 60_000;
/** Blob-side indexes unused for this long are dropped on refresh(). The
 *  runner pid changes on every model load, so old entries pile up. */
const BLOB_DIR_MAX_IDLE_MS = 10 * 60_000;

interface BlobDirIndex {
  index: Map<string, string>;
  builtAt: number;
  usedAt: number;
}

interface MountEntry {
  dev: string;
  root: string;
  mountPoint: string;
}

/** mountinfo escapes space, tab, newline and backslash as octal. */
function unescapeMount(path: string): string {
  return path.replaceAll(/\\([0-7]{3})/g, (_, oct: string) => String.fromCodePoint(Number.parseInt(oct, 8)));
}

/** Parse /proc/<pid>/mountinfo: `id parent major:minor root mountpoint ...`. */
export function parseMountinfo(text: string): MountEntry[] {
  const out: MountEntry[] = [];
  for (const line of text.split('\n')) {
    const f = line.split(' ');
    if (f.length < 5) continue;
    out.push({ dev: f[2], root: unescapeMount(f[3]), mountPoint: unescapeMount(f[4]) });
  }
  return out;
}

/** `path` equals `prefix` or sits under it. */
function under(path: string, prefix: string): boolean {
  return prefix === '/' ? path.startsWith('/') : path === prefix || path.startsWith(`${prefix}/`);
}

function strip(path: string, prefix: string): string {
  return prefix === '/' ? path : path.slice(prefix.length);
}

/** Translate a path seen inside another mount namespace (a container)
 *  into the same file as seen from ours, by matching the filesystem
 *  device: their mount gives the path inside the device, ours gives
 *  where that device is mounted here. Docker bind mounts of
 *  `~/.ollama` resolve this way without any config. */
export function translatePath(path: string, theirs: MountEntry[], ours: MountEntry[]): string | null {
  const longest = <T extends MountEntry>(list: T[], key: (e: T) => string) =>
    list.reduce<T | null>((best, e) => (best && key(best).length >= key(e).length ? best : e), null);
  const src = longest(theirs.filter((e) => under(path, e.mountPoint)), (e) => e.mountPoint);
  if (!src) return null;
  const onDevice = posix.join(src.root, strip(path, src.mountPoint));
  const dst = longest(ours.filter((e) => e.dev === src.dev && under(onDevice, e.root)), (e) => e.root);
  if (!dst) return null;
  return posix.join(dst.mountPoint, strip(onDevice, dst.root));
}

function readMountinfo(path: string): MountEntry[] {
  try {
    return parseMountinfo(readFileSync(path, 'utf8'));
  } catch {
    return [];
  }
}

/** Manifests dirs to try for a blob path, most specific first:
 *  through the runner's own root, the same dir mapped to our mount
 *  namespace, then the path as is (runner on this host). */
function manifestsDirsForBlob(hostProc: string | undefined, ctx: OllamaDigestContext): string[] {
  const at = ctx.blobPath.search(/[\\/]blobs[\\/]/);
  if (at < 0) return [];
  const modelsDir = ctx.blobPath.slice(0, at);
  const sep = ctx.blobPath[at];
  const out: string[] = [];
  if (hostProc && ctx.pid !== undefined && modelsDir.startsWith('/')) {
    const manifests = `${modelsDir}/manifests`;
    out.push(`${hostProc}/${ctx.pid}/root${manifests}`);
    const mapped = translatePath(
      manifests,
      readMountinfo(`${hostProc}/${ctx.pid}/mountinfo`),
      readMountinfo('/proc/self/mountinfo'),
    );
    if (mapped) out.push(mapped);
  }
  out.push(`${modelsDir}${sep}manifests`);
  return [...new Set(out)];
}

function isDir(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** Index of the first readable manifests dir among the candidates. */
function indexNearBlob(hostProc: string | undefined, ctx: OllamaDigestContext): Map<string, string> {
  for (const candidate of manifestsDirsForBlob(hostProc, ctx)) {
    if (!isDir(candidate)) continue;
    const idx = buildIndex(candidate);
    if (idx.size === 0) continue;
    logger.debug('ollama', `${idx.size} manifest(s) indexed next to the blob in ${candidate}`);
    return idx;
  }
  return new Map();
}

export function createOllamaResolver(hostProc?: string): OllamaResolver {
  let dir = discover();
  let index: Map<string, string> = new Map();
  // Keyed by pid + blob path: all the I/O for a runner (mountinfo,
  // stat, manifests walk) happens at most once per BLOB_DIR_RETRY_MS.
  const blobDirs = new Map<string, BlobDirIndex>();

  const doRefresh = (): void => {
    // Re-run discovery in case the user fixed a missing mount
    // mid-flight, or migrated ollama between installs.
    dir = discover();
    const now = Date.now();
    for (const [key, entry] of blobDirs) {
      if (now - entry.usedAt > BLOB_DIR_MAX_IDLE_MS) blobDirs.delete(key);
    }
    if (!dir) {
      index = new Map();
      return;
    }
    try {
      index = buildIndex(dir);
    } catch (err) {
      logger.debug('ollama', `manifest refresh failed: ${(err as Error).message}`);
    }
  };

  const resolveNearBlob = (digest: string, ctx: OllamaDigestContext): string | null => {
    const now = Date.now();
    const key = `${ctx.pid ?? ''}|${ctx.blobPath}`;
    let entry = blobDirs.get(key);
    if (!entry || (!entry.index.has(digest) && now - entry.builtAt > BLOB_DIR_RETRY_MS)) {
      entry = { index: indexNearBlob(hostProc, ctx), builtAt: now, usedAt: now };
      blobDirs.set(key, entry);
    }
    entry.usedAt = now;
    return entry.index.get(digest) ?? null;
  };

  doRefresh();

  if (dir) {
    logger.info('ollama', `model resolver active — ${index.size} manifest(s) indexed from ${dir}`);
  } else {
    logger.debug('ollama', 'no static ollama manifests dir found; names are looked up next to each runner blob instead. Set OLLAMA_MANIFESTS_DIR to pin one.');
  }

  return {
    resolve: (digest: string, ctx?: OllamaDigestContext) =>
      index.get(digest) ?? (ctx ? resolveNearBlob(digest, ctx) : null),
    refresh: doRefresh,
    size: () => index.size,
    manifestsDir: () => dir,
    setHubDir: (next: string | null) => {
      const clean = next && next.startsWith('/') && next.length <= 512 ? next : null;
      if (clean === hubManifestsDir) return;
      hubManifestsDir = clean;
      doRefresh();
    },
  };
}
