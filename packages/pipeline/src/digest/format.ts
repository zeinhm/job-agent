const ATS_SOURCES = new Set(["greenhouse", "lever", "ashby"]);

const M = 1_000_000;

function millions(n: number): string {
  return `IDR ${(n / M).toFixed(1)}M`;
}

export interface SalaryView {
  status: "listed" | "unknown" | "unparsed" | "no_fx";
  idrMonthMin: number | null;
  idrMonthMax: number | null;
}

/** Salary line for the digest. Numbers are the normalized IDR per month values. */
export function formatSalary(s: SalaryView): string {
  if (s.status === "unparsed") return "salary not parsed";
  if (s.status === "no_fx") return "no FX rate";
  const { idrMonthMin: min, idrMonthMax: max } = s;
  if (s.status !== "listed" || (min === null && max === null)) return "salary unknown";
  if (min !== null && max !== null) {
    return min === max
      ? `${millions(min)} / month`
      : `${millions(min)}–${millions(max).slice(4)} / month`;
  }
  if (min !== null) return `from ${millions(min)} / month`;
  return `up to ${millions(max as number)} / month`;
}

export function isAtsSource(source: string): boolean {
  return ATS_SOURCES.has(source);
}

/** Parses a JSON text array column; anything else is an empty list. */
export function parseList(text: string | null): string[] {
  if (text === null) return [];
  try {
    const v: unknown = JSON.parse(text);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
