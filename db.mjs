// SPDX-License-Identifier: AGPL-3.0-only
// relay/db.mjs — the relay's one SQLite file (node:sqlite, WAL): accounts, mailbox claims, queued
// messages (design/relay-plan.md §3 "Allowances", "Retention"; §4 "Store").
//
// No DID is stored in the clear. An account is keyed by the hex SHA-256 of the identity's ORIGINAL
// DID (one account per identity, whatever its rotations), a claim and a message by the reader's
// account and MQTT client id. Those are plain hashes of public values: whoever holds a list of
// DIDs finds their rows, and a copy of this file says which identities read here. The rotations
// of an account's chain (they name DIDs) are kept encrypted under a key derived from the original
// DID: whoever can read them already knows it. What the file must not tell is who wrote to whom,
// and when (plan §5 "Privacy"):
//   - every time in it is the start of a UTC day (dayOf; messages.expires too, which is the publish
//     time plus the retention), and a message row holds no time of its own: a second-exact time on
//     the writer's account and on the reader's message or claim joined them;
//   - no table keeps the order its rows were written in: a table keyed by a hash or a random name
//     has no rowid (WITHOUT ROWID), since a rowid numbers rows as they are inserted and the claims
//     of a pairing are written within one round trip; a message's id is random, and its delivery
//     order is a sequence of its reader's own (seq). Nor do its pages: SQLite places each new cell
//     below the last in a b-tree page, so sorting a page's cells by offset gave the order they
//     were inserted in, across accounts (an invite, its answer and both sides of the pairing side
//     by side). The sweep rebuilds the tables of identities (accounts, claims, chain_dids,
//     pool_sent, and M4's: keepSorted) in key order every RESORT_EVERY seconds, so their pages hold cells in key
//     order; what was inserted since keeps its order until then. Message rows and their index
//     entries, which name only readers, keep theirs until they go;
//   - the sender's side of a message is never written with it: messages sent today (per account
//     and per operator pool), the day of a login, and a claim's day of use are counted in memory and written by the sweep every minute,
//     every account in one transaction just before the WAL is truncated. A message's own commit
//     then holds its reader's rows only, where a counter bumped in the same commit named its sender
//     in the WAL. Nothing else writes them: M4's hourly tidy runs inside the sweep's transaction
//     (sweep `tidy`). What must be written at once for an identity (a new account, proof or claim,
//     a changed chain or pool row) is followed by a checkpoint that truncates the WAL (settle), so
//     no such commit stays there in front of the next message, which its identity may have written.
//     A chain is written only when it changed. Deliveries and acknowledgements write the reader's
//     message rows: a copy of the WAL taken within the minute between sweeps shows one before a
//     message its reader then wrote, as it shows when each message arrived.
// Payloads are the envelopes as received: opaque bytes, never parsed.
//
// node:sqlite is synchronous and the relay has one thread, so a function below runs to completion
// before any other client is served; tx() makes "count, then store" one transaction on disk too.
import { DatabaseSync } from 'node:sqlite';
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { canonicalize, parseBytes } from 'sigelo';

export const DAY = 86400;
// How often the sweep rebuilds the tables of identities in key order (the header).
export const RESORT_EVERY = 3600;
// The start of the UTC day of t: the only times this file holds.
export const dayOf = (t) => Math.floor(t / DAY) * DAY;
export const hashHex = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
export const accountOf = (originalDid) => hashHex(originalDid);
// Plan §3 "Login": client id = "s" + 24 hex digits of SHA-256(original DID). It is the first 24
// digits of the account key, so one identity has exactly one persistent MQTT session.
export const clientIdOf = (originalDid) => 's' + hashHex(originalDid).slice(0, 24);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  account   TEXT PRIMARY KEY,           -- hex SHA-256 of the original DID
  created   INTEGER NOT NULL,           -- times here and below: the start of a UTC day (dayOf)
  last_seen INTEGER NOT NULL,           -- day of the last login; the row goes 30 days after it (plan §5 "Privacy")
  day       INTEGER NOT NULL DEFAULT 0, -- UTC day (unix seconds / 86400) that msgs_day counts
  msgs_day  INTEGER NOT NULL DEFAULT 0, -- messages sent that day: charged to the sender
  chain     BLOB                        -- the chain's rotations, sealed (sealChain); NULL = none
) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS claims (
  topic     TEXT PRIMARY KEY,           -- m/<32 hex> (mailbox) or i/<32 hex> (invite)
  account   TEXT NOT NULL,              -- the reader, who claimed it by subscribing first
  client_id TEXT NOT NULL,              -- the reader's MQTT client id
  created   INTEGER NOT NULL,
  last_used INTEGER NOT NULL,           -- last subscribe or stored message: idle mailboxes go
  expires   INTEGER,                    -- invites only: they live at most 7 days
  dead      INTEGER NOT NULL DEFAULT 0, -- 1: an invite used up by the first answer read; 2: a mailbox given up whose queue goes in batches (release, reap)
  pool      TEXT                        -- the operator pool it was claimed under (allowance.mjs), counted there while it lives; NULL = free
) STRICT, WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS claims_client ON claims (client_id);
CREATE INDEX IF NOT EXISTS claims_account ON claims (account);
CREATE INDEX IF NOT EXISTS claims_pool ON claims (pool) WHERE pool IS NOT NULL;
CREATE INDEX IF NOT EXISTS claims_released ON claims (topic) WHERE dead = 2;
CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY,       -- random (randomId): rows hold no order of arrival across readers
  seq        INTEGER NOT NULL,          -- arrival order at this reader: the delivery order
  topic      TEXT NOT NULL REFERENCES claims (topic) ON DELETE CASCADE,
  client_id  TEXT NOT NULL,             -- the reader's client id: redelivery after a reconnect
  account    TEXT NOT NULL,             -- the reader's account: bytes queued are charged to it
  payload    BLOB NOT NULL,             -- the envelope, opaque
  bytes      INTEGER NOT NULL,
  expires    INTEGER NOT NULL,          -- the retention limit, at the start of its UTC day
  message_id INTEGER,                   -- MQTT packet id of the delivery in flight on this connection
  pool       TEXT                       -- the reader's operator pool when stored: its bytes count there until it goes; NULL = free
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS messages_seq ON messages (client_id, seq);
CREATE INDEX IF NOT EXISTS messages_client ON messages (client_id, message_id);
CREATE INDEX IF NOT EXISTS messages_account ON messages (account);
CREATE INDEX IF NOT EXISTS messages_topic ON messages (topic);
CREATE INDEX IF NOT EXISTS messages_expires ON messages (expires);
CREATE TABLE IF NOT EXISTS chain_dids (
  did       TEXT PRIMARY KEY,           -- hex SHA-256 of a DID in an account's chain as last verified
  account   TEXT NOT NULL               -- that account: no other identity's chain may pass through it
) STRICT, WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS chain_dids_account ON chain_dids (account);
CREATE TABLE IF NOT EXISTS pool_sent (
  pool      TEXT PRIMARY KEY,           -- an operator pool (allowance.mjs): the operator's account
  day       INTEGER NOT NULL,           -- UTC day (unix seconds / 86400) that n counts
  n         INTEGER NOT NULL            -- messages sent that day under the pool, by whichever member then
) STRICT, WITHOUT ROWID;
`;

// What a row of an identity's takes on disk, its index entries included, measured over 100,000
// rows of each with this schema (rows inserted in random key order) and rounded up: a claim 362
// bytes, 564 claimed under a pool (its pool and that index entry), so 576 for either; an account
// 101, plus its sealed chain; a DID of a chain 321. Counted in row_totals (ROWS), so allowance.mjs
// can hold free identities' rows to the free tier's ceiling: they stopped only at relay_full,
// which then refused everyone.
export const CLAIM_ROW = 576, ACCOUNT_ROW = 128, DID_ROW = 384;
// What an account's rows take once setChain has written this chain (ROWS counts the same): its row,
// the sealed rotations (sealChain: a 12-byte nonce, the JCS, a 16-byte tag; nothing when there are
// none) and a DID row for each DID of the chain. allowance.mjs checks a login's growth with it.
export const chainRowBytes = (rotations, dids) => ACCOUNT_ROW + (rotations.length === 0 ? 0 : 28 + Buffer.byteLength(canonicalize(rotations), 'utf8')) + DID_ROW * dids.length;
// The disk the identity rows take, kept by triggers as queue_totals is (allowance.mjs), so a check
// reads one row. Made anew, and the rows counted, at every open and after every rebuild in key
// order: a rebuild copies a table without its triggers (its old triggers go with the old table).
const ROWS = `
DROP TRIGGER IF EXISTS rows_account_in;
DROP TRIGGER IF EXISTS rows_account_out;
DROP TRIGGER IF EXISTS rows_account_chain;
DROP TRIGGER IF EXISTS rows_claim_in;
DROP TRIGGER IF EXISTS rows_claim_out;
DROP TRIGGER IF EXISTS rows_did_in;
DROP TRIGGER IF EXISTS rows_did_out;
DROP TABLE IF EXISTS row_totals;
CREATE TABLE row_totals (
  k     TEXT PRIMARY KEY,             -- '*': one row
  bytes INTEGER NOT NULL              -- CLAIM_ROW a claim, ACCOUNT_ROW and its chain's length an account, DID_ROW a chain DID
) STRICT, WITHOUT ROWID;
CREATE TRIGGER rows_account_in AFTER INSERT ON accounts BEGIN UPDATE row_totals SET bytes = bytes + ${ACCOUNT_ROW} + coalesce(length(new.chain), 0); END;
CREATE TRIGGER rows_account_out AFTER DELETE ON accounts BEGIN UPDATE row_totals SET bytes = bytes - ${ACCOUNT_ROW} - coalesce(length(old.chain), 0); END;
CREATE TRIGGER rows_account_chain AFTER UPDATE OF chain ON accounts BEGIN UPDATE row_totals SET bytes = bytes + coalesce(length(new.chain), 0) - coalesce(length(old.chain), 0); END;
CREATE TRIGGER rows_claim_in AFTER INSERT ON claims BEGIN UPDATE row_totals SET bytes = bytes + ${CLAIM_ROW}; END;
CREATE TRIGGER rows_claim_out AFTER DELETE ON claims BEGIN UPDATE row_totals SET bytes = bytes - ${CLAIM_ROW}; END;
CREATE TRIGGER rows_did_in AFTER INSERT ON chain_dids BEGIN UPDATE row_totals SET bytes = bytes + ${DID_ROW}; END;
CREATE TRIGGER rows_did_out AFTER DELETE ON chain_dids BEGIN UPDATE row_totals SET bytes = bytes - ${DID_ROW}; END;
INSERT INTO row_totals (k, bytes) SELECT '*',
  (SELECT count(*) * ${ACCOUNT_ROW} + coalesce(sum(length(chain)), 0) FROM accounts) + (SELECT count(*) * ${CLAIM_ROW} FROM claims) + (SELECT count(*) * ${DID_ROW} FROM chain_dids);
`;

// The most rows one transaction deletes, beyond a reader's own acknowledgements: a given-up
// mailbox's queue, expired messages, expired invite topics with theirs, idle mailboxes, idle
// accounts with their chains' DIDs (the sweep's one budget for all of them). Deleting a message costs
// its row, four index entries, the queue_out trigger and secure_delete's overwrite: about 72 µs a
// row on tmpfs (the audit's measurement), more on a disk. One transaction that deleted a queue
// whole held the one thread for its length: 64,000 messages on one mailbox, 5 s for a single
// UNSUBSCRIBE; a day's expired messages, swept at once at the UTC day start (messages.expires is
// kept by the day), over a minute. Past DELETE_BATCH, what is left goes in further transactions,
// one per turn of the event loop (reap), so each stall is one batch: 36 ms on tmpfs, 56 ms (at
// most 72) on the phone-class host's flash, its checkpoint included (measured 2026-10-13). Idle
// claims and accounts went whole too: claims.last_used is kept by the UTC day, so every claim last
// used on one day goes idle in the same minute (64,000 held the thread 4.6 s on tmpfs, measured
// 2026-10-13: Sybil identities reconnecting on one day, or a lapsed Pro pool's 16,384 at once).
export const DELETE_BATCH = 512;
// Expired invite topics per batch: each holds at most 4 messages (mailbox.mjs INVITE_MESSAGES),
// which its claim's deletion takes along (the foreign key): 5 rows each, under DELETE_BATCH.
const INVITE_BATCH = DELETE_BATCH / 8;

// A message's id: 53 random bits, a safe integer. A collision is retried (store).
const randomId = () => Number(randomBytes(8).readBigUInt64BE() >> 11n);

// Tables written by an earlier version of a relay module kept a rowid, which numbers rows in the
// order they were inserted; messages were numbered relay-wide. Each table of `tables` in that
// shape (old(t) says which; the sweep passes every table, to have them in key order: the header)
// is set aside, `schema` makes it anew, fill(t, from) copies its rows (by default column for
// column, in the old table's key order), and its indexes are made again over the rows, which
// sorts them: all in one transaction. Foreign keys are off meanwhile, and a rename leaves
// references to the table alone: dropping the old claims must not delete or re-point the messages
// that refer to claims. → whether anything was rebuilt.
function rebuild(db, schema, tables, old = (t) => db.prepare("SELECT wr FROM pragma_table_list WHERE schema = 'main' AND name = ?").get(t)?.wr === 0, fill = null) {
  const stale = tables.filter(old);
  if (stale.length === 0) { db.exec(schema); return false; }
  db.exec('PRAGMA foreign_keys = OFF; PRAGMA legacy_alter_table = ON');
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const t of stale) {
        // Index names are global: the new table's would collide with the old one's.
        for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL").all(t)) db.exec(`DROP INDEX "${name}"`);
        db.exec(`ALTER TABLE "${t}" RENAME TO "${t}_old"`);
      }
      db.exec(schema);
      for (const t of stale) {
        // Made on the empty table, an index would take its entries in the order rows are copied.
        const indexes = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL").all(t);
        for (const { name } of indexes) db.exec(`DROP INDEX "${name}"`);
        if (!fill?.(t, `${t}_old`)) {
          const cols = db.prepare('SELECT name FROM pragma_table_info(?)').all(t).map((r) => `"${r.name}"`).join(', ');
          db.exec(`INSERT INTO "${t}" (${cols}) SELECT ${cols} FROM "${t}_old"`);
        }
        db.exec(`DROP TABLE "${t}_old"`);
        for (const { sql } of indexes) db.exec(sql);
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  } finally { db.exec('PRAGMA foreign_keys = ON; PRAGMA legacy_alter_table = OFF'); }
  return true;
}

// The chain's rotations at rest: JCS, ChaCha20-Poly1305 under HKDF-SHA256(original DID), the
// account as additional data so a sealed chain cannot be moved to another row. → nonce ‖ ct ‖ tag.
const chainKey = (originalDid, account) => Buffer.from(hkdfSync('sha256', originalDid, 'sigelo-relay-chain/0', account, 32));
function sealChain(originalDid, account, rotations) {
  if (rotations.length === 0) return null;
  const nonce = randomBytes(12), c = createCipheriv('chacha20-poly1305', chainKey(originalDid, account), nonce, { authTagLength: 16 });
  c.setAAD(Buffer.from(account, 'utf8'));
  const ct = Buffer.concat([c.update(canonicalize(rotations), 'utf8'), c.final()]);
  return Buffer.concat([nonce, ct, c.getAuthTag()]);
}
// A chain that does not open (an altered file, a wrong DID: never the case for the account's own
// original DID) throws: the login fails as the relay's own error, never as "no rotations seen".
function openChain(originalDid, account, blob) {
  if (blob === null || blob === undefined) return [];
  const b = Buffer.from(blob), d = createDecipheriv('chacha20-poly1305', chainKey(originalDid, account), b.subarray(0, 12), { authTagLength: 16 });
  d.setAAD(Buffer.from(account, 'utf8'));
  d.setAuthTag(b.subarray(b.length - 16));
  const rotations = parseBytes(Buffer.concat([d.update(b.subarray(12, b.length - 16)), d.final()]));
  if (!Array.isArray(rotations)) throw new Error('sealed chain: not an array');
  return rotations;
}

export function openDb(path) {
  const db = new DatabaseSync(path);
  // WAL: readers never block the one writer. secure_delete: an acknowledged or expired message is
  // overwritten in the file, not left in a free page. The WAL still holds the old page images
  // until a checkpoint truncates it: sweep() does that every minute (plan §3 "Retention").
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON; PRAGMA busy_timeout = 5000;');
  // A file written by an earlier version: accounts, claims and chain_dids with a rowid, messages
  // numbered relay-wide (and, before that, with a time of their own). A message keeps its reader's
  // order as its seq.
  const has = (t, col) => db.prepare('SELECT 1 FROM pragma_table_info(?) WHERE name = ?').get(t, col) !== undefined;
  // Before the pool a claim or message was charged to was kept with it: their rows are free ones
  // (NULL). Added before the schema runs, whose index on claims (pool) needs the column.
  for (const t of ['claims', 'messages']) if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t) && !has(t, 'pool')) db.exec(`ALTER TABLE ${t} ADD COLUMN pool TEXT`);
  rebuild(db, SCHEMA, ['accounts', 'claims', 'chain_dids', 'messages'],
    (t) => (t === 'messages' ? has('messages', 'id') && !has('messages', 'seq') : db.prepare("SELECT wr FROM pragma_table_list WHERE schema = 'main' AND name = ?").get(t)?.wr === 0),
    (t, from) => {
      if (t !== 'messages') return false;
      const put = db.prepare('INSERT INTO messages (id, seq, topic, client_id, account, payload, bytes, expires, message_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
      const seqs = new Map();
      for (const m of db.prepare(`SELECT * FROM "${from}" ORDER BY client_id, id`).iterate()) {
        const seq = (seqs.get(m.client_id) ?? 0) + 1;
        seqs.set(m.client_id, seq);
        put.run(randomId(), seq, m.topic, m.client_id, m.account, m.payload, m.bytes, m.expires, m.message_id);
      }
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'sqlite_sequence'").get()) db.exec(`DELETE FROM sqlite_sequence WHERE name IN ('messages', '${from}')`);
      return true;
    });
  db.exec('BEGIN IMMEDIATE');
  try { db.exec(ROWS); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
  const q = (sql) => db.prepare(sql);
  const s = {
    account: q('SELECT * FROM accounts WHERE account = ?'),
    accountNew: q('INSERT INTO accounts (account, created, last_seen) VALUES (?1, ?2, ?2) ON CONFLICT (account) DO NOTHING'),
    accountSeen: q('UPDATE accounts SET last_seen = ?2 WHERE account = ?1 AND last_seen < ?2'),
    accountSent: q('UPDATE accounts SET msgs_day = CASE WHEN day = ?2 THEN msgs_day + ?3 ELSE ?3 END, day = ?2 WHERE account = ?1'),
    chainOf: q('SELECT chain FROM accounts WHERE account = ?'),
    chainSet: q('UPDATE accounts SET chain = ? WHERE account = ?'),
    bytesQueued: q('SELECT coalesce(sum(bytes), 0) AS n FROM messages WHERE account = ?'),
    mailboxCount: q('SELECT count(*) AS n FROM claims WHERE account = ? AND dead = 0'),
    claim: q('SELECT * FROM claims WHERE topic = ?'),
    claimInsert: q('INSERT INTO claims (topic, account, client_id, created, last_used, expires, pool) VALUES (?1, ?2, ?3, ?4, ?4, ?5, ?6)'),
    claimTouch: q('UPDATE claims SET last_used = ?1 WHERE topic = ?2 AND last_used < ?1'),
    claimsTouch: q('UPDATE claims SET last_used = ?1 WHERE client_id = ?2 AND dead = 0 AND last_used < ?1'),
    claimsOf: q('SELECT topic FROM claims WHERE client_id = ? AND dead = 0 AND (expires IS NULL OR expires > ?) ORDER BY created DESC, topic LIMIT ?'),
    claimRelease: q('DELETE FROM claims WHERE topic = ? AND client_id = ?'),
    claimGiveUp: q('UPDATE claims SET dead = 2 WHERE topic = ? AND client_id = ? AND expires IS NULL AND dead = 0'),
    topicQueued: q('SELECT count(*) AS n FROM (SELECT 1 FROM messages WHERE topic = ? LIMIT ?)'),
    inviteKill: q('UPDATE claims SET dead = 1 WHERE topic = ?'),
    topicMessages: q('DELETE FROM messages WHERE topic = ?'),
    topicLoad: q('SELECT count(*) AS n, coalesce(sum(bytes), 0) AS bytes FROM messages WHERE topic = ?'),
    nextSeq: q('SELECT coalesce(max(seq), 0) + 1 AS n FROM messages WHERE client_id = ?'),
    store: q('INSERT INTO messages (id, seq, topic, client_id, account, payload, bytes, expires, pool) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING RETURNING id'),
    midClear: q('UPDATE messages SET message_id = NULL WHERE client_id = ? AND message_id = ?'),
    midSet: q('UPDATE messages SET message_id = ? WHERE id = ? AND client_id = ?'),
    midReset: q('UPDATE messages SET message_id = NULL WHERE client_id = ? AND message_id IS NOT NULL'),
    // By (client id, packet id): left to itself the planner walked the reader's whole queue in its
    // order (messages_seq) to the row in flight, 165 ms behind a long queue given up (measured).
    take: q('DELETE FROM messages WHERE id = (SELECT id FROM messages INDEXED BY messages_client WHERE client_id = ? AND message_id = ? ORDER BY seq LIMIT 1) RETURNING topic'),
    // Not in flight on this connection: resetMessageIds clears every packet id at a connect, and a
    // delivery sets one before it is written (outgoingUpdate).
    // None of the three hands out a message of a mailbox given up (dead 2), whose queue reap is
    // deleting: its reader gave it up. `go`: the row is to be delivered now.
    unsentPage: q('SELECT m.id, m.seq, m.message_id IS NULL AND m.expires > ?2 AND c.dead <> 2 AS go FROM messages m JOIN claims c ON c.topic = m.topic WHERE m.client_id = ?1 AND m.seq > ?3 ORDER BY m.seq LIMIT ?4'),
    unsentOne: q('SELECT 1 AS n FROM messages m JOIN claims c ON c.topic = m.topic WHERE m.id = ? AND m.message_id IS NULL AND c.dead <> 2'),
    message: q('SELECT m.topic, m.payload, m.expires FROM messages m JOIN claims c ON c.topic = m.topic WHERE m.id = ? AND c.dead <> 2'),
    // At most ? rows each (DELETE_BATCH, INVITE_BATCH): the rest goes in the next batch (reap).
    expireSome: q('DELETE FROM messages WHERE id IN (SELECT id FROM messages WHERE expires <= ? LIMIT ?)'),
    invitesSome: q('DELETE FROM claims WHERE topic IN (SELECT topic FROM claims WHERE expires IS NOT NULL AND expires <= ? LIMIT ?)'),
    releasedSome: q('DELETE FROM messages WHERE id IN (SELECT m.id FROM claims c JOIN messages m ON m.topic = c.topic WHERE c.dead = 2 LIMIT ?)'),
    releasedDone: q('DELETE FROM claims WHERE topic IN (SELECT topic FROM claims c WHERE dead = 2 AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.topic = c.topic) LIMIT ?)'),
    // A page in key order after the topic or account read last (sweep): a page of only claims
    // kept longer (a Pro account's, a connected reader's) would otherwise be read again at every
    // sweep, and none after it ever reached.
    idleClaims: q('SELECT topic, client_id, account, last_used FROM claims WHERE topic > ? AND expires IS NULL AND last_used <= ? AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.topic = claims.topic) ORDER BY topic LIMIT ?'),
    claimDelete: q('DELETE FROM claims WHERE topic = ?'),
    idleAccounts: q('SELECT account FROM accounts WHERE account > ? AND last_seen <= ? AND NOT EXISTS (SELECT 1 FROM claims c WHERE c.account = accounts.account) ORDER BY account LIMIT ?'),
    accountDelete: q('DELETE FROM accounts WHERE account = ?'),
    // An index row counts only while its account does: rows an erasure left behind name nobody.
    owner: q('SELECT c.account FROM chain_dids c JOIN accounts a ON a.account = c.account WHERE c.did = ?'),
    didsOf: q('SELECT did FROM chain_dids WHERE account = ? ORDER BY did'),
    didsDrop: q('DELETE FROM chain_dids WHERE account = ?'),
    didSet: q('INSERT INTO chain_dids (did, account) VALUES (?1, ?2) ON CONFLICT (did) DO UPDATE SET account = ?2'),
    counts: q('SELECT (SELECT count(*) FROM claims WHERE dead = 0) AS claims, (SELECT count(DISTINCT client_id) FROM claims WHERE dead = 0) AS clients'),
    poolSent: q('SELECT day, n FROM pool_sent WHERE pool = ?'),
    poolSentAdd: q('INSERT INTO pool_sent (pool, day, n) VALUES (?1, ?2, ?3) ON CONFLICT (pool) DO UPDATE SET n = CASE WHEN day = ?2 THEN n + ?3 ELSE ?3 END, day = ?2'),
    poolSentOld: q('DELETE FROM pool_sent WHERE day < ?'),
    rowBytes: q("SELECT bytes FROM row_totals WHERE k = '*'"),
    rowsOf: q(`SELECT ${ACCOUNT_ROW} + coalesce(length(chain), 0) + (SELECT count(*) FROM chain_dids d WHERE d.account = a.account) * ${DID_ROW} AS bytes FROM accounts a WHERE account = ?`),
    changes: q('SELECT total_changes() AS n'),
  };

  // One transaction around fn; any throw rolls it back and propagates. Never nested: no caller
  // below calls tx() from inside fn.
  const tx = (fn) => {
    db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
  };

  // The sender's side of each message, the day of each login and of each claim's use, until the
  // next flush (the header): account → { day, n } sent that UTC day; operator pool → { day, n }
  // sent under it that day; account → the day of its last login; topic, and client id (every claim
  // of it), → the day it was last used. Lost with the process between two flushes, as plan §6 lets
  // counters be: a claim's day is a day late at most.
  const sent = new Map(), poolsSent = new Map(), seen = new Map(), topicsUsed = new Map(), clientsUsed = new Map();
  function flush() {
    for (const [account, x] of sent) s.accountSent.run(account, x.day, x.n);
    for (const [pool, x] of poolsSent) s.poolSentAdd.run(pool, x.day, x.n);
    for (const [account, day] of seen) s.accountSeen.run(account, day);
    for (const [clientId, day] of clientsUsed) s.claimsTouch.run(day, clientId);
    for (const [topic, day] of topicsUsed) s.claimTouch.run(day, topic);
    sent.clear(); poolsSent.clear(); seen.clear(); clientsUsed.clear(); topicsUsed.clear();
  }
  const checkpoint = () => db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  // The tables the sweep rebuilds in key order (the header): [schema, tables, after], where after()
  // remakes anything else of that module's that holds rows in write order.
  const sorted = [[SCHEMA, ['accounts', 'claims', 'chain_dids', 'pool_sent'], () => tx(() => db.exec(ROWS))]];
  let resorted = -Infinity;
  // Where the sweep's pages of idle claims and idle accounts go on: the last key read, '' = from the start.
  let idleFrom = '', accountFrom = '';
  const pendingSent = (account, now) => { const x = sent.get(account); return x && x.day === Math.floor(now / DAY) ? x.n : 0; };
  const bump = (map, key, now) => {
    const day = Math.floor(now / DAY), x = map.get(key);
    if (x && x.day === day) x.n++; else map.set(key, { day, n: 1 });
  };

  return {
    raw: db, tx,
    // The counters and days kept in memory go to the file first.
    close: () => { tx(flush); db.close(); },
    // For allowance.mjs and operator.mjs: their tables, made WITHOUT ROWID from a file of an
    // earlier version (rebuild above), and rebuilt in key order by the sweep (the header), then
    // after() if given.
    rebuild: (schema, tables) => rebuild(db, schema, tables),
    keepSorted: (schema, tables, after = null) => { sorted.push([schema, tables, after]); },
    // fn() for what may write rows of an identity that must be durable at once (a login, a claim, a
    // licence, a mailbox given up): if it wrote anything, the WAL is checkpointed and truncated
    // before anything else is served, so no commit of that identity's stays in it in front of the
    // next message, which that identity may have written (the header). Also when fn throws: what it
    // wrote before is committed.
    settle: (fn) => {
      const before = s.changes.get().n;
      try { return fn(); } finally { if (s.changes.get().n !== before) checkpoint(); }
    },

    // ---- accounts and the counters M4's allowances read ----
    account: (account) => s.account.get(account),
    // A new account is written now; a known one's day of login waits for the flush.
    touchAccount: (account, now) => {
      if (s.account.get(account) === undefined) s.accountNew.run(account, dayOf(now));
      else seen.set(account, dayOf(now));
    },
    // The rotations of the account's chain as last verified (auth.mjs): [] when none are kept.
    chainOf: (account, originalDid) => openChain(originalDid, account, s.chainOf.get(account)?.chain),
    // dids: every DID of that chain, the original first. Each is indexed to the account (hashed,
    // as account keys are), so auth.mjs can refuse another identity's chain that passes through
    // one. auth.mjs checks before this runs; a row it overwrites is one that login took from
    // another chain by a recovery rotation from that DID, or a row an erasure left behind. Nothing
    // is written when the account already holds exactly this chain and these DIDs: most logins (a
    // carrier sends its bundle at each) change nothing. → whether it wrote.
    setChain: (account, originalDid, rotations, dids = [originalDid]) => {
      const want = dids.map(hashHex).sort(), held = s.didsOf.all(account).map((r) => r.did);
      if (want.join() === held.join() && canonicalize(openChain(originalDid, account, s.chainOf.get(account)?.chain)) === canonicalize(rotations)) return false;
      s.chainSet.run(sealChain(originalDid, account, rotations), account);
      s.didsDrop.run(account);
      for (const d of want) s.didSet.run(d, account);
      return true;
    },
    // The account whose chain holds the DID with this hash: from the index, else the account it is
    // the original of. → the account, or undefined.
    ownerOf: (didHash) => s.owner.get(didHash)?.account ?? (s.account.get(didHash) ? didHash : undefined),
    // One message sent: counted in memory, written at the next flush (the header). pool: the
    // operator pool the sender drew on (allowance.mjs), whose count it stays in whatever the sender
    // does next: counted over its members as they are now, a member that left took its messages
    // out of the pool, and one licence gave its count once per member that left.
    countSent: (account, now, pool = null) => {
      bump(sent, account, now);
      if (pool !== null) bump(poolsSent, pool, now);
    },
    // Messages sent today under the pool: as written, plus those counted since the last flush.
    poolSentToday: (pool, now) => {
      const day = Math.floor(now / DAY), r = s.poolSent.get(pool), x = poolsSent.get(pool);
      return (r && r.day === day ? r.n : 0) + (x && x.day === day ? x.n : 0);
    },
    // What the identity rows take on disk (ROWS): accounts with their chains, claims, chain DIDs.
    rowBytes: () => s.rowBytes.get()?.bytes ?? 0,
    // What one account's row, sealed chain and chain DIDs take, as ROWS counts them: 0 for none.
    rowsOf: (account) => s.rowsOf.get(account)?.bytes ?? 0,
    // Messages sent today: as written, plus those counted since the last flush.
    sentToday: (account, now) => {
      const a = s.account.get(account);
      return (a && a.day === Math.floor(now / DAY) ? a.msgs_day : 0) + pendingSent(account, now);
    },
    pendingSent,
    counters(account, now) {
      return {
        bytes_queued: s.bytesQueued.get(account).n,                                       // charged to the reader
        msgs_today: this.sentToday(account, now),                                          // charged to the sender
        mailboxes: s.mailboxCount.get(account).n,
      };
    },

    // ---- claims ----
    claim: (topic) => s.claim.get(topic),
    // expires (invites): rounded up to the next day's start (times are kept by the UTC day: the
    // header), so an invite topic lives at least its 7 days and at most a day less a second more.
    // Rounding down would cut an invite short of what its code promised.
    // pool: the operator pool it is claimed under (allowance.mjs), or null.
    insertClaim: (topic, account, clientId, now, expires, pool = null) => { s.claimInsert.run(topic, account, clientId, dayOf(now), expires === null ? null : dayOf(expires + DAY - 1), pool); },
    // Kept in memory until the next flush (the header).
    touchClaim: (topic, now) => { topicsUsed.set(topic, dayOf(now)); },
    // A reconnect: every live claim of the client is in use again.
    touchClaims: (clientId, now) => { clientsUsed.set(clientId, dayOf(now)); },
    // limit: at most this many, the most recently claimed first (mailbox.mjs RESTORE_MAX).
    claimsOf: (clientId, now, limit = -1) => s.claimsOf.all(clientId, now, limit).map((r) => r.topic),
    // UNSUBSCRIBE gives a mailbox up: the claim and, by the foreign key, its queued messages go,
    // at most DELETE_BATCH messages in all at once. A mailbox whose queue does not fit what is left
    // of that is marked given up (dead 2) instead: nothing more is stored on it, delivered from it
    // or counted as its reader's mailbox, and reap deletes its queue in batches, then the claim.
    // Deleted whole, one claim's queue held the thread for its length (DELETE_BATCH). An invite
    // topic goes at once: it holds at most 4 messages, 512 for the 128 topics a packet may give
    // up. Its commit names the reader's account: settled (the header). → how many were marked.
    release(clientId, topics) {
      let budget = DELETE_BATCH, marked = 0;
      this.settle(() => tx(() => {
        for (const t of topics) {
          const c = s.claim.get(t);
          if (!c || c.client_id !== clientId) continue;
          const n = c.expires !== null ? 0 : s.topicQueued.get(t, budget + 1).n;
          if (n <= budget) { budget -= n; s.claimRelease.run(t, clientId); } else if (s.claimGiveUp.run(t, clientId).changes > 0) marked++;
        }
      }));
      return marked;
    },
    // An invite topic is used up by the first answer its reader acknowledges: what else is queued
    // goes, and the claim stays as a tombstone (nobody can claim it again) until it expires.
    killInvite: (topic) => tx(() => { s.inviteKill.run(topic); s.topicMessages.run(topic); }),
    countClaims: () => s.counts.get(),

    // ---- queued messages ----
    topicLoad: (topic) => s.topicLoad.get(topic),
    // m.expires rounded down to its day's start: a message is kept at most its retention, as
    // relay/site/privacy.md promises ("at most 7 days"), up to a day less. m.pool: the reader's
    // operator pool, or null (free). seq: one past the reader's highest queued, so it goes down
    // again once the newest are acknowledged (mailbox.mjs reading). → { id: the row's, seq }.
    store: (m) => {
      const seq = s.nextSeq.get(m.clientId).n;
      for (;;) {
        const id = randomId();
        if (s.store.get(id, seq, m.topic, m.clientId, m.account, m.payload, m.payload.length, dayOf(m.expires), m.pool ?? null)) return { id, seq };
      }
    },
    // The packet id of the delivery now in flight. An id is reused by the client after 65,535
    // deliveries: it then leaves the older row, which stays queued for the next reconnect.
    setMessageId: (id, clientId, mid) => tx(() => { s.midClear.run(clientId, mid); s.midSet.run(mid, id, clientId); }),
    // At (re)connect, before anything is delivered: ids of an earlier connection mean nothing now.
    resetMessageIds: (clientId) => { s.midReset.run(clientId); },
    // The reader's PUBACK: the acknowledged message is deleted. → its topic, or undefined.
    take: (clientId, mid) => s.take.get(clientId, mid)?.topic,
    // The reader's queue after seq `after`, in its order: `limit` rows read at most, and of them
    // the ids not yet delivered on this connection, unexpired, of a mailbox not given up. A cap on
    // the rows read, not on the ids found: a run of rows that go nowhere (a long queue given up,
    // then rows after it) is read a page at a time too. → { ids, last: the seq of the last row read
    // (`after` when none), rows: how many were read }.
    unsentPage: (clientId, now, after, limit) => {
      const r = s.unsentPage.all(clientId, now, after, limit);
      return { ids: r.filter((x) => x.go === 1).map((x) => x.id), last: r.length > 0 ? r.at(-1).seq : after, rows: r.length };
    },
    // Whether this message is queued and not yet delivered on this connection.
    unsent: (id) => s.unsentOne.get(id) !== undefined,
    message: (id) => s.message.get(id),

    // ---- retention (plan §3): expired messages, expired invites, idle mailboxes, old accounts ----
    // A claim with nothing queued is idle once unused for idleAfter(account) seconds, at least
    // minIdle (the shortest any account gets). Its last_used is the start of the day it was last
    // used, up to a day before the use itself, so it is idle a day later than its stamp says: a
    // reader offline its retention plus 7 days still finds its claims. online(clientId) → true
    // keeps a connected reader's claims: it may be subscribed right now. The counters and days kept
    // in memory are written first, in the same transaction, so an account seen this minute is not
    // swept as idle; then the WAL is truncated, so neither that commit nor what was deleted stays
    // in it. tidy(now): M4's own retention, in this transaction for the same reason (it may not
    // call tx()). kept(account, now) → true keeps an idle account and its chain (a licensed
    // operator's, an agent's an operator vouched for: allowance.mjs accountKept; with the chain gone,
    // a key its owner recovered from would log in as it again). Every RESORT_EVERY seconds, after
    // that transaction and before the truncation, the tables of identities are rebuilt in key order.
    // One budget of DELETE_BATCH rows for the transaction, taken in this order: expired messages,
    // expired invite topics (5 rows each at most: INVITE_BATCH), idle claims, idle accounts (a row
    // and its chain's DIDs, so the last may take up to 65 more). Every message stored on one UTC day
    // expires at one instant, and every claim used on one day goes idle in one minute: deleted
    // whole, each was one transaction of seconds. Idle claims and accounts are read a page at a
    // time in key order (idleFrom, accountFrom), as many as the room left: a candidate kept longer
    // (idleAfter, online, kept) is passed over until the next round of pages. more: a step was cut
    // short; reap takes the expired messages and invites left, the next sweep the rest.
    sweep(now, { minIdle, idleAfter, accountAfter, online, tidy = () => {}, kept = () => false }) {
      const r = tx(() => {
        flush();
        let room = DELETE_BATCH, more = false;
        const expired = Number(s.expireSome.run(now, room).changes);
        if (expired === room) more = true;
        room -= expired;
        s.poolSentOld.run(Math.floor(now / DAY));
        const inviteLimit = Math.min(INVITE_BATCH, Math.floor(room / 5));
        const invites = inviteLimit > 0 ? Number(s.invitesSome.run(now, inviteLimit).changes) : 0;
        if (invites === inviteLimit) more = true;
        room -= invites * 5;
        let idle = 0;
        if (room > 0) {
          const limit = room, page = s.idleClaims.all(idleFrom, now - minIdle - DAY, limit);
          for (const c of page) {
            if (c.last_used <= now - Math.max(minIdle, idleAfter(c.account)) - DAY && !online(c.client_id)) { s.claimDelete.run(c.topic); idle++; }
          }
          room -= idle;
          idleFrom = page.length === limit ? page.at(-1).topic : '';
          if (idleFrom !== '') more = true;
        } else more = true;
        tidy(now);
        let accounts = 0;
        if (room > 0) {
          const limit = room, page = s.idleAccounts.all(accountFrom, now - accountAfter, limit);
          let last = '', cut = false;
          for (const { account } of page) {
            if (room <= 0) { cut = true; break; }
            last = account;
            if (kept(account, now)) continue;
            s.accountDelete.run(account);
            room -= 1 + Number(s.didsDrop.run(account).changes);
            accounts++;
          }
          accountFrom = cut || page.length === limit ? last : '';
          if (accountFrom !== '') more = true;
        } else more = true;
        return { expired, invites, idle, accounts, more };
      });
      if (now - resorted >= RESORT_EVERY) {
        resorted = now;
        for (const [schema, tables, after] of sorted) { rebuild(db, schema, tables, () => true); after?.(); }
      }
      checkpoint();
      return r;
    },
    // One batch of what the sweep and release left: expired messages, expired invite topics (5
    // rows each at most: the claim and its queue), the queues of mailboxes given up (dead 2), then
    // those claims once empty. At most DELETE_BATCH rows in one transaction; mailbox.mjs runs the
    // next on a later turn of the event loop while `more`: a step cut short by its limit or by the
    // room left may have more. Settled: a claim's deletion names its reader, and the WAL keeps no
    // deleted page image of a message past its batch. → { more }.
    reap(now) {
      return this.settle(() => tx(() => {
        let room = DELETE_BATCH, more = false;
        const step = (limit, per, run) => {
          const n = Math.min(limit, Math.floor(room / per));
          if (n === 0) { more = true; return; }
          const done = Number(run(n).changes);
          room -= done * per;
          if (done === n) more = true;
        };
        step(DELETE_BATCH, 1, (n) => s.expireSome.run(now, n));
        step(INVITE_BATCH, 5, (n) => s.invitesSome.run(now, n));
        step(DELETE_BATCH, 1, (n) => s.releasedSome.run(n));
        step(DELETE_BATCH, 1, (n) => s.releasedDone.run(n));
        return { more };
      }));
    },
  };
}
