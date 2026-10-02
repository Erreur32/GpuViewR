// GPU display-name normalization. Trims off the vendor prefix
// ("NVIDIA" / "AMD") and the marketing brand ("GeForce" / "Quadro" /
// "Tesla" / "Radeon" / "Instinct") so multi-GPU tabs, fleet tiles and
// combined-chart legends stay readable.
//
// Implemented as a token scan (split on single spaces, drop matches)
// so there is no nested-quantifier regex — addresses the
// catastrophic-backtracking class of regex DoS even though the input
// here is always a fixed-shape vendor string from nvidia-smi / rocm-smi.

const VENDOR_PREFIXES = new Set(['nvidia', 'amd']);
const BRAND_WORDS = new Set(['GeForce', 'Quadro', 'Tesla', 'Radeon', 'Instinct']);

export function shortGpuName(name: string): string {
  const parts = name.split(' ').filter(Boolean);
  if (parts.length > 0 && VENDOR_PREFIXES.has(parts[0].toLowerCase())) {
    parts.shift();
  }
  const brandIdx = parts.findIndex((p) => BRAND_WORDS.has(p));
  if (brandIdx === -1) return parts.join(' ');
  const rest = parts.filter((_, i) => i !== brandIdx);
  // AMD APUs report a bare "AMD Radeon Graphics": without the brand
  // only "Graphics" would be left, so keep the name whole then.
  if (rest.length === 0 || (rest.length === 1 && rest[0] === 'Graphics')) return parts.join(' ');
  return rest.join(' ');
}
