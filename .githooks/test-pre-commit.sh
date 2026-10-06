#!/usr/bin/env bash
# Tests .githooks/pre-commit in a throwaway repo (never touches the real config/).
set -uo pipefail
HOOK_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/pre-commit"
FAKE="FAKE-PERSONA-7731"
T=$(mktemp -d "${TMPDIR:-/tmp}/hooktest.XXXXXX")
trap 'cd /; rm -r "$T"' EXIT
pass=0; failn=0
ok()  { echo "PASS: $1"; pass=$((pass+1)); }
bad() { echo "FAIL: $1"; failn=$((failn+1)); }

export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.invalid
export GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.invalid

R="$T/repo"
mkdir -p "$R" && cd "$R" && git init -q -b main
mkdir -p .githooks config
cp "$HOOK_SRC" .githooks/pre-commit && chmod +x .githooks/pre-commit
git config core.hooksPath .githooks
printf '# fake patterns\n%s\n' "$FAKE" > config/private-patterns.txt
printf '/config/*\n!/config/*.example.*\n' > .gitignore
git add .gitignore .githooks && git commit -q -m init
git worktree add -q "$T/wt" -b feature
OUT="$T/out"

try_commit() { git commit -q -m "$1" >"$OUT" 2>&1; }

# (a) main checkout, fake string -> blocked
echo "leak $FAKE here" > a.txt; git add a.txt
if try_commit a; then bad "(a) main checkout leak committed"; else ok "(a) main checkout leak blocked"; fi
if grep -q "$FAKE" "$OUT"; then bad "(f) fake string printed in (a)"; else ok "(f) fake string not in output (a)"; fi
git reset -q; rm -f a.txt

cd "$T/wt" || exit 2
# (b) worktree, fake string -> blocked
echo "leak $FAKE here" > b.txt; git add b.txt
if try_commit b; then bad "(b) worktree leak committed"; else ok "(b) worktree leak blocked"; fi
if grep -q "$FAKE" "$OUT"; then bad "(f) fake string printed in (b)"; else ok "(f) fake string not in output (b)"; fi
if grep -q "b.txt" "$OUT"; then ok "(b) output names staged file"; else bad "(b) output lacks staged file name"; fi
git reset -q; rm -f b.txt

# (c) config/ files
mkdir -p config; echo "x: 1" > config/x.yaml; git add -f config/x.yaml
if try_commit c1; then bad "(c) config/x.yaml committed"; else ok "(c) config/x.yaml blocked"; fi
git reset -q; rm -f config/x.yaml
echo "x: 1" > config/foo.example.yaml; git add config/foo.example.yaml
if try_commit c2; then ok "(c) config/foo.example.yaml allowed"; else bad "(c) example yaml blocked: $(cat "$OUT")"; fi

# (d) clean change in worktree
echo "hello" > d.txt; git add d.txt
if try_commit d; then ok "(d) clean worktree commit succeeds"; else bad "(d) clean commit failed: $(cat "$OUT")"; fi

# (g) check 1: each private path class is blocked (incl. non-ASCII config/ and data/ names)
mkdir -p config data
for n in config/salary.yaml data/x.json .env a.db "config/café.yaml" "data/é.json"; do
  echo "x" > "$n"; git add -f -- "$n"
  if try_commit g; then bad "(g) $n committed"; else
    if grep -q "BLOCKED: private files staged" "$OUT"; then ok "(g) $n blocked"; else bad "(g) $n blocked by wrong check"; fi
  fi
  git reset -q; rm -f -- "$n"
done

# (g2) check 1: typechange under data/ (symlink -> regular file) is blocked
mkdir -p data; ln -s a.txt data/t.json; git add -f data/t.json
git -c core.hooksPath=/dev/null commit -q -m seed-symlink
rm data/t.json; echo x > data/t.json; git add -f data/t.json
if git diff --cached --name-status | grep -q '^T'; then ok "(g2) staged change is a typechange"; else bad "(g2) not a typechange"; fi
if try_commit g2; then bad "(g2) data/ typechange committed"; else
  if grep -q "BLOCKED: private files staged" "$OUT"; then ok "(g2) data/ typechange blocked"; else bad "(g2) blocked by wrong check"; fi
fi
git reset -q; git rm -q -f --cached data/t.json; git -c core.hooksPath=/dev/null commit -q -m drop-symlink; rm -f data/t.json

# (h) non-ASCII file name containing the fake string, in a worktree
printf 'leak %s\n' "$FAKE" > "café.txt"; git add "café.txt"
if try_commit h; then bad "(h) café.txt leak committed"; else ok "(h) café.txt leak blocked"; fi
if grep -q "$FAKE" "$OUT"; then bad "(f) fake string printed in (h)"; else ok "(f) fake string not in output (h)"; fi
git reset -q; rm -f "café.txt"

# (i) file name containing a double quote
printf 'leak %s\n' "$FAKE" > 'q"uote.txt'; git add 'q"uote.txt'
if try_commit i; then bad "(i) quote-name leak committed"; else ok "(i) quote-name leak blocked"; fi
git reset -q; rm -f 'q"uote.txt'

# (j) fake string on line 1 of a >=200KB file
{ printf 'leak %s\n' "$FAKE"; head -c 200000 /dev/zero | tr '\0' 'a'; echo; } > big.txt
git add big.txt
if try_commit j; then bad "(j) large-file leak committed"; else ok "(j) large-file leak blocked"; fi
git reset -q; rm -f big.txt

# (k) check 2 gaps: modified file, typechange, lowercase, no trailing newline, pathspec magic
echo "base" > m.txt; git add m.txt; git commit -q -m base-m
echo "leak $FAKE" >> m.txt; git add m.txt
if try_commit k1; then bad "(k1) modified-file leak committed"; else ok "(k1) modified-file leak blocked"; fi
git reset -q; git checkout -q -- m.txt

ln -s m.txt tc.txt; git add tc.txt; git commit -q -m base-tc
rm tc.txt; printf 'leak %s\n' "$FAKE" > tc.txt; git add tc.txt
if git diff --cached --name-status | grep -q '^T'; then ok "(k2) staged change is a typechange"; else bad "(k2) not a typechange"; fi
if try_commit k2; then bad "(k2) typechange leak committed"; else ok "(k2) typechange leak blocked"; fi
git reset -q; git checkout -q -- tc.txt

printf 'leak %s\n' "$(echo "$FAKE" | tr 'A-Z' 'a-z')" > lc.txt; git add lc.txt
if try_commit k3; then bad "(k3) lowercase leak committed"; else ok "(k3) lowercase leak blocked"; fi
git reset -q; rm -f lc.txt

printf '# fake patterns\n%s' "$FAKE" > "$R/config/private-patterns.txt"
printf 'leak %s\n' "$FAKE" > nn.txt; git add nn.txt
if try_commit k4; then bad "(k4) no-trailing-newline pattern missed leak"; else ok "(k4) no-trailing-newline pattern blocked leak"; fi
git reset -q; rm -f nn.txt
printf '# fake patterns\n%s\n' "$FAKE" > "$R/config/private-patterns.txt"

printf 'leak %s\n' "$FAKE" > ':(exclude)z.txt'; GIT_LITERAL_PATHSPECS=1 git add -- ':(exclude)z.txt'
if try_commit k5; then bad "(k5) pathspec-magic name leak committed"; else ok "(k5) pathspec-magic name leak blocked"; fi
if grep -q "$FAKE" "$OUT"; then bad "(f) fake string printed in (k5)"; else ok "(f) fake string not in output (k5)"; fi
git reset -q; rm -f ':(exclude)z.txt'

# (k6) name that is pathspec magic excluding itself: without literal pathspecs the diff is empty
printf 'leak %s\n' "$FAKE" > ':(exclude)*'; GIT_LITERAL_PATHSPECS=1 git add -- ':(exclude)*'
if [ "$(git diff --cached --name-only | wc -l)" -eq 1 ]; then ok "(k6) magic-named file is staged"; else bad "(k6) magic-named file not staged"; fi
if try_commit k6; then bad "(k6) self-excluding magic name leak committed"; else ok "(k6) self-excluding magic name leak blocked"; fi
git reset -q; rm -f ':(exclude)*'

# (e) patterns file absent
rm -f "$R/config/private-patterns.txt"
echo "more" > e.txt; git add e.txt
if try_commit e; then ok "(e) commit succeeds without patterns file"; else bad "(e) commit failed: $(cat "$OUT")"; fi
if grep -q "^WARNING: .*private-patterns.txt not found, private-string check skipped$" "$OUT"; then
  ok "(e) WARNING printed"; else bad "(e) WARNING missing"; fi

echo "---- $pass passed, $failn failed"
[ "$failn" -eq 0 ]
