#!/usr/bin/env bash
# Tests the operator dispatch (bin/operator-dispatch.sh, the operator role in bin/agent-step and bin/dispatch) in a
# throwaway repo with a stubbed `hermes` and a stubbed bin/cc-run under mktemp -d. Never touches the real repo,
# the board, the network or Claude.
set -uo pipefail
BIN="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pass=0; failn=0
ok()  { echo "PASS: $1"; pass=$((pass+1)); }
bad() { echo "FAIL: $1"; failn=$((failn+1)); }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }

T="$(cd "$(mktemp -d)" && pwd -P)"; trap 'rm -rf "$T"' EXIT
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.invalid GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.invalid

# ---- temp repo with a copy of bin/ and the role prompts, a stub hermes and a stub cc-run
R="$T/repo"; mkdir -p "$R/bin" "$R/prompts/roles" "$R/packages/apply/src" "$R/packages/pipeline/src" "$R/docs" "$T/stub"
cp "$BIN"/agent-step "$BIN"/lib.sh "$BIN"/step-git.sh "$BIN"/operator-dispatch.sh "$BIN"/jobagent.conf "$R/bin/"
for f in common operator; do cp "$BIN/../prompts/roles/$f.md" "$R/prompts/roles/"; done
cd "$R" || exit 1
git init -q -b main .; echo a > docs/a.md; echo a > packages/apply/src/fill.ts; git add -A; git commit -q -m init

BOARD="$T/board.txt"; CALLS="$T/calls.txt"; : > "$BOARD"; : > "$CALLS"
cat > "$T/stub/hermes" <<EOF
#!/usr/bin/env bash
# stub: hermes kanban list|show|create|comment|complete|block
shift
case "\$1" in
  list) cat "$BOARD"; [ -f "$T/list-fails" ] && exit 1; exit 0 ;;
  show) echo "Task \$2: \$(sed -n "s/^\$2 //p" "$T/titles.txt" | head -1)"; echo "  status:    ready"; echo "  assignee:  operator"; echo "  parents:   "
        [ -f "$T/body-\$2.md" ] && { echo; echo "Body:"; cat "$T/body-\$2.md"; echo; echo "Events (1):"; } ;;
  complete) echo "complete \$2" >> "$CALLS" ;;
  create) shift; echo "create \$*" >> "$CALLS"; n=\$(( \$(wc -l < "$T/created.txt") + 1 )); echo x >> "$T/created.txt"
          id="t_\$(printf '%08x' \$n)"; echo "\$id todo operator" >> "$BOARD"; echo "Created \$id"
          while [ \$# -gt 0 ]; do [ "\$1" = --body-file ] && cp "\$2" "$T/body-\$id.md"; shift; done ;;
  comment) echo "comment \$2 \$3" >> "$CALLS" ;;
  *) echo "\$*" >> "$CALLS" ;;
esac
EOF
chmod +x "$T/stub/hermes"; : > "$T/created.txt"
printf 't_dev1 Dry-run filler fix\nt_dev2 Another filler fix\nt_op1 Operator batch\n' > "$T/titles.txt"
# stub cc-run: writes the comment file and a verdict as the operator would ($1 role, $2 workdir, $3 prompt, $4 out)
cat > "$R/bin/cc-run" <<EOF
#!/usr/bin/env bash
echo "\$2" > "$T/cc-workdir.txt"
[ -n "\${STUB_COMMENT:-}" ] && cp "\$STUB_COMMENT" "$R/data/handoff/\$(basename "\$3" -prompt.md)-comment.md"
printf '%s\n' "\$STUB_VERDICT" > "\$4"
EOF
chmod +x "$R/bin/cc-run"
export PATH="$T/stub:$PATH"

export REPO="$R"; . "$R/bin/lib.sh"          # STATE=$R/data/dispatch, jobagent.conf settings, helpers (git toplevel = temp repo)
log() { :; }
. "$R/bin/operator-dispatch.sh"
tick() { OPERATOR_NOW="$1"; export OPERATOR_NOW; op_tick; }
ncreate() { grep -c '^create ' "$CALLS"; }
reset() { : > "$BOARD"; : > "$CALLS"; : > "$T/created.txt"; rm -f "$STATE"/operator-pending "$STATE"/operator-daily "$T/list-fails"; }

# 1. merge trigger: matching paths, none for docs-only
git commit -q --allow-empty -m base
echo b >> packages/apply/src/fill.ts; git commit -q -am m1
operator_note_merge HEAD t_dev1
check "merge touching packages/apply/src/ is recorded" "grep -qx t_dev1 '$STATE/operator-pending'"
rm -f "$STATE/operator-pending"
echo b >> docs/a.md; git commit -q -am docs
operator_note_merge HEAD t_dev2
check "docs-only merge records nothing" "[ ! -s '$STATE/operator-pending' ]"
echo c > packages/pipeline/src/dry-run-report.ts; git add -A; git commit -q -m m2; operator_note_merge HEAD t_dev2
check "merge touching packages/pipeline/src/dry-run* is recorded" "grep -qx t_dev2 '$STATE/operator-pending'"
rm -f "$STATE/operator-pending"
echo c > packages/pipeline/src/cli.ts; git add -A; git commit -q -m m3; operator_note_merge HEAD t_dev1
check "merge touching packages/pipeline/src/cli.ts is recorded" "grep -qx t_dev1 '$STATE/operator-pending'"
rm -f "$STATE/operator-pending"
echo c > packages/pipeline/src/score.ts; git add -A; git commit -q -m m4; operator_note_merge HEAD t_dev1
check "merge touching another pipeline file records nothing" "[ ! -s '$STATE/operator-pending' ]"
operator_note_merge HEAD ""
check "no dev card id records nothing" "[ ! -s '$STATE/operator-pending' ]"
check "agent-step records the trigger after the squash merge is pushed" "sed -n '/^squash_merge()/,/^}/p' '$BIN/agent-step' | awk '/gpush -q origin main/{p=1} p&&/operator_note_merge/{f=1} END{exit !f}'"

# 2. a trigger creates one card, named after the merged card, assigned to the operator
reset; echo t_dev1 > "$STATE/operator-pending"
tick "2026-10-18 12:30"
check "trigger creates exactly one operator card" "[ \$(ncreate) = 1 ] && grep -q '^create Operator batch 2026-10-18 12:30 (after t_dev1) --assignee operator' '$CALLS'"
check "card body names the merged card and its title" "grep -q 't_dev1: Dry-run filler fix' '$T/body-t_00000001.md'"
check "the pending trigger is consumed" "[ ! -s '$STATE/operator-pending' ]"
check "no daily card is made later that day (a card was already created)" "tick '2026-10-18 13:00'; [ \$(ncreate) = 1 ]"

# 3. coalescing: while a card is open (todo/ready/running; a blocked one is section 3c) a trigger is a comment
for st in todo ready running; do
  reset; echo "t_ab01 $st operator" > "$BOARD"; echo "t_dev2" > "$STATE/operator-pending"
  tick "2026-10-18 12:30"
  check "open card ($st): no new card, comment on the open one" "[ \$(ncreate) = 0 ] && grep -q '^comment t_ab01 ' '$CALLS' && [ ! -s '$STATE/operator-pending' ]"
done
reset; echo "t_ab02 done operator" > "$BOARD"; echo t_dev2 > "$STATE/operator-pending"; tick "2026-10-18 12:30"
check "a done card does not block a new one" "[ \$(ncreate) = 1 ]"
reset; echo "t_dev9 running dev" > "$BOARD"; echo t_dev2 > "$STATE/operator-pending"; tick "2026-10-18 12:30"
check "a running card of another role does not block" "[ \$(ncreate) = 1 ]"
reset; echo t_dev1 > "$STATE/operator-pending"; tick "2026-10-18 12:30"; echo t_dev2 > "$STATE/operator-pending"; tick "2026-10-18 12:31"
check "second trigger after a created card coalesces (the card is still todo)" "[ \$(ncreate) = 1 ] && [ \$(grep -c '^comment ' '$CALLS') = 1 ]"
reset; echo t_dev1 > "$STATE/operator-pending"; touch "$T/list-fails"; tick "2026-10-18 12:30"
check "unreadable board: no card is created, the trigger stays" "[ \$(ncreate) = 0 ] && grep -qx t_dev1 '$STATE/operator-pending'"
reset; printf 't_dev1\nt_dev2\n' > "$STATE/operator-pending"; tick "2026-10-18 12:30"
check "two merges before a card exist share one card" "[ \$(ncreate) = 1 ] && grep -q '(after t_dev1, t_dev2)' '$CALLS'"

# 3b. a merge landing while op_tick waits on a slow hk call is never lost (atomic consume)
echo d >> packages/apply/src/fill.ts; git commit -q -am m5
reset; echo t_dev1 > "$STATE/operator-pending"
hk() { [ "$1" = create ] && operator_note_merge HEAD t_dev2; hermes kanban "$@"; }
tick "2026-10-18 12:30"
check "trigger appended during a slow create is kept for the next pass" "grep -qx t_dev2 '$STATE/operator-pending' && ! grep -qx t_dev1 '$STATE/operator-pending' && [ \$(ncreate) = 1 ]"
reset; echo "t_ab01 running operator" > "$BOARD"; echo t_dev1 > "$STATE/operator-pending"
hk() { [ "$1" = comment ] && operator_note_merge HEAD t_dev2; hermes kanban "$@"; }
tick "2026-10-18 12:30"
check "trigger appended during a slow comment is kept" "grep -qx t_dev2 '$STATE/operator-pending' && ! grep -qx t_dev1 '$STATE/operator-pending'"
reset; echo "t_ab01 running operator" > "$BOARD"; echo t_dev1 > "$STATE/operator-pending"
hk() { [ "$1" = comment ] && return 1; hermes kanban "$@"; }
tick "2026-10-18 12:30"
check "failed comment puts the consumed trigger back, no temp file left" "grep -qx t_dev1 '$STATE/operator-pending' && ! ls -A '$STATE' | grep -q operator-processing"
hk() { hermes kanban "$@" </dev/null 2>&1; }

# 3c. a blocked batch is not open: a trigger makes a new card that carries its merged cards, and supersedes it
reset; printf -- '- t_0de2: Another filler fix\n' > "$T/body-t_ab01.md"
echo "t_ab01 blocked operator" > "$BOARD"; echo t_dev1 > "$STATE/operator-pending"
tick "2026-10-18 12:30"
check "blocked batch: a new card is created" "[ \$(ncreate) = 1 ] && grep -q '(after t_dev1)' '$CALLS'"
check "blocked batch: no 'No new card' comment" "! grep -q '^comment t_ab01 Operator trigger' '$CALLS'"
check "new card lists the pending merge and the blocked batch's merged cards" "grep -q 't_dev1: Dry-run filler fix' '$T/body-t_00000001.md' && grep -q 'blocked batch t_ab01' '$T/body-t_00000001.md' && grep -q '^- t_0de2: Another filler fix' '$T/body-t_00000001.md'"
check "blocked batch gets 'superseded by <new id>' and is completed" "grep -q '^comment t_ab01 superseded by t_00000001' '$CALLS' && grep -q '^complete t_ab01' '$CALLS'"
rm -f "$T/body-t_ab01.md"
reset; echo "t_ab01 blocked operator" > "$BOARD"; echo t_dev1 > "$STATE/operator-pending"; echo "t_ab02 running operator" >> "$BOARD"
tick "2026-10-18 12:30"
check "blocked plus a running batch: the trigger still coalesces into the running one" "[ \$(ncreate) = 0 ] && grep -q '^comment t_ab02 ' '$CALLS' && ! grep -q 'superseded' '$CALLS'"
reset; echo "t_ab01 blocked operator" > "$BOARD"; tick "2026-10-18 10:00"
check "blocked batch + daily trigger: new daily card supersedes it" "[ \$(ncreate) = 1 ] && grep -q '^complete t_ab01' '$CALLS'"

# 3d. a batch blocked for more than 30 minutes is listed in operator-summary.md under [OWNER] holds
reset; rm -rf "$STATE/operator-blocked"; rm -f "$STATE/operator-summary.md"
printf '## Owner summary\nReady for your review: 1 runs (p1)\nOpen root causes: none\n[OWNER] holds: none\n' > "$STATE/operator-summary.md"
echo "t_ab01 blocked operator" > "$BOARD"
OPERATOR_EPOCH=1000000; export OPERATOR_EPOCH; OPERATOR_NOW="2026-10-18 07:00"; export OPERATOR_NOW; op_tick
check "blocked just now: not listed" "! grep -q 't_ab01' '$STATE/operator-summary.md'"
OPERATOR_EPOCH=$((1000000 + 30*60)); op_tick
check "blocked exactly 30 min: not yet listed" "! grep -q 't_ab01' '$STATE/operator-summary.md'"
OPERATOR_EPOCH=$((1000000 + 31*60)); op_tick
check "blocked over 30 min: listed under [OWNER] holds, outside the window too" "grep -q '^\\[OWNER\\] holds (blocked operator batches)' '$STATE/operator-summary.md' && grep -q '^- t_ab01: operator batch blocked for 31 min' '$STATE/operator-summary.md'"
check "the existing owner summary text is kept" "grep -q 'Ready for your review: 1 runs (p1)' '$STATE/operator-summary.md'"
op_tick; check "listing is not duplicated on a later pass" "[ \$(grep -c 't_ab01' '$STATE/operator-summary.md') = 1 ]"
echo "t_ab01 done operator" > "$BOARD"; op_tick
check "once the batch is no longer blocked it leaves the summary" "! grep -q 't_ab01' '$STATE/operator-summary.md' && grep -q 'Ready for your review' '$STATE/operator-summary.md'"
unset OPERATOR_EPOCH

# 4. daily: once, at the configured time, none before it
reset
tick "2026-10-18 09:59"; check "daily: nothing before 10:00" "[ \$(ncreate) = 0 ]"
tick "2026-10-18 10:00"; check "daily: card at 10:00" "[ \$(ncreate) = 1 ] && grep -q '^create Operator batch 2026-10-18 10:00 (daily)' '$CALLS'"
echo "t_00000001 done operator" > "$BOARD"; tick "2026-10-18 11:00"
check "daily: only once a day, even when the card is done" "[ \$(ncreate) = 1 ]"
tick "2026-10-19 10:05"; check "daily: next day, new card" "[ \$(ncreate) = 2 ]"
reset; echo "t_ab01 running operator" > "$BOARD"; tick "2026-10-18 10:00"; tick "2026-10-18 10:01"
check "daily with an open card: one comment, no card, not repeated" "[ \$(ncreate) = 0 ] && [ \$(grep -c '^comment ' '$CALLS') = 1 ]"

# 5. window: outside 08:00-22:00 nothing happens, the trigger is kept and fires at the window start
reset; echo t_dev1 > "$STATE/operator-pending"
tick "2026-10-18 07:59"; check "window: 07:59 deferred, trigger kept" "[ \$(ncreate) = 0 ] && grep -qx t_dev1 '$STATE/operator-pending'"
tick "2026-10-18 22:00"; check "window: 22:00 deferred, trigger kept" "[ \$(ncreate) = 0 ] && grep -qx t_dev1 '$STATE/operator-pending'"
tick "2026-10-19 08:00"; check "window: deferred trigger fires at 08:00 (not dropped)" "[ \$(ncreate) = 1 ] && grep -q 'after t_dev1' '$CALLS'"
reset; tick "2026-10-18 23:00"; tick "2026-10-19 02:00"
check "window: the daily trigger outside the window is deferred too" "[ \$(ncreate) = 0 ]"
OPERATOR_NOW="2026-10-18 21:59"; check "op_in_window: 21:59 inside" "op_in_window"
OPERATOR_NOW="2026-10-18 22:00"; check "op_in_window: 22:00 outside" "! op_in_window"
check "dispatch only starts operator cards inside the window" "grep -q 'operator.*op_in_window.*continue' '$BIN/dispatch'"
check "dispatch runs op_tick every pass and lists operator as a role" "grep -q '^  op_tick' '$BIN/dispatch' && grep -q '^ROLES=.* operator ' '$BIN/dispatch'"

# 6. agent-step operator: verdicts, summary copy, no lock / commit / worktree
MARK="MARKER_7f3a91_value"
printf 'Ran 2 postings.\nSecret-ish text %s\n\n## Owner summary\nReady for your review: 2 runs (p1, p2)\nOpen root causes: none\n[OWNER] holds: none\n' "$MARK" > "$T/comment-ok.md"
mkdir -p "$R/data/handoff"; HEAD0="$(git rev-parse HEAD)"; WT0="$(git worktree list | wc -l | tr -d ' ')"
step() { STUB_VERDICT="$1" STUB_COMMENT="${2:-}" "$R/bin/agent-step" operator t_op1 2>&1; }
OUT="$(step 'VERDICT: DONE | branch: - | batch finished' "$T/comment-ok.md")"
check "operator DONE -> ACTION: complete" "printf '%s' \"\$OUT\" | grep -q '^ACTION: complete' && printf '%s' \"\$OUT\" | grep -q 'SUMMARY: batch finished'"
check "summary file holds the Owner summary section" "grep -q '^## Owner summary' '$STATE/operator-summary.md' && grep -q 'Ready for your review: 2 runs (p1, p2)' '$STATE/operator-summary.md' && grep -q '^\\[OWNER\\] holds: none' '$STATE/operator-summary.md'"
check "summary file has nothing from before the section" "! grep -q 'Ran 2 postings' '$STATE/operator-summary.md' && ! grep -q '$MARK' '$STATE/operator-summary.md'"
check "marker never appears on the agent-step output" "! printf '%s' \"\$OUT\" | grep -q '$MARK'"
check "operator ran in the main checkout" "[ \"\$(cat '$T/cc-workdir.txt')\" = '$R' ]"
check "operator: no commit, no worktree, no stash, no main lock" "[ \"\$(git rev-parse HEAD)\" = '$HEAD0' ] && [ \"\$(git worktree list | wc -l | tr -d ' ')\" = '$WT0' ] && [ -z \"\$(git stash list)\" ] && [ ! -e '$R/.git/agent-step.lock' ] && [ -z \"\$(git status --porcelain --untracked-files=no)\" ]"
check "operator report is posted as a card comment" "grep -q '^comment t_op1 ' '$CALLS'"
printf '## Owner summary\nReady for your review: 0 runs (-)\nOpen root causes: none\n[OWNER] holds: none\n' > "$T/comment-2.md"
step 'VERDICT: DONE | branch: - | second' "$T/comment-2.md" >/dev/null
check "summary file is overwritten each batch" "grep -q '0 runs' '$STATE/operator-summary.md' && ! grep -q '2 runs' '$STATE/operator-summary.md'"
printf 'Ran 1 posting.\n' > "$T/comment-3.md"
step 'VERDICT: DONE | branch: - | third' "$T/comment-3.md" >/dev/null
check "no Owner summary in the report: the file says so, the old summary is not kept" "grep -q 'No owner summary' '$STATE/operator-summary.md' && ! grep -q '0 runs' '$STATE/operator-summary.md'"
# no comment file, but the wrapper's fallback file carries the owner summary: it is used, and the summary says which file
rm -f "$R/data/handoff/t_op1-fallback.md"
step $'Report text\n\n## Owner summary\nReady for your review: 3 runs (p4, p5, p6)\nOpen root causes: none\n[OWNER] holds: none\nVERDICT: DONE | branch: - | fallback' "" >/dev/null
check "fallback file used: its owner summary is shown" "[ -s '$R/data/handoff/t_op1-fallback.md' ] && grep -q 'Ready for your review: 3 runs (p4, p5, p6)' '$STATE/operator-summary.md'"
check "fallback file used: the summary names the file and the card" "grep -q 't_op1-fallback.md' '$STATE/operator-summary.md' && grep -q 'no comment file for t_op1' '$STATE/operator-summary.md'"
# neither file: the summary says so, with the card id
rm -f "$R/data/handoff/t_op7-comment.md" "$R/data/handoff/t_op7-fallback.md"
copy_owner_summary "$R/data/handoff/t_op7-comment.md"
check "neither file: summary names the card and says no report" "grep -q 'No batch report for t_op7' '$STATE/operator-summary.md' && ! grep -q 'runs' '$STATE/operator-summary.md'"
# the comment file wins over a leftover fallback file
printf '## Owner summary\nReady for your review: 8 runs (c1)\n' > "$R/data/handoff/t_op8-comment.md"; printf '## Owner summary\nReady for your review: 9 runs (f1)\n' > "$R/data/handoff/t_op8-fallback.md"
copy_owner_summary "$R/data/handoff/t_op8-comment.md"
check "comment file preferred over a fallback file, no note" "grep -q '8 runs' '$STATE/operator-summary.md' && ! grep -q 'fallback' '$STATE/operator-summary.md'"
check "operator prompt: report goes through bin/operator comment, no Write tool" "grep -q 'bin/operator comment' '$BIN/../prompts/roles/operator.md' && ! grep -qiE 'write tool|Write or Edit|to the Comment file' '$BIN/../prompts/roles/operator.md'"
printf '## Owner summary\nReady for your review: 1 runs (p9)\nOpen root causes: none\n[OWNER] holds: t_op1: CAPTCHA\n' > "$T/comment-4.md"
OUT="$(step 'VERDICT: BLOCKED | branch: - | OWNER: CAPTCHA seen on greenhouse posting p9 in batch t_op1' "$T/comment-4.md")"
check "operator BLOCKED -> ACTION: question with the OWNER: text" "printf '%s' \"\$OUT\" | grep -q '^ACTION: question' && printf '%s' \"\$OUT\" | grep -q 'QUESTION: OWNER: CAPTCHA seen'"
check "BLOCKED also copies the summary" "grep -q 'CAPTCHA' '$STATE/operator-summary.md'"
OUT="$(step 'VERDICT: PASS | branch: - | wrong verdict' "$T/comment-ok.md")"
check "operator PASS -> question, not complete" "printf '%s' \"\$OUT\" | grep -q '^ACTION: question' && ! printf '%s' \"\$OUT\" | grep -q '^ACTION: complete'"
OUT="$(step 'no verdict here' "$T/comment-ok.md")"; rc=$?
check "operator without a verdict -> no ACTION (dispatcher retries)" "! printf '%s' \"\$OUT\" | grep -q '^ACTION:'"
check "an OWNER: summary is held [OWNER] by the existing hold rule" "eval \"\$(sed -n '/^hold() {/,/^wait_on()/p' '$BIN/dispatch' | sed '\$d')\"; counter() { echo 1; }; hk() { [ \"\$1\" = block ] && HELD=\"\$3\"; return 0; }; HELD=''; hold t_op1 DOCTOR 'OWNER: CAPTCHA seen'; case \"\$HELD\" in 'HELD #1 [OWNER]: '*) true ;; *) false ;; esac"
check "operator never takes the main lock, commits or creates worktrees in agent-step" "! sed -n '/^  operator)/,/;;/p' '$BIN/agent-step' | sed 's/#.*//' | grep -qE 'lock_main|git commit|worktree'"

echo "$pass passed, $failn failed"
[ "$failn" -eq 0 ]
