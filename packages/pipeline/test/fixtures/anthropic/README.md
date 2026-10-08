# Anthropic fixtures (pipeline)

All hand-built (`"_handbuilt": true`) in the real Messages API response shape from
`docs/research/t_01c08cc2-anthropic-api.md` section 7. No live API call was made; no personal data.

- `extract-ok.json`: valid extraction (the `text` block holds an `Extraction` JSON string).
- `extract-invalid.json`: output that fails the Zod schema (`hiringScope` outside the enum, no other fields).
- `company-research-flat.json`: quote + `location_agnostic`, the quote is present in the test careers page.
- `company-research-none.json`: no wording found (`quote` and `classification` null).
- `company-research-madeup.json`: a quote that is NOT on the page (code must reject it).
