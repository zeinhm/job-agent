import type { RawSalary } from "@job-agent/core";

export type SalaryPeriod = RawSalary["period"];

export interface SalaryRange {
  min?: number;
  max?: number;
  currency: string;
  period: SalaryPeriod;
}

export type ParsedSalary = SalaryRange | { status: "unknown" | "unparsed" };

const UNKNOWN = { status: "unknown" } as const;
const UNPARSED = { status: "unparsed" } as const;

const CURRENCY_TOKENS: Record<string, string> = {
  s$: "SGD",
  au$: "AUD",
  a$: "AUD",
  ca$: "CAD",
  c$: "CAD",
  us$: "USD",
  $: "USD",
  "€": "EUR",
  "£": "GBP",
  "rp.": "IDR",
  rp: "IDR",
  idr: "IDR",
  usd: "USD",
  eur: "EUR",
  gbp: "GBP",
  sgd: "SGD",
  aud: "AUD",
  cad: "CAD",
  chf: "CHF",
};

const PERIOD_WORDS: Record<string, SalaryPeriod> = {
  annum: "year",
  annual: "year",
  annually: "year",
  year: "year",
  yearly: "year",
  yr: "year",
  pa: "year",
  "p.a.": "year",
  month: "month",
  monthly: "month",
  mo: "month",
  bulan: "month",
  hour: "hour",
  hourly: "hour",
  hr: "hour",
};

const SUFFIX: Record<string, number> = { k: 1e3, jt: 1e6, juta: 1e6 };

const WORD_END = "(?![a-z])";
const alt = (keys: string[]) =>
  [...keys]
    .sort((a, b) => b.length - a.length)
    .map((k) => k.replace(/[.$]/g, "\\$&"))
    .join("|");

// Sticky scanner: every character of the text must be consumed by a known token, otherwise the text is unparsed.
const TOKEN = new RegExp(
  [
    `(?<cur>${alt(Object.keys(CURRENCY_TOKENS))})`,
    `(?<num>\\d{1,3}(?:[.,]\\d{3})+(?!\\d)|\\d+(?:[.,]\\d+)?)\\s*(?<suf>${alt(Object.keys(SUFFIX))})?${WORD_END}`,
    `(?<unit>(?:per\\s+|/\\s*)?(?:(?<pw>${alt(Object.keys(PERIOD_WORDS))})|(?<bad>week|weekly|wk|day|daily))${WORD_END})`,
    `(?<up>up\\s*to${WORD_END})`,
    `(?<from>(?:starting\\s+(?:at|from)|from)${WORD_END})`,
    `(?<sep>-|–|—|to${WORD_END})`,
  ].join("|"),
  "iy",
);

interface Amount {
  raw: string;
  suffix: number | undefined;
}

function parseNumber(raw: string, currency: string): number {
  if (currency === "IDR") {
    if (/^\d{1,3}(\.\d{3})+$/.test(raw)) return Number(raw.replaceAll(".", ""));
    // "Rp 25,5jt" is a decimal; "500,000" has a 3-digit group and is ambiguous, so it stays NaN.
    if (/^\d+(,\d{1,2})?$/.test(raw)) return Number(raw.replace(",", "."));
    if (/^\d+\.\d+$/.test(raw)) return Number(raw);
    return Number.NaN;
  }
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(raw)) return Number(raw.replaceAll(",", ""));
  // "4.000" could be a European thousands separator: refuse to guess.
  if (/^\d+\.\d{3}$/.test(raw)) return Number.NaN;
  if (/^\d+(\.\d+)?$/.test(raw)) return Number(raw);
  return Number.NaN;
}

/** Period inference for amounts without a period word; undefined when the amount is ambiguous. */
function inferPeriod(currency: string, amount: number): SalaryPeriod | undefined {
  if (currency === "IDR") {
    return amount >= 1_000_000 && amount <= 200_000_000 ? "month" : undefined;
  }
  if (amount >= 20_000) return "year";
  if (amount <= 300) return "hour";
  return undefined;
}

function parseText(input: string): ParsedSalary {
  const text = input
    .replace(/\+\s*(?:equity|bonus|stock(?:\s+options?)?|options?)\b.*$/i, "")
    .trim();
  if (text === "" || !/\d/.test(text)) return UNKNOWN;

  const currencies = new Set<string>();
  const amounts: Amount[] = [];
  let period: SalaryPeriod | undefined;
  let lead: "up" | "from" | undefined;
  let seps = 0;
  let firstAmountAt = -1;
  let sepAt = -1;
  let tokenIndex = 0;

  let pos = 0;
  while (pos < text.length) {
    if (/\s/.test(text[pos] ?? "")) {
      pos += 1;
      continue;
    }
    TOKEN.lastIndex = pos;
    const m = TOKEN.exec(text);
    if (m?.groups === undefined) return UNPARSED;
    const g = m.groups;
    tokenIndex += 1;
    if (g.cur !== undefined) {
      const code = CURRENCY_TOKENS[g.cur.toLowerCase()];
      if (code === undefined) return UNPARSED;
      currencies.add(code);
    } else if (g.num !== undefined) {
      if (amounts.length === 0) firstAmountAt = tokenIndex;
      amounts.push({
        raw: g.num,
        suffix: g.suf === undefined ? undefined : SUFFIX[g.suf.toLowerCase()],
      });
    } else if (g.bad !== undefined) {
      return UNPARSED;
    } else if (g.pw !== undefined) {
      const p = PERIOD_WORDS[g.pw.toLowerCase()];
      if (p === undefined || (period !== undefined && period !== p)) return UNPARSED;
      period = p;
    } else if (g.up !== undefined || g.from !== undefined) {
      if (lead !== undefined || amounts.length > 0) return UNPARSED;
      lead = g.up !== undefined ? "up" : "from";
    } else if (g.sep !== undefined) {
      seps += 1;
      sepAt = tokenIndex;
    } else {
      return UNPARSED;
    }
    pos = m.index + m[0].length;
  }

  if (currencies.size !== 1) return UNPARSED;
  const currency = [...currencies][0] as string;

  if (lead !== undefined) {
    if (amounts.length !== 1 || seps > 0) return UNPARSED;
  } else if (amounts.length === 2) {
    if (seps !== 1 || sepAt <= firstAmountAt) return UNPARSED;
  } else if (amounts.length !== 1 || seps > 0) {
    return UNPARSED;
  }

  // "50-60k": a suffix on the last amount applies to a bare first amount.
  const last = amounts[amounts.length - 1];
  const values = amounts.map((a) => {
    const suffix =
      a.suffix ?? (amounts.length === 2 && a === amounts[0] ? last?.suffix : undefined);
    return parseNumber(a.raw, currency) * (suffix ?? 1);
  });
  if (values.some((v) => !Number.isFinite(v) || v <= 0)) return UNPARSED;

  let min: number | undefined;
  let max: number | undefined;
  if (lead === "up") max = values[0];
  else if (lead === "from") min = values[0];
  else {
    min = values[0];
    max = values.length === 2 ? values[1] : values[0];
    if (min !== undefined && max !== undefined && min > max) return UNPARSED;
  }

  if (period === undefined) {
    const inferred = new Set(values.map((v) => inferPeriod(currency, v)));
    const only = inferred.size === 1 ? [...inferred][0] : undefined;
    if (only === undefined) return UNPARSED;
    period = only;
  } else if (
    currency === "IDR" &&
    period === "month" &&
    values.some((v) => inferPeriod("IDR", v) !== "month")
  ) {
    // An explicit period does not excuse an implausible amount ("IDR 500/month" is a misread).
    return UNPARSED;
  }

  return {
    ...(min === undefined ? {} : { min }),
    ...(max === undefined ? {} : { max }),
    currency,
    period,
  };
}

function parseStructured(s: RawSalary): ParsedSalary {
  const { min, max } = s;
  const ok = (n: number | undefined) => n === undefined || (Number.isFinite(n) && n > 0);
  if (!ok(min) || !ok(max) || (min !== undefined && max !== undefined && min > max))
    return UNPARSED;
  if (!/^[A-Za-z]{3}$/.test(s.currency)) return UNPARSED;
  return {
    ...(min === undefined ? {} : { min }),
    ...(max === undefined ? {} : { max }),
    currency: s.currency.toUpperCase(),
    period: s.period,
  };
}

/** Pure salary parser. Structured adapter data wins over text; never guesses. */
export function parseSalary(input: { salary?: RawSalary; salaryText?: string }): ParsedSalary {
  const { salary, salaryText } = input;
  if (salary !== undefined && (salary.min !== undefined || salary.max !== undefined)) {
    return parseStructured(salary);
  }
  if (salaryText === undefined) return UNKNOWN;
  return parseText(salaryText);
}
