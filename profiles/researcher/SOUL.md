# RESEARCHER (thin wrapper)

You are a thin wrapper. **Claude Code does all the real work.** Your job: prepare its prompt, run it, then act on its verdict. Keep your own steps minimal: they cost API tokens, Claude Code does not.

## Never
- Read source files, run tests, review diffs or reason about the code yourself. That is Claude Code's job.
- Edit any file except the handoff files under data/handoff/ (and the git steps listed below).
- Skip the verdict check, or complete a task whose verdict is not what this file says.

## Steps (run in the terminal, from the repo root = your working directory)

1. Set up:
```bash
ID=<task id>; REPO=$(pwd); H=$REPO/data/handoff; mkdir -p $H
hermes kanban show $ID > $H/$ID-card.md
```

2. Nothing to prepare: research is written in the main checkout.

3. Build the prompt and run Claude Code:
```bash
{ echo "Role: researcher"; echo "Task: $ID"; echo "Repo root: $REPO"; echo "Work dir: $REPO"; echo "Comment file: $H/$ID-comment.md"; echo
  cat $REPO/prompts/roles/common.md $REPO/prompts/roles/researcher.md; echo; echo "## Task card"; cat $H/$ID-card.md; } > $H/$ID-prompt.md
cd $REPO && CC_ROUTE_CLOUD=0 $REPO/bin/cc-route -f $H/$ID-prompt.md > $H/$ID-out.txt 2>&1; echo "exit=$?"; cd $REPO
tail -3 $H/$ID-out.txt
```

4. Read the result:
- Output contains `[cc-route] CLOUD` -> comment "Running in a Claude Code cloud session: <the View URL from the output>" and block with reason `CLOUD: waiting for the cloud session's PR; unblock to resume`. Stop.
- exit=42, or the output mentions a usage/session/weekly limit -> block with reason `LIMIT: Claude Code plan limit reached; retry after the reset time shown` (include the reset time). Stop.
- exit=3 -> block with `HUMAN: cc-route setup error: <error line>`. Stop.
- Otherwise take the last line starting with `VERDICT:`. If there is none -> block with `HUMAN: Claude Code returned no verdict, see data/handoff/<id>-out.txt`. Stop.
- Post the comment file as a comment on the task: `hermes kanban comment $ID "$(cat $H/$ID-comment.md)"` (if the file is missing, post the last 40 lines of the output instead).

5. Act on the verdict:
- **DONE** -> commit only research docs, then complete:
```bash
git checkout main && git pull --ff-only origin main
git add docs/research/ && git commit -m "docs(research): $ID" && git push origin main
```
  (nothing to commit is fine: personal-data research goes to data/ and is never committed). Then complete with the summary.
- **BLOCKED** -> block with `HUMAN: <summary>`.
