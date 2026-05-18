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
//   2. /host/ollama/manifests  (docker bind-mount we add in compose)
//   3. /usr/share/ollama/.ollama/manifests
//                              (systemd `ollama` user default)
//   4. $HOME/.ollama/manifests (per-user install)
//   5. /root/.ollama/manifests (root user, ollama-as-root install)

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../logger.js';

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
   *  match any manifest (or no manifests dir was found). */
  resolve(digest: string): string | null;
  /** Force a re-scan. The collector lifecycle in index.ts calls
   *  this on startup once, then a setInterval keeps it warm. */
  refresh(): void;
  /** Number of `digest → name` entries currently in the cache. Used
   *  by the boot log so operators can confirm discovery worked. */
  size(): number;
  /** Resolved manifests dir for the boot log, or null when none of
   *  the candidate locations existed. */
  manifestsDir(): string | null;
}

const MODEL_MEDIA_TYPE = 'application/vnd.ollama.image.model';

/** Order matters — first existing dir wins. Tweak via env if your
 *  ollama install lives somewhere else. */
function candidateManifestsDirs(): string[] {
  const env = process.env.OLLAMA_MANIFESTS_DIR?.trim();
  const out: string[] = [];
  if (env) out.push(env);
  out.push('/host/ollama/manifests');
  out.push('/usr/share/ollama/.ollama/manifests');
  if (process.env.HOME) out.push(`${process.env.HOME}/.ollama/manifests`);
  out.push('/root/.ollama/manifests');
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
function walkTagFiles(root: string, acc: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return acc;
  }
  for (const name of entries) {
    const full = join(root, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walkTagFiles(full, acc);
    } else if (st.isFile()) {
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

export function createOllamaResolver(): OllamaResolver {
  let dir = discover();
  let index: Map<string, string> = new Map();

  const doRefresh = (): void => {
    // Re-run discovery in case the user fixed a missing mount
    // mid-flight, or migrated ollama between installs.
    dir = discover();
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

  doRefresh();

  if (dir) {
    logger.info('ollama', `model resolver active — ${index.size} manifest(s) indexed from ${dir}`);
  } else {
    logger.debug('ollama', 'no ollama manifests dir found; runner badges will show sha256 prefix only. Set OLLAMA_MANIFESTS_DIR or bind-mount ~/.ollama into the container to enable.');
  }

  return {
    resolve: (digest: string) => index.get(digest) ?? null,
    refresh: doRefresh,
    size: () => index.size,
    manifestsDir: () => dir,
  };
}
