#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# deploy/test-deploy.sh — deploy/deploy.sh against a host played by a stub (SIGELO_SSH), on a copy
# of this relay's files committed in a scratch repository. npm and every node script are
# stubbed (the suites deploy.sh runs are tested on their own; `npm ci` writes one stand-in
# dependency); `node -e` runs for real. Checks:
#   - a package-lock.json entry without its sha512 integrity: refused, the entry named, nothing sent;
#   - the host reports another code sha256 than the one staged: rolled back, then refused;
#   - the host reports the staged code sha256 and another deps sha256 (node_modules changed in the
#     stage after the upload): rolled back, then refused;
#   - the rollback fails too: refused, saying the release is still live;
#   - the host reports both staged sha256s: deployed, no rollback, and the host was asked to
#     install nothing (the dependencies go up with the stage).
#   sh deploy/test-deploy.sh   → ALL PASS (n)
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/sigelo-test-deploy.XXXXXX")
trap 'rm -rf "$work"' EXIT
n=0; failed=0
ok() { n=$((n + 1)); if [ "$1" = 0 ]; then echo "ok $2"; else failed=$((failed + 1)); echo "FAIL $2"; fi; }

# The release: this relay's files (not node_modules, site/dist or .git), its build output stood in
# for, in a repository of its own.
repo=$work/relay; mkdir "$repo"
(cd "$here" && find . \( -path ./node_modules -o -path ./site/dist -o -path ./.git \) -prune -o -type f -print) | while IFS= read -r f; do
  mkdir -p "$repo/$(dirname "$f")"; cp "$here/$f" "$repo/$f"
done
mkdir -p "$repo/node_modules" "$repo/site/dist"
echo '<h1>stand-in</h1>' > "$repo/site/dist/index.html"
printf 'node_modules/\ndist/\n' > "$repo/.gitignore"
lock() {  # a lockfile whose one package carries the integrity $1 ("" = none)
  printf '{"name":"sigelo-relay","lockfileVersion":3,"packages":{"":{"name":"sigelo-relay"},"node_modules/x":{"version":"1.0.0","resolved":"https://registry.npmjs.org/x/-/x-1.0.0.tgz"%s}}}\n' \
    "${1:+,\"integrity\":\"$1\"}" > "$repo/package-lock.json"
  git -C "$repo" -c user.name=test -c user.email=test@example.invalid add -A
  git -C "$repo" -c user.name=test -c user.email=test@example.invalid commit -qm "lockfile" --allow-empty
}
git -C "$repo" init -q

# The stubs: npm and node scripts succeed; the host answers as HOSTHASH, HOSTDEPS and ROLLBACK_RC
# say and logs each command it is sent.
bin=$work/bin; mkdir "$bin"
real=$(command -v node)
printf '#!/bin/sh\ncase "$1" in -e) exec "%s" "$@" ;; *) exit 0 ;; esac\n' "$real" > "$bin/node"
printf '#!/bin/sh\ncase "$1" in ci) mkdir -p node_modules/x && echo "stand-in" > node_modules/x/index.js ;; esac\nexit 0\n' > "$bin/npm"
cat > "$bin/host" <<'HOST'
#!/bin/sh
shift
echo "$*" >> "$LOG"
case "$*" in
  "command -v rsync"*) exit 1 ;;
  *"tar -xf -"*) cat > /dev/null ;;
  *--rollback*) echo "[sigelo-relay-apply] rolled back: code sha256 0000 deps sha256 0000"; exit "${ROLLBACK_RC:-0}" ;;
  *sigelo-relay-apply*) echo "[sigelo-relay-apply] installed: code sha256 $HOSTHASH deps sha256 $HOSTDEPS" ;;
esac
exit 0
HOST
chmod 0755 "$bin/node" "$bin/npm" "$bin/host"
# deploy HOSTHASH ROLLBACK_RC [HOSTDEPS] → the run's output in $work/out, its exit status in $rc,
# the host's log in $work/log
deploy() {
  : > "$work/log"
  rc=0
  LOG=$work/log HOSTHASH=$1 ROLLBACK_RC=$2 HOSTDEPS=${3:-0000} SIGELO_SSH=$bin/host PATH="$bin:$PATH" sh "$repo/deploy/deploy.sh" --target test-host > "$work/out" 2>&1 || rc=$?
}
has() { grep -qF -- "$2" "$1"; }
# From here a failing test is counted, not the end of the run.
set +e

lock ""
deploy 0000 0
has "$work/out" "node_modules/x has no resolved https://registry.npmjs.org/… with a sha512 integrity"; named=$?
[ "$rc" != 0 ] && [ "$named" = 0 ] && [ ! -s "$work/log" ]; ok $? "an entry without its integrity: refused, the entry named, nothing sent to the host"

lock "sha512-$(printf '%086d' 0 | tr 0 A)=="
deploy 0000 0
staged=$(sed -n 's/^+ code sha256 //p' "$work/out")
stagedDeps=$(sed -n 's/^+ deps sha256 //p' "$work/out")
has "$work/log" "sigelo-relay-apply --rollback"; back=$?
has "$work/out" "rolled back to the previous release"; said=$?
[ "$rc" != 0 ] && [ -n "$staged" ] && [ "$back" = 0 ] && [ "$said" = 0 ]; ok $? "the host reports another code sha256: the release is rolled back, then deploy.sh fails"

deploy "$staged" 0 0000
has "$work/log" "sigelo-relay-apply --rollback"; back=$?
has "$work/out" "rolled back to the previous release"; said=$?
[ "$rc" != 0 ] && [ -n "$stagedDeps" ] && [ "$back" = 0 ] && [ "$said" = 0 ]; ok $? "the host reports the staged code sha256 and another deps sha256: the release is rolled back, then deploy.sh fails"

deploy 0000 1
has "$work/out" "rolling back failed"; said=$?
[ "$rc" != 0 ] && [ "$said" = 0 ]; ok $? "the rollback fails too: deploy.sh fails, saying the release is still live"

deploy "$staged" 0 "$stagedDeps"
has "$work/log" "--rollback"; back=$?
has "$work/out" "deploy.sh: deployed"; done=$?
has "$work/log" "npm"; fetched=$?
[ "$rc" = 0 ] && [ "$back" != 0 ] && [ "$done" = 0 ] && [ "$fetched" != 0 ]; ok $? "the host reports both staged sha256s: deployed, nothing rolled back, and the host was asked to install nothing"

if [ "$failed" = 0 ]; then echo "ALL PASS ($n)"; else echo "$failed FAILED of $n"; exit 1; fi
