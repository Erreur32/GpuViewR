// Vendor logo derived from the GPU's `name` string (nvidia-smi /
// rocm-smi product field). Used on the Hosts page to tell NVIDIA and
// AMD boxes apart at a glance — falls back to a neutral Server icon
// when the vendor can't be inferred (Intel, empty samples, etc.).

import { Server } from 'lucide-react';

export type Vendor = 'nvidia' | 'amd';

const NVIDIA_HINTS = ['nvidia', 'geforce', 'quadro', 'tesla', 'rtx', 'gtx'];
const AMD_HINTS = ['amd', 'radeon', 'instinct', 'ryzen ai'];

/** Returns the vendor inferred from a GPU product name, or null when
 *  unrecognised. Accepts a single name or an array (multi-GPU host —
 *  first recognised wins). Case-insensitive substring match. */
export function detectVendor(input: string | readonly string[] | undefined): Vendor | null {
  if (!input) return null;
  const names = Array.isArray(input) ? input : [input];
  for (const raw of names) {
    const n = raw.toLowerCase();
    if (NVIDIA_HINTS.some((h) => n.includes(h))) return 'nvidia';
    if (AMD_HINTS.some((h) => n.includes(h))) return 'amd';
  }
  return null;
}

interface VendorIconProps {
  vendor: Vendor | null;
  size?: number;
  /** Shown as tooltip + aria-label when a vendor is detected. */
  title?: string;
}

export default function VendorIcon({ vendor, size = 16, title }: Readonly<VendorIconProps>) {
  if (vendor === 'nvidia') {
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 86.6 512 338.8"
        width={size}
        height={size * (338.8 / 512)}
        role="img"
        aria-label={title ?? 'NVIDIA'}
        style={{ flexShrink: 0 }}
      >
        <title>{title ?? 'NVIDIA'}</title>
        <path
          d="M52.3 232.5s46.3-68.3 138.7-75.4v-24.8C88.7 140.5 0 227.2 0 227.2s50.2 145.2 191 158.4v-26.3C87.7 346.3 52.3 232.5 52.3 232.5M191 307v24.1C112.9 317.2 91.3 236 91.3 236s37.5-41.5 99.8-48.3v26.5h-.1c-32.7-3.9-58.2 26.6-58.2 26.6S147 292.2 191 307m0-220.4v45.7c3-.2 6-.4 9-.5 116.4-3.9 192.2 95.5 192.2 95.5s-87.1 105.9-177.8 105.9c-8.3 0-16.1-.8-23.4-2.1v28.3c6.3.8 12.7 1.3 19.5 1.3 84.4 0 145.5-43.1 204.6-94.2 9.8 7.9 49.9 27 58.2 35.3-56.2 47.1-187.3 85-261.5 85-7.2 0-14-.4-20.8-1.1v39.7h321V86.6zm0 101.1v-30.6c3-.2 6-.4 9-.5 83.7-2.6 138.6 71.9 138.6 71.9s-59.3 82.4-122.9 82.4c-9.2 0-17.4-1.5-24.7-4v-92.8c32.6 3.9 39.1 18.3 58.7 51l43.6-36.7s-31.8-41.7-85.4-41.7c-5.8 0-11.4.4-16.9 1"
          fill="#77b900"
        />
      </svg>
    );
  }
  if (vendor === 'amd') {
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 512 512"
        width={size}
        height={size}
        role="img"
        aria-label={title ?? 'AMD'}
        style={{ flexShrink: 0 }}
      >
        <title>{title ?? 'AMD'}</title>
        <path
          d="M143.8 139.5 4.3 0H512v507.7L372.5 368.3V139.5zm-.2 27.9L0 311v201h201l143.6-143.6h-201z"
          fill="#f63737"
        />
      </svg>
    );
  }
  return (
    <Server
      size={size}
      style={{ color: 'var(--gv-text-muted)', flexShrink: 0 }}
      aria-label={title ?? 'Host'}
    />
  );
}
