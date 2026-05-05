// GPU display-name normalization. Trims off the vendor prefix
// ("NVIDIA") and the marketing brand ("GeForce" / "Quadro" / "Tesla")
// so multi-GPU tabs and combined-chart legends stay readable.
//
// Implemented as a token scan (split on single spaces, drop matches)
// so there is no nested-quantifier regex — addresses the
// catastrophic-backtracking class of regex DoS even though the input
// here is always a fixed-shape vendor string from nvidia-smi.

const VENDOR_PREFIX = 'NVIDIA';
const BRAND_WORDS = new Set(['GeForce', 'Quadro', 'Tesla']);

export function shortGpuName(name: string): string {
  const parts = name.split(' ').filter(Boolean);
  if (parts.length > 0 && parts[0].toLowerCase() === VENDOR_PREFIX.toLowerCase()) {
    parts.shift();
  }
  for (let i = 0; i < parts.length; i++) {
    if (BRAND_WORDS.has(parts[i])) {
      parts.splice(i, 1);
      break;
    }
  }
  return parts.join(' ').trim();
}
