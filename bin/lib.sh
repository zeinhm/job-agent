#!/usr/bin/env bash
# Shared helpers for bin/dispatch, bin/agent-step, bin/cloud-dev, bin/cc-run. macOS bash 3.2.
REPO="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "not in the job-agent repo" >&2; exit 2; }
. "$REPO/bin/jobagent.conf"
STATE="$REPO/data/dispatch"
for d in running cloud fails errors notes; do mkdir -p "$STATE/$d"; done
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
pro_paused()    { local u; u="$(cat "$STATE/pro-paused-until" 2>/dev/null)"; [ -n "$u" ] && [ "$(now)" -lt "$u" ]; }
