/** 7.5 → "7.5h", null → "–". Rounds to two decimals. */
export function formatHours(hours: number | null): string {
  if (hours === null) return "–";
  return `${Number(hours.toFixed(2))}h`;
}
