#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# deploy/deploy.sh — test, upload, install and check the relay on its host, in one command.
#
#   deploy/deploy.sh [--target ALIAS] [--dry-run]
#   deploy/deploy.sh --rollback [--target ALIAS] [--dry-run]
#
# Run it from a clone of the relay's own repository (the export `release/publish.sh --relay` makes),
# never from the private tree: what runs on the host is then a commit anyone can read. It
#   1. refuses a dirty tree, a missing node_modules (run `npm ci` once), or a package-lock.json
#      entry without its registry URL and sha512 integrity (npm ci checks a package only against
#      that hash, and step 3 installs what root then runs), runs `npm test` and
#      `node test/allowance.mjs` (allowances, proof of work, operators, licences), the helper's
#      allowlist self-test and its check of deploy/nginx.conf (the host would refuse a config that
#      fails it), the stats chart's self-test (deploy/stats-chart.mjs: R16 of server-setup.sh
#      --relay installs it), builds the front page with `node site/build.mjs --final` (refused while a
#      placeholder is open) and runs `node site/test.mjs`: any failure and nothing is uploaded;
#   2. stages the tracked files of HEAD plus site/dist, installs the dependencies in the stage
#      here (npm ci --omit=dev --ignore-scripts --no-bin-links: each package checked against
#      package-lock.json's sha512, no install script run), refuses a path with a control character
#      (the hash reads paths by line, as the helper's does, and the helper refuses them too), and
#      prints two sha256s, by the helper's algorithm (sha256 of `sha256sum` over every file,
#      sorted): the code (node_modules apart) and the dependencies (node_modules);
#   3. uploads the stage, dependencies included, to /var/lib/sigelo/relay-stage on the host as the
#      deploy user (rsync --delete when both sides have rsync, else tar | ssh). Nothing on the host
#      fetches or installs: what root installs is what was hashed here;
#   4. runs the deploy user's one root command, sudo -n /usr/local/sbin/sigelo-relay-apply (copy
#      root-owned to /opt/sigelo-relay/app, nginx config, restart, roll back if the relay does not
#      come up), and requires both sha256s it logs to be the ones staged here: another code or
#      dependency tree, and the release is rolled back (sigelo-relay-apply --rollback) before
#      deploy.sh stops. The stage is the deploy user's until the helper reads it, so whatever runs
#      as that user meanwhile can change any file of it, node_modules included;
#   5. node deploy/check.mjs: the live checks of sigelo.ai; the exit status is the check's.
#
# --rollback runs sigelo-relay-apply --rollback (the previous release and its nginx config back;
# run it again to roll forward), then the check. --dry-run prints every command and runs none.
# ALIAS (default sigelo-relay-deploy) is an ~/.ssh/config entry for the deploy user `sigelo` on the
# relay host; the host is prepared once by site/deploy/server-setup.sh --relay (in the sigelo
# repository, csigelo/sigelo).
set -eu

STAGE_DIR=/var/lib/sigelo/relay-stage
APPLY=/usr/local/sbin/sigelo-relay-apply

die() { printf 'deploy.sh: %s\n' "$*" >&2; exit 1; }
# lockfile_pinned FILE: each entry under node_modules that is not a link to a local directory
# carries resolved https://registry.npmjs.org/… and a sha512 integrity; the first that does not is
# named. The same rule as release/publish.sh's.
lockfile_pinned() {
  node -e '
    const f = process.argv[1], l = JSON.parse(require("node:fs").readFileSync(f, "utf8"));
    if (!(l.lockfileVersion >= 2) || typeof l.packages !== "object" || l.packages === null) { console.error(`${f}: no "packages" (lockfileVersion 2 or 3)`); process.exit(1); }
    for (const [p, e] of Object.entries(l.packages)) {
      if (!/(^|\/)node_modules\//.test(p) || e.link === true) continue;
      if (!/^https:\/\/registry\.npmjs\.org\//.test(e.resolved ?? "") || !/^sha512-[A-Za-z0-9+\/]{86}==$/.test(e.integrity ?? "")) {
        console.error(`${f}: ${p} has no resolved https://registry.npmjs.org/… with a sha512 integrity`);
        process.exit(1);
      }
    }' "$1"
}
step() { printf '\n==> %s\n' "$*"; }
usage() { sed -n '5,6p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }

target=sigelo-relay-deploy; dry=0; rollback=0
while [ $# -gt 0 ]; do
  case $1 in
    --target) [ $# -ge 2 ] || usage; target=$2; shift 2 ;;
    --dry-run) dry=1; shift ;;
    --rollback) rollback=1; shift ;;
    -h|--help) usage ;;
    *) die "unknown argument: $1" ;;
  esac
done
# an ~/.ssh/config alias or user@host: nothing a remote shell could read as an option or command
printf '%s' "$target" | grep -Eq '^([A-Za-z0-9._-]+@)?[A-Za-z0-9][A-Za-z0-9.-]*$' || die "--target must be an ssh alias or user@host: $target"

SSH=${SIGELO_SSH:-ssh}
root=$(cd "$(dirname "$0")/.." && pwd)
run() { printf '+ %s\n' "$*"; [ "$dry" = 1 ] || "$@"; }
rsh() { printf '+ %s %s %s\n' "$SSH" "$target" "'$1'"; [ "$dry" = 1 ] || $SSH "$target" "$1"; }

[ "$dry" = 0 ] || echo "deploy.sh: DRY RUN — printing the plan, running nothing"
command -v node >/dev/null || die "node is required"
command -v "${SSH%% *}" >/dev/null || die "${SSH%% *} not found"
[ -f "$root/server.mjs" ] && [ -f "$root/deploy/sigelo-relay-apply" ] || die "$root is not the relay (no server.mjs, deploy/sigelo-relay-apply)"
top=$(git -C "$root" rev-parse --show-toplevel 2>/dev/null || echo none)
[ "$top" = "$root" ] || die "deploy from the relay's own repository (release/publish.sh --relay <dir>), not from $top"
echo "deploy.sh: $root -> $target"

if [ "$rollback" = 1 ]; then
  step "rollback: the previous release back on the host"
  rsh "sudo -n $APPLY --rollback"
  step "live check"
  run node "$root/deploy/check.mjs"
  exit 0
fi

step "1/5 preflight, tests, front page (nothing is uploaded unless all pass)"
# tracked files only: the stage is `git archive HEAD`, and node_modules and site/dist are not tracked
[ -z "$(git -C "$root" status --porcelain --untracked-files=no)" ] || die "uncommitted changes in $root: deploy a commit"
head=$(git -C "$root" rev-parse HEAD)
echo "HEAD $head"
[ -d "$root/node_modules" ] || [ "$dry" = 1 ] || die "no $root/node_modules: run npm ci in $root first (the tests need it)"
echo "+ every package in package-lock.json pinned by its hash"
lockfile_pinned "$root/package-lock.json" || die "package-lock.json pins a package without its hash (above): regenerate it from the registry; nothing is uploaded"
run sh -c "cd '$root' && npm test"
run sh -c "cd '$root' && node test/allowance.mjs"
run sh "$root/deploy/sigelo-relay-apply" --self-test
run sh "$root/deploy/sigelo-relay-apply" --check "$root/deploy/nginx.conf"
run node "$root/deploy/stats-chart.mjs" --self-test
run node "$root/site/build.mjs" --final
run node "$root/site/test.mjs"

step "2/5 stage the tracked files of HEAD, site/dist and the dependencies"
work=$(mktemp -d "${TMPDIR:-/tmp}/sigelo-relay-deploy.XXXXXX")
trap 'rm -rf "$work"' EXIT
stage=$work/stage
printf '+ git archive HEAD | tar -x -C %s; cp -R site/dist %s/site/\n' "$stage" "$stage"
printf '+ cd %s && npm ci --omit=dev --ignore-scripts --no-bin-links --no-audit --no-fund\n' "$stage"
codehash=""; depshash=""
if [ "$dry" = 0 ]; then
  mkdir "$stage"
  git -C "$root" archive --format=tar HEAD | tar -x -C "$stage"
  [ -f "$root/site/dist/index.html" ] || die "no site/dist/index.html after the build"
  rm -rf "$stage/site/dist"; cp -R "$root/site/dist" "$stage/site/dist"
  (cd "$stage" && npm ci --omit=dev --ignore-scripts --no-bin-links --no-audit --no-fund) || die "npm ci in the stage failed: nothing is uploaded"
  [ -d "$stage/node_modules" ] || die "npm ci left no node_modules in the stage: nothing is uploaded"
  ctl=$(cd "$stage" && LC_ALL=C find . -name "$(printf '*[\001-\037\177]*')" | head -n 3)
  [ -z "$ctl" ] || die "a staged path holds a control character (the sha256 reads paths by line; the host refuses it): $ctl"
  if command -v sha256sum >/dev/null 2>&1; then sum=sha256sum; else sum="shasum -a 256"; fi
  codehash=$(cd "$stage" && find . -path ./node_modules -prune -o -type f -print | LC_ALL=C sort | while IFS= read -r f; do $sum "$f"; done | $sum | cut -d' ' -f1)
  depshash=$(cd "$stage" && find ./node_modules -type f | LC_ALL=C sort | while IFS= read -r f; do $sum "$f"; done | $sum | cut -d' ' -f1)
  echo "+ code sha256 $codehash"
  echo "+ deps sha256 $depshash"
fi

step "3/5 upload to $target:$STAGE_DIR"
mode=tar
if command -v rsync >/dev/null 2>&1; then
  if [ "$dry" = 1 ]; then mode=rsync
  elif $SSH "$target" 'command -v rsync >/dev/null 2>&1'; then mode=rsync
  else echo "no rsync on the host: tar | ssh"; fi
else
  echo "no rsync here: tar | ssh"
fi
if [ "$mode" = rsync ]; then
  rsh "mkdir -p $STAGE_DIR"
  # --delete: nothing of an earlier deploy stays beside what was hashed here, node_modules included
  run rsync -rlt --delete --chmod=D755,F644 -e "$SSH" "$stage/" "$target:$STAGE_DIR/"
else
  printf '+ tar -C %s -cf - . | %s %s %s\n' "$stage" "$SSH" "$target" "'rm -rf $STAGE_DIR; mkdir $STAGE_DIR; tar -xf - -C $STAGE_DIR'"
  [ "$dry" = 1 ] || tar -C "$stage" -cf - . | $SSH "$target" "set -e; rm -rf $STAGE_DIR; mkdir $STAGE_DIR; tar -xf - -C $STAGE_DIR"
fi

step "4/5 install through the helper (root): copy, nginx config, restart"
out=$(rsh "sudo -n $APPLY") || { printf '%s\n' "${out:-}"; die "sigelo-relay-apply failed: the host keeps or restores the previous release"; }
printf '%s\n' "$out"
if [ "$dry" = 0 ]; then
  case $out in
    *"installed: code sha256 $codehash deps sha256 $depshash"*) ;;
    *)
      # The stage changed between upload and install (another deploy, or someone else on the deploy
      # account), its code or its dependencies: what the host now runs is not what was tested and
      # hashed here. It is live already, so the previous release goes back before deploy.sh stops.
      if rsh "sudo -n $APPLY --rollback"; then die "the host installed code or dependencies other than what was staged here (code sha256 $codehash, deps sha256 $depshash): rolled back to the previous release"; fi
      die "the host installed code or dependencies other than what was staged here (code sha256 $codehash, deps sha256 $depshash), and rolling back failed (a first release has nothing to go back to): stop it by hand as the admin (systemctl stop sigelo-relay)" ;;
  esac
fi

step "5/5 live check"
run node "$root/deploy/check.mjs"
[ "$dry" = 1 ] && echo "deploy.sh: dry run complete; nothing was run" || echo "deploy.sh: deployed $head"
