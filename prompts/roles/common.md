# Common rules (every local role reads this first)

You were started by the automation. Nobody is watching this run and nobody can answer questions during it.
Never stop to ask or wait. Decide sensibly from the docs and the card, and write your assumptions in your report.

## Before you start
1. Read AGENTS.md, then what the card points to: docs/PLAN.md sections, docs/decisions.md, docs/phase-*-conventions.md,
   docs/audit-patterns.md, research docs.
2. Read the whole card including its comments. Comments starting with "Answer:" are decisions from the Doctor or the
   owner: follow them. Later comments override the card body.

## Hard rules
- The repo is public. Never put personal data (the owner's CV, salary, answers, contact details, IP addresses,
  anything from config/ or data/) into code, tests, fixtures, docs or comments. Never read .env or config/.
- No logins, no CAPTCHA bypass, no LinkedIn automation, no real job applications, no contacting anyone.
- Never push to main and never merge: the automation does that. Never create, complete or block cards
  (only the PM creates cards when planning). `hermes kanban show` and `list` are fine.
- Live runs of the tool: use `bin/smoke` (temp DB, example configs, public feeds only).

## Your report (mandatory)
1. Write your full report (evidence, findings, reasoning) as markdown to the Comment file given at the top.
   Be specific: files, lines, commands, real output (trimmed, never paraphrased).
2. The LAST line of your reply must be exactly:
     VERDICT: <DONE|PASS|FAIL|BLOCKED> | branch: <branch or -> | <one-line summary>
   - BLOCKED only when you cannot decide from the docs, the card and common sense. Put the exact question in the
     summary. Start it with "OWNER:" only if it is about money, accounts or keys, salary or personal data,
     legal or terms-of-service, or acting in the owner's name; everything else is answered by the Doctor.
