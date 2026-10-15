#!/usr/bin/env bash
# Tests the hold labelling of bin/dispatch (hold) and the helpers in bin/lib.sh (owner_cause, errtail).
# Owner-only causes must be held as [OWNER] (NEEDS-ZEIN.md lists only those); the real error must be in the reason.
set -uo pipefail
BIN="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pass=0; failn=0
ok()  { echo "PASS: $1"; pass=$((pass+1)); }
bad() { echo "FAIL: $1"; failn=$((failn+1)); }

# lib.sh helpers only (the part from the owner_cause comment up to pro_paused), so no repo or hermes is needed
eval "$(sed -n '/^owner_cause()/p;/^errtail()/p' "$BIN/lib.sh")"
# the hold function of bin/dispatch with stubbed board calls
eval "$(sed -n '/^hold() {/,/^wait_on()/p' "$BIN/dispatch" | sed '$d')"
HELD=""
counter() { echo 1; }
log() { :; }
hk() { [ "$1" = block ] && HELD="$3"; return 0; }

holds() { # $1 label, $2 given class, $3 text, $4 expected class
  HELD=""; hold t_x "$2" "$3"
  case "$HELD" in "HELD #1 [$4]: "*) ok "$1" ;; *) bad "$1: got '$HELD', want class $4" ;; esac
}
holds "git push failure given as DOCTOR becomes OWNER" DOCTOR "push of main failed after merging task/t_1-x: remote: Permission denied" OWNER
holds "missing Keychain token becomes OWNER" DOCTOR "could not push task/t_1-x: gpush: no Keychain token (job-agent-github-token)" OWNER
holds "local main not on GitHub becomes OWNER" DOCTOR "local main has commits that are not on GitHub: the owner must run jpush" OWNER
holds "usage limit becomes OWNER" DOCTOR "claude: you have hit your weekly limit reached" OWNER
holds "login needed becomes OWNER" DOCTOR "the site needs a login before this can continue" OWNER
holds "OWNER: prefix from a BLOCKED verdict becomes OWNER" DOCTOR "OWNER: which salary floor do you want?" OWNER
holds "plain decision stays DOCTOR" DOCTOR "FAIL number 3 on this task: decide (split the task or rewrite the card)" DOCTOR
holds "explicit OWNER stays OWNER" OWNER "anything" OWNER
holds "real error text is kept in the reason" DOCTOR "could not push b: fatal: Authentication failed for the remote" OWNER
case "$HELD" in *"fatal: Authentication failed"*) ok "reason keeps the real error" ;; *) bad "reason lost the error: $HELD" ;; esac

E="$(errtail "$(printf 'one\n\ntwo\nthree\nfour\n')")"
[ "$E" = "two three four " ] && ok "errtail keeps the last 3 non-empty lines on one line" || bad "errtail: '$E'"
[ "$(errtail "$(printf 'a\nb\nc\n' )" 1)" = "c " ] && ok "errtail line count argument" || bad "errtail count"

# every hold-reason source in agent-step puts the failing command's output into the reason
for pat in 'errtail "\$PE"' 'errtail "\$CE"'; do
  grep -q "$pat" "$BIN/agent-step" && ok "agent-step uses $pat" || bad "agent-step lacks $pat"
done
grep -q 'errtail' "$BIN/dispatch" && ok "dispatch uses errtail" || bad "dispatch lacks errtail"

echo "$pass passed, $failn failed"
[ "$failn" -eq 0 ]
