// GPU memory label helper. Apple Silicon has no discrete VRAM: the GPU
// shares the same physical RAM pool as the CPU, so labeling the metric
// "VRAM" on a macOS host is actively misleading. Everywhere the UI shows
// a VRAM ratio/gauge/label should route through here instead of a
// hardcoded string, keyed off the host's reported install_mode.

/** `install_mode` is typed per-store (HostRecord/hostsStore vs the
 *  gpuStore's per-sample host metadata) so this accepts the loosest
 *  shape that's actually needed: just the string. */
export function isUnifiedMemoryHost(installMode: string | null | undefined): boolean {
  return installMode === 'macos';
}

/** Short label for column headers / gauge captions. */
export function memoryLabel(installMode: string | null | undefined): string {
  return isUnifiedMemoryHost(installMode) ? 'Unified' : 'VRAM';
}

/** Longer label for prose contexts ("X GB of Memory used"). */
export function memoryLongLabel(installMode: string | null | undefined): string {
  return isUnifiedMemoryHost(installMode) ? 'Unified Memory' : 'Memory';
}
