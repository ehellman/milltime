/** Milltime splits durations into whole hours and minutes. */
export function toHours(hh: number | null, mm: number | null): number {
  return (hh ?? 0) + (mm ?? 0) / 60;
}
