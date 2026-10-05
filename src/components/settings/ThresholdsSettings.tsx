import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Activity, RotateCcw } from "lucide-react";
import { useUiStore } from "../../store/uiStore";
import { useAuthStore } from "../../store/authStore";
import { useHostsStore } from "../../store/hostsStore";
import { useGpuStore } from "../../store/gpuStore";
import { useThresholdsStore } from "../../store/thresholdsStore";
import {
  DEFAULT_THRESHOLDS,
  gpuKey,
  resolveThresholds,
  THRESHOLD_KEYS,
  type HardwareLimits,
  type ThresholdKey,
  type ThresholdValues,
} from "../../lib/thresholds";

const METRIC_LABEL: Record<ThresholdKey, { label: string; unit: string }> = {
  util: { label: "dashboard.metrics.utilization", unit: "%" },
  mem: { label: "dashboard.metrics.memory", unit: "%" },
  fan: { label: "dashboard.metrics.fan", unit: "%" },
  temp: { label: "dashboard.metrics.temperature", unit: "°C" },
  pow: { label: "dashboard.metrics.power", unit: "W" },
};
/** Display order of the fields, same as before v0.11.5. */
const FIELD_ORDER: ThresholdKey[] = ["util", "mem", "fan", "temp", "pow"];

interface GpuRow {
  key: string;
  host: string;
  gpu: string;
  limits: HardwareLimits;
}

/** "200 W · 95 °C" from what the card reports, "" when it reports nothing. */
function limitsLabel(limits: HardwareLimits): string {
  const parts: string[] = [];
  if (limits.pow) parts.push(`${limits.pow} W`);
  if (limits.temp) parts.push(`${limits.temp} °C`);
  return parts.join(" · ");
}

/** Settings > General > Chart thresholds: global lines, then per-GPU
 *  overrides. Values are shared through the hub; only admins edit them. */
export default function ThresholdsSettings() {
  const { t } = useTranslation();
  const isAdmin = useAuthStore((s) => s.user?.role === "admin");
  const enabled = useUiStore((s) => s.chartThresholdsEnabled);
  const setEnabled = useUiStore((s) => s.setChartThresholdsEnabled);
  const global = useThresholdsStore((s) => s.global);
  const gpus = useThresholdsStore((s) => s.gpus);
  const setGlobal = useThresholdsStore((s) => s.setGlobal);
  const resetGlobal = useThresholdsStore((s) => s.resetGlobal);
  const setGpu = useThresholdsStore((s) => s.setGpu);
  const clearGpu = useThresholdsStore((s) => s.clearGpu);
  const hosts = useHostsStore((s) => s.hosts);
  const latestByHost = useGpuStore((s) => s.latestByHost);
  const locked = !enabled || !isAdmin;

  // GPUs seen live, plus any with saved overrides (host offline or gone).
  const rows = useMemo<GpuRow[]>(() => {
    const label = (id: string) => hosts.find((h) => h.id === id)?.label ?? id;
    const out = new Map<string, GpuRow>();
    for (const [hostId, samples] of latestByHost) {
      for (const [index, s] of samples) {
        out.set(gpuKey(hostId, index), {
          key: gpuKey(hostId, index),
          host: label(hostId),
          gpu: `GPU ${index} · ${s.name}`,
          limits: { pow: s.power_limit ?? null, temp: s.temp_limit ?? null },
        });
      }
    }
    for (const key of Object.keys(gpus)) {
      if (out.has(key)) continue;
      const at = key.lastIndexOf(":");
      out.set(key, { key, host: label(key.slice(0, at)), gpu: `GPU ${key.slice(at + 1)}`, limits: {} });
    }
    return [...out.values()].sort((a, b) => a.host.localeCompare(b.host) || a.gpu.localeCompare(b.gpu));
  }, [hosts, latestByHost, gpus]);

  return (
    <section className="card p-5 space-y-3">
      <h2 className="font-semibold flex items-center gap-2">
        <Activity className="w-4 h-4" /> {t("settings.thresholds")}
      </h2>
      <p className="text-xs" style={{ color: "var(--gv-text-muted)" }}>
        {t("settings.thresholds_help")}
      </p>
      <label className="inline-flex items-center gap-2 text-sm cursor-pointer">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        {t("settings.thresholds_enable")}
      </label>
      {!isAdmin && (
        <p className="text-xs" style={{ color: "var(--gv-text-dim)" }}>
          {t("settings.thresholds_admin_only")}
        </p>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 pt-1" aria-disabled={locked}>
        {FIELD_ORDER.map((k) => (
          <ThresholdField
            key={k}
            label={`${t(METRIC_LABEL[k].label)} (${METRIC_LABEL[k].unit})`}
            value={global[k] ?? undefined}
            placeholder={String(DEFAULT_THRESHOLDS[k])}
            disabled={locked}
            onChange={(v) => setGlobal(k, v ?? null)}
            clearLabel={t("settings.thresholds_clear")}
          />
        ))}
      </div>
      <div>
        <button type="button" className="seg-btn text-xs" onClick={resetGlobal} disabled={locked}>
          {t("settings.thresholds_reset")}
        </button>
      </div>

      {rows.length > 0 && (
        <div className="pt-3 space-y-2 border-t" style={{ borderColor: "var(--gv-border)" }}>
          <h3 className="text-sm font-semibold">{t("settings.thresholds_per_gpu")}</h3>
          <p className="text-xs" style={{ color: "var(--gv-text-muted)" }}>
            {t("settings.thresholds_per_gpu_help")}
          </p>
          {rows.map((row) => (
            <GpuThresholdRow
              key={row.key}
              row={row}
              own={gpus[row.key]}
              global={global}
              disabled={locked}
              onChange={(k, v) => setGpu(row.key, k, v)}
              onClear={() => clearGpu(row.key)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function GpuThresholdRow({
  row,
  own,
  global,
  disabled,
  onChange,
  onClear,
}: Readonly<{
  row: GpuRow;
  own: ThresholdValues | undefined;
  global: ThresholdValues;
  disabled: boolean;
  onChange: (key: ThresholdKey, value: number | null | undefined) => void;
  onClear: () => void;
}>) {
  const { t } = useTranslation();
  const hasOwn = own !== undefined && THRESHOLD_KEYS.some((k) => k in own);
  // What an empty field resolves to on this card (global, capped at its limits).
  const inheritedLines = resolveThresholds(global, undefined, row.limits);
  const hw = limitsLabel(row.limits);
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3 items-end">
      <div className="text-xs lg:self-center min-w-0">
        <div className="font-semibold truncate" title={row.host}>{row.host}</div>
        <div className="truncate" style={{ color: "var(--gv-text-muted)" }} title={row.gpu}>{row.gpu}</div>
        {hw && (
          <div className="truncate" style={{ color: "var(--gv-text-dim)" }}>
            {t("settings.thresholds_hw_limits", { limits: hw })}
          </div>
        )}
      </div>
      {FIELD_ORDER.map((k) => {
        const inherited = inheritedLines[k];
        const value = own && k in own ? own[k] : undefined;
        return (
          <ThresholdField
            key={k}
            label={`${t(METRIC_LABEL[k].label)} (${METRIC_LABEL[k].unit})`}
            // 0 stands for "no line on this GPU": a 0 % / 0 °C / 0 W line
            // is never useful, and an empty field means "inherit".
            value={value ?? 0}
            placeholder={typeof inherited === "number" ? String(inherited) : t("settings.thresholds_off")}
            disabled={disabled}
            onChange={(v) => onChange(k, v === 0 ? null : v)}
            clearLabel={t("settings.thresholds_inherit")}
          />
        );
      })}
      {hasOwn && (
        <div className="lg:col-start-6">
          <button type="button" className="seg-btn text-xs inline-flex items-center gap-1" onClick={onClear} disabled={disabled}>
            <RotateCcw className="w-3 h-3" /> {t("settings.thresholds_inherit_all")}
          </button>
        </div>
      )}
    </div>
  );
}

/** Number input; clearing it (empty or ×) calls onChange(undefined). */
function ThresholdField({
  label,
  value,
  placeholder,
  disabled,
  onChange,
  clearLabel,
}: Readonly<{
  label: string;
  value: number | undefined;
  placeholder: string;
  disabled: boolean;
  onChange: (v: number | undefined) => void;
  clearLabel: string;
}>) {
  return (
    <label className="block text-xs space-y-1">
      <span style={{ color: "var(--gv-text-muted)" }}>{label}</span>
      <span className="flex items-center gap-1">
        <input
          type="number"
          inputMode="numeric"
          step="1"
          min="0"
          value={value ?? ""}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(e) => {
            const raw = e.target.value;
            if (raw === "") {
              onChange(undefined);
              return;
            }
            const n = Number(raw);
            if (Number.isFinite(n) && n >= 0) onChange(n);
          }}
          className="w-full px-2 py-1 rounded"
          style={{
            background: "var(--gv-surface-alt)",
            border: "1px solid var(--gv-border)",
            color: "var(--gv-text)",
          }}
        />
        {value !== undefined && (
          <button
            type="button"
            aria-label={clearLabel}
            title={clearLabel}
            disabled={disabled}
            onClick={() => onChange(undefined)}
            className="px-2 py-1 rounded text-xs"
            style={{
              background: "transparent",
              border: "1px solid var(--gv-border)",
              color: "var(--gv-text-dim)",
            }}
          >
            ×
          </button>
        )}
      </span>
    </label>
  );
}
