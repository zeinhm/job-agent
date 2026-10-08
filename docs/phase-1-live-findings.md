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
