import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Server, ChevronDown } from 'lucide-react';
import { useHostsStore, LOCAL_HOST_ID } from '../../store/hostsStore';
import { useDropdown } from '../../lib/useDropdown';
import DropdownPanel from '../ui/DropdownPanel';

// Host selector, only past mono-host installs (zero-touch for existing
// single-machine users). URL syncs to /host/:hostId on change so the
// choice is bookmarkable and survives a hard reload. Same themed
// trigger + panel as RangeSelector and GpuTabs, not a native <select>.
export default function HostSelector({
  hosts,
  selectedHostId,
}: Readonly<{
  hosts: ReturnType<typeof useHostsStore.getState>['hosts'];
  selectedHostId: string;
}>) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { open, setOpen, rootRef } = useDropdown();
  if (hosts.length <= 1) return null;
  const active = hosts.find((h) => h.id === selectedHostId) ?? hosts[0];

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        className="seg-btn inline-flex items-center gap-1.5"
        style={{ background: 'var(--gv-surface-alt)', border: '1px solid var(--gv-border)' }}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title={t('dashboard.host_select')}
      >
        <Server className="w-3.5 h-3.5" />
        {active.label}
        <ChevronDown className="w-3 h-3" />
      </button>
      {open && (
        <DropdownPanel label={t('dashboard.host_select')}>
          {hosts.map((h) => (
            <button
              key={h.id}
              type="button"
              className="seg-btn text-left whitespace-nowrap"
              aria-pressed={h.id === active.id}
              onClick={() => {
                setOpen(false);
                navigate(h.id === LOCAL_HOST_ID ? '/' : `/host/${h.id}`);
              }}
            >
              {h.label}
            </button>
          ))}
        </DropdownPanel>
      )}
    </div>
  );
}
