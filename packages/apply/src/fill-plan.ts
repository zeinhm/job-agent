import { closeSync, openSync, readSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { ANSWER_TYPES } from "@job-agent/core";
import { mappingId } from "./choice-coverage.ts";
import { matchQuestion, normalizeQuestion, type AnswerIndex, type StandardField } from "./match.ts";
import { isSalaryWording } from "./salary.ts";
import { validateTypedAnswer } from "./typed-answer.ts";

/**
 * Fill plan (PLAN 5.1, 6, 10): which value goes into which form field, decided in plain code from the form's fields,
 * the approved answers, the approved choice mappings and the posting's tier ask. No browser, no network, no LLM.
 *
 * Result (owner decision on t_2c20b3fa question 4, Phase 5): a covered field is filled, an uncovered one stays empty and
 * is listed in `needsInput`; the run is then `needs_input`. Only a form that cannot be filled safely at all is a `stop`
 * (scam flagged, unsupported field type, a field that matches two answers). The strict rule (everything covered) is the
 * rule for submitting in Phase 6, where a non-empty `needsInput` blocks the submit.
 */

/** Field kinds the planner can fill; the vocabulary of `posting_questions.type`, plus `number`. Anything else stops. */
export const SUPPORTED_FIELD_TYPES = [
  "text",
  "long_text",
  "number",
  "yes_no",
  "choice",
  "multi_choice",
  "file",
] as const;
export type SupportedFieldType = (typeof SUPPORTED_FIELD_TYPES)[number];

/** One field the form shows, as the fillers read it. Shared by the planner and the per-ATS fillers. */
export interface FormField {
  label: string;
  field_type: string;
  required: boolean;
  /** Option texts exactly as the form lists them; null for a field without options. */
  options: string[] | null;
  /** The ATS's own handle for the field, so a filler can find it again. */
  ats: { type: string; id: string; name?: string | null };
  /** DOM shape of the control as a filler read it (tags and input types only); shown when the field stops the run. */
  dom?: string;
}

/** The bank answers the planner may use; `approved: false` rows cover nothing. */
export interface PlanAnswer {
  key: string;
  question: string | null;
  alternatives: string[] | null;
  answer: string;
  type: (typeof ANSWER_TYPES)[number] | null;
  choices: string[] | null;
  approved: boolean;
}

/** The posting's tier ask (the analysis `intel` row): both figures are always stored together. */
export interface TierAsk {
  askIdrMonth: number | null;
  askUsdYear: number | null;
  askText: string | null;
}

export type ResumeProbe = (path: string) => { ok: true } | { ok: false; detail: string };

export interface FillInput {
  fields: readonly FormField[];
  answers: readonly PlanAnswer[];
  /** Approved choice mappings: `mappingId(answer key, label, options)` -> the options the owner picked. */
  choiceMappings: ReadonlyMap<string, readonly string[]>;
  ask: TierAsk | null;
  /** `scam` verdict or review action on the posting. */
  scamFlagged: boolean;
  /** The posting's company name and title, for the cover letter's `{company}` / `{role}`; absent = unknown. */
  posting?: PostingNames | null;
  /** Defaults to `probeResumeFile`. */
  probeResume?: ResumeProbe;
}

/** The posting facts a cover letter text may name. */
export interface PostingNames {
  company: string | null;
  title: string | null;
}

export type FieldSource = "answer" | "choice_mapping" | "tier_ask" | "standard" | "resume" | "none";
export type NeedsInputReason = "uncovered_question" | "choice_unmapped";

export type PlannedField =
  | {
      field: FormField;
      filled: true;
      /** One string; a multi-choice field gets every picked option. A resume gets its local path. */
      value: string | string[];
      source: Exclude<FieldSource, "none">;
      answerKey: string | null;
    }
  | {
      field: FormField;
      filled: false;
      source: "none";
      answerKey: string | null;
      reason: NeedsInputReason;
      /** Short, never an answer value. */
      detail: string;
      /** True when no answer matches the wording at all: the label goes to the Inbox. */
      inbox: boolean;
    };

export type StopReason = "unexpected_field" | "other";

export type FillPlan =
  | {
      kind: "fill";
      /** Every form field, in form order. */
      fields: PlannedField[];
      /** `filled` when no field needs input (a full fill), else `needs_input`. */
      status: "filled" | "needs_input";
      /** `choice_unmapped` when only mappings are missing, else `uncovered_question`; null for a full fill. */
      needsInputReason: NeedsInputReason | null;
    }
  | { kind: "stop"; reason: StopReason; details: string[] };

export const MAX_RESUME_BYTES = 10 * 1024 * 1024;

/** The resume file must exist, be an absolute path to a regular PDF (`.pdf`, `%PDF-` header) under 10 MB. */
export const probeResumeFile: ResumeProbe = (path) => {
  if (!isAbsolute(path)) return { ok: false, detail: "resume path is not absolute" };
  if (!/\.pdf$/i.test(path)) return { ok: false, detail: "resume file is not a .pdf" };
  let size: number;
  try {
    const st = statSync(path);
    if (!st.isFile()) return { ok: false, detail: "resume path is not a file" };
    size = st.size;
  } catch {
    return { ok: false, detail: "resume file does not exist" };
  }
  if (size === 0 || size >= MAX_RESUME_BYTES)
    return { ok: false, detail: "resume file is empty or 10 MB or more" };
  const head = Buffer.alloc(5);
  try {
    const fd = openSync(path, "r");
    try {
      readSync(fd, head, 0, 5, 0);
    } finally {
      closeSync(fd);
    }
  } catch {
    return { ok: false, detail: "resume file cannot be read" };
  }
  return head.toString("latin1") === "%PDF-"
    ? { ok: true }
    : { ok: false, detail: "resume file is not a PDF" };
};

/** Standard fields come from approved answers under the real bank's keys (`contact.*`; files stay `profile.*`). `name` is split by `nameRole`. */
export const PROFILE_KEYS: Record<StandardField, string | null> = {
  name: "contact.full_name",
  email: "contact.email",
  phone: "contact.phone",
  resume: "profile.resume_file",
  cover_letter: null, // no such key in answer-keys.json: the field is never filled
  linkedin: "contact.linkedin",
  website: "contact.portfolio",
  location: "contact.location",
  additional_info: "misc.contractor_note",
};

/** Approved answer of a "Cover letter" text field (owner decision, no LLM): a text with `{company}` and `{role}`. */
export const COVER_LETTER_TEXT_KEY = "misc.cover_letter_text";

/** The fixed cover letter notes a row may carry (listed in the dry-run report's known notes; the text itself never is). */
export const COVER_LETTER_NOTES: readonly string[] = [
  "cover letter needs a file",
  "cover letter text not approved",
  "no answer-bank key for cover_letter",
  `${COVER_LETTER_TEXT_KEY} is empty or not valid`,
  "cover letter text has an unknown placeholder",
  "cover letter needs the posting's title",
  "cover letter needs the posting's company name",
];

type Rendered = { ok: true; text: string } | { ok: false; detail: string };

/**
 * Plain replacement of `{company}` and `{role}` in the approved cover letter text with the posting's company name and
 * title. One pass (a company named "{role}" is not expanded again). Any other `{...}` placeholder, or a missing / blank
 * company or title for a placeholder the text uses, is a miss. The detail never contains the text.
 */
export function renderCoverLetter(
  template: string,
  posting: PostingNames | null | undefined,
): Rendered {
  const names: Record<string, string | null | undefined> = {
    company: posting?.company,
    role: posting?.title,
  };
  let detail: string | null = null;
  const text = template.replace(/\{([^{}]*)\}/g, (whole: string, name: string) => {
    if (!Object.hasOwn(names, name)) {
      detail ??= "cover letter text has an unknown placeholder";
      return whole;
    }
    const value = (names[name] ?? "").trim().replace(/\s+/g, " ");
    if (value === "")
      detail ??= `cover letter needs the posting's ${name === "role" ? "title" : "company name"}`;
    return value;
  });
  return detail === null ? { ok: true, text } : { ok: false, detail };
}

/**
 * Name rule: `contact.full_name` is the full name. A "first name" / "given name" field (and "preferred name") gets the first
 * whitespace-separated word; a "last name" / "surname" / "family name" field gets everything after the first word (a
 * single-word name has no last name: the field needs input); every other name field gets the full name.
 */
export function nameRole(normalized: string): "first" | "last" | "full" {
  if (normalized === "first name" || normalized === "given name" || normalized === "preferred name")
    return "first";
  if (normalized === "last name" || normalized === "surname" || normalized === "family name")
    return "last";
  return "full";
}

export function splitName(full: string, role: "first" | "last" | "full"): string | null {
  const words = full
    .trim()
    .split(/\s+/)
    .filter((w) => w !== "");
  if (words.length === 0) return null;
  if (role === "full") return words.join(" ");
  if (role === "first") return words[0] ?? null;
  return words.length > 1 ? words.slice(1).join(" ") : null;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^\+?[\d\s().-]{6,30}$/;

function isHttpUrl(v: string): boolean {
  try {
    const u = new URL(v.trim());
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

/** Format rule per standard field, on top of the answer's own typed validation. */
function standardFormatOk(field: StandardField, value: string): boolean {
  const v = value.trim();
  if (field === "email") return EMAIL.test(v);
  if (field === "phone") return PHONE.test(v) && (v.match(/\d/g)?.length ?? 0) >= 6;
  if (field === "linkedin" || field === "website") return isHttpUrl(v);
  return v !== "";
}

/** ISO 4217 codes other than USD / IDR, matched case-insensitively. Codes that are also common English words (all, try, top, mad, pen, cup, sos) are only caught in upper case. */
const FOREIGN_ISO = new Set(
  "aed afn amd ang aoa ars aud awg azn bam bbd bdt bgn bhd bif bmd bnd bob brl bsd btn bwp byn bzd cad cdf chf clp cny cop crc cve czk djf dkk dop dzd egp ern etb eur fjd fkp gbp gel ghs gip gmd gnf gtq gyd hkd hnl htg huf ils inr iqd irr isk jmd jod jpy kes kgs khr kmf kpw krw kwd kyd kzt lak lbp lkr lrd lsl lyd mdl mga mkd mmk mnt mop mru mur mvr mwk mxn myr mzn nad ngn nio nok npr nzd omr pab pgk php pkr pln pyg qar ron rsd rub rwf sar sbd scr sdg sek sgd shp sll srd ssp stn svc syp szl thb tjs tmt tnd ttd twd tzs uah ugx uyu uzs vef ves vnd vuv wst xaf xcd xof xpf yer zar zmw".split(
    " ",
  ),
);
const FOREIGN_WORD = new RegExp(
  "\\b(euros?|pounds?|sterling|yen|yuan|renminbi|rmb|ringgit|pesos?|francs?|rupees?|won|baht|dong|kronor|krona|kroner|krone|rand|riyals?|dirhams?|shekels?|zloty|forint|lira|rubles?|roubles?|reais|kuna|lei|taka|" +
    "(singapore|singaporean|australian|canadian|hong kong|new zealand|nz|taiwan|taiwanese|brunei|fijian|jamaican|liberian|namibian|trinidad|eastern caribbean|bahamian|barbadian|belize|guyanese|surinamese) dollars?)\\b",
  "u",
);

type SalaryNumber = { ok: true; value: string } | { ok: false; detail: string };

/**
 * Salary number rule. Currency: `idr` / `rupiah` in the label = IDR, naming both IDR and USD is unclear, any other currency
 * (ISO code, word or symbol) is not supported (needs input), nothing or `usd` = USD. Period: month words (`month`, `monthly`, `bulan`, `bulanan`) = monthly,
 * year words (`year`, `yearly`, `annual`, `annually`, `annum`, `tahun`, `tahunan`) = yearly, both = unclear (needs input),
 * hourly / daily / weekly = not supported (needs input); no period word = monthly for IDR, yearly for USD.
 * Figures: IDR monthly = `askIdrMonth`, IDR yearly = `askIdrMonth` x 12, USD yearly = `askUsdYear`, USD monthly =
 * `askUsdYear` / 12 rounded up (never below the ask). Plain integer, no separators.
 */
export function salaryNumber(label: string, ask: TierAsk | null): SalaryNumber {
  const n = normalizeQuestion(label);
  const idr = /\b(idr|rupiah|rp)\b/u.test(n);
  const usd = /\b(usd|us dollars?)\b/u.test(n) || label.includes("$");
  // Allow-list: only USD, IDR or no currency word at all. Any other ISO code, currency word or symbol needs input.
  const foreignCode =
    (label.match(/\b[A-Z]{3}\b/gu) ?? []).some((c) => c !== "USD" && c !== "IDR") ||
    (n.match(/\b[a-z]{3}\b/gu) ?? []).some((c) => FOREIGN_ISO.has(c));
  const foreignWord = FOREIGN_WORD.test(n);
  const symbol = /[€£¥₹₩₱฿₫₪₺₽]/u.test(label);
  if (foreignCode || foreignWord || symbol)
    return { ok: false, detail: "salary: currency not supported" };
  if (idr && usd) return { ok: false, detail: "salary: currency unclear" };
  const monthly = /\b(month|monthly|bulan|bulanan)\b/u.test(n);
  const yearly = /\b(year|yearly|annual|annually|annum|tahun|tahunan)\b/u.test(n);
  if (/\b(hour|hourly|day|daily|weekly|week)\b/u.test(n))
    return { ok: false, detail: "salary: period not supported" };
  if (monthly && yearly) return { ok: false, detail: "salary: period unclear" };
  const perMonth = monthly || (!yearly && idr);
  if (ask === null) return { ok: false, detail: "salary: no ask" };
  const figure = idr
    ? ask.askIdrMonth === null
      ? null
      : perMonth
        ? ask.askIdrMonth
        : ask.askIdrMonth * 12
    : ask.askUsdYear === null
      ? null
      : perMonth
        ? Math.ceil(ask.askUsdYear / 12)
        : ask.askUsdYear;
  return figure === null || !Number.isFinite(figure) || figure <= 0
    ? { ok: false, detail: "salary: no ask" }
    : { ok: true, value: String(figure) };
}

/** Text of a salary text field: the ask text when the tier has one, else both figures. */
export function salaryText(ask: TierAsk | null): string | null {
  if (ask === null) return null;
  if (ask.askText !== null && ask.askText.trim() !== "") return ask.askText.trim();
  const parts: string[] = [];
  if (ask.askUsdYear !== null) parts.push(`${ask.askUsdYear} USD per year`);
  if (ask.askIdrMonth !== null) parts.push(`${ask.askIdrMonth} IDR per month`);
  return parts.length === 0 ? null : parts.join(" (") + (parts.length > 1 ? ")" : "");
}

const norm = (s: string): string => s.trim().replace(/\s+/g, " ").toLowerCase();

/** Wording -> distinct approved answer keys that carry it. Salary wordings are never indexed. */
function wordingKeys(answers: readonly PlanAnswer[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const a of answers) {
    if (!a.approved) continue;
    for (const w of [a.question, ...(a.alternatives ?? [])]) {
      if (w === null || isSalaryWording(w)) continue;
      const n = normalizeQuestion(w);
      if (n === "") continue;
      const set = out.get(n) ?? new Set<string>();
      set.add(a.key);
      out.set(n, set);
    }
  }
  return out;
}

type Cell = {
  ok: true;
  value: string | string[];
  answerKey: string | null;
  source: Exclude<FieldSource, "none">;
};
type Miss = {
  ok: false;
  reason: NeedsInputReason;
  detail: string;
  inbox: boolean;
  answerKey: string | null;
};

const miss = (detail: string, answerKey: string | null = null, inbox = false): Miss => ({
  ok: false,
  reason: "uncovered_question",
  detail,
  inbox,
  answerKey,
});

/** Typed validation (P1) of an answer for the field it goes into: the field's own rule and the answer's own type. */
function answerValue(field: FormField, a: PlanAnswer): string | null {
  const text = a.answer.trim();
  const own = validateTypedAnswer({ answer: a.answer, type: a.type, choices: a.choices });
  if (!own.ok) return null;
  const byField =
    field.field_type === "yes_no" || field.field_type === "number" ? field.field_type : null;
  if (
    byField !== null &&
    !validateTypedAnswer({ answer: a.answer, type: byField, choices: null }).ok
  )
    return null;
  if (field.field_type === "yes_no") {
    const wanted = text.toLowerCase();
    const option = field.options?.find((o) => norm(o) === wanted);
    return option ?? (wanted === "yes" ? "Yes" : "No");
  }
  return text;
}

/** The plan for one posting's form. Pure: the same input always gives the same plan. */
export function planFill(input: FillInput): FillPlan {
  if (input.scamFlagged) return { kind: "stop", reason: "other", details: ["scam flagged"] };

  const unsupported = input.fields.filter(
    (f) => !(SUPPORTED_FIELD_TYPES as readonly string[]).includes(f.field_type),
  );
  if (unsupported.length > 0)
    return {
      kind: "stop",
      reason: "unexpected_field",
      details: unsupported.map((f) =>
        f.dom === undefined ? f.label : `${f.label} (${f.field_type}, ${f.dom})`,
      ),
    };

  const approved = input.answers.filter((a) => a.approved);
  const byKey = new Map(approved.map((a) => [a.key, a]));
  const keysOf = wordingKeys(input.answers);
  const index: AnswerIndex = new Map(
    [...keysOf].flatMap(([w, keys]) =>
      keys.size === 1 ? [[w, [...keys][0] as string] as const] : [],
    ),
  );
  const probe = input.probeResume ?? probeResumeFile;

  // Ambiguity: a wording reached by more than one distinct answer key (the standard profile key is one key, however
  // many routes lead to it). The stop names the keys per field, never values.
  const ambiguous: string[] = [];
  for (const f of input.fields) {
    if (isSalaryWording(f.label)) continue;
    const n = normalizeQuestion(f.label);
    const keys = new Set(keysOf.get(n) ?? []);
    const m = matchQuestion(n, new Map());
    const pk = m?.kind === "standard" ? PROFILE_KEYS[m.field] : null;
    if (pk != null && byKey.has(pk)) keys.add(pk);
    if (keys.size > 1) ambiguous.push(`${f.label} (${[...keys].sort().join(", ")})`);
  }
  if (ambiguous.length > 0)
    return { kind: "stop", reason: "other", details: ["ambiguous match", ...ambiguous] };

  const fields: PlannedField[] = input.fields.map((field): PlannedField => {
    const cell = coverField(field, input, index, byKey, probe);
    return cell.ok
      ? { field, filled: true, value: cell.value, source: cell.source, answerKey: cell.answerKey }
      : {
          field,
          filled: false,
          source: "none",
          answerKey: cell.answerKey,
          reason: cell.reason,
          detail: cell.detail,
          inbox: cell.inbox,
        };
  });
  const open = fields.filter((f) => !f.filled);
  return {
    kind: "fill",
    fields,
    status: open.length === 0 ? "filled" : "needs_input",
    needsInputReason:
      open.length === 0
        ? null
        : open.every((f) => !f.filled && f.reason === "choice_unmapped")
          ? "choice_unmapped"
          : "uncovered_question",
  };
}

function coverField(
  field: FormField,
  input: FillInput,
  index: AnswerIndex,
  byKey: ReadonlyMap<string, PlanAnswer>,
  probe: ResumeProbe,
): Cell | Miss {
  const type = field.field_type as SupportedFieldType;
  const n = normalizeQuestion(field.label);

  if (isSalaryWording(field.label)) {
    if (type === "number") {
      const r = salaryNumber(field.label, input.ask);
      return r.ok
        ? { ok: true, value: r.value, answerKey: null, source: "tier_ask" }
        : miss(r.detail);
    }
    if (type === "text" || type === "long_text") {
      const t = salaryText(input.ask);
      return t === null
        ? miss("salary: no ask")
        : { ok: true, value: t, answerKey: null, source: "tier_ask" };
    }
    return miss(`salary: a ${type} field cannot take the ask`);
  }

  const m = matchQuestion(n, index);

  // A cover letter TEXT field is filled from the approved text; a file-only cover letter needs a file (none is generated).
  if (m?.kind === "standard" && m.field === "cover_letter") {
    if (type === "file") return miss("cover letter needs a file");
    if (type === "text" || type === "long_text") {
      const key = COVER_LETTER_TEXT_KEY;
      const a = byKey.get(key);
      if (a === undefined)
        return input.answers.some((x) => x.key === key)
          ? miss("cover letter text not approved", key)
          : miss("no answer-bank key for cover_letter", key);
      const base = answerValue(field, a);
      if (base === null || base === "") return miss(`${key} is empty or not valid`, key);
      const r = renderCoverLetter(base, input.posting);
      return r.ok
        ? { ok: true, value: r.text, answerKey: key, source: "answer" }
        : miss(r.detail, key);
    }
  }

  if (m?.kind === "standard" && m.field === "additional_info") {
    const key = PROFILE_KEYS.additional_info as string;
    if (type !== "text" && type !== "long_text")
      return miss(`additional information field is a ${type} field`, key);
    const a = byKey.get(key);
    if (a === undefined) return miss(`no approved ${key}`, key);
    const value = answerValue(field, a);
    return value === null || value === ""
      ? miss(`${key} is empty or not valid`, key)
      : { ok: true, value, answerKey: key, source: "answer" };
  }

  if (m?.kind === "standard") {
    const key = PROFILE_KEYS[m.field];
    if (key === null) return miss(`no answer-bank key for ${m.field}`);
    const a = byKey.get(key);
    if (a === undefined) return miss(`no approved ${key}`, key);
    if (m.field === "resume") {
      if (type !== "file") return miss("resume field is not a file field", key);
      const path = a.answer.trim();
      const probed = probe(path);
      return probed.ok
        ? { ok: true, value: path, answerKey: key, source: "resume" }
        : miss(probed.detail, key);
    }
    if (type !== "text" && type !== "long_text")
      return miss(`${m.field} field is a ${type} field`, key);
    const base = answerValue(field, a);
    const value = base === null ? null : m.field === "name" ? splitName(base, nameRole(n)) : base;
    if (value === null || !standardFormatOk(m.field, value))
      return miss(`${key} is empty or not valid for ${m.field}`, key);
    return { ok: true, value, answerKey: key, source: "standard" };
  }

  if (m === null) return miss("no approved answer", null, true);
  if (m.kind !== "answer") return miss("no approved answer", null, true);
  const a = byKey.get(m.key);
  if (a === undefined) return miss("no approved answer", null, true);

  if (type === "choice" || type === "multi_choice") {
    const options = field.options;
    if (options === null || options.length === 0)
      return miss("choice field lists no options", m.key);
    const chosen = input.choiceMappings.get(mappingId(m.key, field.label, options));
    if (chosen === undefined)
      return {
        ok: false,
        reason: "choice_unmapped",
        detail: "no approved choice mapping",
        inbox: false,
        answerKey: m.key,
      };
    const picked = chosen.map((c) => options.find((o) => norm(o) === norm(c)));
    const exact = picked.filter((o): o is string => o !== undefined);
    const valid =
      exact.length === chosen.length &&
      new Set(exact).size === exact.length &&
      (type === "multi_choice" ? exact.length >= 1 : exact.length === 1) &&
      exact.every((o) => validateTypedAnswer({ answer: o, type: "choice", choices: options }).ok);
    if (!valid) return miss("choice mapping does not fit the form's options", m.key);
    return {
      ok: true,
      value: type === "multi_choice" ? exact : (exact[0] as string),
      answerKey: m.key,
      source: "choice_mapping",
    };
  }

  if (type === "file") return miss("file field has no source", m.key);
  const value = answerValue(field, a);
  if (value === null) return miss(`${m.key} is not valid for a ${type} field`, m.key);
  return { ok: true, value, answerKey: m.key, source: "answer" };
}
