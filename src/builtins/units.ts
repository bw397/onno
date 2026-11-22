/**
 * Human-readable sizes, as GNU ls -h and df -h print them: powers of 1024 with a
 * K/M/G/T/P suffix, one decimal below 10, always rounded up (so a size is never
 * under-reported); under 1024 bytes, the plain number.
 */
export function human(n: number): string {
  const units = ["", "K", "M", "G", "T", "P"];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  if (unit === 0) return String(n);
  // Decide the format from the *rounded* value, as GNU does: 9.99K rounds up to 10K (no
  // decimal), and 1023.9K rounds up to 1024K, which becomes 1.0M.
  for (;;) {
    if (value < 10) {
      const tenths = Math.ceil(value * 10) / 10;
      if (tenths < 10) return tenths.toFixed(1) + units[unit]!;
    }
    const whole = Math.ceil(value);
    if (whole >= 1024 && unit < units.length - 1) {
      value = whole / 1024;
      unit++;
      continue;
    }
    return whole + units[unit]!;
  }
}
