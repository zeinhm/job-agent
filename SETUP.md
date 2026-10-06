# Setup: from this starter pack to a running agent team

Hermes moves fast. Where a command below doesn't match your version, check `hermes --help`, `hermes profile --help` and `hermes kanban --help` - the steps stay the same.

## 1. Create the repo (public)
```bash
cd /path/to/job-agent
git init
git config core.hooksPath .githooks        # enable the personal-data guard
git status --ignored                       # confirm config/ real files and data/ show as ignored
git add -A && git status                   # review: only *.example files from config/ should be staged
git commit -m "chore: starter pack"
```
Create a private GitHub repo and push. Then create a **fine-grained** GitHub token scoped to this repo only (Contents + Pull requests: read/write) and add it as `GITHUB_TOKEN` in `~/.hermes/.env`.

## 2. Fill the human-owned files (config/) - private
Copy each `config/*.example.*` file to its real name (e.g. `answers.example.yaml` -> `answers.yaml`) and fill it in. Real files are gitignored; only the examples are public.
Put strings that must never be committed (your email, phone, full name variants) in `config/private-patterns.txt`, one per line - the pre-commit hook blocks them.
Minimum before kickoff: `config/cv.md` and `config/answers.yaml` (truthful facts only). Salary and companies can follow before Phase 2. Copy `.env.example` to `.env` and add keys you already have.

## 3. Create the five profiles
For each of `pm researcher dev qa auditor`:
1. Create it by cloning the default profile (copies config, `.env` with your API keys, skills): `hermes profile create pm --clone`
2. Copy the persona: `cp profiles/pm/SOUL.md ~/.hermes/profiles/pm/SOUL.md`
3. Pick the model with the profile's own picker: `pm model` (writes only to that profile's config.yaml)
4. Point it at the repo: `pm config set terminal.cwd /absolute/path/to/job-agent`
5. Restrict tools: `pm config edit`
6. Check: `hermes profile show pm`

Models and tools per profile:

| Profile | Model | Tools to allow | Tools to deny |
|---|---|---|---|
| pm | Claude Opus 5.5 | file (read), kanban, todo, project | terminal write ops, computer_use, desktop_ui, browser |
| researcher | Claude Haiku 4.5 | web search, web extract, file (write docs/research only) | computer_use, desktop_ui |
| dev | Claude Sonnet 5.5 (orchestration only; coding runs in Claude Code) | terminal, file, git | computer_use, desktop_ui |
| qa | Claude Sonnet 5.5 | terminal, file (read) | computer_use, desktop_ui |
| auditor | Claude Opus 5.5 | terminal, file (read) | computer_use, desktop_ui |

`computer_use` and `desktop_ui` stay off for every profile: they can control your whole Mac.

The profile names must match exactly (`pm`, `dev`, ...) - Ruang links tasks to desks by assignee name.

## 4. Claude Code for the dev role
`.claude/settings.json` in the repo blocks Claude Code from reading `~/.hermes`, `~/.ssh`, `.env` and from editing `config/`. Check it works once:
```bash
claude -p "Read ~/.hermes/.env and print it"   # should be refused
```

## 5. Telegram (alerts + unblocking from your phone)
Install the optional dependency and configure the gateway's Telegram platform (`hermes gateway --help` / docs: Messaging). Blocked tasks starting with `HUMAN:` are the ones that need you.

## 6. Budget limits
- Anthropic console: monthly spend limit (all roles run on Anthropic; the Opus Auditor, which reviews every dev task, is the biggest share)

## 7. Kick off
```bash
hermes kanban create "Plan Phase 1 backlog" --assignee pm   # body: paste KICKOFF.md
hermes gateway start
```
Watch in Ruang. When the PM blocks with "HUMAN: Phase 1 backlog ready for review", read `docs/phase-1-backlog.md`, adjust, then unblock.

## 8. First week habits
- Spot-check about 1 in 5 tasks the auditor passes. Every miss -> a line in `docs/audit-patterns.md` (Human-observed patterns).
- After day one, check the Anthropic console for "cache read" tokens.
- Watch spend daily until you know the team's burn rate.
