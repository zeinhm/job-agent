#!/usr/bin/env bash
# Tests bin/dispatch restart safety (live sessions are adopted, never duplicated), binary-safe verdict reads in
# bin/agent-step and bin/cc-run, and the self-restart after a script change. Throwaway repo under mktemp -d with a
# stubbed `hermes` and a stubbed `claude`; never touches the real repo, the board, the network or Claude.
set -uo pipefail
BIN="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pass=0; failn=0
ok()  { echo "PASS: $1"; pass=$((pass+1)); }
bad() { echo "FAIL: $1"; failn=$((failn+1)); }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }

T="$(cd "$(mktemp -d)" && pwd -P)"; SLEEPERS=""
cleanup() { for p in $SLEEPERS; do kill "$p" 2>/dev/null; done; rm -rf "$T"; }
trap cleanup EXIT
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.invalid GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.invalid

R="$T/repo"; mkdir -p "$R/bin" "$R/prompts/roles" "$R/docs" "$T/stub"
cp "$BIN"/dispatch "$BIN"/agent-step "$BIN"/cc-run "$BIN"/lib.sh "$BIN"/step-git.sh "$BIN"/operator-dispatch.sh "$BIN"/jobagent.conf "$R/bin/"
for f in common operator; do cp "$BIN/../prompts/roles/$f.md" "$R/prompts/roles/"; done
cd "$R" || exit 1
git init -q -b main .; echo a > docs/a.md; git add -A; git commit -q -m init

BOARD="$T/board.txt"; CALLS="$T/calls.txt"; : > "$BOARD"; : > "$CALLS"
cat > "$T/stub/hermes" <<EOF
#!/usr/bin/env bash
# stub: hermes kanban list|show|reclaim|...
shift
case "\$1" in
  list) cat "$BOARD" ;;
  show) echo "Task \$2: stub card"; echo "  status:    \$(cat "$T/status-\$2" 2>/dev/null || echo running)"; echo "  assignee:  auditor"; echo "  parents:   " ;;
  *) echo "\$*" >> "$CALLS" ;;
esac
EOF
# stub claude: writes binary junk plus verdict lines to stdout (the out file); STUB_HOLD seconds of life first
cat > "$T/stub/claude" <<'EOF'
#!/usr/bin/env bash
[ -n "${STUB_HOLD:-}" ] && sleep "$STUB_HOLD"
printf 'noise \000\377\376 more\nVERDICT: FAIL | branch: - | early\n\200\201 binary \000 line\nVERDICT: DONE | branch: x | the last one\n\377\000tail\n'
EOF
chmod +x "$T/stub/hermes" "$T/stub/claude"
export PATH="$T/stub:$PATH"
export REPO="$R"
log() { :; }
DISPATCH_LIB_ONLY=1; export DISPATCH_LIB_ONLY
. "$R/bin/dispatch"
STATE="$R/data/dispatch"
log() { :; }

sleeper() { sleep 60 & SLEEPERS="$SLEEPERS $!"; LAST=$!; }
reset() { : > "$BOARD"; : > "$CALLS"; rm -f "$STATE"/running/* "$STATE"/adopted/* "$STATE"/sessions/* "$T"/status-*; }

# 1. a live claude session is adopted, never reclaimed
reset; echo "t_a0d1 running auditor" > "$BOARD"
sleeper; echo "$LAST" > "$STATE/sessions/t_a0d1"
recover
check "live session: card not reclaimed" "! grep -q 'reclaim t_a0d1' '$CALLS'"
check "live session: adopted and marked running (not started twice)" "[ -f '$STATE/running/t_a0d1.auditor' ] && [ -f '$STATE/adopted/t_a0d1' ]"
check "live session: counts as a local job and blocks its role" "[ \"\$(local_count)\" = 1 ] && busy_role auditor"
reap_running
check "live session still going: still adopted after a reap" "[ -f '$STATE/running/t_a0d1.auditor' ] && ! grep -q reclaim '$CALLS'"
kill "$LAST"; wait "$LAST" 2>/dev/null
reap_running
check "session ended: running card reclaimed once, markers gone" "[ \"\$(grep -c 'reclaim t_a0d1' '$CALLS')\" = 1 ] && [ ! -e '$STATE/running/t_a0d1.auditor' ] && [ ! -e '$STATE/adopted/t_a0d1' ]"

# 2. only the agent-step process is alive (claude pid file gone): still adopted
reset; echo "t_a0d2 running auditor" > "$BOARD"
sleeper; echo "$LAST" > "$STATE/sessions/t_a0d2.step"
recover
check "live agent-step: adopted, not reclaimed" "! grep -q 'reclaim t_a0d2' '$CALLS' && [ -f '$STATE/adopted/t_a0d2' ]"
kill "$LAST"; wait "$LAST" 2>/dev/null

# 3. dead session / no session: orphan is reclaimed as before; a card finished meanwhile is not reclaimed again
reset; echo "t_a0d3 running auditor" > "$BOARD"
sleeper; echo "$LAST" > "$STATE/sessions/t_a0d3"; kill "$LAST"; wait "$LAST" 2>/dev/null
recover
check "dead session: orphan reclaimed" "grep -q 'reclaim t_a0d3' '$CALLS' && [ ! -e '$STATE/adopted/t_a0d3' ] && [ ! -e '$STATE/sessions/t_a0d3' ]"
reset; echo "t_a0d4 running auditor" > "$BOARD"; sleeper; echo "$LAST" > "$STATE/sessions/t_a0d4"
recover; kill "$LAST"; wait "$LAST" 2>/dev/null; echo done > "$T/status-t_a0d4"
reap_running
check "adopted session ended after the card was completed: no reclaim" "! grep -q reclaim '$CALLS' && [ ! -e '$STATE/running/t_a0d4.auditor' ]"

# 4. binary-safe verdict: cc-run records the claude pid while it runs and agent-step reads the last VERDICT from binary output
reset; mkdir -p "$R/data/handoff" "$R/.claude/roles"; echo '{}' > "$R/.claude/roles/operator.json"; echo "t_0b01 ready operator" > "$BOARD"
OUT="$R/data/handoff/t_0b01-out.txt"; PF="$T/prompt.md"; echo prompt > "$PF"
( STUB_HOLD=2 "$R/bin/cc-run" operator "$R" "$PF" "$OUT" "$STATE/sessions/t_0b01" >/dev/null 2>&1 ) &
CCP=$!; sleep 1
check "cc-run writes the live claude pid to the session file" "[ -s '$STATE/sessions/t_0b01' ] && kill -0 \"\$(cat '$STATE/sessions/t_0b01')\""
wait "$CCP"
check "cc-run removes the session file when claude ends" "[ ! -e '$STATE/sessions/t_0b01' ]"
check "stub output really is binary (plain grep says so)" "grep '^VERDICT:' '$OUT' | grep -q 'Binary file' || file '$OUT' | grep -qi data"
check "last_verdict_line takes the LAST verdict line of binary output" "[ \"\$(last_verdict_line '$OUT')\" = 'VERDICT: DONE | branch: x | the last one' ]"
rm -f "$STATE"/notes/*
RES="$("$R/bin/agent-step" operator t_0b01 2>&1)"
check "agent-step on binary output: ACTION complete with the last summary" "printf '%s' \"\$RES\" | grep -q '^ACTION: complete' && printf '%s' \"\$RES\" | grep -q 'SUMMARY: the last one'"
check "agent-step records its pid for the dispatcher" "[ -e '$STATE/sessions/t_0b01.step' ]"
printf 'only \000\377 binary, no verdict\n' > "$T/novd.txt"
check "last_verdict_line: no verdict in binary output -> empty" "[ -z \"\$(last_verdict_line '$T/novd.txt')\" ]"

# 5. self-restart after a script change, only at an idle point
reset
RESTARTS="$T/restarts.txt"; : > "$RESTARTS"
restart_self() { echo "restart $*" >> "$RESTARTS"; }
log() { echo "$*" >> "$T/log.txt"; }
ONCE=0; SCRIPT_SUM="$(script_sum)"
maybe_restart
check "unchanged scripts: no restart" "[ ! -s '$RESTARTS' ]"
echo "# changed" >> "$R/bin/operator-dispatch.sh"
sleeper; echo "$LAST" > "$STATE/running/t_busy.qa"
maybe_restart
check "changed script, a card running: no restart yet" "[ ! -s '$RESTARTS' ]"
kill "$LAST"; wait "$LAST" 2>/dev/null; reap_running
maybe_restart --flag
check "changed script, idle: restarts itself with its arguments" "[ \"\$(cat '$RESTARTS')\" = 'restart --flag' ]"
check "restart is logged as 'restarted after script change'" "grep -q 'restarted after script change' '$T/log.txt'"
SCRIPT_SUM="$(script_sum)"; : > "$RESTARTS"
echo "if then" >> "$R/bin/lib.sh"
maybe_restart
check "changed script that does not parse: kept running, no restart" "[ ! -s '$RESTARTS' ] && grep -q 'do not parse' '$T/log.txt'"
maybe_restart
check "unparsable change is reported once, not every pass" "[ \"\$(grep -c 'do not parse' '$T/log.txt')\" = 1 ]"
ONCE=1; SCRIPT_SUM=x
maybe_restart
check "--once never restarts" "[ ! -s '$RESTARTS' ]"
check "main loop calls maybe_restart after each pass" "grep -q 'pass; .*maybe_restart' '$BIN/dispatch'"

echo "$pass passed, $failn failed"
[ "$failn" -eq 0 ]
