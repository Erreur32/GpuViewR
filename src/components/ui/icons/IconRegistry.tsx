// Central SVG icon registry — single source of truth so adding a new
// icon = one entry, and consumers just do <Icon name="platform.windows" />
// instead of pasting SVG markup at every call site.
//
// Conventions:
// - All icons accept { size, title } and forward `size` to width/height.
// - `title` doubles as <title> (tooltip) and aria-label for a11y.
// - Brand colors are hardcoded inside the SVG (vendor logos must look
//   right regardless of theme). Generic icons that should follow the
//   text color use `fill="currentColor"`.
// - SVGs are minified by hand (whitespace removed, attributes folded)
//   so this file stays grep-friendly.

import type { CSSProperties } from 'react';

export type IconKey =
  // Vendors
  | 'vendor.nvidia'
  | 'vendor.amd'
  // Install platforms / runtime contexts
  | 'platform.windows'
  | 'platform.linux'
  | 'platform.docker'
  | 'platform.systemd';

export interface IconProps {
  size?: number;
  /** Doubles as tooltip + aria-label. Falls back to a sensible default per icon. */
  title?: string;
  /** Optional inline style override (mostly for `flexShrink: 0` consumers). */
  style?: CSSProperties;
}

const baseStyle: CSSProperties = { flexShrink: 0 };

const Nvidia = ({ size = 16, title = 'NVIDIA', style }: IconProps) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 86.6 512 338.8"
    width={size}
    height={size * (338.8 / 512)}
    role="img"
    aria-label={title}
    style={{ ...baseStyle, ...style }}
  >
    <title>{title}</title>
    <path
      d="M52.3 232.5s46.3-68.3 138.7-75.4v-24.8C88.7 140.5 0 227.2 0 227.2s50.2 145.2 191 158.4v-26.3C87.7 346.3 52.3 232.5 52.3 232.5M191 307v24.1C112.9 317.2 91.3 236 91.3 236s37.5-41.5 99.8-48.3v26.5h-.1c-32.7-3.9-58.2 26.6-58.2 26.6S147 292.2 191 307m0-220.4v45.7c3-.2 6-.4 9-.5 116.4-3.9 192.2 95.5 192.2 95.5s-87.1 105.9-177.8 105.9c-8.3 0-16.1-.8-23.4-2.1v28.3c6.3.8 12.7 1.3 19.5 1.3 84.4 0 145.5-43.1 204.6-94.2 9.8 7.9 49.9 27 58.2 35.3-56.2 47.1-187.3 85-261.5 85-7.2 0-14-.4-20.8-1.1v39.7h321V86.6zm0 101.1v-30.6c3-.2 6-.4 9-.5 83.7-2.6 138.6 71.9 138.6 71.9s-59.3 82.4-122.9 82.4c-9.2 0-17.4-1.5-24.7-4v-92.8c32.6 3.9 39.1 18.3 58.7 51l43.6-36.7s-31.8-41.7-85.4-41.7c-5.8 0-11.4.4-16.9 1"
      fill="#77b900"
    />
  </svg>
);

const Amd = ({ size = 16, title = 'AMD', style }: IconProps) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 512 512"
    width={size}
    height={size}
    role="img"
    aria-label={title}
    style={{ ...baseStyle, ...style }}
  >
    <title>{title}</title>
    <path
      d="M143.8 139.5 4.3 0H512v507.7L372.5 368.3V139.5zm-.2 27.9L0 311v201h201l143.6-143.6h-201z"
      fill="#f63737"
    />
  </svg>
);

// Modern Windows logo — four equal squares in Fluent blue (#0078D4,
// Microsoft's current brand color). The older "asymmetric grid"
// Win10-era logo (#00ADEF) ages poorly: at 14-16px the perspective
// trick is invisible and the path data is 3x larger for no visual
// benefit. Symmetric quadrants stay sharp at any size.
const Windows = ({ size = 16, title = 'Windows', style }: IconProps) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 512 512"
    width={size}
    height={size}
    role="img"
    aria-label={title}
    style={{ ...baseStyle, ...style }}
  >
    <title>{title}</title>
    <path
      fill="#0078D4"
      d="M0 0h242.7v242.6H0zm269.3 0H512v242.6H269.3zM0 269.3h242.7V512H0zm269.3 0H512V512H269.3"
    />
  </svg>
);

// Tux silhouette — minimalist; uses currentColor so it inherits the
// surrounding text color in both light + dark themes.
const Linux = ({ size = 16, title = 'Linux', style }: IconProps) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    width={size}
    height={size}
    role="img"
    aria-label={title}
    style={{ ...baseStyle, ...style }}
    fill="currentColor"
  >
    <title>{title}</title>
    <path d="M12.504 0c-.155 0-.315.008-.48.021-4.226.333-3.105 4.807-3.17 6.298-.076 1.092-.3 1.953-1.05 3.02-.885 1.051-2.127 2.75-2.716 4.521-.278.832-.41 1.684-.287 2.489a.424.424 0 0 0-.11.135c-.26.268-.45.6-.663.839-.199.199-.485.267-.797.4-.313.136-.658.269-.864.68-.09.189-.136.394-.132.602 0 .199.027.4.055.59.058.401.116.772.026.997-.29.55-.32 1.07-.135 1.476.187.408.55.685.974.83.852.305 2.027.351 3.07.677.55.21 1.118.41 1.692.567.873.234 1.59.353 2.184.353.546 0 1.026-.106 1.412-.412.547-.412.842-1.137.842-1.953v-.038c.183-.071.355-.166.501-.286.146-.118.282-.225.485-.273l.027-.006c.215-.077.487-.158.766-.158.279 0 .57.082.825.245.46.297.71.769.812 1.198.102.43.052.84.144.83.5-.04 1.057-.137 1.578-.265.484-.124.964-.255 1.43-.418.55-.187 1.099-.382 1.508-.738.408-.357.677-.873.628-1.456-.05-.583-.343-1.158-.928-1.532-.302-.193-.661-.292-1.022-.292-.36 0-.72.099-1.022.292-.243.155-.426.382-.564.642a4.6 4.6 0 0 1-.094-.196c-.052-.114-.107-.226-.166-.327-.196-.336-.477-.532-.769-.532-.291 0-.572.196-.769.532-.196.336-.32.79-.32 1.32 0 .144.013.288.04.43.014.073.052.142.097.21Z"/>
  </svg>
);

const Docker = ({ size = 16, title = 'Docker', style }: IconProps) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    width={size}
    height={size}
    role="img"
    aria-label={title}
    style={{ ...baseStyle, ...style }}
  >
    <title>{title}</title>
    <path
      fill="#2496ED"
      d="M13.983 11.078h2.119a.186.186 0 00.186-.185V9.006a.186.186 0 00-.186-.186h-2.119a.185.185 0 00-.185.185v1.888c0 .102.083.185.185.185m-2.954-5.43h2.118a.186.186 0 00.186-.186V3.574a.186.186 0 00-.186-.185h-2.118a.185.185 0 00-.185.185v1.888c0 .102.082.185.185.186m0 2.716h2.118a.187.187 0 00.186-.186V6.29a.186.186 0 00-.186-.185h-2.118a.185.185 0 00-.185.185v1.888c0 .102.082.185.185.186m-2.93 0h2.12a.186.186 0 00.184-.186V6.29a.185.185 0 00-.185-.185H8.1a.185.185 0 00-.185.185v1.888c0 .102.083.185.185.186m-2.964 0h2.119a.186.186 0 00.185-.186V6.29a.185.185 0 00-.185-.185H5.136a.186.186 0 00-.186.185v1.888c0 .102.084.185.186.186m5.893 2.715h2.118a.186.186 0 00.186-.185V9.006a.186.186 0 00-.186-.186h-2.118a.185.185 0 00-.185.185v1.888c0 .102.082.185.185.185m-2.93 0h2.12a.185.185 0 00.184-.185V9.006a.185.185 0 00-.184-.186h-2.12a.185.185 0 00-.184.185v1.888c0 .102.083.185.185.185m-2.964 0h2.119a.185.185 0 00.185-.185V9.006a.185.185 0 00-.184-.186h-2.12a.186.186 0 00-.186.186v1.887c0 .102.084.185.186.185m-2.92 0h2.12a.185.185 0 00.184-.185V9.006a.185.185 0 00-.184-.186h-2.12a.185.185 0 00-.184.185v1.888c0 .102.082.185.185.185M23.763 9.89c-.065-.051-.672-.51-1.954-.51-.338.001-.676.03-1.01.087-.248-1.7-1.653-2.53-1.716-2.566l-.344-.199-.226.327c-.284.438-.49.922-.612 1.43-.23.97-.09 1.882.403 2.661-.595.332-1.55.413-1.744.42H.751a.751.751 0 00-.75.748 11.376 11.376 0 00.692 4.062c.545 1.428 1.355 2.48 2.41 3.124 1.18.723 3.1 1.137 5.275 1.137.983.003 1.963-.086 2.93-.266a12.248 12.248 0 003.823-1.389c.98-.567 1.86-1.288 2.61-2.136 1.252-1.418 1.998-2.997 2.553-4.4h.221c1.372 0 2.215-.549 2.68-1.009.309-.293.55-.65.707-1.046l.098-.288z"
    />
  </svg>
);

// systemd uses the official "gear with red ring" but for a 16px UI badge
// a simpler gear icon reads better. fill=currentColor so it works in
// any theme.
const Systemd = ({ size = 16, title = 'systemd', style }: IconProps) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    width={size}
    height={size}
    role="img"
    aria-label={title}
    style={{ ...baseStyle, ...style }}
    fill="currentColor"
  >
    <title>{title}</title>
    <path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm9.43 5.4 1.7 1.34a.5.5 0 0 1 .12.62l-1.6 2.77a.5.5 0 0 1-.6.22l-2-.8a8 8 0 0 1-1.66.96l-.3 2.13a.5.5 0 0 1-.5.43h-3.18a.5.5 0 0 1-.5-.43l-.3-2.13a8 8 0 0 1-1.66-.96l-2 .8a.5.5 0 0 1-.6-.22l-1.6-2.77a.5.5 0 0 1 .12-.62L2.57 13.4a8 8 0 0 1 0-2.8L.87 9.26a.5.5 0 0 1-.12-.62l1.6-2.77a.5.5 0 0 1 .6-.22l2 .8a8 8 0 0 1 1.66-.96l.3-2.13a.5.5 0 0 1 .5-.43h3.18a.5.5 0 0 1 .5.43l.3 2.13a8 8 0 0 1 1.66.96l2-.8a.5.5 0 0 1 .6.22l1.6 2.77a.5.5 0 0 1-.12.62l-1.7 1.34a8 8 0 0 1 0 2.8z"/>
  </svg>
);

export const Icons: Record<IconKey, React.FC<IconProps>> = {
  'vendor.nvidia': Nvidia,
  'vendor.amd': Amd,
  'platform.windows': Windows,
  'platform.linux': Linux,
  'platform.docker': Docker,
  'platform.systemd': Systemd,
};

interface IconComponentProps extends IconProps {
  name: IconKey;
}

/** Convenience wrapper: `<Icon name="platform.windows" size={16} />` */
export default function Icon({ name, ...rest }: Readonly<IconComponentProps>) {
  const Component = Icons[name];
  return <Component {...rest} />;
}
