import type { LeverControl } from "../lever/form.ts";

/**
 * What the rendered Ashby application form shows (docs/research/t_d0698332-ats-form-structure.md, section 2, Ashby). The
 * form is not in the page's HTML: it arrives through the allowlisted GraphQL query and the page draws it, so the fields are
 * read from the rendered DOM, never from a network response. Ashby's documented class hooks are the anchors:
 * `.ashby-application-form-container`, one `.ashby-application-form-field-entry` per question holding a
 * `.ashby-application-form-question-title` and its controls. The control's `name` (R2: the field path, `_systemfield_*` or a
 * uuid; the `id` is the fallback) is the question id. Confidence in the real page's ids is low (R2); the owner's first real
 * runs confirm them, and a page that does not match shows as `form_changed` or empty fields, never as a wrong value.
 *
 * Never read, so never filled: the survey / self-identification block (`.ashby-survey-container`), the texting and WhatsApp
 * consent boxes, the "Autofill from resume" drop zone (it would upload the CV for parsing) and hidden inputs.
 */
export type AshbyControl = LeverControl;

/** Where the filler finds a control: its `name` inside the application form container. */
export const ASHBY_SCOPE = ".ashby-application-form-container";

/** The element that shows the form is drawn (the session waits for it before it reads the page). */
export const ASHBY_READY_SELECTOR = `${ASHBY_SCOPE} .ashby-application-form-field-entry`;

/** Fixed expression run in the page; the result is JSON (null when the page has no application form). */
export const READ_CONTROLS_EXPRESSION = `(() => {
  const container = document.querySelector(${JSON.stringify(ASHBY_SCOPE)});
  if (!container) return null;
  const text = (el) => el.textContent.replace(/\\s+/g, " ").trim();
  const titleOf = (entry) => {
    const t = entry.querySelector(".ashby-application-form-question-title");
    if (!t) return "";
    const copy = t.cloneNode(true);
    copy.querySelectorAll("[data-required-marker]").forEach((n) => n.remove());
    return text(copy);
  };
  const optionLabel = (box) => {
    const wrap = box.closest("label");
    return wrap ? text(wrap) : box.value;
  };
  const skipped = (el) => {
    const name = el.getAttribute("name") || el.id || "";
    const type = (el.getAttribute("type") || "").toLowerCase();
    return (
      name === "" ||
      type === "hidden" ||
      ["submit", "button", "image", "reset"].includes(type) ||
      name.startsWith("_systemfield_texting_consent") ||
      name.startsWith("_systemfield_whatsapp_consent") ||
      el.closest(".ashby-survey-container, [class*='autofill']") !== null
    );
  };
  const out = [];
  for (const entry of container.querySelectorAll(".ashby-application-form-field-entry")) {
    if (entry.closest(".ashby-survey-container, [class*='autofill']")) continue;
    const els = [...entry.querySelectorAll("input, textarea, select")].filter((e) => !skipped(e));
    if (els.length === 0) continue;
    const nameOf = (e) => e.getAttribute("name") || e.id;
    const name = nameOf(els[0]);
    const first = els[0];
    const type = (first.getAttribute("type") || "").toLowerCase();
    const base = {
      name,
      label: titleOf(entry),
      required: els.some((e) => e.hasAttribute("required") || e.getAttribute("aria-required") === "true"),
      options: null,
      optionValues: [],
    };
    const sameName = els.every((e) => nameOf(e) === name);
    const allBoxes = els.every((e) => e.tagName === "INPUT" && e.type === type && (type === "radio" || type === "checkbox"));
    if (!sameName || (els.length > 1 && !allBoxes)) {
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

/**
 * Fixed expression that reads what each control now holds, as visible texts, keyed by control name: the typed value, the
 * selected option labels, the checked option labels or the chosen file names.
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
    if (!first) { out[c.name] = []; continue; }
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
