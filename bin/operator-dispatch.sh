#!/usr/bin/env bash
# Operator batch triggers, kept in functions so bin/test-operator-dispatch.sh can run them with a stubbed hk.
# Sourced, never executed. Needs from the caller: REPO, STATE, the OPERATOR_* settings, log(), hk(), board(), title_of().
# The clock is OPERATOR_NOW ("YYYY-MM-DD HH:MM") when set (tests), else the local time.

op_clock() { printf '%s' "${OPERATOR_NOW:-$(date '+%F %H:%M')}"; }
op_minutes() { local h="${1%%:*}" m="${1##*:}"; echo $(( 10#$h * 60 + 10#$m )); }   # HH:MM -> minutes
op_in_window() { local t m; t="$(op_clock)"; m="$(op_minutes "${t##* }")"
  [ "$m" -ge "$(op_minutes "$OPERATOR_WINDOW_START")" ] && [ "$m" -lt "$(op_minutes "$OPERATOR_WINDOW_END")" ]; }

# Record a merge as a trigger when the merged commit ($1, default HEAD, the squash commit) touches an OPERATOR_PATHS prefix.
# $2 = the dev card id. The trigger waits in $STATE/operator-pending until op_tick turns it into a card or a comment.
operator_note_merge() {
  local c="${1:-HEAD}" id="$2" f p hit=""
  [ -n "$id" ] || return 0
  for f in $(git diff-tree --no-commit-id --name-only -r "$c" 2>/dev/null); do
    for p in $OPERATOR_PATHS; do case "$f" in "$p"*) hit="$f"; break 2 ;; esac; done
  done
  [ -n "$hit" ] || return 0
  grep -qx "$id" "$STATE/operator-pending" 2>/dev/null || echo "$id" >> "$STATE/operator-pending"
  log "operator trigger: $id touched $hit"
}

# The operator card that is still going (todo, ready, running, anything but done / archived / blocked), if any.
# A blocked batch is not open: it waits for a human or the Doctor, so it must not swallow later triggers.
operator_open_card() { local id st role
  while read -r id st role; do
    [ "$role" = operator ] || continue
    case "$st" in done|archived|blocked) ;; *) echo "$id"; return 0 ;; esac
  done <<EOT
$(board)
EOT
  return 1; }

# The blocked operator cards, one id per line.
operator_blocked_cards() { local id st role
  while read -r id st role; do [ "$role" = operator ] && [ "$st" = blocked ] && echo "$id"; done <<EOT
$(board)
EOT
  return 0; }

op_epoch() { printf '%s' "${OPERATOR_EPOCH:-$(date +%s)}"; }

# Blocked operator batches older than OPERATOR_BLOCKED_MINUTES (default 30) are listed in operator-summary.md under
# "[OWNER] holds", so the owner sees them (NEEDS-ZEIN lists only [OWNER] holds). The first time a card is seen blocked is kept
# in $STATE/operator-blocked/<id>; the block in the summary file is rebuilt every pass and dropped when nothing is overdue.
op_report_blocked() {
  local dir="$STATE/operator-blocked" out="$STATE/operator-summary.md" lim="${OPERATOR_BLOCKED_MINUTES:-30}" now id since f tmp blocked lines=""
  hk list >/dev/null 2>&1 || return 0
  mkdir -p "$dir"; now="$(op_epoch)"; blocked="$(operator_blocked_cards)"
  for f in "$dir"/t_*; do [ -e "$f" ] || continue; printf '%s\n' "$blocked" | grep -qx "$(basename "$f")" || rm -f "$f"; done
  for id in $blocked; do
    [ -s "$dir/$id" ] || echo "$now" > "$dir/$id"
    since="$(cat "$dir/$id")"
    if [ $(( (now - since) / 60 )) -gt "$lim" ]; then
      lines="$lines- $id: operator batch blocked for $(( (now - since) / 60 )) min
"
    fi
  done
  tmp="$(mktemp "$STATE/.summary.XXXXXX")" || return 0
  [ -f "$out" ] && awk '/^<!-- blocked-batches -->$/{f=1;next} /^<!-- \/blocked-batches -->$/{f=0;next} !f' "$out" > "$tmp"
  [ -n "$lines" ] && printf '<!-- blocked-batches -->\n[OWNER] holds (blocked operator batches):\n%s<!-- /blocked-batches -->\n' "$lines" >> "$tmp"
  if [ -s "$tmp" ]; then mv "$tmp" "$out"; else rm -f "$tmp" "$out"; fi
}

# Put consumed triggers ($1 = the processing file) back at the end of operator-pending.
op_restore() { cat "$1" >> "$STATE/operator-pending"; rm -f "$1"; }

# One pass: create at most one batch card, or turn the triggers into a comment on the open one.
# Outside the window nothing happens and the triggers stay pending (deferred, not dropped).
op_tick() {
  local clk day hm pend proc open ids title new id daily=0 body="$STATE/notes/operator-batch-body.md" blocked old
  op_report_blocked
  op_in_window || return 0
  clk="$(op_clock)"; day="${clk%% *}"; hm="${clk##* }"
  if [ "$(cat "$STATE/operator-daily" 2>/dev/null)" != "$day" ] && [ "$(op_minutes "$hm")" -ge "$(op_minutes "$OPERATOR_DAILY_AT")" ]; then daily=1; fi
  [ -s "$STATE/operator-pending" ] || [ "$daily" = 1 ] || return 0
  hk list >/dev/null 2>&1 || return 0     # board unreadable: an empty list must never look like "no open card"
  open="$(operator_open_card)"
  # Consume the triggers atomically: rename first, so a merge landing during the slow hk calls below appends to a fresh
  # operator-pending instead of being truncated away. On failure the consumed ids go back (appended, never overwritten).
  proc="$(mktemp "$STATE/.operator-processing.XXXXXX")" || return 0
  mv -f "$STATE/operator-pending" "$proc" 2>/dev/null || : > "$proc"
  pend="$(cat "$proc")"
  if [ -n "$open" ]; then      # never two: the trigger becomes a comment on the open card
    hk comment "$open" "Operator trigger while this batch is open ($clk):$([ -n "$pend" ] && printf ' merged %s' "$(printf '%s' "$pend" | tr '\n' ' ')")$([ "$daily" = 1 ] && printf ' daily batch'). No new card." >/dev/null || { op_restore "$proc"; return 0; }
    rm -f "$proc"; [ "$daily" = 1 ] && echo "$day" > "$STATE/operator-daily"
    log "operator trigger coalesced into $open"; return 0
  fi
  blocked="$(operator_blocked_cards)"
  ids="$(printf '%s' "$pend" | tr '\n' ' ' | sed 's/ *$//; s/ /, /g')"
  if [ -n "$ids" ]; then title="Operator batch $clk (after $ids)"; else title="Operator batch $clk (daily)"; fi
  {
    echo "**Risk:** high"
    echo "Operator batch started by the dispatcher at $clk. The batch id is this card's id."
    if [ -n "$pend" ]; then
      echo; echo "Merged cards that touched the dry-run code (re-run their postings first, step b of the loop):"
      for id in $pend; do echo "- $id: $(title_of "$id")"; done
    fi
    for old in $blocked; do
      echo; echo "Merged cards from the blocked batch $old (superseded by this one, re-run them too):"
      body_of "$old" | grep -E '^- t_[0-9a-f]+:' || echo "- (none listed)"
    done
    [ "$daily" = 1 ] && { echo; echo "Daily trigger ($OPERATOR_DAILY_AT)."; }
    echo; echo "Follow prompts/roles/operator.md; end the report with the '## Owner summary' section."
  } > "$body"
  new="$(hk create "$title" --assignee operator --workspace "dir:$REPO" --priority 5 --body-file "$body" | grep -oE 't_[0-9a-f]+' | head -1)"
  if [ -n "$new" ]; then
    rm -f "$proc"; echo "$day" > "$STATE/operator-daily"; log "created operator batch card $new ($title)"
    for old in $blocked; do
      hk comment "$old" "superseded by $new" >/dev/null && hk complete "$old" --summary "superseded by $new" >/dev/null && rm -f "$STATE/operator-blocked/$old"
    done
  else op_restore "$proc"; log "could not create the operator batch card ($title): will retry"; fi
}

# Copy the "## Owner summary" section of a comment file ($1) to $STATE/operator-summary.md (overwritten each batch).
# When the comment file is missing, the wrapper's fallback file next to it (<card>-fallback.md) is used, and the summary says so.
# With neither file the summary says so, with the card id. Never silent.
copy_owner_summary() { local out="$STATE/operator-summary.md" tmp src="$1" note="" id fb
  id="$(basename "$1" -comment.md)"; fb="${1%-comment.md}-fallback.md"
  if [ ! -s "$src" ] && [ -s "$fb" ]; then src="$fb"; note="(taken from $(basename "$fb"): no comment file for $id)"; fi
  tmp="$(mktemp "$STATE/.summary.XXXXXX")" || return 1
  [ -s "$src" ] && awk '/^## Owner summary[[:space:]]*$/{f=1;print;next} f&&/^## /{f=0} f' "$src" 2>/dev/null | head -c 4000 > "$tmp"
  if [ -s "$tmp" ]; then [ -z "$note" ] || printf '%s\n' "$note" >> "$tmp"
  elif [ -s "$src" ]; then printf '## Owner summary\nNo owner summary in the last batch report (%s).\n' "$(basename "$src")" > "$tmp"
  else printf '## Owner summary\nNo batch report for %s (no comment file, no fallback file).\n' "$id" > "$tmp"; fi
  mv "$tmp" "$out"; }
