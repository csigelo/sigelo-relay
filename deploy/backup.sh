#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# deploy/backup.sh — the relay host's nightly backup: licences, operator chains and config,
# encrypted with age; never a mailbox (design/relay-plan.md §6 "Backups").
#
#   backup.sh                   as root (sigelo-relay-backup.timer, daily): the archive
#                               <admin home>/backup/relay-state-<stamp>.tgz.age, admin user 0600, 7 kept
#   backup.sh --extract FILE    only the licence extract of $RELAY_DB, as a new SQLite FILE
#   backup.sh --restore FILE    merge an extract back into $RELAY_DB; the relay must be stopped
#   backup.sh --self-test       no root, from the relay's repository: --extract over a database
#                               seeded with the relay's own schema (../db.mjs, ../allowance.mjs)
#                               keeps those tables and rows and nothing of a mailbox; it writes
#                               into the timer's scratch layout (scratch()) and checks its modes
#
# The relay keeps everything in one SQLite file, mailboxes included, so that file is never copied.
# The extract holds what a paid licence needs: the tables licences, operator_retired and
# vendor_chain whole, and each licensed operator's rows of accounts and chain_dids (its chain,
# sealed as the relay keeps it, so a recovery from a stolen key stays in force after a restore).
# Messages, claims, counters, proofs and pool rows are left out: agents pool again at their next
# login with their operator attestation, and plan §6 lets counters be lost. The extract is read in
# one transaction, so its tables agree with each other.
#
# Run as root, the extract and the restore run as the user sigelo-relay: SQLite may create the
# database's -wal and -shm files, and root-owned ones would stop the relay from opening its own
# database. The archive also carries the host's config (below), /etc/letsencrypt included, and is
# encrypted to the recipient in /etc/sigelo-relay-backup.recipient (age1…, the public half; the
# identity is not on this host, so the host cannot read its own backups).
#
# Installed by site/deploy/server-setup.sh --relay --backup age1… as /usr/local/sbin/sigelo-relay-backup.
# Restore: site/deploy/README.md (csigelo/sigelo), "The relay host". Environment: RELAY_DB (default
# /var/lib/sigelo-relay/relay.db, the relay's own default), ADMIN (default csigelo).
set -eu
DB=${RELAY_DB:-/var/lib/sigelo-relay/relay.db}
ADMIN=${ADMIN:-csigelo}
RECIPIENT_FILE=/etc/sigelo-relay-backup.recipient
TABLES="licences operator_retired vendor_chain accounts chain_dids"

die() { echo "backup.sh: $*" >&2; exit 1; }
# setpriv, not su or runuser: no PAM session inside the backup's systemd unit
as_relay() { if [ "$(id -u)" = 0 ]; then setpriv --reuid=sigelo-relay --regid=sigelo-relay --clear-groups "$@"; else "$@"; fi; }

# scratch DIR [OWNER]: the backup's work directory. DIR is new from mktemp -d (0700, root's when
# the timer runs) and becomes 0711; x/ inside it, 0700 and OWNER's, takes the extract. sigelo-relay
# writes the extract, so it needs the search bit on DIR to reach x/; it gets no write bit there,
# because root's tar writes state.tgz in DIR, and nothing sigelo-relay could leave in DIR (a link)
# may decide what root's archive overwrites (an earlier backup, say).
scratch() {
  chmod 0711 "$1"
  if [ -n "${2:-}" ]; then install -d -m 0700 -o "$2" -g "$2" "$1/x"; else install -d -m 0700 "$1/x"; fi
}

extract() {  # extract OUT
  [ -f "$DB" ] || die "no relay database at $DB (RELAY_DB)"
  [ ! -e "$1" ] || die "$1 exists: the extract is always a new file"
  as_relay node --input-type=module - "$DB" "$1" <<'JS'
import { DatabaseSync } from 'node:sqlite';
import { rmSync } from 'node:fs';
const [, , src, out] = process.argv;
const db = new DatabaseSync(src, { readOnly: true }), x = new DatabaseSync(out);
// A failed extract leaves no file that could pass for one.
process.on('uncaughtException', (e) => { x.close(); rmSync(out, { force: true }); console.error(e.message); process.exit(1); });
const OPERATORS = 'WHERE account IN (SELECT operator FROM licences)';
const copy = (table, where = '') => {
  const def = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  if (!def) throw new Error(`extract: ${src} has no table ${table}: not a relay database, or one older than the licence code`);
  x.exec(def.sql);
  const rows = db.prepare(`SELECT * FROM ${table} ${where}`).all();
  for (const r of rows) {
    const cols = Object.keys(r);
    x.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((c) => r[c]));
  }
  return `${table} ${rows.length}`;
};
db.exec('BEGIN');   // one snapshot for every table
x.exec('BEGIN');
const n = [copy('licences'), copy('operator_retired'), copy('vendor_chain'), copy('accounts', OPERATORS), copy('chain_dids', OPERATORS)];
x.exec('COMMIT');
db.exec('COMMIT');
console.log(`extract: ${n.join(', ')}`);
JS
}

restore() {  # restore FILE
  [ -f "$1" ] || die "no extract at $1"
  [ -f "$DB" ] || die "no relay database at $DB: start the relay once so it creates its tables, stop it, then restore"
  if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet sigelo-relay.service; then
    die "sigelo-relay is running: systemctl stop sigelo-relay first (it keeps state in memory and would overwrite the rows)"
  fi
  as_relay node --input-type=module - "$DB" "$1" "$TABLES" <<'JS'
import { DatabaseSync } from 'node:sqlite';
const [, , dst, file, tables] = process.argv;
const db = new DatabaseSync(dst);
db.prepare('ATTACH DATABASE ? AS b').run(file);
const n = [];
db.exec('BEGIN');
try {
  for (const t of tables.split(' ')) {
    const cols = db.prepare(`SELECT name FROM pragma_table_info(?, 'b')`).all(t).map((c) => c.name);
    if (cols.length === 0) throw new Error(`restore: the extract has no table ${t}`);
    const have = new Set(db.prepare(`SELECT name FROM pragma_table_info(?, 'main')`).all(t).map((c) => c.name));
    const missing = cols.filter((c) => !have.has(c));
    if (missing.length) throw new Error(`restore: ${dst} table ${t} lacks ${missing.join(', ')}: start this relay version once so it creates its tables`);
    const r = db.prepare(`INSERT OR REPLACE INTO main.${t} (${cols.join(', ')}) SELECT ${cols.join(', ')} FROM b.${t}`).run();
    n.push(`${t} ${r.changes}`);
  }
  db.exec('COMMIT');
} catch (e) { db.exec('ROLLBACK'); throw e; }
console.log(`restore: ${n.join(', ')}`);
JS
}

# --self-test: a database made by the relay's own code (openDb, relayPolicy: every table it has),
# one licensed operator and one free agent with a claimed mailbox, a queued message, pool, proof and
# daily rows; then extract() as the timer runs it. The extract must hold exactly the five tables,
# only the operator's rows of accounts and chain_dids, and no byte of the agent's: not its
# account, its sealed chain, its topic or its message.
self_test() {
  [ "$(id -u)" != 0 ] || die "--self-test runs without root (as root the extract runs as sigelo-relay)"
  here=$(cd "$(dirname "$0")/.." && pwd)
  [ -f "$here/db.mjs" ] && [ -f "$here/allowance.mjs" ] || die "--self-test runs from the relay's repository (deploy/backup.sh beside ../db.mjs and ../allowance.mjs)"
  t=$(mktemp -d "${TMPDIR:-/tmp}/sigelo-backup-test.XXXXXX")
  trap 'rm -rf "$t"' EXIT
  node --input-type=module - "$here" "$t/relay.db" <<'JS' || die "self-test: seeding the database failed (above)"
import { pathToFileURL } from 'node:url';
const [, , here, file] = process.argv;
const { openDb, hashHex } = await import(pathToFileURL(`${here}/db.mjs`));
const { relayPolicy } = await import(pathToFileURL(`${here}/allowance.mjs`));
// test-vectors.json's first DID: a well-formed vendor DID; the rows below are written directly
const VENDOR = 'did:sigelo:zF5FYbH5zNLX5pfd7DZUjPirXeAFzLVxrdFyCrnexdpBG';
const db = openDb(file);
relayPolicy({ db, host: 'relay.example', clock: () => 1767225600 }, { vendor: VENDOR, freeQueue: 1 << 20 });
const r = db.raw, op = hashHex('operator'), agent = hashHex('agent'), day = 1767225600;
const run = (sql, ...a) => r.prepare(sql).run(...a);
run('INSERT INTO licences (operator, current, vendor_key, iat, exp, storage_mb, msgs_day, retention_days, groups, support) VALUES (?, ?, ?, ?, ?, 1000, 50000, 90, 0, ?)', op, op, VENDOR, day, day + 86400 * 365, 'email');
run('INSERT INTO operator_retired VALUES (?, ?)', hashHex('operator old key'), op);
run('INSERT INTO vendor_chain VALUES (?, ?, ?, ?)', VENDOR, VENDOR, '{}', '[]');
run('INSERT INTO accounts (account, created, last_seen, chain) VALUES (?, ?, ?, ?)', op, day, day, Buffer.from('OPERATOR-CHAIN'));
run('INSERT INTO accounts (account, created, last_seen, chain) VALUES (?, ?, ?, ?)', agent, day, day, Buffer.from('AGENT-CHAIN-SEALED'));
run('INSERT INTO chain_dids VALUES (?, ?)', hashHex('operator did'), op);
run('INSERT INTO chain_dids VALUES (?, ?)', hashHex('agent did'), agent);
run('INSERT INTO claims (topic, account, client_id, created, last_used) VALUES (?, ?, ?, ?, ?)', 'm/' + 'ab'.repeat(16), agent, 's' + agent.slice(0, 24), day, day);
run('INSERT INTO messages (id, seq, topic, client_id, account, payload, bytes, expires) VALUES (1, 1, ?, ?, ?, ?, 21, ?)', 'm/' + 'ab'.repeat(16), 's' + agent.slice(0, 24), agent, Buffer.from('MAILBOX-PAYLOAD-BYTES'), day + 7 * 86400);
run('INSERT INTO pool_members VALUES (?, ?, ?, ?)', agent, op, op, day + 86400);
run('INSERT INTO pow_proofs VALUES (?, ?)', agent, day);
run('INSERT INTO vouched VALUES (?, ?)', agent, day + 86400);
run('INSERT INTO pool_sent VALUES (?, ?, 3)', op, 20454);
db.close();
process.exit(0);
JS
  # The timer's layout, its modes checked by name: without root the caller owns both directories,
  # so an extract here succeeds whatever DIR's mode is, while sigelo-relay's would fail EACCES
  # without DIR's search bit for others.
  s=$(mktemp -d "$t/scratch.XXXXXX")
  scratch "$s"
  m=$(ls -ld "$s" | cut -c1-10)
  [ "$m" = drwx--x--x ] || die "self-test FAILED: scratch() leaves its directory $m, not drwx--x--x (0711): sigelo-relay must pass through it to x/ and write nothing beside root's state.tgz"
  m=$(ls -ld "$s/x" | cut -c1-10)
  [ "$m" = drwx------ ] || die "self-test FAILED: scratch() makes x/ $m, not drwx------ (0700)"
  DB=$t/relay.db
  extract "$s/x/relay-licences.db" > "$t/out" || die "self-test: the extract failed: $(cat "$t/out")"
  node --input-type=module - "$s/x/relay-licences.db" <<'JS' || die "self-test FAILED (above)"
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const file = process.argv[2], x = new DatabaseSync(file, { readOnly: true }), bad = [];
const h = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const tables = x.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((t) => t.name).join(' ');
if (tables !== 'accounts chain_dids licences operator_retired vendor_chain') bad.push(`tables: ${tables}`);
const rows = (sql) => x.prepare(sql).all().map((o) => Object.values(o).join('|')).join(',');
if (rows('SELECT account FROM accounts') !== h('operator')) bad.push('accounts: not the operator\'s row alone');
if (rows('SELECT did, account FROM chain_dids') !== `${h('operator did')}|${h('operator')}`) bad.push('chain_dids: not the operator\'s row alone');
for (const t of ['licences', 'operator_retired', 'vendor_chain']) if (x.prepare(`SELECT count(*) AS n FROM ${t}`).get().n !== 1) bad.push(`${t}: not its one row`);
x.close();
const bytes = readFileSync(file);
for (const s of [h('agent'), h('agent did'), 'AGENT-CHAIN-SEALED', 'ab'.repeat(16), 'MAILBOX-PAYLOAD-BYTES']) if (bytes.includes(s)) bad.push(`the extract holds the agent's ${s.slice(0, 24)}`);
if (bad.length) { console.error(bad.join('\n')); process.exit(1); }
JS
  echo "backup.sh --self-test: the scratch layout is 0711 with x/ 0700; the extract holds the five tables, the licensed operator's rows only, nothing of a mailbox ($(cat "$t/out"))"
}

case ${1:-} in
  --self-test) [ $# -eq 1 ] || die "usage: backup.sh --self-test"; self_test; exit 0 ;;
  --extract) [ $# -eq 2 ] || die "usage: backup.sh --extract FILE"; extract "$2"; exit 0 ;;
  --restore) [ $# -eq 2 ] || die "usage: backup.sh --restore FILE"; restore "$2"; exit 0 ;;
  "") ;;
  *) die "unknown argument: $1" ;;
esac

[ "$(id -u)" = 0 ] || die "run as root (the timer does)"
[ -f "$RECIPIENT_FILE" ] || die "no $RECIPIENT_FILE: server-setup.sh --relay --backup age1… writes it"
R=$(cat "$RECIPIENT_FILE")
getent passwd "$ADMIN" >/dev/null || die "no user $ADMIN: the archives go to its ~/backup"
home=$(getent passwd "$ADMIN" | cut -d: -f6)
OUT=$home/backup
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
umask 077
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
scratch "$tmp" sigelo-relay   # $tmp 0711 root's, $tmp/x 0700 sigelo-relay's (see scratch())
extract "$tmp/x/relay-licences.db"
list=""
for p in /etc/sigelo-relay.env "$RECIPIENT_FILE" /etc/letsencrypt /etc/nginx/conf.d/sigelo-relay.conf \
         /etc/systemd/system/sigelo-relay* /etc/systemd/journald@sigelo-relay.conf /etc/systemd/journald.conf.d/00-sigelo.conf \
         /usr/local/sbin/sigelo-relay-* /etc/sudoers.d/sigelo-relay /etc/ssh/sshd_config.d/00-sigelo.conf /etc/nftables.conf \
         /etc/fail2ban/jail.d/sshd.local /etc/fail2ban/jail.d/nginx-limit-req.local /etc/apt/apt.conf.d/20auto-upgrades \
         /etc/apt/apt.conf.d/52sigelo-relay /etc/apt/sources.list.d/nodesource.sources /etc/apt/preferences.d/nodejs; do
  if [ -e "$p" ]; then list="$list ${p#/}"; fi
done
# Never the database or anything else of the relay's state directory: it holds the mailboxes.
case $list in *var/lib/sigelo-relay*) die "refused: the list names the relay's state directory" ;; esac
# A file first, then age: sh has no pipefail, and a failed tar in a pipe would still be encrypted.
# shellcheck disable=SC2086
tar -czf "$tmp/state.tgz" -C "$tmp/x" relay-licences.db -C / $list
tar -tzf "$tmp/state.tgz" | grep -qx relay-licences.db || die "the archive lacks relay-licences.db"
install -d -m 0700 -o "$ADMIN" -g "$ADMIN" "$OUT"
part=$OUT/.relay-state-$STAMP.tmp
age -r "$R" -o "$part" "$tmp/state.tgz"
chown "$ADMIN:$ADMIN" "$part"; chmod 0600 "$part"
mv "$part" "$OUT/relay-state-$STAMP.tgz.age"
( cd "$OUT" && ls -t relay-state-*.tgz.age | tail -n +8 | xargs -r rm -f )
echo "backup.sh: $OUT/relay-state-$STAMP.tgz.age, $(wc -c < "$OUT/relay-state-$STAMP.tgz.age") bytes: relay-licences.db$list"
