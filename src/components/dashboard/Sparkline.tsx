import { useId } from 'react';

interface Props {
  values: number[];
  max?: number;
  width?: number;
  height?: number;
  stroke?: string;
  className?: string;
}

export default function Sparkline({
  values,
  max,
  width = 120,
  height = 28,
  stroke,
  className = '',
}: Props) {
  // One gradient id per Sparkline instance. With a fixed id the area
  // fills of every gauge shared a single <linearGradient> definition,
  // so the browser picked a single winning color for the whole page —
  // making every sparkline look like the wrong metric.
  const gradId = `sl-grad-${useId().replaceAll(':', '')}`;

  if (values.length < 2) {
    return <div className={className} style={{ width, height }} />;
  }
  const m = max ?? Math.max(1, ...values);
  const step = width / (values.length - 1);
  let path = '';
  for (let i = 0; i < values.length; i++) {
    const x = i * step;
    const y = height - (values[i] / m) * height;
    path += (i === 0 ? 'M' : 'L') + x.toFixed(1) + ',' + y.toFixed(1) + ' ';
  }
  const area = path + `L${width},${height} L0,${height} Z`;
  const color = stroke || 'currentColor';
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      className={className}
      preserveAspectRatio="none"
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor={color} stopOpacity="0.45" />
          <stop offset="60%"  stopColor={color} stopOpacity="0.12" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gradId})`} />
      <path d={path} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
