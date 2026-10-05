// Which GPU sensors a sample really has. Agents send fan and utilization
// as null when missing, but temperature and power as 0 (the wire type is
// a number): Windows without nvidia-smi, macOS without a reading, amdgpu
// without power1_average. A running GPU never reads exactly 0 °C or 0 W,
// so 0 means "no sensor" for those two.

import type { NaMetric } from '../components/ui/SensorNaInfo';

type SensorFields = {
  fan_speed?: number | null;
  utilization?: number | null;
  temperature?: number | null;
  power?: number | null;
};

export function sensorMissing(metric: NaMetric, s: SensorFields | undefined): boolean {
  if (!s) return true;
  switch (metric) {
    case 'fan': return s.fan_speed == null;
    case 'utilization': return s.utilization == null;
    case 'temperature': return s.temperature == null || s.temperature <= 0;
    case 'power': return s.power == null || s.power <= 0;
  }
}
