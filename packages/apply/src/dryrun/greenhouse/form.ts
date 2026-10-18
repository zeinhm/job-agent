import { normalizeQuestion } from "../../match.ts";
import type { FormField } from "../../fill-plan.ts";

/**
 * What the Greenhouse job-boards form shows (docs/research/t_d0698332-ats-form-structure.md, section 2): every control
 * has an `id` that equals the stored `question_id`, there is no `name` attribute, selects are react-select comboboxes
 * whose options only exist once the menu opens. The reader works on `form#application-form` and skips the EEOC block,
 * the phone country combobox and react-select's hidden helper inputs.
 */
export type DomKind =
  | "text"
  | "textarea"
  | "file"
  | "select"
  | "multiselect"
  | "combobox"
  | "location"
  | "education"
  | "radio_group"
  | "checkbox_group"
  | "unsupported";

export interface DomControl {
  id: string;
  kind: DomKind;
  label: string;
  /** Option labels the DOM lists (select, radio, checkbox groups); null for a combobox (menu closed) or a plain input. */
  options: string[] | null;
  /** Ids of the radio / checkbox inputs of a group, parallel to `options`. */
  optionIds: string[];
  /** The page marks the control required (`required` / `aria-required`); read for the education block. */
  required?: boolean;
}

/** Fixed expression run in the page; the result is JSON (null when the page has no application form). */
export const READ_CONTROLS_EXPRESSION = `(() => {
  const form = document.querySelector("form#application-form");
  if (!form) return null;
  const clean = (el) => {
    const copy = el.cloneNode(true);
    copy.querySelectorAll("[aria-hidden='true']").forEach((n) => n.remove());
    return copy.textContent.replace(/\\s+/g, " ").trim();
  };
  const labelOf = (el) => {
    const byFor = el.id ? form.querySelector('label[for="' + CSS.escape(el.id) + '"]') : null;
    if (byFor) return clean(byFor);
    const by = el.getAttribute("aria-labelledby");
    const named = by ? document.getElementById(by) : null;
    if (named) return clean(named);
    const legend = el.querySelector(":scope > legend");
    return legend ? clean(legend) : (el.getAttribute("aria-label") || "");
  };
  const skipped = (el) =>
    el.closest(".eeoc__container, .phone-input__country") !== null ||
    el.getAttribute("aria-hidden") === "true";
  const out = [];
  const grouped = new Set();
  // Location autocomplete: a "Location (City)" text / combobox input plus a helper "Search" input in the same widget
  // (at most 3 levels up from the location input), both with ids that are not the stored question id.
  const plain = (el) => labelOf(el).replace(/[^a-z0-9]+/gi, " ").trim().toLowerCase();
  const isInput = (el) =>
    el.tagName === "INPUT" &&
    (el.getAttribute("role") === "combobox" ||
      ["", "text"].includes((el.getAttribute("type") || "").toLowerCase()));
  const locations = new Set();
  const helpers = new Set();
  for (const el of form.querySelectorAll("input")) {
    if (!el.id || skipped(el) || !isInput(el) || plain(el) !== "location city") continue;
    locations.add(el);
  }
  // A widget helper input is a search / filter box that belongs to a combobox or autocomplete (location, school, any
  // react-select): labelled "Search ...", "Filter ..." or "Type to search", or a react-select internal input with no
  // label at all. It is part of its widget, not a question, wherever the page puts it. A form with a widget has them.
  const hasWidget =
    locations.size > 0 ||
    form.querySelector("input[role='combobox'], input[aria-autocomplete], .select__container") !== null;
  const helperLabel = /^(search|filter|type to search)( |$)/;
  for (const n of form.querySelectorAll("input")) {
    if (!isInput(n) || skipped(n) || locations.has(n)) continue;
    const text = plain(n);
    const bare = text === "" && /^react-select-/.test(n.id);
    if (hasWidget && (bare || helperLabel.test(text))) helpers.add(n);
  }
  // The standard Greenhouse education block (School, Degree, Discipline, start / end dates) is not made of API questions.
  const educationId = /^(school|degree|discipline|start-(month|year)|end-(month|year))(--\\d+)?$/;
  const inEducation = (el) =>
    el.closest("#education_section, .education, [data-section='education']") !== null ||
    educationId.test(el.id);
  for (const g of form.querySelectorAll("[role='group'][id], [role='radiogroup'][id]")) {
    const boxes = [...g.querySelectorAll("input[type='checkbox'], input[type='radio']")];
    if (boxes.length === 0 || skipped(g)) continue;
    boxes.forEach((b) => grouped.add(b));
    out.push({
      id: g.id,
      kind: boxes[0].type === "radio" ? "radio_group" : "checkbox_group",
      label: labelOf(g),
      options: boxes.map((b) => labelOf(b)),
      optionIds: boxes.map((b) => b.id),
    });
  }
  for (const el of form.querySelectorAll("input, textarea, select")) {
    if (grouped.has(el) || helpers.has(el) || skipped(el) || el.type === "hidden" || !el.id) continue;
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (["submit", "button", "image", "reset"].includes(type)) continue;
    let kind = "unsupported";
    let options = null;
    if (locations.has(el)) kind = "location";
    else if (inEducation(el)) kind = "education";
    else if (el.tagName === "TEXTAREA") kind = "textarea";
    else if (el.tagName === "SELECT") {
      kind = el.hasAttribute("multiple") ? "multiselect" : "select";
      options = [...el.options].filter((o) => o.value !== "").map((o) => o.textContent.trim());
    } else if (type === "file") kind = "file";
    else if (el.getAttribute("role") === "combobox") kind = "combobox";
    else if (["", "text", "email", "tel", "url", "number"].includes(type)) kind = "text";
    const required = el.required === true || el.getAttribute("aria-required") === "true";
    out.push({ id: el.id, kind, label: labelOf(el), options, optionIds: [], required });
  }
  return out;
})()`;

/** DOM kinds a stored question type may appear as. `other` (unknown to the planner) is checked by the planner itself. */
const COMPATIBLE: Record<string, readonly DomKind[]> = {
  text: ["text"],
  long_text: ["textarea"],
  file: ["file"],
  yes_no: ["select", "combobox", "radio_group"],
  choice: ["select", "combobox", "radio_group"],
  multi_choice: ["multiselect", "combobox", "checkbox_group"],
};

export interface FormComparison {
  ok: boolean;
  /** Stored questions without a control on the page (labels). */
  missing: string[];
  /** Controls on the page that no stored question explains (labels). */
  extra: string[];
  /** Stored questions whose control is of another kind or lists other options (labels). */
  different: string[];
}

const sameOptions = (a: readonly string[], b: readonly string[]): boolean => {
  const x = new Set(a.map(normalizeQuestion));
  const y = new Set(b.map(normalizeQuestion));
  return x.size === y.size && [...x].every((o) => y.has(o));
};

/**
 * The stored Location question and the page's location autocomplete control, paired by the question's label (the page's
 * ids are not the stored id). Null unless both exist exactly once.
 */
export function pairLocation(
  stored: readonly FormField[],
  dom: readonly DomControl[],
): { storedId: string; domId: string } | null {
  const questions = stored.filter((f) => normalizeQuestion(f.label) === "location");
  const controls = dom.filter((c) => c.kind === "location");
  const [q, c] = [questions[0], controls[0]];
  return questions.length === 1 && controls.length === 1 && q && c
    ? { storedId: q.ats.id, domId: c.id }
    : null;
}

/** Stored questions (`FormField.ats.id` = question id) against the controls read from the page. Labels only. */
export function compareForm(
  allStored: readonly FormField[],
  allDom: readonly DomControl[],
): FormComparison {
  // The location autocomplete is the stored Location question: left out of the by-id comparison on both sides.
  const pair = pairLocation(allStored, allDom);
  const stored = pair ? allStored.filter((f) => f.ats.id !== pair.storedId) : allStored;
  const dom = pair ? allDom.filter((c) => c.id !== pair.domId) : allDom;
  const byId = new Map(dom.map((c) => [c.id, c]));
  const storedIds = new Set(stored.map((f) => f.ats.id));
  const missing: string[] = [];
  const different: string[] = [];
  for (const f of stored) {
    const control = byId.get(f.ats.id);
    if (control === undefined) {
      missing.push(f.label);
      continue;
    }
    const kinds = COMPATIBLE[f.field_type];
    if (kinds === undefined) continue;
    if (control.kind === "education") continue; // a stored question on an education id: the block stays the block
    const kindOk = kinds.includes(control.kind);
    const optionsOk =
      control.options === null || f.options === null || sameOptions(control.options, f.options);
    if (!kindOk || !optionsOk) different.push(f.label);
  }
  // The education block is known to the form but is not an API question: never extra.
  const extra = dom
    .filter((c) => !storedIds.has(c.id) && c.kind !== "education")
    .map((c) => c.label || c.id);
  return {
    ok: missing.length === 0 && extra.length === 0 && different.length === 0,
    missing,
    extra,
    different,
  };
}

/** Short stop detail: labels only, at most 200 characters (the store's limit). */
export function describeComparison(c: FormComparison): string {
  const parts = [
    c.missing.length > 0 ? `missing: ${c.missing.join(", ")}` : "",
    c.extra.length > 0 ? `extra: ${c.extra.join(", ")}` : "",
    c.different.length > 0 ? `different: ${c.different.join(", ")}` : "",
  ].filter((p) => p !== "");
  const text = `form changed (${parts.join("; ")})`;
  return text.length <= 200 ? text : `${text.slice(0, 197)}...`;
}

/**
 * Fixed expression that reads what each control now holds, as visible texts: the typed value, the selected option
 * labels, the checked option labels, the picked react-select text, or the chosen file names, keyed by control id.
 */
export function readValuesExpression(controls: readonly DomControl[]): string {
  const spec = controls.map((c) => ({ id: c.id, kind: c.kind, optionIds: c.optionIds }));
  return `((spec) => {
  const out = {};
  const labelFor = (id) => {
    const l = document.querySelector('label[for="' + CSS.escape(id) + '"]');
    return l ? l.textContent.replace(/\\s+/g, " ").trim() : "";
  };
  for (const c of spec) {
    const el = document.getElementById(c.id);
    if (!el) { out[c.id] = []; continue; }
    if (c.kind === "select" || c.kind === "multiselect") {
      out[c.id] = [...el.selectedOptions].filter((o) => o.value !== "").map((o) => o.textContent.trim());
    } else if (c.kind === "radio_group" || c.kind === "checkbox_group") {
      out[c.id] = c.optionIds
        .filter((id) => document.getElementById(id)?.checked)
        .map((id) => labelFor(id));
    } else if (c.kind === "combobox") {
      const box = el.closest(".select__container");
      out[c.id] = box
        ? [...box.querySelectorAll(".select__single-value, .select__multi-value__label")].map((n) => n.textContent.trim())
        : [];
    } else if (c.kind === "file") {
      out[c.id] = [...(el.files || [])].map((f) => f.name);
    } else {
      out[c.id] = el.value === "" ? [] : [el.value];
    }
  }
  return out;
})(${JSON.stringify(spec)})`;
}
