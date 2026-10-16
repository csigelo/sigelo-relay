// SPDX-License-Identifier: AGPL-3.0-only
// relay/allowance.mjs — allowances per account and per operator pool, the rate brake, and the policy
// that wires them, the proof of work (pow.mjs) and the licence (operator.mjs) into M3's hooks
// (auth.mjs, mailbox.mjs: `policy`). design/relay-plan.md §1 "Abuse brakes"; §3 "Allowances",
// "Proof of work", "Errors"; §5; §11 "Allowances (pricing leak)", "Topics window and counts".
//
// The tiers (§11): free allowances are per DID, and a DID costs seconds of proof of work (more
// from a network that mints many: pow.mjs), so free volume is not what Pro sells. Free: 14 days,
// 512 KB, a modest daily count, 128 mailboxes (raised 2026-10-14 from 7 days, 256 KB, 1,000 a day,
// 50 MB, 64). Pro sells what cannot be minted: 90 days' retention,
// 1 MB messages, the operator pool, groups (version 2: counted in no table yet), support.
//
// Charged per account (an identity's original DID, db.mjs): bytes queued to the reader, freed when
// it acknowledges a message or the message expires; messages today (UTC) to the sender; live
// claims (mailboxes and invite topics) to their reader. A queued message is charged its size, at
// least 256, plus 384 for the row that holds it (chargeOf), so empty messages fill an allowance
// as fast as they fill the disk. Free readers also stop at a ceiling for the whole relay, below
// relay_full, so free identities alone cannot fill it for everyone; past half of it, one network
// may fill no more than its share (FREE_SHARES). The ceiling counts every queued message and every
// identity row (db.mjs row_totals: accounts with their chains, claims, chain DIDs): past it a free
// identity gets no new claim (quota_mailboxes), and no new free identity and no longer chain of one
// is stored (relay_full; rowsRefusal). A pool's identity rows are held to its storage, beside its
// queue. Rows alone were bounded by relay_full, which then refused every publish and claim, Pro's too. How long
// a message is kept follows the reader, whose queue holds it; the largest message is the smaller of
// the sender's and the reader's; one pooled reader holds at most a share of its pool from writers
// outside it (POOL_SHARES). Publishes, subscribed topics and claims are rate-limited per identity
// and per network. Refusals reach the client as $sigelo/notice {code, detail}:
// quota_storage, quota_messages, quota_mailboxes, too_large, pow, rate. A quota_storage refusing a
// publish also says whose quota it is (side): "reader" (the reader's queue or its pool's, or its
// share of its pool, is full: a free reader full, a lapsed Pro back on the free tier's storage),
// "sender" (the writer's network used its share of the free tier) or "relay" (the free tier is
// full); the detail begins "reader over quota" or "network share used" for the first two. A new
// code would read as stored to clients that do not know it. An identity that has not
// proven work (pow.mjs) may log in, but nothing is stored for it (no account, chain or pool row),
// and its first claim or message is refused "pow". A login whose operator attestation pools
// nothing still succeeds, on the free tier, and is told why ("operator" or "licence") as soon as
// it is connected.
//
// A pool: the operator holding a valid licence, and every agent whose last bundle carried a valid
// operator attestation from it (operator.mjs), draw on one allowance. Never a count of agents. What
// is used under the pool is charged to the pool, whoever uses it: each message stored for a pooled
// reader carries the pool (db.mjs messages.pool, totalled in pool_queue) until it goes, a pooled
// sender's message counts in the pool's day (db.mjs pool_sent), a claim made under the pool counts
// there while it lives. Summed over the members as they are now, a member that left (its
// attestation expired, a login without it, its operator's key rotated) took its usage out of the
// pool, its queue kept its Pro retention, and one licence gave its allowance once per member that
// left. An agent presents its attestation with its bundle; a later login without a bundle
// (auth.mjs's cache) keeps the pool until the attestation's exp, and the operator's key and licence
// are checked again at every use. An agent's account and chain are kept until the latest exp of the
// operator attestations it presented from operators licensed here (vouched), a licensed operator's
// while its licence is kept (operator.mjs): swept 30 days after the last login like any other, the
// chain went with its recovery, and whoever held a key the identity had recovered from logged in as
// it with the old chain and its operator's attestation, or the operator's public licence, and pooled.
import { statfsSync } from 'node:fs';
import { dirname } from 'node:path';
// licence.ts is sigelo's spend/licence.ts (MIT) byte for byte, copied because relay/ is published
// alone; in sigelo's tree relay/site/test.mjs and release/publish.sh --relay refuse a copy that differs.
import { vendorDid } from './licence.ts';
import { DID_RE } from './auth.mjs';
import { ACCOUNT_ROW, CLAIM_ROW, DAY, DID_ROW, chainRowBytes, dayOf } from './db.mjs';
import { LICENCE_RATE, SUPPORT, operators } from './operator.mjs';
import { SCHEMA as GIFT_SCHEMA, UNKNOWN as GIFT_UNKNOWN, giftBrake, giftStore } from './gifts.mjs';
import { C_RE, NETWORK_DAY, NETWORK_STEPS, POW_BITS, POW_LOAD_BITS, powCheck } from './pow.mjs';

export const KB = 1024, MB = 1024 * KB;
// server.mjs closes a connection whose packet is over 1 MB plus its header room: no tier may allow
// a larger message, or a client would see its connection drop instead of a too_large notice.
const FRAME = 1024 * 1024;
// The ISO weeks a reader's mailboxes span: one topic per direction per week (plan §3 "Topics"), and
// a reader subscribes to every week its retention reaches back into (§11): 2 for 7 days, 14 for 90.
export const windowWeeks = (retentionDays) => Math.ceil(retentionDays / 7) + 1;
// Plan §3 "Allowances", §11. free: every identity. pro: the most this relay grants any licence; a
// pool gets the licence's claims (storage_mb, msgs_day, retention_days, groups) up to these and,
// but for groups, never less than free's, pro's largest message and mailboxes, and the licence's
// support. Mailboxes: a contact costs its reader windowWeeks of its retention plus the week ahead
// a client claims, so free's 128 hold about 32 contacts (4 each at 14 days) and pro's 16,384 about 1,090 for a
// whole pool (15 each). pro.storage is 5 GB (2026-10-16; plan §9 item
// 3); pro.groups stays 0 until groups exist (version 2), whatever a licence claims.
export const TIERS = Object.freeze({
  free: Object.freeze({ storage: 100 * MB, msgsDay: 3000, retentionDays: 14, maxMessage: 512 * KB, mailboxes: 128, groups: 0, support: 'none' }),
  pro: Object.freeze({ storage: 5120 * MB, msgsDay: 50000, retentionDays: 90, maxMessage: 1 * MB, mailboxes: 16384, groups: 0, support: 'email' }),
});
const COUNTS = ['storage', 'msgsDay', 'retentionDays', 'maxMessage', 'mailboxes'];
// What a queued message is charged: its payload, at least MESSAGE_FLOOR, plus MESSAGE_ROW for the
// row that holds it. The payload alone let empty messages queue free of charge: a row of db.mjs's
// messages table takes 333 bytes on disk with its four index entries (measured over 100,000 empty
// rows), rounded up here; and no envelope is shorter than one padded block (contact/envelope.mjs
// pads the plaintext to a multiple of 256).
export const MESSAGE_FLOOR = 256, MESSAGE_ROW = 384;
export const chargeOf = (bytes) => Math.max(bytes, MESSAGE_FLOOR) + MESSAGE_ROW;
const chargeSql = (col) => `(max(${col}, ${MESSAGE_FLOOR}) + ${MESSAGE_ROW})`;
// server.mjs's FULL: the share of the database's filesystem in use, every file on it counted, at
// which the relay takes no new claims and no new identities (relay_full). Not imported, because
// server.mjs imports this module; relay/test/allowance.mjs checks that the two agree.
const RELAY_FULL = 0.70;
// Free readers queue nothing more once everything queued here, with the identity rows (db.mjs
// row_totals), is charged half the room the relay has below relay_full, so free identities alone
// cannot reach it and stop everyone. The room is
// what the other files on the disk (the system, logs, the database's free pages and WAL) leave
// below 70 %, measured at start as server.mjs measures use (statfs: blocks, bavail, bsize). What
// the ceiling counts (queued, the queue's charge and the rows) is added back, so a restart with a
// full free tier does not move the ceiling.
// A share of the whole disk let a disk already 40 % used reach relay_full on free messages alone.
// No room left: 1, free readers take nothing. Files that keep growing after start are not seen:
// set RELAY_FREE_QUEUE_MB on such a disk. → bytes.
export function freeQueueOf({ blocks, bavail, bsize }, queued) {
  const room = (RELAY_FULL * blocks - (blocks - bavail)) * bsize + queued;
  return Math.max(1, Math.floor(room / 2));
}
// Plan §1 "Abuse brakes": publishes, and topics subscribed, per identity: a token bucket each,
// refilled every second. One client id per identity, so this is per connection too. Far above
// honest use: the largest pool sends 50,000 messages a day, under one a second, and a reader's
// topics come back with its persistent session, without a SUBSCRIBE. network: the same per
// address prefix (/24 or /48, as auth.mjs counts logins), across every identity logged in from it:
// a login costs no work, so per identity alone one network's sessions times 20 a second could keep
// the one thread busy (a publish refused costs ~250 µs here, one stored ~390 µs, measured on a
// phone-class CPU), and 200 a second is a tenth of it. Identities that have proven no work draw on
// a network bucket of their own, beside the one proven identities share: they cost nothing to mint
// and can claim and send nothing, so in one bucket a few dozen of their sessions took every token
// of a /24 and refused its proven identities (a Pro operator's agents among them) every publish,
// claim and UNSUBSCRIBE. So do identities drawing on an operator pool: a refusal (no_reader, a quota)
// costs a free identity nothing but its tokens, and a dozen of them on a shared /24 kept its bucket
// empty and refused every Pro agent there "rate". Free proven identities on one network still share
// one: per network, nothing tells one free identity from many.
// claim: a mailbox or invite topic claimed anew or given up (mailbox.mjs), beside the subscribe
// token every topic takes. Each is a transaction followed by a WAL checkpoint (db.mjs settle), 7 to
// 8 ms on flash storage (measured 2026-10-12 on the phone-class host with empty claims: claim 8.1
// ms, release 7.2 ms; 0.16 ms on tmpfs; a release deletes at most db.mjs DELETE_BATCH queued
// messages at once, the rest in batches), where a publish costs 0.25 to 0.39 ms: within the subscribe brake alone, one
// network's SUBSCRIBE/UNSUBSCRIBE churn held the thread (PUBACKs elsewhere from 6.5 ms to 220 ms).
// 10 a second per network is ~80 ms of the thread at that cost. An honest agent claims a few
// mailboxes per contact per week: 3 or 4 per contact at its first connection (15 for Pro's 90
// days), so the burst holds a free identity's 128 at once, and an agent with more waits (contact/
// carrier.mjs tries again after a pause). Not yet measured on the relay's VPS: its disk sets it.
// One network can so take about three tenths of the thread, much of it refusals.
// strikes: refusals in a clock minute after which the connection is closed; going on then costs a
// login, which auth.mjs limits per network. Every refused publish counts, whatever its code
// (strike): a refusal that costs a free identity nothing else (no_reader, a quota already reached)
// was otherwise unbounded but by its tokens. Refused topics count only when the brake refused
// them: an honest client asks again at each connection for every topic it wants (a full quota, a
// full disk), and counted, those closed it at every connection.
export const RATE = Object.freeze({
  publish: Object.freeze({ perSecond: 20, burst: 200 }),
  subscribe: Object.freeze({ perSecond: 20, burst: 256 }),
  claim: Object.freeze({ perSecond: 2, burst: 128 }),
  network: Object.freeze({
    publish: Object.freeze({ perSecond: 200, burst: 1000 }),
    subscribe: Object.freeze({ perSecond: 200, burst: 2000 }),
    claim: Object.freeze({ perSecond: 10, burst: 256 }),
  }),
  strikes: 500,
});
const KINDS = ['publish', 'subscribe', 'claim'];
// The free tier's ceiling is one pool for every free reader here, and an identity costs one proof
// of work, so a few identities on one network writing to their own mailboxes (nobody collects
// them) filled it for 7 days and stopped every free delivery. Once the relay holds more than half
// the ceiling, a network that has stored more than ceiling / FREE_SHARES for free readers within
// the free retention is refused (quota_storage): the other half stays for the others. Counted in
// memory by the writer's /24 or /48 and UTC day (a restart forgets it); no address reaches the
// file. Many networks (IPv6 address rotation) still beat it: plan §10, R15.
export const FREE_SHARES = 64;
const SHARE_PREFIXES = 100000;
// New identities proving work in an hour above which the proof rises to 24 bits (RELAY_POW_LOAD).
export const POW_LOAD = 1000;
const TIDY_EVERY = 3600;
const NOTICES = 10000, BUCKETS = 100000;
// The network bucket keys of identities without a proof, and of those drawing on an operator pool:
// a prefix followed by either is never a prefix.
const UNPROVEN = ' unproven', POOLED = ' pooled';
// Within a pool, one reader's queue holds at most this share of the pool's storage (at least the
// free tier's), against writers outside the pool: one contact of one offline agent, a free identity
// among them, otherwise filled the pool for 90 days and every other agent's mail was refused.
export const POOL_SHARES = 4;

const SCHEMA = `
-- WITHOUT ROWID: a rowid would number rows in the order they were written (db.mjs's header).
CREATE TABLE IF NOT EXISTS pool_members (
  account  TEXT PRIMARY KEY,   -- the agent's account
  operator TEXT NOT NULL,      -- the pool it draws on: its operator's account
  key      TEXT NOT NULL,      -- hex SHA-256 of the attestation's iss: it pools while that is the operator's current key
  exp      INTEGER NOT NULL    -- the attestation's exp
) STRICT, WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS pool_members_operator ON pool_members (operator);
CREATE TABLE IF NOT EXISTS pow_proofs (
  account TEXT PRIMARY KEY,    -- an identity that has proven work once (pow.mjs)
  at      INTEGER NOT NULL     -- the start of the UTC day of the proof (db.mjs dayOf: no second-exact time)
) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS vouched (
  account TEXT PRIMARY KEY,    -- an agent that presented an operator attestation of the right shape, from an operator licensed here
  exp     INTEGER NOT NULL     -- the latest exp among them: its account and chain are kept until then (accountKept)
) STRICT, WITHOUT ROWID;
`;
// Charges and messages queued per reader account, and in all (account '*'), kept by triggers on
// db.mjs's messages table, so a quota check reads one row instead of summing the reader's queue
// (100,000 queued rows made every check of that reader cost 45 ms of the one thread). Every way a
// message goes updates them in the same statement: acknowledged, expired, an invite used up, a
// mailbox released or swept (a foreign-key cascade fires the trigger too). Rebuilt from the queue
// at every start, so the counts always follow the charge rule above; made anew, so a table of an
// earlier version with a rowid (the order readers got their first message) goes. pool_queue: the
// same per operator pool, over the messages stored for a reader while it drew on that pool.
const QUEUE = `
DROP TRIGGER IF EXISTS queue_in;
DROP TRIGGER IF EXISTS queue_out;
DROP TABLE IF EXISTS queue_totals;
DROP TABLE IF EXISTS pool_queue;
CREATE TABLE queue_totals (
  account TEXT PRIMARY KEY,    -- a reader's account, or '*': everything queued
  n       INTEGER NOT NULL,    -- messages queued
  bytes   INTEGER NOT NULL     -- their charge (chargeOf)
) STRICT, WITHOUT ROWID;
CREATE TABLE pool_queue (
  pool    TEXT PRIMARY KEY,    -- an operator pool: the operator's account
  n       INTEGER NOT NULL,    -- messages queued that were stored under it
  bytes   INTEGER NOT NULL     -- their charge (chargeOf)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER queue_in AFTER INSERT ON messages BEGIN
  INSERT INTO queue_totals (account, n, bytes) VALUES (new.account, 1, ${chargeSql('new.bytes')}), ('*', 1, ${chargeSql('new.bytes')})
    ON CONFLICT (account) DO UPDATE SET n = n + 1, bytes = bytes + excluded.bytes;
  INSERT INTO pool_queue (pool, n, bytes) SELECT new.pool, 1, ${chargeSql('new.bytes')} WHERE new.pool IS NOT NULL
    ON CONFLICT (pool) DO UPDATE SET n = n + 1, bytes = bytes + excluded.bytes;
END;
CREATE TRIGGER queue_out AFTER DELETE ON messages BEGIN
  UPDATE queue_totals SET n = n - 1, bytes = bytes - ${chargeSql('old.bytes')} WHERE account IN (old.account, '*');
  DELETE FROM queue_totals WHERE account = old.account AND n = 0;
  UPDATE pool_queue SET n = n - 1, bytes = bytes - ${chargeSql('old.bytes')} WHERE pool = old.pool;
  DELETE FROM pool_queue WHERE pool = old.pool AND n = 0;
END;
INSERT INTO queue_totals (account, n, bytes) SELECT account, count(*), sum(${chargeSql('bytes')}) FROM messages GROUP BY account;
INSERT INTO queue_totals (account, n, bytes) SELECT '*', count(*), coalesce(sum(${chargeSql('bytes')}), 0) FROM messages;
INSERT INTO pool_queue (pool, n, bytes) SELECT pool, count(*), sum(${chargeSql('bytes')}) FROM messages WHERE pool IS NOT NULL GROUP BY pool;
`;

// config.tiers: each tier's keys over TIERS's (a test sets the counts it needs), then checked.
function checkTiers(given) {
  const tiers = { free: { ...TIERS.free, ...given.free }, pro: { ...TIERS.pro, ...given.pro } };
  for (const name of ['free', 'pro']) {
    const t = tiers[name];
    for (const k of COUNTS) {
      if (!Number.isSafeInteger(t[k]) || t[k] < 1) throw new Error(`tiers.${name}.${k}: want a whole number, at least 1`);
      if (name === 'pro' && t[k] < tiers.free[k]) throw new Error(`tiers.pro.${k}: want at least tiers.free.${k} (${tiers.free[k]})`);
    }
    if (!Number.isSafeInteger(t.groups) || t.groups < 0) throw new Error(`tiers.${name}.groups: want a whole number, at least 0`);
    if (!SUPPORT.includes(t.support)) throw new Error(`tiers.${name}.support: want one of ${SUPPORT.join(', ')}`);
    if (t.maxMessage > FRAME) throw new Error(`tiers.${name}.maxMessage: at most ${FRAME} bytes (server.mjs's frame cap)`);
  }
  return tiers;
}

function checkRate(rate) {
  for (const [path, r] of [['rate', rate], ['rate.network', rate?.network]]) {
    for (const kind of KINDS) {
      for (const k of ['perSecond', 'burst']) {
        if (!Number.isSafeInteger(r?.[kind]?.[k]) || r[kind][k] < 1) throw new Error(`${path}.${kind}.${k}: want a whole number, at least 1`);
      }
    }
  }
  if (!Number.isSafeInteger(rate.strikes) || rate.strikes < 1) throw new Error('rate.strikes: want a whole number, at least 1');
  return rate;
}

// The filesystem that holds the database, where server.mjs measures disk use too.
function diskOf(db) {
  const file = db.raw.prepare('PRAGMA database_list').all().find((d) => d.name === 'main')?.file;
  if (!file) throw new Error('freeQueue: the database has no file to measure its disk by: set freeQueue');
  return statfsSync(dirname(file));
}

// ctx: what server.mjs passes a policy factory, { db, host, clock, log }. config: { vendor (the
// pinned vendor genesis DID; default licence.ts's vendorDid()), tiers ({free, pro} as TIERS;
// a key left out keeps TIERS's), pow ({bits, loadBits, loadPerHour, steps, perDay}, pow.mjs), licenceRate
// (POST /licence per prefix and minute), gifts ({tries, triesAll}: POST /gift's brakes, gifts.mjs),
// rate (as RATE; a key left out keeps RATE's), freeQueue (bytes; default freeQueueOf the database's disk at start), freeShares
// (as FREE_SHARES) }.
// → the policy: M3's hooks, plus tierOf and freeQueue (for tests and reports).
export function relayPolicy({ db, host, clock, log = () => {} }, config = {}) {
  const tiers = checkTiers(config.tiers ?? TIERS);
  const rate = checkRate({ ...RATE, ...config.rate, network: { ...RATE.network, ...config.rate?.network } });
  const pow = powCheck({ steps: NETWORK_STEPS, ...(config.pow ?? { bits: POW_BITS, loadBits: POW_LOAD_BITS, loadPerHour: POW_LOAD }) });
  if (config.freeQueue !== undefined && (!Number.isSafeInteger(config.freeQueue) || config.freeQueue < 1)) throw new Error('freeQueue: want a whole number of bytes, at least 1');
  const freeShares = config.freeShares ?? FREE_SHARES;
  if (!Number.isSafeInteger(freeShares) || freeShares < 1) throw new Error('freeShares: want a whole number, at least 1');
  const ops = operators({ db, host, clock, log, vendor: config.vendor ?? vendorDid(), rate: config.licenceRate ?? LICENCE_RATE });
  db.rebuild(SCHEMA, ['pool_members', 'pow_proofs', 'vouched']);
  db.raw.exec(GIFT_SCHEMA);   // gift codes (gifts.mjs): granted on the operator's licence row (operator.mjs gift)
  const gifts = giftStore(db.raw), giftCharge = giftBrake(config.gifts);
  db.tx(() => db.raw.exec(QUEUE));
  // Rebuilt in key order by the sweep (db.mjs keepSorted), and the queue's totals put back in key
  // order: copied, not summed afresh as at start, which cost the one thread the whole queue's
  // length every hour (156,000 messages: 0.26 s on tmpfs, measured).
  const resortQueue = () => db.tx(() => {
    for (const [table, key] of [['queue_totals', 'account'], ['pool_queue', 'pool']]) {
      const rows = db.raw.prepare(`SELECT ${key} AS k, n, bytes FROM ${table} ORDER BY ${key}`).all();
      db.raw.exec(`DELETE FROM ${table}`);
      const put = db.raw.prepare(`INSERT INTO ${table} (${key}, n, bytes) VALUES (?, ?, ?)`);
      for (const r of rows) put.run(r.k, r.n, r.bytes);
    }
  });
  db.keepSorted(SCHEMA, ['pool_members', 'pow_proofs', 'vouched'], resortQueue);
  const q = (sql) => db.raw.prepare(sql);
  // After the queue's totals are rebuilt: the default adds back what is queued now.
  const freeQueue = config.freeQueue ?? freeQueueOf(diskOf(db), q("SELECT bytes FROM queue_totals WHERE account = '*'").get().bytes + db.rowBytes());
  const s = {
    member: q('SELECT * FROM pool_members WHERE account = ? AND exp > ?'),
    memberRow: q('SELECT * FROM pool_members WHERE account = ?'),
    memberSet: q('INSERT INTO pool_members (account, operator, key, exp) VALUES (?, ?, ?, ?) ON CONFLICT (account) DO UPDATE SET operator = excluded.operator, key = excluded.key, exp = excluded.exp'),
    memberDrop: q('DELETE FROM pool_members WHERE account = ?'),
    proven: q('SELECT at FROM pow_proofs WHERE account = ?'),
    prove: q('INSERT INTO pow_proofs (account, at) VALUES (?, ?) ON CONFLICT (account) DO UPDATE SET at = excluded.at'),
    unprove: q('DELETE FROM pow_proofs WHERE account = ?'),
    vouched: q('SELECT exp FROM vouched WHERE account = ?'),
    vouch: q('INSERT INTO vouched (account, exp) VALUES (?1, ?2) ON CONFLICT (account) DO UPDATE SET exp = ?2 WHERE exp < ?2'),
    queued: q('SELECT bytes FROM queue_totals WHERE account = ?'),
    claimsHeld: q('SELECT count(*) AS n FROM claims WHERE account = ? AND dead = 0'),
    // What was charged to the pool (the header), whoever is in it now.
    poolBytes: q('SELECT bytes FROM pool_queue WHERE pool = ?'),
    poolClaims: q('SELECT count(*) AS n FROM claims WHERE pool = ? AND dead = 0'),
    // The identity rows of a pool, the operator's own and its members' (db.mjs ROWS counts them so),
    // but those of one account (?2): login() adds what that account's will take.
    poolRows: q(`SELECT
      (SELECT count(*) * ${ACCOUNT_ROW} + coalesce(sum(length(chain)), 0) FROM accounts WHERE account <> ?2 AND (account = ?1 OR account IN (SELECT account FROM pool_members WHERE operator = ?1)))
      + (SELECT count(*) * ${DID_ROW} FROM chain_dids WHERE account <> ?2 AND (account = ?1 OR account IN (SELECT account FROM pool_members WHERE operator = ?1))) AS bytes`),
    // A proof is written before its login creates the account (pow comes first): one from before
    // today without an account belongs to a login that failed after it, or a swept account.
    tidyProofs: q('DELETE FROM pow_proofs WHERE at < ? AND account NOT IN (SELECT account FROM accounts)'),
    tidyMembers: q('DELETE FROM pool_members WHERE exp <= ? OR account NOT IN (SELECT account FROM accounts)'),
    tidyVouched: q('DELETE FROM vouched WHERE exp <= ? OR account NOT IN (SELECT account FROM accounts)'),
  };
  const notices = new Map();   // account → { code, detail } for its next connection (operator, licence)
  const buckets = new Map();   // account → { publish, subscribe, claim: a bucket each, window, refused }
  const networks = new Map();  // address prefix, + UNPROVEN or POOLED (RATE) → { publish, subscribe, claim: a bucket each }
  const shares = new Map();    // address prefix → Map(UTC day → bytes stored for free readers): FREE_SHARES
  let tidied = -Infinity, broker = null;

  // The account's allowance at `now`: { pool: the operator's account, or null (free), limits }.
  function tierOf(account, now) {
    let lic = ops.licenceOf(account, null, now);   // the operator itself
    if (!lic) {
      const m = s.member.get(account, now);
      lic = m ? ops.licenceOf(m.operator, m.key, now) : null;
    }
    return tierOfLicence(lic);
  }
  // lic: a valid licence (operator.mjs licenceOf), or null for the free tier.
  function tierOfLicence(lic) {
    const free = tiers.free, pro = tiers.pro;
    if (!lic) return { pool: null, limits: { ...free, retention: free.retentionDays * DAY } };
    // The licence's number, at most pro's, and never below free's: a licence sold under the free
    // tier must not leave a paying pool worse off than one free identity. Gift months alone (no
    // licence holds: operator.mjs licenceOf) give pro's numbers.
    const sold = (n, k) => (lic.gift ? pro[k] : Math.max(free[k], Math.min(n, pro[k])));
    const retentionDays = sold(lic.retention_days, 'retentionDays');
    return {
      pool: lic.operator,
      limits: {
        storage: sold(lic.storage_mb * MB, 'storage'), msgsDay: sold(lic.msgs_day, 'msgsDay'), retentionDays, retention: retentionDays * DAY,
        maxMessage: pro.maxMessage, mailboxes: pro.mailboxes, groups: lic.gift ? pro.groups : Math.min(lic.groups, pro.groups), support: lic.gift ? pro.support : lic.support,
      },
    };
  }
  // What the free tier's ceiling counts: every queued message's charge and the identity rows.
  const freeUsed = () => (s.queued.get('*')?.bytes ?? 0) + db.rowBytes();
  const whose = (t) => (t.pool ? 'your operator\'s pool' : 'this identity (free tier)');
  const readerOf = (t) => (t.pool ? 'the reader\'s pool' : 'the reader (free tier)');

  // Accounts and proofs swept by M3 (30 days after the last login) take their rows here along,
  // pool rows and vouched ones go at their exp, licences 30 days after theirs (operator.mjs): plan §5
  // "Privacy". At most hourly, from the sweep, inside its transaction (db.mjs): it runs after the
  // counters kept in memory are written and before the WAL is truncated. Run from a login, it wrote
  // every sender's count mid-minute, in a commit beside the reader's message, and left it in the WAL.
  function tidy(now) {
    if (now - tidied < TIDY_EVERY) return;
    tidied = now;
    s.tidyProofs.run(dayOf(now));
    s.tidyMembers.run(now);
    s.tidyVouched.run(now);
    ops.tidy(now);
    gifts.sweep(now);
  }

  // Bytes stored for free readers from `prefix` within the free retention (FREE_SHARES); older
  // days go as they are read.
  function sharedBy(prefix, day) {
    const m = shares.get(prefix);
    let n = 0;
    if (m) for (const [d, b] of m) if (d <= day - tiers.free.retentionDays) m.delete(d); else n += b;
    return n;
  }
  function share(prefix, day, bytes) {
    let m = shares.get(prefix);
    if (!m) {
      if (shares.size >= SHARE_PREFIXES) shares.delete(shares.keys().next().value);
      m = new Map();
      shares.set(prefix, m);
    }
    m.set(day, (m.get(day) ?? 0) + bytes);
  }

  // A login's rows (db.mjs chainRowBytes: the account, its sealed chain, a row per DID of it),
  // against what the account holds now. Grown, they must fit: a free identity's under the free
  // tier's ceiling (freeUsed counts every identity's rows), a pooled one's with its pool's other
  // identity rows within the pool's storage, a cap of their own beside the pool's queue. Checked
  // only at a new identity's first login, and against ACCOUNT_ROW, a chain sent again longer grew
  // free rows past the ceiling up to relay_full, which refuses every publish, Pro's too; and a
  // pooled new identity was checked against nothing and charged to nobody. One growth passes the
  // cap: a recovery that adds at most one edge to a chain whose last edge is not one, so the owner
  // of a stolen key takes it back however full the tier is (SPEC §7.1: refused, the thief kept
  // logging in with the chain held), and an identity minting recoveries of its own gains one edge.
  // lic: the licence the identity draws on, or null. → null, or why not.
  function rowsRefusal({ account, original, rotations, dids, isNew, now, lic }) {
    const before = isNew ? 0 : db.rowsOf(account), after = chainRowBytes(rotations, dids);
    if (after <= before) return null;
    const t = tierOfLicence(lic), others = t.pool === null ? 0 : s.poolRows.get(t.pool, account).bytes;
    if (t.pool === null ? freeUsed() + after - before <= freeQueue : others + after <= t.limits.storage) return null;
    if (!isNew) {
      const held = db.chainOf(account, original);
      if (rotations.length <= held.length + 1 && rotations.at(-1)?.body?.reason === 'recovery' && held.at(-1)?.body?.reason !== 'recovery') return null;
    }
    return t.pool === null
      ? `this relay's free tier is full (${freeQueue} bytes queued and held for identities in all): it stores no new free identity, and no longer chain of one, until messages are collected or expire`
      : `your operator's pool holds ${others} bytes of identity rows besides this one's ${after}, more than its storage (${t.limits.storage}): it stores no new agent of the pool, and no longer chain of one`;
  }

  // A bucket left alone this long is full again, as good as a new one: it can be forgotten.
  const full = (b, lim, now) => b.tokens + Math.max(0, now - b.at) * lim.perSecond >= lim.burst;
  function forget(map, lim, now) {
    for (const [key, b] of map) if (KINDS.every((k) => full(b[k], lim[k], now))) map.delete(key);
    while (map.size > BUCKETS * 0.9) map.delete(map.keys().next().value);
  }
  const bucket = (lim, now) => ({ tokens: lim.burst, at: now });
  const buckets3 = (lim, now) => ({ publish: bucket(lim.publish, now), subscribe: bucket(lim.subscribe, now), claim: bucket(lim.claim, now) });
  // The account's buckets, made full at its first request (and again once forgotten).
  function bucketsOf(account, now) {
    let b = buckets.get(account);
    if (!b) {
      if (buckets.size >= BUCKETS) forget(buckets, rate, now);
      b = { ...buckets3(rate, now), window: -1, refused: 0 };
      buckets.set(account, b);
    }
    return b;
  }
  // One refusal more in this clock minute; past rate.strikes the connection is closed (RATE).
  function strike(b, clientId, now) {
    const w = Math.floor(now / 60);
    if (b.window !== w) { b.window = w; b.refused = 0; }
    if (++b.refused > rate.strikes) { b.refused = 0; close(clientId); }
  }
  const refill = (k, lim, now) => {
    k.tokens = Math.min(lim.burst, k.tokens + Math.max(0, now - k.at) * lim.perSecond);
    if (now > k.at) k.at = now;
  };
  // Closed after the hook returns: Aedes is inside its packet handler then.
  function close(clientId) {
    const client = broker?.clients[clientId];
    if (!client) return;
    log('rate: connection closed after repeated refusals');
    setImmediate(() => client.close());
  }

  return {
    // GET /challenge's pow_bits: what a new identity's proof must meet with the nonce issued now to
    // `network` (auth.mjs's key for the /24 or /48 asking; pow.mjs), which carries it, valid until
    // `exp`. The challenge waits from now on: it counts as an arrival to come until a login spends
    // its nonce (powSpent) or it expires, so challenges fetched ahead cannot all state the base.
    // One of them missing is auth.mjs's bug: thrown (GET /challenge answers 500), never a count skipped.
    powBits({ network, exp, now }) {
      if (typeof network !== 'string' || !Number.isInteger(exp) || !Number.isInteger(now)) throw new Error('policy.powBits: auth.mjs passes no network, exp or now');
      return pow.issue(now, network, exp);
    },
    // A login spent the nonce of a challenge issued to `network` until `exp` (auth.mjs, once per
    // nonce, whatever the login's outcome): it waits no more. A good proof with it is an arrival
    // (pow, below).
    powSpent({ network, exp, now }) {
      if (typeof network !== 'string' || !Number.isInteger(exp) || !Number.isInteger(now)) throw new Error('policy.powSpent: auth.mjs passes no network, exp or now');
      pow.spent(now, network, exp);
    },

    // Every publish and every topic subscribed or given up, before any other work, and every claim
    // made anew or given up besides (mailbox.mjs: kind "claim"). → null, or the refusal { code:
    // "rate", detail }, which counts as a strike.
    // prefix: the client's address cut to /24 or /48 (auth.mjs), for the network's bucket: the one
    // its free proven identities share, the one of those drawing on an operator pool, or the one of
    // those that have proven no work (RATE); a token is taken from both or from neither.
    rate({ account, clientId, kind, now, prefix }) {
      if (!KINDS.includes(kind)) return { code: 'rate', detail: `no rate for ${JSON.stringify(kind)}: refused` };
      const lim = rate[kind], nlim = rate.network[kind], b = bucketsOf(account, now);
      let n = null, proven = true, pooled = false;
      if (prefix !== undefined) {
        // Read here, where sender() and claim() read them: no copy kept in memory that a proof, a
        // licence or a sweep could leave stale.
        proven = s.proven.get(account) !== undefined;
        pooled = proven && tierOf(account, now).pool !== null;
        const key = !proven ? prefix + UNPROVEN : pooled ? prefix + POOLED : prefix;
        n = networks.get(key);
        if (!n) {
          if (networks.size >= BUCKETS) forget(networks, rate.network, now);
          n = buckets3(rate.network, now);
          networks.set(key, n);
        }
        refill(n[kind], nlim, now);
      }
      const k = b[kind];
      refill(k, lim, now);
      if (k.tokens >= 1 && (!n || n[kind].tokens >= 1)) { k.tokens -= 1; if (n) n[kind].tokens -= 1; return null; }
      const who = k.tokens >= 1
        ? `this network (${nlim.burst} at once, ${nlim.perSecond} a second, every identity on it ${!proven ? 'without a proof of work' : pooled ? 'drawing on an operator pool' : 'on the free tier'} together)`
        : `this identity (${lim.burst} at once, ${lim.perSecond} a second)`;
      strike(b, clientId, now);
      // Every refusal is named. A publish dropped without a notice is acknowledged all the same, so
      // its writer took it for stored (contact/carrier.mjs reported it "sent"); one notice per
      // refused packet, and the strikes close a connection past them in a minute.
      const what = { publish: 'messages', subscribe: 'topics subscribed or given up', claim: 'mailboxes claimed or given up' }[kind];
      return { code: 'rate', detail: `too many ${what} from ${who}: dropped; slow down` };
    },
    // A publish refused by any other check (mailbox.mjs: no_reader, too_large, a quota, relay_full,
    // pow) counts as a strike too (RATE).
    strike({ account, clientId, now }) { strike(bucketsOf(account, now), clientId, now); },

    // Every login (auth.mjs, before the account is touched). A proof is hashed once per identity:
    // from an identity that has proven work already, only its shape is checked. bits, network: what
    // the login's nonce states (auth.mjs): the difficulty GET /challenge gave with it, and the
    // network that asked, which the arrival counts against (pow.mjs). Either missing is auth.mjs's
    // bug: thrown, so the login fails as the relay's own error, never with a proof unchecked.
    pow({ pow: c, host: h, account, original, nonce, isNew, now, bits, network }) {
      if (typeof original !== 'string') throw new Error('policy.pow: auth.mjs passes no original DID');
      if (!Number.isInteger(bits) || typeof network !== 'string') throw new Error('policy.pow: auth.mjs passes no bits or network from the nonce');
      let proof = s.proven.get(account);
      // A new identity's proof from before today belongs to a swept account (30 days unused): void.
      // One from today belongs to a login of this identity that stored nothing (relay_full, a session
      // cap): kept, so a retry reuses it. Voided as well, it cost every retry a new proof and one
      // more arrival against its network, until honest retries behind one NAT were told that network
      // had brought its most for the day. tidyProofs clears it tomorrow if nothing is stored.
      if (isNew && proof && proof.at < dayOf(now)) { s.unprove.run(account); proof = undefined; }
      if (c === undefined) return null;
      if (typeof c !== 'string' || !C_RE.test(c)) return 'want c as a string of 1 to 16 decimal digits';
      if (proof) return null;
      // Before the hash: whatever the proof, a network past its count of new identities brings no
      // more today (pow.mjs: proof of work alone does not bound what a native solver mints).
      if (pow.capped(now, network)) return `the network this login's challenge came from brought ${pow.perDay} new identities here in the last 24 hours, the most one network may: try again tomorrow`;
      const why = pow.check({ pow: c, host: h, original, nonce, bits });
      if (why) return why;
      s.prove.run(account, dayOf(now));
      // An arrival is counted at a good proof, not at every login of an unknown identity: raising
      // the difficulty for every newcomer must cost whoever raises it the work too.
      pow.arrived(now, network);
      return null;
    },

    // Every login, after the proof (pow, above): whether a new identity's account and chain are
    // stored (auth.mjs). Only once it has proven work: logins cost none, so rows for every fresh DID
    // would fill the disk for everyone with free identities alone, past the ceiling freeQueue sets
    // for messages. Before, it can log in and is told "pow" at its first claim or publish.
    keep: ({ account }) => s.proven.get(account) !== undefined,

    // Every login, after every login check: the login proceeds (the free tier at least), unless the
    // rows it would store do not fit (rowsRefusal). rotations: the rotation on each edge of
    // result.chain (auth.mjs). original: the identity's original DID.
    login({ account, original, current, result, rotations, isNew, now }) {
      ops.loggedIn(account, current, result?.chain, rotations);   // a licensed operator's own login: its current key
      if (result === undefined) { notices.delete(account); return null; }
      const { member, notice, keep } = ops.present(result, now);
      const row = s.memberRow.get(account), proven = s.proven.get(account) !== undefined;
      const lic = member === null ? null : ops.licenceOf(member.operator, member.key, now);
      // auth.mjs stores the account and chain of a known identity, and of a new one with a proof.
      // The licence its rows go to, in tierOf's order: an operator's own first, then its pool's.
      if (!isNew || proven) {
        const why = rowsRefusal({ account, original, rotations, dids: result.chain, isNew, now, lic: ops.licenceOf(account, null, now) ?? lic });
        if (why) return { check: 'relay_full', detail: why };
      }
      // Pool membership is a row too: written only for an identity that has proven work, and only
      // when it changed (each write is a commit in the WAL beside what this agent sends next: db.mjs).
      if (member && proven) {
        if (row?.operator !== member.operator || row?.key !== member.key || row?.exp !== member.exp) s.memberSet.run(account, member.operator, member.key, member.exp);
      } else if (row) s.memberDrop.run(account);
      if (proven && keep > (s.vouched.get(account)?.exp ?? 0)) s.vouch.run(account, keep);
      notices.delete(account);
      if (notice) {
        if (notices.size >= NOTICES) notices.delete(notices.keys().next().value);
        notices.set(account, notice);
      }
      return null;
    },

    // A new claim, inside the transaction that inserts it (mailbox.mjs): pow, then quota_mailboxes.
    claim({ account, now }) {
      if (!s.proven.get(account)) {
        return { code: 'pow', detail: 'a new identity proves work once, before its first claim: log in again with pow, to the pow_bits GET /challenge gives' };
      }
      const t = tierOf(account, now);
      const held = t.pool ? s.poolClaims.get(t.pool).n : s.claimsHeld.get(account).n;
      if (held >= t.limits.mailboxes) return { code: 'quota_mailboxes', detail: `${whose(t)} holds ${t.limits.mailboxes} mailboxes and invite topics, its most: unsubscribe from one first` };
      if (!t.pool && freeUsed() + CLAIM_ROW > freeQueue) {
        return { code: 'quota_mailboxes', detail: `this relay's free tier is full (${freeQueue} bytes queued and held for identities in all): no new mailbox for a free identity until messages are collected or expire` };
      }
      return null;
    },

    // A message's sender, before any transaction (mailbox.mjs): its proof of work, one row read, so
    // an identity that has proven none never opens one. → null, or the refusal. Every refusal is
    // named (rate, above): each publish draws on the rate brake first, which bounds the notices.
    sender({ sender }) {
      if (s.proven.get(sender)) return null;
      return { code: 'pow', detail: 'a new identity proves work once, before its first claim or message: log in again with pow, to the pow_bits GET /challenge gives' };
    },

    // A message to store, inside the transaction that stores it: the sender's proof of work (asked
    // already by sender(), and again here so no path stores for an unproven sender), its count,
    // then the reader's queue, then (free readers) the relay's and the network's share of it. Each
    // a few row reads, whatever is queued. The sender's messages today are counted on its account
    // row, which exists only once it has proven work (keep): before, it sends nothing. prefix: the
    // sender's address cut to /24 or /48, memory only (FREE_SHARES).
    publish({ sender, reader, bytes, now, prefix }) {
      if (!s.proven.get(sender)) return { code: 'pow', detail: 'a new identity proves work once, before its first claim or message: log in again with pow, to the pow_bits GET /challenge gives' };
      const day = Math.floor(now / DAY);
      const ts = tierOf(sender, now);
      const sent = ts.pool ? db.poolSentToday(ts.pool, now) : db.sentToday(sender, now);
      if (sent >= ts.limits.msgsDay) return { code: 'quota_messages', detail: `${whose(ts)} sent ${ts.limits.msgsDay} messages today, its most: the count starts again at 00:00 UTC` };
      const tr = tierOf(reader, now), charge = chargeOf(bytes);
      const queued = tr.pool ? s.poolBytes.get(tr.pool)?.bytes ?? 0 : s.queued.get(reader)?.bytes ?? 0;
      if (queued + charge > tr.limits.storage) {
        return { code: 'quota_storage', side: 'reader', detail: `reader over quota: ${readerOf(tr)} has ${queued} of ${tr.limits.storage} bytes queued (a message counts its size, at least ${MESSAGE_FLOOR}, plus ${MESSAGE_ROW}): it frees as messages are collected or expire` };
      }
      // A pooled reader's own share, against writers outside its pool (POOL_SHARES); its pool's
      // members write to it on the whole pool.
      if (tr.pool && ts.pool !== tr.pool) {
        const mine = s.queued.get(reader)?.bytes ?? 0, most = Math.max(tiers.free.storage, Math.floor(tr.limits.storage / POOL_SHARES));
        if (mine + charge > most) {
          return { code: 'quota_storage', side: 'reader', detail: `reader over quota: the reader has ${mine} of ${most} bytes queued, the most one agent of its pool holds from writers outside it (1/${POOL_SHARES} of the pool's ${tr.limits.storage}, at least ${tiers.free.storage}): it frees as messages are collected or expire` };
        }
      }
      if (!tr.pool) {
        const all = freeUsed(), mine = prefix === undefined ? 0 : sharedBy(prefix, day);
        if (all + charge > freeQueue) {
          return { code: 'quota_storage', side: 'relay', detail: `this relay's free tier is full (${freeQueue} bytes queued and held for identities in all): free readers take nothing more until messages are collected or expire` };
        }
        if (prefix !== undefined && all + charge > freeQueue / 2 && mine + charge > freeQueue / freeShares) {
          return { code: 'quota_storage', side: 'sender', detail: `network share used: this relay's free tier is more than half full, and your network stored ${mine} bytes for free readers in the last ${tiers.free.retentionDays} days, its share (1/${freeShares} of ${freeQueue}): nothing more from it until messages are collected or expire` };
        }
        if (prefix !== undefined) share(prefix, day, charge);
      }
      return null;
    },

    // The smaller of the sender's largest message and the reader's: the reader's alone let a free
    // identity send a pooled reader 1 MB messages, kept on the pool for up to 90 days.
    maxMessage: ({ sender, reader, now }) => Math.min(tierOf(sender, now).limits.maxMessage, tierOf(reader, now).limits.maxMessage),
    // The operator pool `account` draws on now, or null (mailbox.mjs): what it uses stays charged there.
    pool: (account, now) => tierOf(account, now).pool,
    retention: (account) => tierOf(account, clock()).limits.retention,
    // The sweep (mailbox.mjs, db.mjs): this policy's retention, and the accounts it keeps idle: a
    // licensed operator's, while the licence is kept (operator.mjs licensed), and an agent's until
    // its operator attestations expire (vouched; the header).
    tidy,
    accountKept: (account, now) => ops.licensed(account) || (s.vouched.get(account)?.exp ?? 0) > now,

    // POST /licence (auth.mjs's HTTP server).
    licence: (req) => ops.http(req),

    // POST /gift (auth.mjs's HTTP server, gifts.mjs): charge(prefix, now) first, before the body or
    // the login (throws rate); then, once the login passed with proof of work, redeem. account: the
    // identity's, which becomes the operator; current: the DID its login was signed by. An identity
    // drawing on an operator's pool is refused before the code is looked at: a gift is the
    // operator's, and redeemed by an agent it would take that agent out of its pool. → the body.
    gift: {
      charge: (prefix, now) => giftCharge(prefix, now),
      redeem({ account, current, code_hash }, now) {
        if (s.member.get(account, now)) {
          return { ok: false, check: 'gift_member', detail: 'this identity draws on an operator\'s pool: a gift code is redeemed by the operator identity (SIGELO_IDENTITY=<the operator\'s file> sigelo-agent pro redeem <code>); the code is not used' };
        }
        // Settled: the commit names the operator's row (db.mjs's header).
        return db.settle(() => db.tx(() => {
          const g = gifts.peek(code_hash, now);
          if (g === null) return GIFT_UNKNOWN;
          const r = ops.gift(account, current, g.months, now);
          if (!r.ok) return r;
          gifts.take(code_hash, g.campaign);
          return { ok: true, exp: r.exp, months: g.months };
        }));
      },
    },
    // GET /stats: codes loaded and used, over all campaigns (a label is never public).
    giftTotals: () => gifts.totals(),

    // After the broker starts (server.mjs): an operator or licence notice goes to the client once
    // its session is up.
    attach({ broker: b, notify, sessionOf }) {
      broker = b;
      broker.on('clientReady', (client) => {
        const account = sessionOf(client)?.account, n = account && notices.get(account);
        if (!n) return;
        notices.delete(account);
        notify(client, n.code, n.detail);
      });
    },

    tierOf,
    freeQueue,
    freeUsed,   // GET /stats (stats.mjs): the free tier's ceiling used
  };
}

// The relay's environment (server.mjs fromEnv): → the policy factory, checked now. die(why) is
// called on a bad value.
//   RELAY_VENDOR_DID      the vendor's genesis DID licences must chain to (default: licence.ts's
//                         vendorDid(), i.e. SIGELO_VENDOR_DID or the D1 placeholder)
//   RELAY_PRO_STORAGE_MB  the most storage any pool gets (default 1024: a placeholder)
//   RELAY_POW_BITS        proof of work for a new identity (default 22; + 2 and + 4 from a network
//                         at 8 and 64 new identities in a day, challenges it holds unredeemed
//                         counted: pow.mjs NETWORK_STEPS; 64 good proofs close it, below)
//   RELAY_POW_LOAD_BITS   …while more new identities than RELAY_POW_LOAD prove work in an hour,
//                         challenges unredeemed counted (24)
//   RELAY_POW_LOAD        new identities an hour (default 1000)
//   RELAY_POW_NETWORK_DAY new identities one /24 or /48 may bring in 24 hours (default 64, pow.mjs
//                         NETWORK_DAY): past it the next is refused "pow", an operator's agent too
//   RELAY_FREE_QUEUE_MB   queued in all, past which free readers take nothing more (default: half
//                         the room below relay_full the database's disk has at start, freeQueueOf;
//                         set it on a disk whose other files keep growing)
export function relayPolicyFromEnv(env, die = (why) => { throw new Error(why); }) {
  const whole = (name, def, min, max) => {
    const v = env[name];
    if (v === undefined || v === '') return def;
    if (!/^\d+$/.test(v) || Number(v) < min || Number(v) > max) die(`${name}: want a whole number from ${min} to ${max}, got ${JSON.stringify(v)}`);
    return Number(v);
  };
  const vendor = env.RELAY_VENDOR_DID || vendorDid();
  if (!DID_RE.test(vendor)) die('RELAY_VENDOR_DID: want the vendor\'s genesis DID, did:sigelo:z…');
  const config = {
    vendor,
    tiers: { free: TIERS.free, pro: { ...TIERS.pro, storage: whole('RELAY_PRO_STORAGE_MB', TIERS.pro.storage / MB, 1, 1e7) * MB } },
    pow: { bits: whole('RELAY_POW_BITS', POW_BITS, 0, 64), loadBits: whole('RELAY_POW_LOAD_BITS', POW_LOAD_BITS, 0, 64), loadPerHour: whole('RELAY_POW_LOAD', POW_LOAD, 1, 1e9), steps: NETWORK_STEPS,
      perDay: whole('RELAY_POW_NETWORK_DAY', NETWORK_DAY, 1, 1e6) },
  };
  const freeMb = whole('RELAY_FREE_QUEUE_MB', undefined, 1, 1e9);
  if (freeMb !== undefined) config.freeQueue = freeMb * MB;
  try { checkTiers(config.tiers); powCheck(config.pow); } catch (e) { die(e.message); }
  return (ctx) => relayPolicy(ctx, config);
}
