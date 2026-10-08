/** IDR amount in millions with one decimal: 25000000 -> "25.0M". */
export function formatMillions(idr: number): string {
  return `${(idr / 1_000_000).toFixed(1)}M`;
}

export interface DigestSalary {
  status: "listed" | "unknown" | "unparsed" | "no_fx";
  idrMonthMin: number | null;
  idrMonthMax: number | null;
}

export function formatSalary(s: DigestSalary): string {
  if (s.status === "unparsed") return "salary not parsed";
  if (s.status === "no_fx") return "no FX rate";
  const { idrMonthMin: min, idrMonthMax: max } = s;
  if (s.status === "unknown" || (min === null && max === null)) return "salary unknown";
  if (min !== null && max !== null) {
    return min === max
      ? `IDR ${formatMillions(min)} / month`
      : `IDR ${formatMillions(min)}–${formatMillions(max)} / month`;
  }
  if (min !== null) return `from IDR ${formatMillions(min)} / month`;
  return `up to IDR ${formatMillions(max ?? 0)} / month`;
}
