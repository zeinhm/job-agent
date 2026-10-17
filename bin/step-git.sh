#!/usr/bin/env bash
# Git logic of bin/agent-step, kept in functions so bin/test-agent-step.sh can run them in a throwaway repo.
# Sourced, never executed. Needs from the caller: ROLE, ID, log(). Functions return non-zero on failure and
# put the reason in STEP_ERR; the caller turns that into an ACTION: question.

# The docs path a role may commit (empty: the role commits no docs).
docs_prefix() { case "$ROLE" in pm) echo docs ;; researcher) echo docs/research ;; esac; }

# Stash modified tracked files, except the role's docs path (those are committed by commit_docs, never stashed).
stash_foreign() {
  local p; p="$(docs_prefix)"
  set -- .; [ -n "$p" ] && set -- . ":(exclude)$p"
  [ -n "$(git status --porcelain --untracked-files=no -- "$@")" ] || return 0
  git stash push -q -m "agent-step $ID: owner's uncommitted changes" -- "$@" && log "stashed uncommitted changes in main for $ID (git stash list)"
}

# Commit the role's docs edits (modified tracked and new files). Sets DOCS_COMMITTED=1 when a commit was made.
DOCS_COMMITTED=0
commit_docs() {
  local p; p="$(docs_prefix)"; [ -n "$p" ] || return 0
  git add -- "$p" 2>/dev/null
  git diff --cached --quiet && return 0
  if ! STEP_ERR="$(git commit -q -m "docs($ROLE): $ID" 2>&1)"; then git reset -q; STEP_ERR="the pre-commit hook refused the $ROLE docs: $STEP_ERR"; return 1; fi
  DOCS_COMMITTED=1
}

# Bring local main up to origin/main. After a docs commit this rebases that commit (a plain ff-only pull would fail as
# soon as main moved while the agent ran); a conflict aborts the rebase, so the edits stay in the commit.
sync_main() {
  if [ "$DOCS_COMMITTED" = 1 ]; then
    STEP_ERR="$(git pull -q --rebase origin main 2>&1)" && return 0
    git rebase --abort 2>/dev/null
    STEP_ERR="git pull --rebase of the $ROLE docs commit conflicted; the edits are still in local main (git log origin/main..main): $STEP_ERR"; return 1
  fi
  STEP_ERR="$(git pull -q --ff-only origin main 2>&1)" || { STEP_ERR="git pull on main failed (diverged?): $STEP_ERR"; return 1; }
}

# Does tag audit-$1 exist locally or on origin?
audit_tag_exists() {
  git rev-parse -q --verify "refs/tags/audit-$1" >/dev/null 2>&1 && return 0
  git ls-remote --tags origin "refs/tags/audit-$1" 2>/dev/null | grep -q .
}

# First number >= $1 that has neither an audit tag nor a report docs/audits/$2-<n>.md.
free_audit_number() {
  local n="$1" kind="$2"
  while audit_tag_exists "$n" || [ -e "docs/audits/$kind-$n.md" ]; do n=$((n+1)); done
  echo "$n"
}

# Commit the audit report and, on PASS only, set a new audit tag. Never moves or overwrites anything.
# $1 verdict  $2 number from the card title (may be empty)  $3 title  $4 report file.
# Sets AUDIT_TAG (empty if none) and AUDIT_REPORT (empty if no report).
AUDIT_TAG=""; AUDIT_REPORT=""; LEDGER_NOTE=""

# Remove the ledger rows whose merged commit is an ancestor of $1 and set the "Last audit tag:" line to
# "audit-$2 (<short sha of $1>)". A ledger without the table header is left unchanged (LEDGER_NOTE says so); never deleted.
clear_ledger() {
  local sha="$1" n="$2" f=docs/audit-ledger.md tmp row c short
  LEDGER_NOTE=""
  [ -f "$f" ] || { LEDGER_NOTE="ledger not cleared: $f is missing"; return 0; }
  grep -q '^| Task id |' "$f" || { LEDGER_NOTE="ledger not cleared: $f has no table header (left unchanged)"; return 0; }
  short="$(git rev-parse --short "$sha")"; tmp="$(mktemp)"
  while IFS= read -r row; do
    case "$row" in
      "| Task id |"*|"|---"*) ;;
      "| "*) c="$(printf '%s' "$row" | awk -F'|' '{gsub(/ /,"",$5); print $5}')"
          if [ -n "$c" ] && git merge-base --is-ancestor "$c" "$sha" 2>/dev/null; then continue; fi ;;
      "Last audit tag:"*) row="Last audit tag: audit-$n ($short). Rows merged up to that commit were cleared by the automation." ;;
    esac
    printf '%s\n' "$row"
  done < "$f" > "$tmp"
  cat "$tmp" > "$f"; rm -f "$tmp"
}

record_audit() {
  local verdict="$1" n="$2" title="$3" rep="$4" kind=batch
  AUDIT_TAG=""; AUDIT_REPORT=""; LEDGER_NOTE=""
  case "$title" in *[Pp]hase*) kind=phase ;; esac
  [ -n "$n" ] && n="$(free_audit_number "$n" "$kind")"
  if [ -s "$rep" ]; then
    mkdir -p docs/audits
    AUDIT_REPORT="docs/audits/$kind-${n:-$ID}.md"
    if [ -e "$AUDIT_REPORT" ]; then AUDIT_REPORT=""; else cp "$rep" "$AUDIT_REPORT"; fi
  fi
  git add docs/audits 2>/dev/null
  # PASS with a tag to set: clear the covered ledger rows in the same commit as the report (explicit paths only).
  if [ "$verdict" = PASS ] && [ -n "$n" ]; then
    clear_ledger "$(git rev-parse HEAD)" "$n"
    git add docs/audit-ledger.md 2>/dev/null
  fi
  if ! git diff --cached --quiet; then
    if ! STEP_ERR="$(git commit -q -m "docs: audit report ($ID)" 2>&1)"; then git reset -q; STEP_ERR="the pre-commit hook refused the audit report: $STEP_ERR"; return 1; fi
  fi
  if [ "$verdict" = PASS ] && [ -n "$n" ]; then
    git tag "audit-$n" 2>/dev/null && AUDIT_TAG="audit-$n"
  fi
  return 0
}
