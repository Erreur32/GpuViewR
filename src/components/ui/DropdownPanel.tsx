import type { ReactNode } from 'react';

/** Floating popup body shared by the header dropdowns (range picker,
 *  GPU picker). Opaque background: floats over page content with no
 *  backdrop of its own, so it can't reuse the toolbar's translucent
 *  `.seg` background without the content behind it bleeding through. */
export default function DropdownPanel({
  align = 'left', label, children,
}: Readonly<{
  align?: 'left' | 'right';
  label: string;
  children: ReactNode;
}>) {
  return (
    <div
      className={`seg absolute top-full mt-1 z-20 flex-col max-h-72 overflow-y-auto ${align === 'right' ? 'right-0' : 'left-0'}`}
      style={{ background: 'var(--gv-bg2)', boxShadow: '0 8px 24px rgba(0,0,0,0.4)' }}
      role="listbox"
      aria-label={label}
    >
      {children}
    </div>
  );
}
