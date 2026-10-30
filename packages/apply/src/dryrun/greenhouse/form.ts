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
  const form = document.querySelector("form#application-form, form#application_form");
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
  // Checkbox / radio options that no id-carrying group element wraps (a plain fieldset with a legend, a field wrapper with
  // a caption label, the classic embed's list of wrapped labels): one question per holder, not one control per option.
  const holderOf = (b) => b.closest("fieldset, [role='group'], [role='radiogroup'], .field-wrapper, .field");
  const optionLabel = (b) => {
    const own = labelOf(b);
    if (own) return own;
    const wrap = b.closest("label");
    return wrap ? clean(wrap) : "";
  };
  const captionOf = (holder, boxes) => {
    const direct = labelOf(holder);
    if (direct) return direct;
    const legend = holder.querySelector("legend");
    if (legend) return clean(legend);
    const caption = [...holder.querySelectorAll("label, .label, [class*='label']")].find(
      (n) => !n.querySelector("input") && !boxes.some((b) => b.id && n.getAttribute("for") === b.id),
    );
    return caption ? clean(caption) : "";
  };
  const groupIdOf = (holder, boxes) => {
    if (holder.id) return holder.id;
    const first = boxes[0];
    const name = (first.getAttribute("name") || "").replace(/\\[\\]$/, "");
    const fromId = first.id ? first.id.replace(/(\\[\\])?[_-][^_\\-\\[\\]]+$/, "") : "";
    return fromId !== "" && fromId !== first.id ? fromId : name || first.id;
  };
  const holders = new Map();
  for (const b of form.querySelectorAll("input[type='checkbox'], input[type='radio']")) {
    if (grouped.has(b) || skipped(b)) continue;
    const holder = holderOf(b);
    if (!holder || skipped(holder)) continue;
    if (!holders.has(holder)) holders.set(holder, []);
    holders.get(holder).push(b);
  }
  for (const [holder, boxes] of holders) {
    // A lone box in a plain field wrapper is a single consent / yes-no control with its own id, not a group.
    if (boxes.length < 2 && !holder.matches("fieldset, [role='group'], [role='radiogroup']")) continue;
    boxes.forEach((b) => grouped.add(b));
    out.push({
      id: groupIdOf(holder, boxes),
      kind: boxes[0].type === "radio" ? "radio_group" : "checkbox_group",
      label: captionOf(holder, boxes),
      options: boxes.map(optionLabel),
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

/**
 * Fixed expression run in the page when no application form is there: true when the page says the posting is closed
 * (Greenhouse's "no longer open / available / accepting applications" wording), so the run can say so instead of
 * reporting a changed form.
 */
export const READ_CLOSED_EXPRESSION = `(() => {
  const text = (document.body ? document.body.innerText : "").replace(/\\s+/g, " ");
  return /no longer (open|available|accepting)|(position|job|posting|role) (has been|is) (closed|filled|removed)|(job|position|posting) (not found|does not exist)/i.test(text);
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

const isGroup = (c: DomControl): boolean => c.kind === "checkbox_group" || c.kind === "radio_group";

/**
 * A choice group read from the page under an id that is not the stored question's (a fieldset without an id, a classic
 * list of wrapped labels) is the stored question of the same label: it takes that question's id, so the compare and the
 * filler see one question with its options. Only when exactly one stored question and one group carry that label.
 */
export function alignGroups(
  stored: readonly FormField[],
  dom: readonly DomControl[],
): DomControl[] {
  const storedIds = new Set(stored.map((f) => f.ats.id));
  const unmatched = (c: DomControl) => isGroup(c) && !storedIds.has(c.id);
  return dom.map((c) => {
    if (!unmatched(c)) return c;
    // The API names a multi-select question `question_<id>[]`; the page's group may carry the bare id.
    const listed = stored.find(
      (f) => f.ats.id === `${c.id}[]` && !dom.some((d) => d.id === f.ats.id),
    );
    if (listed !== undefined) return { ...c, id: listed.ats.id };
    const label = normalizeQuestion(c.label);
    if (label === "") return c;
    const domIds = new Set(dom.map((d) => d.id));
    const questions = stored.filter(
      (f) =>
        normalizeQuestion(f.label) === label &&
        !domIds.has(f.ats.id) &&
        (COMPATIBLE[f.field_type] ?? []).includes(c.kind),
    );
    const groups = dom.filter((d) => unmatched(d) && normalizeQuestion(d.label) === label);
    const q = questions[0];
    return questions.length === 1 && groups.length === 1 && q !== undefined
      ? { ...c, id: q.ats.id }
      : c;
  });
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

/**
 * Controls on the page that no stored question explains (the education block and the location autocomplete paired with
 * the stored Location question are known). These are new, unmatched questions: the filler lists them as needing input.
 */
export function extraControls(
  allStored: readonly FormField[],
  allDom: readonly DomControl[],
): DomControl[] {
  const pair = pairLocation(allStored, allDom);
  const storedIds = new Set(allStored.map((f) => f.ats.id));
  return allDom.filter(
    (c) => c.id !== pair?.domId && !storedIds.has(c.id) && c.kind !== "education",
  );
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
  const extra = extraControls(allStored, allDom).map((c) => c.label || c.id);
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
 * labels, the checked option labels, the picked react-select text, or the chosen file names (also the page's upload-complete file-name line), keyed by control id.
 */
export function readValuesExpression(
  controls: readonly DomControl[],
  plannedFiles: Readonly<Record<string, string>> = {},
): string {
  const spec = controls.map((c) => ({
    id: c.id,
    kind: c.kind,
    optionIds: c.optionIds,
    planned: plannedFiles[c.id] ?? "",
  }));
  return `((spec) => {
  const out = {};
  const labelFor = (id) => {
    const l = document.querySelector('label[for="' + CSS.escape(id) + '"]') || document.getElementById(id)?.closest("label");
    return l ? l.textContent.replace(/\\s+/g, " ").trim() : "";
  };
  const fold = (t) => t.normalize("NFC").replace(/\\s+/g, " ").trim().toLowerCase();
  const shown = (root, name) => {
    const want = fold(name);
    const copy = root.cloneNode(true);
    for (const bad of copy.querySelectorAll("[role='alert'], [class*='error'], [class*='fail'], label, .label, [id^='upload-label'], [class*='filetypes']")) bad.remove();
    const attrs = ["title", "aria-label", "data-filename", "data-file-name", "alt"];
    const texts = [copy.textContent, ...[...copy.querySelectorAll("*")].flatMap((n) => attrs.map((a) => n.getAttribute(a) || ""))].map(fold);
    const flat = (t) => t.replace(/[^\\p{L}\\p{N}]/gu, "");
    const stem = want.replace(/\\.[a-z0-9]{2,5}$/, "");
    return texts.some((t) => {
      if (t.includes(want)) return true;
      if (flat(stem).length >= 4 && flat(t).includes(flat(stem))) return true;
      // A shortened name: "start...end.ext" with both ends of the planned name.
      return t.split(" ").some((w) => {
        const parts = w.split(/\\u2026|\\.\\.\\./);
        return parts.length === 2 && parts[0].length >= 2 && parts[1].length >= 4 && want.startsWith(parts[0]) && want.endsWith(parts[1]);
      });
    });
  };
  for (const c of spec) {
    const el = document.getElementById(c.id);
    if (c.kind === "file") {
      // The input's own files, else the page's upload-complete display: the form may swap the input for a file-name line.
      const own = el ? [...(el.files || [])].map((f) => f.name) : [];
      if (own.length > 0) { out[c.id] = own; continue; }
      const box = (el && el.closest(".file-upload__wrapper")) || document.getElementById("upload-label-" + c.id)?.parentElement;
      const named = box
        ? [...box.querySelectorAll("[class*='filename'], [class*='file-name'], [data-testid*='filename']")]
            .map((n) => n.textContent.replace(/\\s+/g, " ").trim())
            .filter((t) => t !== "")
        : [];
      // A widget with other markup: any file-name-looking token (name.ext) in the control's text, only when no name line
      // is found; each name once (a name counted twice would not equal the single planned file).
      const loose = box && named.length === 0
        ? box.parentElement.textContent.match(/[^\\s\\/\\\\]+\\.(?:pdf|docx?|txt|rtf)\\b/gi) || []
        : [];
      let found = [...new Set([...named, ...loose])];
      const root = (el && el.closest(".file-upload, [role='group'], .field-wrapper")) || document.getElementById("upload-label-" + c.id)?.parentElement;
      if (c.planned !== "") {
        const want = fold(c.planned);
        // A line that holds the planned name plus a size or a remove hint is the planned file, and counts once.
        if (found.some((n) => fold(n).includes(want))) found = [c.planned];
        // Else a widget that shows the planned file's name in its own markup (spaces or underscores swapped, no extension, a
        // shortened "start...end.pdf", a title / aria-label attribute, no "filename" class). Only the control's group is
        // looked at, never an error / alert part of it.
        else if (root && shown(root, c.planned)) found = [c.planned];
      }
      // An upload that is still running (a progress bar, a spinner, an uploading class): the filler waits instead of
      // attaching the file a second time.
      out["busy:" + c.id] = root && root.querySelector("progress, [role='progressbar'], [aria-busy='true'], [class*='uploading'], [class*='progress'], [class*='spinner'], [class*='loading']") ? ["1"] : [];
      out[c.id] = found;
      continue;
    }
    if (c.kind === "radio_group" || c.kind === "checkbox_group") {
      // A group may have no element of its own id (its id can be derived from the options): read the options.
      out[c.id] = c.optionIds
        .filter((id) => document.getElementById(id)?.checked)
        .map((id) => labelFor(id));
      continue;
    }
    if (!el) { out[c.id] = []; continue; }
    if (c.kind === "select" || c.kind === "multiselect") {
      out[c.id] = [...el.selectedOptions].filter((o) => o.value !== "").map((o) => o.textContent.trim());
    } else if (c.kind === "combobox") {
      const box = el.closest(".select__container");
      out[c.id] = box
        ? [...box.querySelectorAll(".select__single-value, .select__multi-value__label")].map((n) => n.textContent.trim())
        : [];
    } else {
      out[c.id] = el.value === "" ? [] : [el.value];
    }
  }
  return out;
})(${JSON.stringify(spec)})`;
}

/**
 * Fixed expression that describes the markup around one file control without any value: tag names, class tokens and the
 * input type of the control's group (no text, no attribute values, no file names), for the dry-run report.
 */
export function uploadStructureExpression(controlId: string): string {
  return `((id) => {
  const el = document.getElementById(id);
  const root = (el && el.closest(".file-upload, [role='group'], .field-wrapper")) || document.getElementById("upload-label-" + id)?.parentElement;
  if (!root) return "no-group";
  const tok = (t) => t.toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 24);
  const part = (n) => {
    const kind = n.tagName === "INPUT" ? "[" + tok(n.getAttribute("type") || "") + "]" : "";
    const cls = [...n.classList].slice(0, 2).map(tok).filter((t) => t !== "").map((t) => "." + t).join("");
    return tok(n.tagName) + kind + cls;
  };
  const walk = (n, depth) => {
    const kids = depth < 3 ? [...n.children].slice(0, 6).map((k) => walk(k, depth + 1)) : [];
    return part(n) + (kids.length > 0 ? "(" + kids.join(",") + ")" : "");
  };
  return (el ? "input=yes " : "input=no ") + walk(root, 0).slice(0, 300);
})(${JSON.stringify(controlId)})`;
}
