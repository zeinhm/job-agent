#!/usr/bin/env bash
# Tests backup_before_merge (bin/step-git.sh) with a temp SQLite file under mktemp -d. Never touches data/job-agent.db.
set -uo pipefail
BIN="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pass=0; failn=0
ok()  { echo "PASS: $1"; pass=$((pass+1)); }
bad() { echo "FAIL: $1"; failn=$((failn+1)); }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }

T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
log() { :; }
errtail() { printf '%s' "$1" | grep -v '^[[:space:]]*$' | tail -n "${2:-3}" | tr '\n' ' ' | cut -c1-400; }
REPO="$T/repo"; ID=t_test; ROLE=qa
. "$BIN/step-git.sh"

mkdir -p "$T/data"; export BACKUP_DB="$T/data/job-agent.db"
fresh_db() { rm -rf "$T/data"; mkdir -p "$T/data"; sqlite3 "$BACKUP_DB" "CREATE TABLE t(x); INSERT INTO t VALUES (1);"; }
baks() { ls -1 "$T/data" | grep -c '^job-agent\.db\.bak-'; }
CARD="$(printf 'Task t_dev: x\n  status: done\n\nBody:\n**Risk:** high\n\nComments (1):\n  [2026-10-17 18:25] default: OWNER: back up data/job-agent.db before this merges\n\n# t_dev: report\n\nBranch b.\n')"
NOCARD="$(printf 'Task t_dev: x\n\nBody:\nA card that adds a migration starts its report with `OWNER: back up data/job-agent.db before this\n  merges`\n\nComments (1):\n  [2026-10-17 18:25] default: see the OWNER: back up data/job-agent.db line in the card\n\n# t_dev: report\n\nWe mention OWNER: back up data/job-agent.db mid-line.\n')"
NOFILE="$T/none.md"

# line in the dev card's comment -> backup made, named in the note, content equal
fresh_db; STEP_ERR=""
backup_before_merge "$CARD" "$NOFILE"; rc=$?
check "line in dev comment: backup made" "[ $rc -eq 0 ] && [ \"\$(baks)\" = 1 ]"
check "line in dev comment: note names the backup file" "printf '%s' \"\$BACKUP_NOTE\" | grep -qE '^DB backup: data/job-agent\\.db\\.bak-[0-9]{12}\$' && [ -s \"$T/data/\${BACKUP_NOTE#DB backup: data/}\" ]"
check "line in dev comment: backup is a valid copy, original untouched" "[ \"\$(sqlite3 \"$T/data/\${BACKUP_NOTE#DB backup: data/}\" 'PRAGMA integrity_check')\" = ok ] && [ -s \"$BACKUP_DB\" ]"

# line only in the reviewer's comment file (bold, leading spaces)
fresh_db; printf 'intro\n  **OWNER: back up data/job-agent.db** before merging\n' > "$T/c.md"
backup_before_merge "$NOCARD" "$T/c.md"; rc=$?
check "line in reviewer file (leading spaces and **): backup made" "[ $rc -eq 0 ] && [ \"\$(baks)\" = 1 ]"

# a report line at the very start of a comment file
fresh_db; printf 'OWNER: back up data/job-agent.db before this merges\n' > "$T/c.md"
backup_before_merge "$NOCARD" "$T/c.md"
check "line at the start of the file: backup made" "[ \"\$(baks)\" = 1 ]"

# line absent / only mentioned elsewhere: no backup, no new file
fresh_db; BACKUP_NOTE=x
backup_before_merge "$NOCARD" "$NOFILE"; rc=$?
check "mention not at line start (and the card body quote): no backup, no file, empty note" "[ $rc -eq 0 ] && [ \"\$(baks)\" = 0 ] && [ -z \"\$BACKUP_NOTE\" ] && [ \"\$(ls -1 \"$T/data\" | wc -l | tr -d ' ')\" = 1 ]"
printf 'a line mentioning data/job-agent.db backup\nnot OWNER: back up data/job-agent.db at start\n' > "$T/c.md"
backup_before_merge "" "$T/c.md"
check "reviewer file mention mid-line: no backup" "[ \"\$(baks)\" = 0 ]"

# keep 5: pre-existing six old backups + one new -> five newest remain, other files untouched
fresh_db; echo keep > "$T/data/other.txt"
for d in 202001010101 202001010102 202001010103 202001010104 202001010105 202001010106; do echo old > "$T/data/job-agent.db.bak-$d"; done
backup_before_merge "$CARD" "$NOFILE"; rc=$?
NEW="${BACKUP_NOTE#DB backup: data/}"
check "prune: exactly 5 backups remain, the new one among them" "[ $rc -eq 0 ] && [ \"\$(baks)\" = 5 ] && [ -f \"$T/data/\$NEW\" ]"
check "prune: the two oldest are gone, the four newest old ones stay" "[ ! -e \"$T/data/job-agent.db.bak-202001010101\" ] && [ ! -e \"$T/data/job-agent.db.bak-202001010102\" ] && [ -e \"$T/data/job-agent.db.bak-202001010103\" ] && [ -e \"$T/data/job-agent.db.bak-202001010106\" ]"
check "prune: the database and other files are untouched" "[ -s \"$BACKUP_DB\" ] && [ \"\$(cat \"$T/data/other.txt\")\" = keep ]"

# failures: no DB file, not a database, no sqlite3
rm -f "$BACKUP_DB"; STEP_ERR=""
backup_before_merge "$CARD" "$NOFILE"; rc=$?
check "no DB file: fails with a reason, no backup, empty note" "[ $rc -ne 0 ] && [ -n \"\$STEP_ERR\" ] && [ -z \"\$BACKUP_NOTE\" ]"
rm -rf "$T/data"; mkdir -p "$T/data"; echo "not a database, just text padding padding padding" > "$BACKUP_DB"; STEP_ERR=""
backup_before_merge "$CARD" "$NOFILE"; rc=$?
check "corrupt DB: fails, no backup file left" "[ $rc -ne 0 ] && [ -n \"\$STEP_ERR\" ] && [ \"\$(baks)\" = 0 ]"
fresh_db; STEP_ERR=""; OLDPATH="$PATH"; mkdir -p "$T/nobin"; for c in date ls grep sort awk sed tr cut cat dirname basename printf rm tail; do ln -sf "$(command -v $c)" "$T/nobin/$c" 2>/dev/null; done
PATH="$T/nobin"; backup_before_merge "$CARD" "$NOFILE"; rc=$?; PATH="$OLDPATH"
check "no sqlite3: fails with a reason, no backup" "[ $rc -ne 0 ] && printf '%s' \"\$STEP_ERR\" | grep -q sqlite3 && [ \"\$(baks)\" = 0 ]"

# agent-step wiring: one helper, called before the merge, failure -> OWNER question, no commit
S="$BIN/agent-step"
check "agent-step: backup runs before the squash merge in squash_merge" "[ \"\$(grep -n 'backup_before_merge' '$S' | head -1 | cut -d: -f1)\" -lt \"\$(grep -n 'git merge -q --squash' '$S' | head -1 | cut -d: -f1)\" ]"
check "agent-step: backup failure ends in an OWNER question" "grep -q 'backup_before_merge .*question \"OWNER: DB backup before merging \$br failed: \$STEP_ERR\"' '$S'"
check "agent-step: QA and audit merges both go through squash_merge, no other merge call" "[ \"\$(grep -c 'squash_merge \"\$BR\"' '$S')\" = 2 ] && [ \"\$(grep -c 'git merge -q --squash' '$S')\" = 1 ]"
check "agent-step: note goes into the commit message and both summaries" "grep -q 'squash of \$br)\${BACKUP_NOTE' '$S' && [ \"\$(grep -c 'merged \$BR\${BACKUP_NOTE' '$S')\" = 2 ]"
check "step-git: only .backup and PRAGMA integrity_check touch the DB" "! grep -E 'sqlite3' '$BIN/step-git.sh' | grep -vE 'command -v|\\.backup|integrity_check|^#' | grep -q ."

echo "$pass passed, $failn failed"
[ "$failn" -eq 0 ]
