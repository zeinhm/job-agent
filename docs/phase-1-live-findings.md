# Phase 1 live run findings (2026-10-08)

First real run: 521 postings from 7 sources, digest generated. Quality problems to fix FIRST in Phase 2,
before LLM extraction (rules are free; fewer postings reach the LLM):

1. Role relevance filter (rules): Matches contain attorneys, medical directors, sales and marketing roles.
   Keep only software engineering roles matching the owner's target (frontend, fullstack, React, TypeScript,
   Next.js, platform/frontend architecture, senior IC / lead). Reject the rest before any LLM call.
2. Location bugs:
   - Himalayas "Countries: <list>" means the candidate must live there: classify as restricted
     (reject unless the list includes Indonesia or a region covering it), not "worldwide".
   - "Remote, <country>" (e.g. GitLab "Remote, United States") is restricted to that country: reject unless
     Indonesia/APAC is included; currently only "unclear".
3. HN adapter: only top-level comments of the "Who is hiring" thread are job posts; replies are parsed as jobs.
4. Group identical postings (same company + same title) listed per city/country into one digest entry.
5. web3.career: the API answers with HTTP 302 (redirect); the adapter must follow it (or use the target URL).
   Never tested live before today.
6. Every phase-end audit includes a live run (bin/smoke), not only fixtures.
7. web3.career terms of use (from the API access email, 2026-10-08):
   - Link to postings with the API's apply_url exactly as given (no rel="nofollow").
   - Never modify apply_url: the URL cleanup (utm_*, ref removal) must SKIP web3.career links.
   - Keep the token private (env only). Violations can suspend access.
   - API reference moved to https://docs.bondex.app/api-reference ; the adapter was built from older docs:
     record a real fixture and check the response shape.
8. web3.career live response (2026-10-08): 100 of 100 jobs rejected as invalid, because the adapter expects a
   `url` field that the real API does not return (the link field is `apply_url`). A real fixture was recorded
   with record:web3career; rebuild the adapter's schema against it (apply_url kept unmodified, see item 7).
