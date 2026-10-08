# Anthropic API for Phase 2: prices, structured output, caching, budget (t_01c08cc2)

Access date for every source below: **2026-10-08**. Base URL for all doc pages: `https://platform.claude.com/docs/en/`
(the old `docs.claude.com` host 301/302-redirects there).

## Answer

- Models: `claude-haiku-5-5` ($0.10 in / $0.50 out per MTok, prompts up to 100k) and `claude-sonnet-5-5` ($2 in / $10 out). Cache reads cost $0.01 and $0.10.
- Get schema-valid JSON with `output_config.format = {type:"json_schema", schema}` (GA, no beta header). **Forced tool use (`tool_choice` any/tool) is rejected with a 400 on Sonnet 5.5**, so do not build on it.
- Both models think by default and thinking tokens are billed as output and count against `max_tokens`. Turn it off (`thinking:{type:"disabled"}` on Haiku, `{type:"between_tools"}` on Sonnet) or the budget estimates in this doc are wrong.
- Extraction costs about $0.00055 per posting, fit scoring about $0.0122 (CV cached). $1/day covers about 1,800 extractions, or about 80 fit scores, or about 330 postings if 20% reach fit scoring.

## 1. Model ids and prices (USD per million tokens)

| Model | API id | Input | Output | 5m cache write | 1h cache write | Cache read |
|---|---|---|---|---|---|---|
| Claude Haiku 5.5, prompt <= 100,000 tokens | `claude-haiku-5-5` | 0.10 | 0.50 | 0.125 | 0.20 | 0.01 |
| Claude Haiku 5.5, prompt > 100,000 tokens | `claude-haiku-5-5` | 0.50 | 2.50 | 0.625 | 1.00 | 0.05 |
| Claude Sonnet 5.5 | `claude-sonnet-5-5` | 2.00 | 10.00 | 2.50 | 4.00 | 0.10 |

- Source: pricing page `about-claude/pricing` ("Model pricing" table and the footnote "Cache hits and refreshes on Claude Opus 5.5 and Claude Sonnet 5.5 are priced at 0.05x the base input price"); ids from `models/overview` and `models/haiku-5-5/overview`, `models/sonnet-5-5/overview`.
- The ids are pinned snapshots (no date suffix, no separate alias): "Every Claude model ID is a pinned snapshot, including the dateless IDs" (`models/overview`). Retirement "not sooner than" Oct 7, 2027 (Haiku) and Sep 28, 2027 (Sonnet).
- Haiku 5.5 is **priced by prompt length** (> 100k tokens costs 5x). Our prompts are far below it; `prices.ts` should still carry both tiers or assert the prompt is under 100k.
- New tokenizer: Haiku 5.5 and Sonnet 5.5 use the tokenizer from Opus 4.7 onward, "approximately 30% more tokens for the same text" than older models (pricing page, `models/haiku-5-5/overview`). Do not reuse token counts from older Claude models.
- Limits: 1M context, 128K max output (`models/overview`).
- Batch API is 50% off (Haiku $0.05/$0.25, Sonnet $1/$5). Not needed for Phase 2 (daily run, results wanted right away) but is a 2x lever if the cap ever bites.
- Data residency: `inference_geo:"us"` multiplies every price by 1.1. Leave it unset (global, default).
- Sampling: `temperature`, `top_p`, `top_k` with a non-default value return 400 on both models. Omit them.

## 2. SDK, structured output, response shape

**SDK.** `@anthropic-ai/sdk` latest on the npm registry is **0.132.1**, MIT, deps `standardwebhooks`, `json-schema-to-ts`; optional peer dep `zod` `^3.25.0 || ^4.0.0` (`https://registry.npmjs.org/@anthropic-ai/sdk/latest`). No `engines` field in the registry JSON; the docs say "Node.js 20 LTS or later (non-EOL) versions", TypeScript >= 5.0 (`cli-sdks-libraries/sdks/typescript`). It uses global `fetch`, so msw v2 in Node intercepts it; a custom `fetch` or `baseURL` can be passed to the client. It sends `anthropic-version: 2023-06-01` by itself.

**Structured outputs** (`build-with-claude/structured-outputs`):
- Request field: `output_config: { format: { type: "json_schema", schema: {...} } }`. Beta header not needed; the older `output_format` is deprecated and 400s without a beta header.
- `claude-haiku-5-5` and `claude-sonnet-5-5` are both on the supported list.
- Result: valid JSON in the response's text block, `JSON.parse` it. Schema rules: every object needs `additionalProperties:false`; no recursive schemas; no numeric/string constraints (`minimum`, `minLength`...); `minItems` only 0 or 1; enum case is not guaranteed (compare case-insensitively).
- Check `stop_reason` before parsing: `"refusal"` (still 200 and billed, output may not match) and `"max_tokens"` (truncated JSON).
- SDK helper: `client.messages.parse({..., output_config:{format: zodOutputFormat(Schema)}})` with `import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod"`, result in `response.parsed_output`. `jsonSchemaOutputFormat()` does not validate. **Suggestion for the client card (not a doc fact):** use `messages.create` with `output_config.format` built from the Zod schema, then run our own `schema.safeParse(JSON.parse(text))`, so retries, cost accounting and the "invalid output: one retry then failed" rule (phase-2-conventions) stay in our code and the Zod issue paths are ours.
- Cost side effects: the API injects an extra system prompt describing the format (counted as input); the first use of a schema has extra latency while the grammar compiles (cached 24 h after last use); changing `output_config.format` invalidates the prompt cache. Keep one fixed schema per stage.

**Forced tool use is not an option on Sonnet 5.5.** `api/errors`, "Forced tool use not supported": Opus 5.5, Sonnet 5.5, Fable 5.1, Mythos 5.1 return 400 `tool_choice: type "tool" and "any" are not supported for this model.` Haiku 5.5 is not on that list, but use `output_config.format` for both models so there is one code path.

**Thinking (affects cost and response shape).** `build-with-claude/thinking`, "Configuring thinking" table:
- Both models have adaptive thinking **on by default**. Thinking tokens "are billed as output tokens, even when the thinking text isn't returned" and count toward `max_tokens`.
- Haiku 5.5: `thinking:{"type":"disabled"}` works at `high` effort or below (400 at `xhigh`/`max`). Default effort `medium`.
- Sonnet 5.5: `"disabled"` is a 400. The lowest setting is `thinking:{"type":"between_tools"}` (works at `high` effort or below; default effort `high`). Error text: "To turn thinking off on this model, send "thinking": {"type": "between_tools"} instead of {"type": "disabled"}." (`api/errors`).
- Effort: `output_config: { effort: "low" | "medium" | "high" | "xhigh" | "max" }`; changing it invalidates the prompt cache (`build-with-claude/effort`).
- Display: `display` defaults to `"omitted"` on these models, so any thinking block comes back with an empty `thinking` string (still billed). So `content[0]` is not guaranteed to be the text block; **pick the first block with `type === "text"`**.
- Recommendation for the client card: extraction on Haiku with `thinking:{type:"disabled"}`, `effort:"low"` or `"medium"`; fit scoring on Sonnet with `thinking:{type:"between_tools"}`, `effort:"low"|"medium"`. Whether fit-scoring quality survives without up-front thinking is a quality question for the golden set (t_26e69a7a), not answered here. If thinking is left on, add the thinking tokens to the reserve (`max_tokens` is the cap on thinking + answer).

**Response shape.** See section 7. Usage fields (`build-with-claude/prompt-caching`, "Usage fields"): `input_tokens` (only tokens after the last cache breakpoint), `cache_creation_input_tokens`, `cache_read_input_tokens`, `output_tokens`, and a `cache_creation` breakdown (`ephemeral_5m_input_tokens`, `ephemeral_1h_input_tokens`). Total input = `cache_read + cache_creation + input_tokens`. Cost formula for `prices.ts`:

```
cost = input_tokens*P_in + cache_creation_5m*P_write5m + cache_creation_1h*P_write1h
     + cache_read*P_read + output_tokens*P_out         (all / 1e6)
```
Fallback if `cache_creation` is absent: treat all of `cache_creation_input_tokens` as 5m writes (what we request by default).

## 3. Prompt caching

Source: `build-with-claude/prompt-caching` (only the first 100,000 of 160,149 characters were read; the rest was not checked).
- **Minimum cacheable prefix: 512 tokens for both Haiku 5.5 and Sonnet 5.5** (1,024 for Sonnet 5, 4,096 for Haiku 4.5). A shorter prefix is silently not cached, no error; both cache fields are then 0.
- Mark the prefix with `cache_control: {"type":"ephemeral"}` on the last block that should be included (e.g. the last `system` text block). Everything up to and including it is cached. Order is tools, then system, then messages, so put the static part (instructions, schema, CV) first and the posting in the user message. There is also an "automatic" mode: one top-level `cache_control` field; the docs call it the recommended start, but explicit breakpoints are clearer for a reserve calculation.
- Lifetime: 5 minutes by default, refreshed free on every hit; `"ttl":"1h"` optional (write costs 2x base input instead of 1.25x). Lifetime counts from request start.
- Prices (Sonnet 5.5): write 5m $2.50, read $0.10 (0.05x, not the usual 0.1x). Haiku 5.5: write $0.125, read $0.01.
- Extraction prompt (instructions + schema) is probably 500-1,500 tokens: cacheable only if >= 512, and at Haiku prices the saving is tiny ($0.0001 per call). Worth doing only because it is a one-line marker; the CV in fit scoring is where it matters.
- Run fit calls back to back so the 5m cache stays warm (each hit refreshes it). One run per day means one write per run; use 1h TTL only if the run is paced slower than 5 min between fit calls.
- Rate-limit bonus: cache reads do not count toward ITPM (`api/rate-limits`).

## 4. Token counting before a call

Source: `build-with-claude/token-counting`.
- Endpoint: `POST https://api.anthropic.com/v1/messages/count_tokens` (SDK: `client.messages.countTokens({model, system, messages, ...})`), body same as Messages, response `{ "input_tokens": 14 }`.
- Free, separate rate limit from message creation (Start tier 5,000 RPM). It is an **estimate**: "the actual number of input tokens used ... might differ by a small amount". It ignores `cache_control` (no caching logic), so it returns the total prompt size, which is what a worst-case reserve wants. It counts under the tokenizer of the model you pass.
- It does not accept forced tool use on Sonnet 5.5 either (same 400), irrelevant if we use `output_config.format`. I did not verify whether `output_config.format` is accepted by the count endpoint (UNKNOWN; not tried, no API key).
- Doc heuristics: "1 token is approximately 4 characters" (pricing FAQ, old tokenizer) but the current tokenizer is about 2.5 Unicode characters per token ("1M tokens is roughly ... 2.5M Unicode characters", `models/overview`).

**Recommendation (my judgment, not a doc statement) for the worst-case reservation:** a local estimate, no network call. `input_est = ceil(total_chars / 2)` over system + CV + posting + schema JSON + a flat 500 tokens for injected structured-output/tool prompts, priced at the **full input price (ignore the cache discount)**; plus `max_tokens * output_price`. That is conservative against 2.5 chars/token and keeps the reserve step synchronous, offline-testable and free of an extra call per posting. Reserve over-estimates by roughly 20-60%, which is fine because the real cost from `usage` is what is written to `llm_calls`. If the reserve proves too pessimistic (postings skipped to `budget_wait` while real spend is far below the cap), the upgrade is `countTokens` once per static prefix (instructions + CV) per run plus the local estimate for the posting. Use `countTokens` per call only if accuracy matters more than doubling the request count.

## 5. Rate limits, errors, retries

Sources: `api/rate-limits`, `api/errors`, `cli-sdks-libraries/sdks/typescript`.
- New organizations may start in an "Evaluation" tier with limits below the standard ones; the standard Start tier for both models is 1,000 RPM / 2,000,000 ITPM / 400,000 OTPM (Haiku 5.5 and Sonnet 5.5 separate buckets). A few hundred calls per day is far under any tier. The owner's actual tier is unknown (it is in the console, not readable here).
- Limits use a token bucket, so short bursts can 429. `max_tokens` does not count toward OTPM. Keep the loop sequential or concurrency <= 2.
- Error codes (`api/errors`): 400 `invalid_request_error` (also when an org/workspace spend limit **you set** is hit), 401 `authentication_error`, 402 `billing_error`, 403 `permission_error`, 404, 409, 413 `request_too_large`, 429 `rate_limit_error`, 500 `api_error`, 504 `timeout_error`, **529 `overloaded_error`** (temporary, high traffic across all users). Body: `{"type":"error","error":{"type","message"},"request_id":"req_..."}`; also a `request-id` response header.
- 429 comes with a `retry-after` header (seconds), except the **monthly tier spend-cap 429**, which has no `retry-after` and `error.details.error_code == "enforced_spend_limit_reached"`; retrying fails until the 1st of next month 00:00 UTC. Treat that one as fatal for the run (not `budget_wait`, which is our own cap).
- SDK: `maxRetries` default 2, short exponential backoff, honors `retry-after`; retries connection errors, 408, 409, 429, >= 500 (so 529). Default timeout 10 minutes (for non-streaming, scaled by `max_tokens`); set `timeout` to about 60 s for these small calls. Error classes: `Anthropic.APIError` with `.status`, `BadRequestError` (400), `AuthenticationError` (401), `RateLimitError` (429), `InternalServerError` (>= 500), `APIConnectionError`; `err.headers`, `message._request_id`.
- Advice: leave the SDK's 2 retries on and treat one `messages.create` as one logical call for the reserve and for `llm_calls` (one row). If it still fails after retries with 429/529/5xx, write a `status = error` row (cost 0 unless `usage` is present), leave the posting `pending` for the next run and stop the run on a second consecutive 529. Do not retry 400/401/402/403 at all. Whether a request that errors out is billed is UNKNOWN from the docs read; the docs say a refusal (`stop_reason:"refusal"`) with HTTP 200 is billed.
- Do not set `max_tokens` large without streaming (the SDK refuses non-streaming calls it expects to exceed 10 minutes); our values (about 1-2k) are fine.

## 6. Worked cost example

Assumptions (the card's numbers, treated as **Sonnet/Haiku-tokenizer counts**, thinking off, no structured-output overhead, 5m cache). Prices from section 1.

**Extraction, Haiku 5.5:** 3,000 in, 500 out.
- 3,000 x 0.10 / 1e6 = $0.00030; 500 x 0.50 / 1e6 = $0.00025; **total $0.00055**. $1 / 0.00055 = **about 1,818 extractions/day**.
- If the 3k included a 1k cached instruction prefix: 1,000 x 0.01/1e6 + 2,000 x 0.10/1e6 + $0.00025 = $0.00046 (not worth the complexity).

**Fit scoring, Sonnet 5.5:** CV 2,000 cached + posting 3,000 + 600 out.
- Warm cache: 2,000 x 0.10/1e6 = $0.00020; 3,000 x 2/1e6 = $0.00600; 600 x 10/1e6 = $0.00600; **total $0.01220**. $1 / 0.0122 = **about 82 fit scores/day**.
- First call of a cache window (write): 2,000 x 2.50/1e6 = $0.00500 instead of $0.00020, so $0.01700.
- No caching at all: 5,000 x 2/1e6 + $0.006 = $0.01600 (about 62/day). Caching saves about 24% here because the posting and the output dominate.

**Combined per posting that reaches fit:** 0.00055 + 0.01220 = **$0.01275, about 78 postings/day**.
**Realistic mix:** if only 20% of extracted postings are `keep` and reach fit: 0.00055 + 0.2 x 0.0122 = $0.00299, so **about 334 postings/day** (and about 5 per cent of the day's cap is extraction). At 10%: about 640/day. The Sonnet output (10x the input price per token) is the lever: a 300-token reasons list instead of 600 saves $0.003 per fit score (25%).

**Sensitivity:** if the real token counts are 30% above the card's guess (new tokenizer), costs scale about +30%: extraction $0.0007 (1,400/day), fit $0.0159 (63/day). If adaptive thinking is left on, thinking tokens add output at $0.50/MTok (Haiku) or $10/MTok (Sonnet): 1,000 thinking tokens add $0.0005 or $0.010 per call, i.e. nearly double the Sonnet cost. Hence section 2's advice to disable it.

**Reserve example (worst case, section 4 rule):** fit call, prompt 5,000 tokens counted by the estimator at full price + `max_tokens` 1,200: 5,000 x 2/1e6 + 1,200 x 10/1e6 = $0.022. With $1 cap this blocks new calls once spent >= $0.978.

## 7. Hand-built msw fixtures

Real JSON shape per `build-with-claude/structured-outputs`, `build-with-claude/prompt-caching` ("Usage fields") and the Messages API reference excerpt (`api/messages`; the page is 1.17M characters and only the first 100k were read, so the field list below is verified for `id/type/role/model/content/stop_reason/stop_sequence/usage.{input,output,cache_*,cache_creation}` and **not verified** for `usage.service_tier`/`inference_geo`). No live request was made (no key; none may be requested). Mark these fixtures `"_handbuilt": true` in the README as the conventions require.

Request the tests should match: `POST https://api.anthropic.com/v1/messages`, headers `x-api-key`, `anthropic-version: 2023-06-01`, `content-type: application/json`.

Text response (structured output, extraction; thinking disabled, cache miss):
```json
{
  "id": "msg_01XFDUDYJgAACzvnptvVoYEL",
  "type": "message",
  "role": "assistant",
  "model": "claude-haiku-5-5",
  "content": [
    { "type": "text", "text": "{\"remote\":true,\"currency\":\"USD\",\"salary_min\":90000,\"salary_max\":120000}" }
  ],
  "stop_reason": "end_turn",
  "stop_sequence": null,
  "usage": {
    "input_tokens": 3012,
    "cache_creation_input_tokens": 0,
    "cache_read_input_tokens": 0,
    "output_tokens": 48
  }
}
```

Text response with cache usage (fit scoring, Sonnet, cache hit on a 2,000 token CV):
```json
{
  "id": "msg_01AbCdEfGhIjKlMnOpQrStUv",
  "type": "message",
  "role": "assistant",
  "model": "claude-sonnet-5-5",
  "content": [
    { "type": "text", "text": "{\"fit_score\":72,\"reasons\":[\"stack matches\",\"seniority one level above\"]}" }
  ],
  "stop_reason": "end_turn",
  "stop_sequence": null,
  "usage": {
    "input_tokens": 3020,
    "cache_creation_input_tokens": 0,
    "cache_read_input_tokens": 2000,
    "cache_creation": { "ephemeral_5m_input_tokens": 0, "ephemeral_1h_input_tokens": 0 },
    "output_tokens": 411
  }
}
```

`tool_use` response (only if a later card uses tools; block shape from the Messages reference; `stop_reason` is `"tool_use"`):
```json
{
  "id": "msg_01D7FLrfh4GYq7yT1ULFeyMV",
  "type": "message",
  "role": "assistant",
  "model": "claude-haiku-5-5",
  "content": [
    { "type": "tool_use", "id": "toolu_01D7FLrfh4GYq7yT1ULFeyMV", "name": "record_extraction", "input": { "remote": true, "currency": "USD" } }
  ],
  "stop_reason": "tool_use",
  "stop_sequence": null,
  "usage": { "input_tokens": 3300, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0, "output_tokens": 60 }
}
```

Variants every stage test needs:
- `stop_reason: "max_tokens"` with truncated JSON text (invalid output, retry then failed).
- `stop_reason: "refusal"` with a plain-text message.
- Text that is valid JSON but fails the Zod schema (missing field).
- With thinking left on: `content: [{"type":"thinking","thinking":"","signature":"EuYB..."},{"type":"text","text":"{...}"}]` (checks that the client picks the text block, not `content[0]`).
- Error bodies, status 429 with header `retry-after: 1`, status 529 `{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"},"request_id":"req_011CSHoEeqs5C35K2UUqR7Fy"}` (shape per `api/errors`; the 529 message text is my guess), and the spend-cap 429 with `"details":{"error_code":"enforced_spend_limit_reached"}` and no `retry-after`. SDK retries need msw handlers that fail once then succeed (or `maxRetries: 0` in tests).

## Risks / notes

- Prices and ids are from a docs page that changes (a Sonnet 5 introductory price was recently made permanent per the footnote). Keep prices in the one table `prices.ts` and have a test that pins the values; re-check the pricing page when a model id changes.
- The $1/day cap holds with disabled thinking; with thinking on, Sonnet fit calls roughly double in cost.
- Structured outputs on a first-seen schema add latency; irrelevant for a batch run.
- Prompt and CV go to Anthropic (PLAN 7). The docs state ZDR eligibility for structured outputs, thinking and token counting excluding "Covered Models"; whether the owner's org has ZDR is not known and not needed.
- Not read/verified: the last 60k characters of the prompt-caching page, the last 3k of the structured-outputs page, the Messages API reference beyond its first 100k characters, `prompting-claude-haiku-5-5` and `prompting-claude-sonnet-5-5` pages (they may carry extra advice on effort and extraction quality).

## Sources (all accessed 2026-10-08)

1. https://platform.claude.com/docs/en/about-claude/pricing (prices, cache multipliers, tokenizer note, batch)
2. https://platform.claude.com/docs/en/models/overview (ids, context, max output, retirement)
3. https://platform.claude.com/docs/en/models/haiku-5-5/overview and https://platform.claude.com/docs/en/models/sonnet-5-5/overview (pricing, thinking, sampling params)
4. https://platform.claude.com/docs/en/build-with-claude/prompt-caching (512 token minimum, cache_control, TTL, usage fields)
5. https://platform.claude.com/docs/en/build-with-claude/structured-outputs (`output_config.format`, helpers, limits, stop reasons)
6. https://platform.claude.com/docs/en/build-with-claude/token-counting (count_tokens, free, estimate)
7. https://platform.claude.com/docs/en/api/errors (codes, body shape, forced-tool-use and thinking 400s)
8. https://platform.claude.com/docs/en/api/rate-limits (tiers, ITPM caching, retry-after, spend cap)
9. https://platform.claude.com/docs/en/cli-sdks-libraries/sdks/typescript (Node 20+, retries, timeouts, errors)
10. https://platform.claude.com/docs/en/build-with-claude/thinking and https://platform.claude.com/docs/en/build-with-claude/effort (thinking table, billing, effort)
11. https://registry.npmjs.org/@anthropic-ai/sdk/latest (version 0.132.1, peer deps)
12. https://platform.claude.com/docs/en/api/messages (response shape, partially read)

## Confidence

- **High:** ids, prices, 512-token minimum, `output_config.format`, forced-tool-use ban on Sonnet 5.5, thinking on by default and billed as output, error codes, SDK retry behavior, SDK version and Node 20+ (all read from official pages today).
- **Medium:** the response fixtures (assembled from several doc excerpts, not copied from one live response; `service_tier` and similar extras omitted), the reserve heuristic (my recommendation), chars-per-token factor.
- **Low / UNKNOWN:** whether failed requests are billed; whether `count_tokens` accepts `output_config.format`; the owner's rate tier; extraction/fit quality with thinking off.
- **Would raise confidence:** one live smoke call by the owner with a real key, saving a trimmed real response (`usage` included, redacted of content) as the fixture; one `count_tokens` call on a real prompt to measure the chars-per-token ratio.
