import type { LeverControl } from "../lever/form.ts";

/**
 * What the rendered Ashby application form shows (docs/research/t_d0698332-ats-form-structure.md, section 2, Ashby). The
 * form is not in the page's HTML: it arrives through the allowlisted GraphQL query and the page draws it, so the fields are
 * read from the rendered DOM, never from a network response. Ashby's documented class hooks are the anchors:
 * `.ashby-application-form-container`, one `.ashby-application-form-field-entry` per question holding a
 * `.ashby-application-form-question-title` and its controls. The control's `name` (R2: the field path, `_systemfield_*` or a
 * uuid; the `id` is the fallback, then a slug of the title) is the question id. Confidence in the real page's ids is low
 * (R2); the owner's first real runs confirm them, and a page that does not match shows as `form_changed` or empty fields,
 * never as a wrong value.
 *
 * Every question is read: text, textarea, select, combobox (location autocomplete), radio group, checkbox group, file. A
 * shape that is not understood is an `unsupported` control, never dropped. Read but never filled (listed as skipped in the
 * table): the survey / self-identification block (`.ashby-survey-container`: EEO, veteran status) and the texting / WhatsApp
 * consent groups. Never read: the "Autofill from resume" drop zone (it would upload the CV for parsing) and hidden inputs.
 * A combobox is never filled: the owner picks the suggestion.
 */
export type AshbyControl = LeverControl;

/** A block of the page the run reads but never touches (survey, EEO, veteran status, SMS consent): listed so it is visible. */
export interface AshbySkipped {
  label: string;
  reason: string;
}

/** What the page shows: every question as a control, every untouched block, and every question title seen anywhere. */
export interface AshbyPage {
  controls: AshbyControl[];
  skipped: AshbySkipped[];
  /** Titles of all questions on the page, found independently of the entry loop; each must reach the table. */
  seen: string[];
}

const SURVEY_REASON = "survey / self-identification block, never touched";
const CONSENT_REASON = "text message consent, never touched";

/** Where the filler finds a control: its `name` inside the application form container. */
export const ASHBY_SCOPE = ".ashby-application-form-container";

/** The element that shows the form is drawn (the session waits for it before it reads the page). */
export const ASHBY_READY_SELECTOR = `${ASHBY_SCOPE} .ashby-application-form-field-entry`;

/** Fixed expression run in the page; the result is `AshbyPage` as JSON (null when the page has no application form). */
export const READ_CONTROLS_EXPRESSION = `(() => {
  const container = document.querySelector(${JSON.stringify(ASHBY_SCOPE)});
  if (!container) return null;
  const SURVEY = ".ashby-survey-container";
  const AUTOFILL = "[class*='autofill']";
  const ENTRY = ".ashby-application-form-field-entry";
  const TITLE = ".ashby-application-form-question-title";
  const FIELDS = "input, textarea, select, [role='combobox']";
  const text = (el) => el.textContent.replace(/\\s+/g, " ").trim();
  const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
  const titleText = (t) => {
    const copy = t.cloneNode(true);
    copy.querySelectorAll("[data-required-marker]").forEach((n) => n.remove());
    return text(copy);
  };
  const titleOf = (entry) => {
    const t = entry.querySelector(TITLE);
    return t ? titleText(t) : "";
  };
  const optionLabel = (box) => {
    const wrap = box.closest("label");
    return wrap ? text(wrap) : box.value;
  };
  const typeOf = (e) => (e.getAttribute("type") || "").toLowerCase();
  const isCombo = (e) =>
    e.getAttribute("role") === "combobox" ||
    e.getAttribute("aria-autocomplete") === "list" ||
    e.getAttribute("aria-haspopup") === "listbox";
  // A helper "Search" input (a combobox's filter box) belongs to the widget's field, never a question of its own.
  const helperOf = (e) => {
    const label = (e.getAttribute("aria-label") || e.getAttribute("placeholder") || "").trim().toLowerCase();
    if (e.tagName !== "INPUT" || (label !== "search" && typeOf(e) !== "search")) return false;
    let box = e.parentElement;
    for (let i = 0; i < 3 && box && box !== container; i++, box = box.parentElement) {
      if ([...box.querySelectorAll(FIELDS)].some((o) => o !== e && isCombo(o))) return true;
    }
    return false;
  };
  const inert = (e) => {
    const name = e.getAttribute("name") || "";
    return (
      helperOf(e) ||
      typeOf(e) === "hidden" ||
      ["submit", "button", "image", "reset"].includes(typeOf(e)) ||
      /^(g-recaptcha-response|h-captcha-response)/.test(name) ||
      e.closest("[hidden], [aria-hidden='true']") !== null ||
      e.closest(AUTOFILL) !== null
    );
  };
  const consentNamed = (e) => /^_systemfield_(texting|whatsapp)_consent/.test(e.getAttribute("name") || e.id || "");
  const consentTitle = (t) => /\\b(text messag|sms|whatsapp)/i.test(t);
  const isBox = (e) => e.tagName === "INPUT" && ["radio", "checkbox"].includes(typeOf(e));
  const nameOf = (e) => e.getAttribute("name") || e.id || "";
  const attrRequired = (els) => els.some((e) => e.hasAttribute("required") || e.getAttribute("aria-required") === "true");
  const controls = [];
  const skipped = [];
  const survey = [...document.querySelectorAll(SURVEY)];
  // One question as a control: the shared classification for entries and for controls found outside any entry.
  const build = (els, label, required) => {
    const first = els[0];
    const type = typeOf(first);
    const shape = els
      .map((e) => e.tagName.toLowerCase() + (e.tagName === "INPUT" ? ":" + (e.getAttribute("type") || "text").toLowerCase() : ""))
      .join("+")
      .slice(0, 60);
    const base = { name: nameOf(first) || "q:" + slug(label), shape, label, required, options: null, optionValues: [] };
    const combo = els.find(isCombo);
    const sameName = els.every((e) => nameOf(e) === nameOf(first));
    const allBoxes = els.every((e) => isBox(e) && typeOf(e) === type);
    if (combo) return { ...base, name: nameOf(combo) || base.name, kind: "combobox" };
    if (!sameName || (els.length > 1 && !allBoxes)) return { ...base, kind: "unsupported" };
    if (allBoxes)
      return {
        ...base,
        kind: type === "radio" ? "radio_group" : "checkbox_group",
        options: els.map(optionLabel),
        optionValues: els.map((e) => e.value),
      };
    if (first.tagName === "TEXTAREA") return { ...base, kind: "textarea" };
    if (first.tagName === "SELECT")
      return {
        ...base,
        kind: first.hasAttribute("multiple") ? "multiselect" : "select",
        options: [...first.options].filter((o) => o.value !== "").map((o) => text(o)),
      };
    if (type === "file") return { ...base, kind: "file" };
    if (["", "text", "email", "tel", "url"].includes(type)) return { ...base, kind: "text" };
    return { ...base, kind: "unsupported" };
  };
  const entries = new Set([
    ...container.querySelectorAll(ENTRY),
    ...survey.flatMap((s) => [...s.querySelectorAll(ENTRY)]),
  ]);
  const covered = new Set();
  for (const entry of entries) {
    if (entry.closest(AUTOFILL)) continue;
    const title = titleOf(entry);
    const all = [...entry.querySelectorAll(FIELDS)].filter((e) => !inert(e));
    all.forEach((e) => covered.add(e));
    if (entry.closest(SURVEY)) {
      skipped.push({ label: title || "Self-identification question", reason: ${JSON.stringify(SURVEY_REASON)} });
      continue;
    }
    // A texting / WhatsApp consent group: by name, or by title when the group is only radios / checkboxes.
    if (all.length > 0 && (all.every(consentNamed) || (all.every(isBox) && consentTitle(title)))) {
      skipped.push({ label: title || "Text message consent", reason: ${JSON.stringify(CONSENT_REASON)} });
      continue;
    }
    // A phone widget is a country selector next to a tel input (it may carry a texting-consent group): the tel input is
    // the question, a consent group beside it is listed as skipped, the country selector is left alone.
    const tels = all.filter((e) => e.tagName === "INPUT" && typeOf(e) === "tel");
    let els = all;
    if (tels.length === 1) {
      els = tels;
      if (all.some(isBox))
        skipped.push({ label: (title || "Phone") + ": text message consent", reason: ${JSON.stringify(CONSENT_REASON)} });
    }
    const marked = entry.querySelector("[data-required-marker]") !== null;
    if (els.length === 0) {
      // A title with nothing readable under it (a button group, say) is a question the filler does not understand.
      if (title === "") continue;
      const widgets = entry.querySelectorAll("button, [role='radio'], [role='checkbox'], [role='switch']").length;
      controls.push({
        name: "q:" + slug(title), shape: widgets > 0 ? "widgets:" + widgets : "none", label: title,
        required: marked, options: null, optionValues: [], kind: "unsupported",
      });
      continue;
    }
    const c = build(els, title, attrRequired(els));
    if (c.kind === "combobox" && marked) c.required = true;
    controls.push(c);
  }
  // Controls outside any question entry (markup the entry hooks do not cover): grouped by name, never dropped.
  const strays = new Map();
  for (const e of [...container.querySelectorAll(FIELDS)]) {
    if (covered.has(e) || inert(e)) continue;
    const key = nameOf(e) || "stray" + strays.size;
    if (!strays.has(key)) strays.set(key, []);
    strays.get(key).push(e);
  }
  for (const s of survey)
    for (const e of s.querySelectorAll(FIELDS)) {
      if (covered.has(e) || inert(e)) continue;
      skipped.push({ label: e.getAttribute("aria-label") || "Self-identification question", reason: ${JSON.stringify(SURVEY_REASON)} });
    }
  for (const els of strays.values()) {
    const first = els[0];
    const fieldset = first.closest("fieldset");
    const legend = fieldset ? fieldset.querySelector("legend") : null;
    const byFor = first.id ? document.querySelector('label[for="' + CSS.escape(first.id) + '"]') : null;
    const label =
      (legend && text(legend)) || (byFor && text(byFor)) || first.getAttribute("aria-label") || first.getAttribute("placeholder") || "";
    if (els.every(consentNamed) || (els.every(isBox) && consentTitle(label))) {
      skipped.push({ label: label || "Text message consent", reason: ${JSON.stringify(CONSENT_REASON)} });
      continue;
    }
    controls.push(build(els, label || "(unlabelled " + first.tagName.toLowerCase() + ")", attrRequired(els)));
  }
  // Every question title on the page, found without the entry loop: the filler compares it with the table.
  const seen = [...container.querySelectorAll(TITLE + ", legend"), ...survey.flatMap((s) => [...s.querySelectorAll(TITLE + ", legend")])]
    .filter((t) => t.closest(AUTOFILL) === null)
    .map((t) => (t.matches("legend") ? text(t) : titleText(t)))
    .filter((t) => t !== "");
  return { controls, skipped, seen };
})()`;

const normalize = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim();

/** Question titles seen on the page that neither a control nor a skipped block accounts for (labels only, no values). */
export function missingFromTable(page: AshbyPage): string[] {
  const known = new Set(
    [...page.controls.map((c) => c.label), ...page.skipped.map((s) => s.label)].map(normalize),
  );
  return [...new Set(page.seen.filter((t) => !known.has(normalize(t))))];
}

/**
 * Fixed expression that reads what each control now holds, as visible texts, keyed by control name: the typed value, the
 * selected option labels, the checked option labels or the chosen file names. A combobox is never filled: always empty.
 */
export function readValuesExpression(controls: readonly AshbyControl[]): string {
  const spec = controls.map((c) => ({ name: c.name, kind: c.kind }));
  return `((spec) => {
  const out = {};
  const text = (el) => el.textContent.replace(/\\s+/g, " ").trim();
  const container = document.querySelector(${JSON.stringify(ASHBY_SCOPE)});
  for (const c of spec) {
    const els = [...container.querySelectorAll("input, textarea, select")].filter(
      (e) => (e.getAttribute("name") || e.id) === c.name,
    );
    const first = els[0];
    if (!first || c.kind === "combobox") { out[c.name] = []; continue; }
    if (c.kind === "select" || c.kind === "multiselect") {
      out[c.name] = [...first.selectedOptions].filter((o) => o.value !== "").map((o) => text(o));
    } else if (c.kind === "radio_group" || c.kind === "checkbox_group") {
      out[c.name] = els.filter((e) => e.checked).map((e) => {
        const wrap = e.closest("label");
        return wrap ? text(wrap) : e.value;
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
