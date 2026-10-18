#!/usr/bin/env bash
# Tests bin/operator (argument checks, stdout only, failure line) and the deny-list union of bin/cc-run, both in a temp git
# repo with a stub pnpm and a stub claude. Never touches the real repo, database or config.
set -uo pipefail
BIN="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pass=0; failn=0
ok()  { echo "PASS: $1"; pass=$((pass+1)); }
bad() { echo "FAIL: $1"; failn=$((failn+1)); }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }

T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
R="$T/repo"; mkdir -p "$R/bin" "$R/.claude/roles" "$T/stub" "$T/home/.config/job-agent"
git -C "$R" init -q
cp "$BIN/operator" "$BIN/cc-run" "$BIN/lib.sh" "$BIN/jobagent.conf" "$BIN/merge-settings.jq" "$R/bin/"

# stub pnpm: records its arguments and working directory, prints $T/out on stdout and a marker on stderr, exits with $T/rc
cat > "$T/stub/pnpm" <<EOF
#!/usr/bin/env bash
echo "\$PWD|\$*" > "$T/pnpm.call"
[ -f "$T/out" ] && cat "$T/out"
echo "MARKER_STDERR_Q7Z \$*" >&2
exit "\$(cat "$T/rc" 2>/dev/null || echo 0)"
EOF
chmod +x "$T/stub/pnpm"
export PATH="$T/stub:$PATH"
OP="$R/bin/operator"
run() { rm -f "$T/pnpm.call"; STDOUT="$(bash "$OP" "$@" 2>"$T/err")"; RC=$?; STDERR="$(cat "$T/err")"; }
called() { [ -f "$T/pnpm.call" ]; }

rm -f "$T/out" "$T/rc"
printf 'gh-1 greenhouse "A job"\n' > "$T/out"
run candidates
check "candidates: stdout of the command only" "[ \"\$STDOUT\" = 'gh-1 greenhouse \"A job\"' ] && [ \$RC -eq 0 ] && [ -z \"\$STDERR\" ]"
check "candidates: runs dry-run-candidates in the repo root" "grep -qx \"\$(cd "$R" && pwd -P)|--silent job-agent dry-run-candidates\" \"$T/pnpm.call\" || grep -q '|--silent job-agent dry-run-candidates\$' \"$T/pnpm.call\""
run candidates --limit 7
check "candidates --limit 7 passed on" "grep -q 'dry-run-candidates --limit 7\$' \"$T/pnpm.call\""
run report --posting p-1 --last 5 --since 2026-10-01
check "report: arguments passed on" "grep -q 'dry-run-report --posting p-1 --last 5 --since 2026-10-01\$' \"$T/pnpm.call\""
run report
check "report without arguments" "[ \$RC -eq 0 ] && grep -q 'dry-run-report\$' \"$T/pnpm.call\""
run run t_batch1 gh-1
check "run: operator-dry-run with both ids" "grep -q 'operator-dry-run t_batch1 gh-1\$' \"$T/pnpm.call\""
check "stderr of the command never reaches the caller" "! printf '%s%s' \"\$STDOUT\" \"\$STDERR\" | grep -q MARKER_STDERR_Q7Z"

# refusals: nothing is called, exit 2, the typed text is not echoed
refused() { # $1 label, rest = arguments
  local l="$1"; shift
  run "$@"
  check "refused: $l" "[ \$RC -eq 2 ] && ! called && printf '%s' \"\$STDOUT\" | grep -q '^operator: refused: ' && ! printf '%s' \"\$STDOUT\$STDERR\" | grep -q 'ZZ_TYPED'"
}
refused "no subcommand"
refused "unknown subcommand" ZZ_TYPED
refused "dry-run is not a subcommand" dry-run gh-1
refused "candidates with an unknown option" candidates --headless
refused "candidates limit not a number" candidates --limit ZZ_TYPED
refused "candidates limit without value" candidates --limit
refused "candidates extra positional" candidates ZZ_TYPED
refused "report unknown option" report --value ZZ_TYPED
refused "report option without value" report --last
refused "report bad id" report --posting 'a;ZZ_TYPED'
refused "report bad date" report --since 'ZZ_TYPED'
refused "report positional" report ZZ_TYPED
refused "run without ids" run
refused "run one id" run t_batch1
refused "run three args" run t_batch1 gh-1 ZZ_TYPED
refused "run id with shell characters" run 't_b;ZZ_TYPED' gh-1
refused "run id with leading dash" run --headless gh-1
refused "run id with a newline" run "$(printf 't_b\nZZ_TYPED')" gh-1

# failure: fixed line first, then the command's own stdout, exit code kept, stderr dropped
printf 'run gh-1 stopped captcha\n' > "$T/out"; echo 3 > "$T/rc"
run run t_batch1 gh-1
check "failure: first line is the fixed text" "[ \$RC -eq 3 ] && [ \"\$(printf '%s\n' \"\$STDOUT\" | sed -n 1p)\" = 'operator: run failed (exit 3)' ]"
check "failure: command stdout follows" "[ \"\$(printf '%s\n' \"\$STDOUT\" | sed -n 2p)\" = 'run gh-1 stopped captcha' ] && [ \"\$(printf '%s\n' \"\$STDOUT\" | wc -l | tr -d ' ')\" = 2 ]"
check "failure: no stderr text" "! printf '%s%s' \"\$STDOUT\" \"\$STDERR\" | grep -q MARKER_STDERR_Q7Z"
rm -f "$T/out"; echo 1 > "$T/rc"
run candidates
check "failure without stdout: one line" "[ \"\$STDOUT\" = 'operator: candidates failed (exit 1)' ] && [ \$RC -eq 1 ]"
rm -f "$T/rc" "$T/out"

# started from a worktree: the command still runs in the main checkout
git -C "$R" -c user.email=t@example.invalid -c user.name=t commit -q --allow-empty -m init
git -C "$R" worktree add -q "$T/wt" -b wtb >/dev/null 2>&1
mkdir -p "$T/wt/bin"; cp "$OP" "$T/wt/bin/operator"
rm -f "$T/pnpm.call"; bash "$T/wt/bin/operator" candidates >/dev/null 2>&1
check "from a worktree: runs in the main checkout" "[ \"\$(cut -d'|' -f1 \"$T/pnpm.call\")\" = \"\$(cd "$R" && pwd -P)\" ] || [ \"\$(cut -d'|' -f1 \"$T/pnpm.call\")\" = \"$R\" ]"

# ---- card / note / release: text only from data/handoff/<batch>-<slug>.md, fixed flags, no arbitrary file ----
cat > "$T/stub/hermes" <<EOF
#!/usr/bin/env bash
{ echo "\$PWD"; for a in "\$@"; do echo "ARG:\$a"; done; } > "$T/hermes.call"
[ "\$2" = show ] && cat "$T/show" 2>/dev/null
echo "created t_new1"; echo "MARKER_STDERR_Q7Z" >&2
exit "\$(cat "$T/hrc" 2>/dev/null || echo 0)"
EOF
printf '#!/usr/bin/env bash\necho "$*" > "%s/release.call"\n' "$T" > "$R/bin/release"
chmod +x "$T/stub/hermes" "$R/bin/release"
HD="$R/data/handoff"; mkdir -p "$HD" "$R/data/dispatch/notes"
printf 'body one\n' > "$HD/t_b1-fix-a.md"
hcalled() { [ -f "$T/hermes.call" ]; }
hrun() { rm -f "$T/hermes.call" "$T/release.call"; run "$@"; }
hrun card t_b1 fix-a dev "Operator fix [rc:fix-a]: label not filled"
check "card: fixed flags and the body file" "[ \$RC -eq 0 ] && [ \"\$STDOUT\" = 'created t_new1' ] && grep -qx 'ARG:create' \"$T/hermes.call\" && grep -qx 'ARG:--assignee' \"$T/hermes.call\" && grep -qx 'ARG:dev' \"$T/hermes.call\" && grep -qx 'ARG:--priority' \"$T/hermes.call\" && grep -qx 'ARG:9' \"$T/hermes.call\" && grep -q \"^ARG:--body-file\$\" \"$T/hermes.call\" && grep -q \"^ARG:.*/data/handoff/t_b1-fix-a.md\$\" \"$T/hermes.call\" && grep -Fqx 'ARG:Operator fix [rc:fix-a]: label not filled' \"$T/hermes.call\" && ! grep -q parent \"$T/hermes.call\""
check "card: stderr dropped" "! printf '%s%s' \"\$STDOUT\" \"\$STDERR\" | grep -q MARKER_STDERR_Q7Z"
hrun card t_b1 fix-a qa "QA for fix a" t_dev9
check "card: parent passed" "grep -qx 'ARG:--parent' \"$T/hermes.call\" && grep -qx 'ARG:t_dev9' \"$T/hermes.call\" && grep -qx 'ARG:qa' \"$T/hermes.call\""
crefused() { local l="$1"; shift; hrun "$@"; check "refused: $l" "[ \$RC -eq 2 ] && ! hcalled && printf '%s' \"\$STDOUT\" | grep -q '^operator: refused: ' && ! printf '%s' \"\$STDOUT\$STDERR\" | grep -q 'ZZ_TYPED'"; }
crefused "card: path as slug" card t_b1 ../../config/x dev "T ZZ_TYPED"
crefused "card: slash in slug" card t_b1 a/b dev "T ZZ_TYPED"
crefused "card: batch id with a slash" card ../t_b1 fix-a dev "T ZZ_TYPED"
crefused "card: assignee not whitelisted" card t_b1 fix-a pm "T ZZ_TYPED"
crefused "card: title with a dash first" card t_b1 fix-a dev "--body-file ZZ_TYPED"
crefused "card: title with shell characters" card t_b1 fix-a dev 'T $(ZZ_TYPED)'
crefused "card: parent with a dash" card t_b1 fix-a qa "T" --workspace
crefused "card: too many arguments" card t_b1 fix-a dev T t_p ZZ_TYPED
crefused "card: missing file" card t_b1 nofile dev "T"
printf 'SECRET_ZZ' > "$T/secretfile"; ln -s "$T/secretfile" "$HD/t_b1-link.md"
crefused "card: symlink body file" card t_b1 link dev "T"
crefused "note: symlink text file" note t_b1 link t_x1
: > "$HD/t_b1-empty.md"
crefused "card: empty file" card t_b1 empty dev "T"
head -c 20001 /dev/zero | tr '\0' a > "$HD/t_b1-big.md"
crefused "card: file over 20000 bytes" card t_b1 big dev "T"
crefused "note: file over 4000 bytes" note t_b1 big t_x1
crefused "note: bad card id" note t_b1 fix-a '-x'
mkdir -p "$HD/t_b1-dir.md"
crefused "card: a directory" card t_b1 dir dev "T"
printf 'evidence\n' > "$HD/t_b1-ev.md"
hrun note t_b1 ev t_x1
check "note: comment text from the file" "[ \$RC -eq 0 ] && grep -qx 'ARG:comment' \"$T/hermes.call\" && grep -qx 'ARG:t_x1' \"$T/hermes.call\" && grep -qx 'ARG:evidence' \"$T/hermes.call\""
printf -- '--body-file x\n' > "$HD/t_b1-dash.md"
hrun note t_b1 dash t_x1
check "note: text starting with a dash is not an option" "grep -qx 'ARG:Note: --body-file x' \"$T/hermes.call\""
echo 4 > "$T/hrc"; hrun card t_b1 fix-a dev "T"
check "card: failure line and exit code" "[ \$RC -eq 4 ] && [ \"\$STDOUT\" = 'operator: card failed (exit 4)' ]"
rm -f "$T/hrc"
printf 'Task t_x2: Some question card\n' > "$T/show"
printf 'go ahead\n' > "$HD/t_b1-ans.md"
hrun release t_b1 ans t_x2
check "release: a non-owner card is released with the file text" "[ \$RC -eq 0 ] && [ \"\$(cat \"$T/release.call\")\" = 't_x2 go ahead' ]"
printf 'Task t_x3: Operator fix [rc:a]: b\n' > "$T/show"
hrun release t_b1 ans t_x3
check "release: an operator fix card is refused" "[ \$RC -eq 2 ] && [ ! -f \"$T/release.call\" ]"
printf 'Task t_x4: [OWNER] hold\n' > "$T/show"
hrun release t_b1 ans t_x4
check "release: a card with OWNER in its title is refused" "[ \$RC -eq 2 ] && [ ! -f \"$T/release.call\" ]"
printf 'Task t_x5: Some question card\n' > "$T/show"; : > "$R/data/dispatch/notes/t_x5.owner"
hrun release t_b1 ans t_x5
check "release: an owner-held card (notes/<id>.owner) is refused" "[ \$RC -eq 2 ] && [ ! -f \"$T/release.call\" ]"
rm -f "$T/show"

# ---- bin/cc-run: the overrides never remove a deny rule ----
cat > "$T/stub/claude" <<EOF
#!/usr/bin/env bash
while [ \$# -gt 0 ]; do [ "\$1" = --settings ] && cp "\$2" "$T/settings.used"; [ "\$1" = --permission-mode ] && echo "\$2" > "$T/mode.used"; shift; done
echo "VERDICT: DONE | branch: - | stub"
EOF
chmod +x "$T/stub/claude"
echo "p" > "$T/prompt.md"
ccrun() { rm -f "$T/settings.used"; ( cd "$R" && HOME="$T/home" bash bin/cc-run fake "$R" "$T/prompt.md" "$T/cc.out" ); }
cat > "$R/.claude/roles/fake.json" <<'EOF'
{"permissions":{"allow":["Bash(a:*)"],"deny":["Bash(role-deny:*)","Bash(both:*)"]},"keep":1}
EOF
cat > "$T/home/.config/job-agent/claude-overrides.json" <<'EOF'
{"permissions":{"allow":["Bash(b:*)"],"deny":["Bash(owner-deny:*)","Bash(both:*)"]},"env":{"X":"1"}}
EOF
ccrun
check "cc-run: deny lists are the union, no duplicates" "[ \"\$(jq -c '.permissions.deny|sort' \"$T/settings.used\")\" = '[\"Bash(both:*)\",\"Bash(owner-deny:*)\",\"Bash(role-deny:*)\"]' ]"
check "cc-run: allow lists merge as before (overrides replace)" "[ \"\$(jq -c '.permissions.allow' \"$T/settings.used\")\" = '[\"Bash(b:*)\"]' ]"
check "cc-run: other keys of both files kept" "[ \"\$(jq -c '[.keep,.env.X]' \"$T/settings.used\")\" = '[1,\"1\"]' ]"
echo '{"permissions":{"deny":[]},"model":"x"}' > "$T/home/.config/job-agent/claude-overrides.json"
ccrun
check "cc-run: an override with an empty deny list removes nothing" "[ \"\$(jq -c '.permissions.deny|sort' \"$T/settings.used\")\" = '[\"Bash(both:*)\",\"Bash(role-deny:*)\"]' ]"
echo '{"env":{"X":"1"}}' > "$T/home/.config/job-agent/claude-overrides.json"
ccrun
check "cc-run: an override without permissions keeps the role's deny list" "[ \"\$(jq -c '.permissions.deny|length' \"$T/settings.used\")\" = 2 ]"
rm -f "$T/home/.config/job-agent/claude-overrides.json"
ccrun
check "cc-run: no overrides file, role file used as is" "cmp -s \"$R/.claude/roles/fake.json\" \"$T/settings.used\""
echo '{"permissions":{"allow":["Bash(only:*)"]}}' > "$T/home/.config/job-agent/claude-overrides.json"
echo '{"permissions":{"allow":["Bash(a:*)"]}}' > "$R/.claude/roles/fake.json"
ccrun
check "cc-run: no deny list anywhere adds none" "[ \"\$(jq -c '.permissions|has(\"deny\")' \"$T/settings.used\")\" = false ]"

check "cc-run: other roles keep acceptEdits" "[ \"\$(cat \"$T/mode.used\")\" = acceptEdits ]"
# a malformed overrides file: the role file is used as is, never an empty settings file
echo '{ not json' > "$T/home/.config/job-agent/claude-overrides.json"
ccrun
check "cc-run: a failing merge falls back to the role file" "cmp -s \"$R/.claude/roles/fake.json\" \"$T/settings.used\""
# the operator: dontAsk, the overrides never merged in, no run without its settings file
echo '{"permissions":{"allow":["Bash(sort:*)","Bash(cat:*)"],"deny":[]}}' > "$T/home/.config/job-agent/claude-overrides.json"
echo '{"permissions":{"allow":["Bash(bin/operator:*)"],"deny":["Bash(cat:*)"]}}' > "$R/.claude/roles/operator.json"
rm -f "$T/mode.used"; rm -f "$T/settings.used"
( cd "$R" && HOME="$T/home" bash bin/cc-run operator "$R" "$T/prompt.md" "$T/cc.out" )
check "cc-run: operator runs in dontAsk" "[ \"\$(cat \"$T/mode.used\")\" = dontAsk ]"
check "cc-run: operator settings are its own file, overrides ignored" "cmp -s \"$R/.claude/roles/operator.json\" \"$T/settings.used\""
rm -f "$R/.claude/roles/operator.json" "$T/mode.used" "$T/settings.used"
( cd "$R" && HOME="$T/home" bash bin/cc-run operator "$R" "$T/prompt.md" "$T/cc.out" ) >/dev/null 2>&1; RC=$?
check "cc-run: operator without its settings file does not start" "[ \$RC -eq 1 ] && [ ! -f \"$T/mode.used\" ]"

echo "$pass passed, $failn failed"
[ "$failn" -eq 0 ]
