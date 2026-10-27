#!/usr/bin/env bash
# Shared helpers for bin/dispatch, bin/agent-step, bin/cloud-dev, bin/cc-run. macOS bash 3.2.
REPO="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "not in the job-agent repo" >&2; exit 2; }
. "$REPO/bin/jobagent.conf"
STATE="$REPO/data/dispatch"
for d in running cloud fails errors notes syncs sessions adopted; do mkdir -p "$STATE/$d"; done
export USER="${USER:-$(id -un)}"

log()   { echo "$(date '+%F %T') $*" >> "$STATE/dispatch.log"; [ -t 1 ] && echo "$(date '+%F %T') $*"; return 0; }
hk()    { hermes kanban "$@" </dev/null 2>&1; }
board() { hk list | grep -oE 't_[0-9a-f]+ +[a-z_]+ +[A-Za-z0-9_-]+'; }          # "id status assignee"
card()  { hk show "$1"; }
field() { printf '%s\n' "$1" | sed -n "s/^ *$2: *//p" | head -1; }               # field "$(card id)" status
title_of() { card "$1" | head -1 | sed -E "s/^Task $1: //"; }
body_of()  { card "$1" | awk '/^Body:/{f=1;next} /^(Latest summary|Comments|Events|Runs)( \([0-9]+\))?:/{f=0} f'; }
status_of(){ field "$(card "$1")" status; }
slugify()  { printf '%s' "$1" | tr 'A-Z' 'a-z' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//' | cut -c1-30 | sed -E 's/-+$//'; }
now()      { date +%s; }
counter()  { local f="$STATE/$1/$2" n; n="$(cat "$f" 2>/dev/null || echo 0)"; n=$((n+1)); echo "$n" > "$f"; echo "$n"; }
gh_token() { security find-generic-password -a "$USER" -s job-agent-github-token -w 2>/dev/null; }
gpush()    { local t; t="$(gh_token)" || { echo "gpush: no Keychain token (job-agent-github-token)"; return 1; }
             JOB_AGENT_GITHUB_TOKEN="$t" git -C "$REPO" push "$@"; }
# the branch a dev task works on: "Branch: task/..." in the card (rework/sync), else task/<id>-<slug>
dev_branch() { local b; b="$(body_of "$1" | grep -m1 -oE 'Branch: *task/t_[0-9a-f]+-[A-Za-z0-9._-]+' | sed -E 's/^Branch: *//')"
               [ -n "$b" ] && { echo "$b"; return; }; echo "task/$1-$(slugify "$(title_of "$1")")"; }
cloud_allowed() { [ ! -f "$STATE/cloud-off" ] && [[ "$(date +%F)" < "$CLOUD_UNTIL" ]]; }
# Holds only the owner can fix are labelled OWNER (NEEDS-ZEIN.md lists only [OWNER] holds): git push or token
# problems, private config values, account or usage limits, anything needing a login.
owner_cause() { printf '%s' "$1" | grep -qiE 'push|keychain|token|jpush|not on github|authenticat|permission denied|credential|username|\b40[13]\b|config/|private config|api key|usage limit|rate limit|limit reached|out of (usage|credits)|credit|log ?in|logged in|password|captcha|subscription'; }
# the last lines of a failing command's output, on one line, for a hold reason
errtail() { printf '%s' "$1" | grep -v '^[[:space:]]*$' | tail -n "${2:-3}" | tr '\n' ' ' | cut -c1-400; }
# Live-session registry: cc-run records the claude pid in sessions/<id>, agent-step its own pid in sessions/<id>.step.
# A card with a live session (kill -0) must never be reclaimed or started again. Dead entries are pruned.
session_alive() { local f p alive=1
  for f in "$STATE/sessions/$1" "$STATE/sessions/$1.step"; do
    [ -s "$f" ] || continue; p="$(cat "$f")"
    if kill -0 "$p" 2>/dev/null; then alive=0; else rm -f "$f"; fi
  done; return $alive; }
# The last VERDICT line of an output file, binary-safe: NUL bytes dropped, grep -a, bytes not decoded.
last_verdict_line() { [ -f "$1" ] || return 0; LC_ALL=C tr -d '\000' < "$1" | LC_ALL=C grep -a '^VERDICT:' | tail -1; }
pro_paused()    { local u; u="$(cat "$STATE/pro-paused-until" 2>/dev/null)"; [ -n "$u" ] && [ "$(now)" -lt "$u" ]; }
