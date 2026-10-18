import { normalizeQuestion } from "../../match.ts";
import type { FormField } from "../../fill-plan.ts";
import type { FormComparison } from "../greenhouse/form.ts";

/**
 * What the Lever apply page shows (docs/research/t_d0698332-ats-form-structure.md, section 2): a server-rendered
 * `form#application-form` whose controls have real `name` attributes (`name`, `email`, `phone`, `org`, `urls[...]`,
 * `cards[<card>][field<n>]`), labels in `.application-label` (a `span.required` marks a required question) and radio /
 * checkbox options in `.application-answer-alternative`. There is no id like Greenhouse's question id: the control's
 * `name` is the question id. The EEO survey (`surveysResponses[...]`), the pronouns checkboxes, the marketing consent and
 * the hidden bookkeeping inputs are never read, so they are never filled.
 */
export type LeverKind =
  | "text"
  | "textarea"
  | "file"
  | "select"
  | "multiselect"
  | "radio_group"
  | "checkbox_group"
  | "combobox"
  | "unsupported";

export interface LeverControl {
  /** The control's `name` attribute: the question id. */
  name: string;
  kind: LeverKind;
  label: string;
  required: boolean;
  /** Option labels (select, radio and checkbox groups); null for a plain input. */
  options: string[] | null;
  /** `value` of each radio / checkbox input, parallel to `options`. */
  optionValues: string[];
  /** Ashby only: tag and input type of the entry's controls (e.g. `input:tel+select`); kinds, never a value. */
  shape?: string;
}

/** Fixed expression run in the page; the result is JSON (null when the page has no application form). */
export const READ_CONTROLS_EXPRESSION = `(() => {
  const form = document.querySelector("form#application-form");
  if (!form) return null;
  const text = (el) => el.textContent.replace(/\\s+/g, " ").trim();
  const item = (el) => el.closest("li.application-question");
  const labelOf = (el) => {
    const li = item(el);
    const l = li ? li.querySelector(".application-label") : null;
    if (l) {
      const copy = l.cloneNode(true);
      copy.querySelectorAll(".required").forEach((n) => n.remove());
      return text(copy);
    }
    const byFor = el.id ? form.querySelector('label[for="' + CSS.escape(el.id) + '"]') : null;
    return byFor ? text(byFor) : (el.getAttribute("aria-label") || el.getAttribute("placeholder") || "");
  };
  const requiredOf = (el) => {
    const li = item(el);
    return li ? li.querySelector(".application-label .required") !== null : el.hasAttribute("required");
  };
  const optionLabel = (box) => {
    const span = box.parentElement ? box.parentElement.querySelector(".application-answer-alternative") : null;
    return span ? text(span) : box.value;
  };
  const skipped = (el) => {
    const name = el.getAttribute("name") || "";
    const type = (el.getAttribute("type") || "").toLowerCase();
    return (
      name === "" ||
      type === "hidden" ||
      // a helper input inside a suggestion widget (location search box) belongs to that widget's field
      el.closest(".dropdown-results, .dropdown-container") !== null ||
      ["submit", "button", "image", "reset"].includes(type) ||
      name.startsWith("surveysResponses[") ||
      name.startsWith("consent[") ||
      name === "pronouns" ||
      name === "selectedLocation" ||
      name === "h-captcha-response"
    );
  };
  const groups = new Map();
  for (const el of form.querySelectorAll("input, textarea, select")) {
    if (skipped(el)) continue;
    const name = el.getAttribute("name");
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(el);
  }
  const out = [];
  for (const [name, els] of groups) {
    const first = els[0];
    const type = (first.getAttribute("type") || "").toLowerCase();
    const base = { name, label: labelOf(first), required: requiredOf(first), options: null, optionValues: [] };
    const allBoxes = els.every((e) => e.tagName === "INPUT" && e.type === type && (type === "radio" || type === "checkbox"));
    if (els.length > 1 && !allBoxes) {
      out.push({ ...base, kind: "unsupported" });
    } else if (allBoxes) {
      out.push({
        ...base,
        kind: type === "radio" ? "radio_group" : "checkbox_group",
        options: els.map(optionLabel),
        optionValues: els.map((e) => e.value),
      });
    } else if (first.tagName === "TEXTAREA") {
      out.push({ ...base, kind: "textarea" });
    } else if (first.tagName === "SELECT") {
      out.push({
        ...base,
        kind: first.hasAttribute("multiple") ? "multiselect" : "select",
        options: [...first.options].filter((o) => o.value !== "").map((o) => text(o)),
      });
    } else if (type === "file") {
      out.push({ ...base, kind: "file" });
    } else if (["", "text", "email", "tel", "url"].includes(type)) {
      out.push({ ...base, kind: "text" });
    } else {
      out.push({ ...base, kind: "unsupported" });
    }
  }
  return out;
})()`;

const isYesNo = (options: readonly string[]): boolean => {
  const n = options.map(normalizeQuestion).sort();
  return n.length === 2 && n[0] === "no" && n[1] === "yes";
};

/** The page's controls as the planner's fields and as `posting_questions` rows (type names as `fetch-questions` uses). */
export function fieldsFromControls(
  controls: readonly LeverControl[],
  atsType = "lever",
): FormField[] {
  return controls.map((c): FormField => {
    const field_type = ((): string => {
      switch (c.kind) {
        case "text":
        case "combobox": // Ashby only (an autocomplete input); the filler never fills it
          return "text";
        case "textarea":
          return "long_text";
        case "file":
          return "file";
        case "select":
        case "radio_group":
          return isYesNo(c.options ?? []) ? "yes_no" : "choice";
        case "multiselect":
        case "checkbox_group":
          return "multi_choice";
        case "unsupported":
          return "other";
      }
    })();
    return {
      label: c.label,
      field_type,
      required: c.required,
      options: c.options,
      ats: { type: atsType, id: c.name },
      ...(c.shape !== undefined ? { dom: c.shape } : {}),
    };
  });
}

const sameOptions = (a: readonly string[], b: readonly string[]): boolean => {
  const x = new Set(a.map(normalizeQuestion));
  const y = new Set(b.map(normalizeQuestion));
  return x.size === y.size && [...x].every((o) => y.has(o));
};

/**
 * The fields the page shows now against the last stored ones, by control name: a stored name that is gone is `missing`,
 * a new one is `extra`, and one whose label, type, required flag or option set changed is `different`. Labels only.
 */
export function compareQuestions(
  stored: readonly FormField[],
  page: readonly FormField[],
  opts: { upgradeOther?: boolean } = {},
): FormComparison & { upgraded?: string[] } {
  const byId = new Map(page.map((f) => [f.ats.id, f]));
  const storedIds = new Set(stored.map((f) => f.ats.id));
  const missing: string[] = [];
  const different: string[] = [];
  const upgraded: string[] = [];
  for (const f of stored) {
    const now = byId.get(f.ats.id);
    if (now === undefined) {
      missing.push(f.label);
      continue;
    }
    const sameLabel = normalizeQuestion(now.label) === normalizeQuestion(f.label);
    // A row an older reader could not classify (`other`) that the reader now understands, under the same name and label,
    // is a reader change, not a page change: its type, required flag and options came from a different reading.
    if (opts.upgradeOther === true && f.field_type === "other" && now.field_type !== "other") {
      if (sameLabel) upgraded.push(now.label);
      else different.push(now.label);
      continue;
    }
    const sameOpts =
      now.options === null || f.options === null
        ? now.options === f.options
        : sameOptions(now.options, f.options);
    if (!sameLabel || now.field_type !== f.field_type || now.required !== f.required || !sameOpts)
      different.push(now.label);
  }
  const extra = page.filter((f) => !storedIds.has(f.ats.id)).map((f) => f.label || f.ats.id);
  return {
    ok: missing.length === 0 && extra.length === 0 && different.length === 0,
    missing,
    extra,
    different,
    ...(opts.upgradeOther === true ? { upgraded } : {}),
  };
}

/**
 * Fixed expression that reads what each control now holds, as visible texts, keyed by control name: the typed value, the
 * selected option labels, the checked option labels or the chosen file names.
 */
export function readValuesExpression(controls: readonly LeverControl[]): string {
  const spec = controls.map((c) => ({ name: c.name, kind: c.kind, optionValues: c.optionValues }));
  return `((spec) => {
  const out = {};
  const text = (el) => el.textContent.replace(/\\s+/g, " ").trim();
  const form = document.querySelector("form#application-form");
  for (const c of spec) {
    const els = [...form.elements].filter((e) => e.getAttribute("name") === c.name);
    const first = els[0];
    if (!first) { out[c.name] = []; continue; }
    if (c.kind === "select" || c.kind === "multiselect") {
      out[c.name] = [...first.selectedOptions].filter((o) => o.value !== "").map((o) => text(o));
    } else if (c.kind === "radio_group" || c.kind === "checkbox_group") {
      out[c.name] = els.filter((e) => e.checked).map((e) => {
        const span = e.parentElement ? e.parentElement.querySelector(".application-answer-alternative") : null;
        return span ? text(span) : e.value;
      });
    } else if (c.kind === "file") {
      out[c.name] = [...(first.files || [])].map((f) => f.name);
    } else {
      out[c.name] = first.value === "" ? [] : [first.value];
    }
  }
  return out;
})(${JSON.stringify(spec)})`;
}
