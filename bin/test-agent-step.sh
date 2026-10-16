#!/usr/bin/env bash
# Tests the git logic of bin/agent-step (bin/step-git.sh) in a throwaway repo with a bare "origin" under mktemp -d.
# Never touches the real repo, the network or GitHub.
set -uo pipefail
BIN="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pass=0; failn=0
ok()  { echo "PASS: $1"; pass=$((pass+1)); }
bad() { echo "FAIL: $1"; failn=$((failn+1)); }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }

T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.invalid GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.invalid
log() { :; }
. "$BIN/step-git.sh"

fresh() { # new bare origin + working clone "w" (main checkout) + second clone "o" (someone else), all with one commit
  rm -rf "$T/origin.git" "$T/w" "$T/o"
  git init -q --bare -b main "$T/origin.git"
  git clone -q "$T/origin.git" "$T/w" 2>/dev/null; cd "$T/w" || exit 1
  git checkout -q -b main 2>/dev/null
  mkdir -p docs/research docs/audits src
  printf 'a\n' > docs/decisions.md; printf 'r\n' > docs/research/q.md; printf 'x\n' > src/code.txt
  git add -A; git commit -q -m init; git push -q origin main
  git clone -q "$T/origin.git" "$T/o" 2>/dev/null
}
other_push() { ( cd "$T/o" && git pull -q --ff-only origin main && "$@" && git add -A && git commit -q -m other && git push -q origin main ); }
prep() { # role: the main_ready sequence of agent-step, without the push-main call
  ROLE="$1"; ID=t_test; DOCS_COMMITTED=0; STEP_ERR=""
  stash_foreign && commit_docs && { git fetch -q origin main; sync_main; }
}

# 1. PM: edit to an existing docs file + a new docs file are committed; a non-doc edit is stashed
fresh
echo "pm edit" >> docs/decisions.md; echo new > docs/new.md; echo "owner" >> src/code.txt
prep pm; rc=$?
check "pm: prep succeeds" "[ $rc -eq 0 ]"
check "pm: edit to an existing docs file is in the docs commit" "git show --stat --format=%s HEAD | grep -q 'docs/decisions.md'"
check "pm: new docs file is in the docs commit" "git show --stat HEAD | grep -q 'docs/new.md'"
check "pm: commit message names role and task" "[ \"\$(git log -1 --format=%s)\" = 'docs(pm): t_test' ]"
check "pm: non-doc edit is stashed (message unchanged)" "[ \"\$(git stash list | wc -l | tr -d ' ')\" = 1 ] && git stash list | grep -q \"agent-step t_test: owner's uncommitted changes\""
check "pm: working tree has no tracked changes left" "[ -z \"\$(git status --porcelain --untracked-files=no)\" ] && [ \"\$(cat src/code.txt)\" = x ]"

# 2. PM: main moved while the agent ran; the docs commit is rebased, edits survive
fresh
echo "pm edit" >> docs/decisions.md
other_push sh -c 'echo o > docs/other.md'
prep pm; rc=$?
check "pm: rebases onto a moved origin/main" "[ $rc -eq 0 ] && [ -f docs/other.md ] && grep -q 'pm edit' docs/decisions.md"
check "pm: only the docs commit is ahead of origin" "[ \"\$(git rev-list origin/main..main | wc -l | tr -d ' ')\" = 1 ]"

# 3. PM: conflicting pull -> failure, the edit is still in a commit, no rebase left half-done, nothing only in a stash
fresh
echo "pm edit" >> docs/decisions.md
other_push sh -c 'echo "other edit" >> docs/decisions.md'
prep pm; rc=$?
check "pm conflict: prep fails with a reason" "[ $rc -ne 0 ] && [ -n \"\$STEP_ERR\" ]"
check "pm conflict: edit is still in a local commit" "git log origin/main..main --format=%s | grep -q 'docs(pm): t_test' && git show main:docs/decisions.md | grep -q 'pm edit'"
check "pm conflict: no rebase in progress, clean tree, empty stash" "[ ! -d .git/rebase-merge ] && [ ! -d .git/rebase-apply ] && [ -z \"\$(git status --porcelain --untracked-files=no)\" ] && [ -z \"\$(git stash list)\" ]"

# 4. researcher: docs/research is committed, other docs and code are stashed
fresh
echo "res" >> docs/research/q.md; echo n > docs/research/new.md; echo "pm-ish" >> docs/decisions.md; echo "owner" >> src/code.txt
prep researcher; rc=$?
check "researcher: prep succeeds" "[ $rc -eq 0 ]"
check "researcher: research edits are committed" "git show --stat HEAD | grep -q 'docs/research/q.md' && git show --stat HEAD | grep -q 'docs/research/new.md'"
check "researcher: docs outside research are not committed" "! git show --stat HEAD | grep -q 'docs/decisions.md'"
check "researcher: other modified tracked files are stashed" "[ \"\$(git stash list | wc -l | tr -d ' ')\" = 1 ] && [ \"\$(cat docs/decisions.md)\" = a ] && [ \"\$(cat src/code.txt)\" = x ]"

# 5. qa/auditor (no docs path): everything modified is stashed, nothing is committed
fresh
echo "docs" >> docs/decisions.md; echo "owner" >> src/code.txt
prep qa; rc=$?
check "qa: all modified tracked files are stashed, no commit" "[ $rc -eq 0 ] && [ \"\$(git stash list | wc -l | tr -d ' ')\" = 1 ] && [ -z \"\$(git rev-list origin/main..main)\" ] && [ \"\$(cat docs/decisions.md)\" = a ]"

# 6. audit tags
audit() { # verdict number title -> runs record_audit with a fake report
  ROLE=auditor; ID=t_audit; printf 'report\n' > "$T/rep.md"; record_audit "$1" "$2" "$3" "$T/rep.md"; }
fresh
git tag audit-1; OLD="$(git rev-parse audit-1)"
echo more >> docs/decisions.md; git commit -q -am more
audit PASS 1 "Batch audit #1"
check "tag: existing audit-1 is not moved" "[ \"\$(git rev-parse audit-1)\" = '$OLD' ]"
check "tag: next free number is used and reported" "[ \"\$AUDIT_TAG\" = audit-2 ] && [ \"\$(git rev-parse audit-2)\" = \"\$(git rev-parse HEAD)\" ]"
check "tag: report name follows the tag number" "[ \"\$AUDIT_REPORT\" = docs/audits/batch-2.md ] && [ -f docs/audits/batch-2.md ]"
echo "more2" >> docs/decisions.md; git commit -q -am more2
audit PASS 1 "Batch audit #1"
check "tag: second collision goes to audit-3, earlier tags untouched" "[ \"\$AUDIT_TAG\" = audit-3 ] && [ \"\$(git rev-parse audit-1)\" = '$OLD' ] && [ \"\$(git rev-parse audit-2)\" != \"\$(git rev-parse audit-3)\" ]"
check "report: existing report file is never overwritten" "[ \"\$(git log --format=%s -- docs/audits/batch-2.md | wc -l | tr -d ' ')\" = 1 ] && [ -f docs/audits/batch-3.md ]"

# a tag that exists only on origin counts too
fresh
( cd "$T/o" && git tag audit-5 && git push -q origin audit-5 )
audit PASS 5 "Phase 2 audit #5"
check "tag: a tag that exists only on origin is not reused" "[ \"\$AUDIT_TAG\" = audit-6 ] && [ \"\$AUDIT_REPORT\" = docs/audits/phase-6.md ]"

# a report file that exists forces the next number even without a tag
fresh
printf 'old\n' > docs/audits/batch-4.md; git add -A; git commit -q -m old
audit PASS 4 "Batch audit #4"
check "report: existing file for the number moves the tag to the next free number" "[ \"\$AUDIT_TAG\" = audit-5 ] && [ \"\$(cat docs/audits/batch-4.md)\" = old ] && [ -f docs/audits/batch-5.md ]"

# FAIL: report committed, no tag
fresh
audit FAIL 7 "Batch audit #7"
check "FAIL audit sets no tag" "[ -z \"\$AUDIT_TAG\" ] && [ -z \"\$(git tag -l 'audit-*')\" ]"
check "FAIL audit still commits its report" "[ -f docs/audits/batch-7.md ] && git log -1 --format=%s | grep -q 'audit report (t_audit)'"

# no number in the title: report named by task id, no tag, nothing else
fresh
audit PASS "" "Audit of something"
check "no number in title: no tag, report named by task id" "[ -z \"\$AUDIT_TAG\" ] && [ -f docs/audits/batch-t_audit.md ]"

# the real agent-step no longer uses tag -f or a plain 'git add docs'
check "agent-step has no 'git tag -f'" "! grep -q 'git tag -f' '$BIN/agent-step' '$BIN/step-git.sh'"

echo "$pass passed, $failn failed"
[ "$failn" -eq 0 ]
