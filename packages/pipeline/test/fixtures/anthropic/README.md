# Anthropic fixtures (pipeline)

All hand-built (`"_handbuilt": true`) in the real Messages API response shape from
`docs/research/t_01c08cc2-anthropic-api.md` section 7. No live API call was made; no personal data.

- `extract-ok.json`: valid extraction (the `text` block holds an `ExtractionWire` JSON string: "unknown", "yes"/"no", "" and 0 instead of null).
- `extract-invalid.json`: output that fails the Zod schema (`hiringScope` outside the enum, no other fields).
- `fit-ok.json`: valid fit result (Sonnet), score 82 with two reasons.
- `fit-score-out-of-range.json`: score 150, fails the 0-100 check.
- `fit-too-many-reasons.json`: four reasons; the code keeps the first three.
- `fit-reason-too-long.json`: one reason of 141 characters without spaces; cut to 140 ending with "…".
- `company-research-flat.json`: quote + `location_agnostic`, the quote is present in the test careers page.
- `company-research-none.json`: no wording found (`quote` empty, `classification` "unknown").
- `company-research-madeup.json`: a quote that is NOT on the page (code must reject it).
- `fit-reason-180-chars.json`: one reason of 180 characters; the code cuts it to <= 140 on a word boundary with "…".
- `fit-max-tokens.json`: `stop_reason: "max_tokens"`, 1536 output tokens, text cut off mid-string (no retry with the same limit).
