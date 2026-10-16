// Synthetic Ashby application page script (t_3b60e4e8). See app.html. Plain DOM calls, no framework.
const ENDPOINT = "/api/non-user-graphql?op=";

const gql = (op, query, variables) =>
  fetch(ENDPOINT + encodeURIComponent(op), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ operationName: op, variables, query }),
  })
    .then((r) => r.json())
    .catch(() => null);

const FORM_QUERY =
  "query ApiJobPostingForApplicationRequest($organizationHostedJobsPageName: String!, $jobPostingId: String!) { " +
  "jobPosting(organizationHostedJobsPageName: $organizationHostedJobsPageName, jobPostingId: $jobPostingId) { " +
  "id title recaptchaAction applicationForm { sections { fieldEntries { id field isRequired isHidden } } } " +
  "surveyForms { title fieldEntries { id field isRequired isHidden } } } }";

// Draft write, run on every change (R2: ApiSetFormValue persists the value server side). A dry run aborts it.
const setValue = (path, value) =>
  gql(
    "ApiSetFormValue",
    "mutation ApiSetFormValue($path: String!, $value: String) { setFormValue(path: $path, value: $value) { ok } }",
    { path, value },
  );

const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  node.append(...children);
  return node;
};

const title = (field, required, forId) => {
  const t = el(
    forId ? "label" : "div",
    { class: "ashby-application-form-question-title" },
    field.title,
  );
  if (forId) t.setAttribute("for", forId);
  if (required) t.append(el("span", { "data-required-marker": "" }, " *"));
  return t;
};

const option = (type, path, o, required, index) => {
  const input = el("input", { type, name: path, id: path + "_" + index, value: o.value });
  if (required) input.setAttribute("required", "");
  return el("label", {}, input, el("span", {}, o.label));
};

function control(field, required) {
  const path = field.path;
  const attrs = { name: path, id: path };
  if (required) attrs.required = "";
  switch (field.type) {
    case "Email":
      return el("input", { ...attrs, type: "email", class: "ashby-application-form-input-text" });
    case "Phone":
      return el("input", { ...attrs, type: "tel", class: "ashby-application-form-input-text" });
    case "LongText":
      return el("textarea", {
        ...attrs,
        maxlength: "400",
        class: "ashby-application-form-input-textarea",
      });
    case "File":
      return el("input", { ...attrs, type: "file", class: "ashby-application-form-input-file" });
    case "Date":
      return el("input", { ...attrs, type: "date", class: "ashby-application-form-input-date" });
    case "Consent":
      return el("input", { name: path, id: path, type: "checkbox", value: "1" });
    case "Boolean":
      return el(
        "div",
        { class: "ashby-application-form-input-yesno" },
        option("radio", path, { label: "Yes", value: "true" }, required, 0),
        option("radio", path, { label: "No", value: "false" }, required, 1),
      );
    case "ValueSelect":
      if (field.display === "radio")
        return el(
          "div",
          { class: "ashby-application-form-input-radio-group" },
          ...field.selectableValues.map((o, i) => option("radio", path, o, required, i)),
        );
      return el(
        "select",
        { ...attrs, class: "ashby-application-form-input-dropdown-select" },
        el("option", { value: "" }, "Select..."),
        ...field.selectableValues.map((o) => el("option", { value: o.value }, o.label)),
      );
    case "MultiValueSelect":
      if (field.display === "dropdown")
        return el(
          "select",
          { ...attrs, multiple: "", class: "ashby-application-form-input-dropdown-select" },
          ...field.selectableValues.map((o) => el("option", { value: o.value }, o.label)),
        );
      return el(
        "div",
        { class: "ashby-application-form-input-checkbox-group" },
        ...field.selectableValues.map((o, i) => option("checkbox", path, o, false, i)),
      );
    default:
      return el("input", { ...attrs, type: "text", class: "ashby-application-form-input-text" });
  }
}

const entry = (e) => {
  const grouped =
    ["Boolean", "ValueSelect", "MultiValueSelect"].includes(e.field.type) &&
    e.field.display !== "dropdown";
  const wrap = el("div", { class: "ashby-application-form-field-entry" });
  const c = control(e.field, e.isRequired);
  wrap.append(
    title(e.field, e.isRequired, grouped || e.field.type === "Consent" ? null : e.field.path),
    c,
  );
  return wrap;
};

function render(posting) {
  const form = el("form", { class: "ashby-application-form-container", novalidate: "" });
  // The "Autofill from resume" drop zone: attaching a file would upload the CV for parsing. The filler never touches it.
  const autofill = el("input", { type: "file", name: "autofill-resume", class: "autofill-input" });
  autofill.addEventListener("change", () =>
    gql(
      "ApiAutofillApplicationFormWithUploadedResume",
      "mutation ApiAutofillApplicationFormWithUploadedResume($handle: String!) { autofillApplicationForm(handle: $handle) { ok } }",
      { handle: "x" },
    ),
  );
  form.append(
    el(
      "div",
      { class: "ashby-application-form-autofill-input-root" },
      "Autofill from resume",
      autofill,
    ),
  );
  for (const section of posting.applicationForm.sections) {
    const box = el("div", { class: "ashby-application-form-section-container" });
    for (const e of section.fieldEntries) if (!e.isHidden) box.append(entry(e));
    form.append(box);
  }
  form.addEventListener("change", (ev) => {
    const t = ev.target;
    const path = t.getAttribute("name");
    if (path === null || path === "autofill-resume") return;
    if (t.type === "file") {
      gql(
        "ApiCreateFileUploadHandle",
        "mutation ApiCreateFileUploadHandle($filename: String!) { createFileUploadHandle(filename: $filename) { url } }",
        { filename: t.files[0] ? t.files[0].name : "" },
      );
      return;
    }
    setValue(path, t.value);
  });
  const submit = el(
    "button",
    { type: "button", class: "ashby-application-form-submit-button" },
    "Submit Application",
  );
  submit.addEventListener("click", () => {
    submitMutation();
    form.requestSubmit();
  });
  form.append(submit);

  const surveys = el("div", { class: "ashby-survey-container" });
  for (const s of posting.surveyForms || []) {
    surveys.append(el("h2", {}, s.title));
    for (const e of s.fieldEntries) surveys.append(entry(e));
  }
  document.getElementById("app").replaceChildren(form, surveys);
  if (posting.recaptchaAction) {
    document.head.append(
      el("script", { src: "https://www.recaptcha.net/recaptcha/enterprise.js?render=fixture" }),
    );
  }
}

const submitMutation = () =>
  gql(
    "ApiSubmitSingleApplicationFormAction",
    "mutation ApiSubmitSingleApplicationFormAction($formRenderIdentifier: String!) { submitSingleApplicationFormAction(formRenderIdentifier: $formRenderIdentifier) { ok } }",
    { formRenderIdentifier: "fixture" },
  );

const parts = location.pathname.split("/");
gql("ApiJobPostingForApplicationRequest", FORM_QUERY, {
  organizationHostedJobsPageName: parts[1],
  jobPostingId: parts[2],
}).then((res) => {
  if (!res || !res.data || !res.data.jobPosting) {
    document.getElementById("app").textContent = "Job not found";
    return;
  }
  render(res.data.jobPosting);
  // Stand-ins for a page that sends the application on its own, and for a mutation hidden under a read-only operation
  // name. The first goes out under its own name, the second under an allowlisted one; both must be aborted.
  submitMutation();
  fetch(ENDPOINT + "ApiJobPosting", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      operationName: "ApiJobPosting",
      variables: {},
      query: 'mutation ApiJobPosting { setFormValue(path: "x", value: "y") { ok } }',
    }),
  }).catch(() => {});
});
