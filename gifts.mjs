#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// relay/gifts.mjs — Pro gift codes (contract sigelo-gift/0: contact/short.mjs giftHash).
//
//   POST /gift     {username, client_id, password, code_hash}: the login fields of POST /check
//                  (auth.mjs: a fresh GET /challenge nonce, signed, spent here) of the OPERATOR
//                  identity, then the code's hash → {ok: true, exp, months} | {ok: false, check, detail}
//   node gifts.mjs load <file>   (or - for stdin) as the relay's user, the relay running or not:
//                  the lines the offline issuer writes, {code_hash, months, expires, campaign}
//                  each, into the relay's database (RELAY_DB, the relay's default) → one line of counts
//   node gifts.mjs counts        the same way: per campaign, codes loaded and used, as JSON
//
// A gift code is PRO- and 8 characters of a short code's alphabet, 40 bits from a CSPRNG, made
// offline by the vendor in batches (a campaign). The relay is given, per code, only code_hash = hex
// SHA-256("sigelo-gift/0" ‖ the normalised 8 characters), the months it grants (1, 6 or 12), the
// day it can no longer be redeemed and the campaign's label; a client sends the hash, never the
// code. No log line or refusal names a code or its hash.
//
// Redeemed by a logged-in identity that has proven its work (it has an account here) and draws on
// no operator's pool: that identity is the operator, as a licence's sub is (operator.mjs), and its
// pool is Pro for the months, from the end of the Pro it holds (operator.mjs gift: the licence's
// exp while it holds, or a running gift's). One use. Unknown, malformed, used and expired codes
// get the same refusal, `gift`, by the same path: one row read by its key.
//
// A row says nothing of who used it: `redeemed` is 1 or 0, no time, no account. It stays until its
// expiry, so loading the same file again cannot make a used code good; the sweep (allowance.mjs
// tidy, hourly) deletes it then, used or not. gift_campaigns keeps per campaign the codes loaded
// and the codes used, counts only, read on the relay host (node gifts.mjs counts); GET /stats
// (stats.mjs) shows the totals over all campaigns only: a label is never public.
//
// Brakes, per /24 or /48 (auth.mjs prefixOf): TRIES redemptions an hour, counted before the login
// or the code is checked; across all networks TRIES_ALL an hour, charged after the network's own
// passes. With 2^40 codes and N loaded, one network's guesses hit with odds of at most
// 10 × N / 2^40 an hour (N = 100,000: under 1 in a million), every network's at most 300 × N / 2^40.
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const DAY = 86400;
export const MONTHS = Object.freeze([1, 6, 12]);
// A campaign label: lowercase words and digits, nothing that carries text.
export const CAMPAIGN_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const HASH_RE = /^[0-9a-f]{64}$/;
export const GIFT_FIELDS = ['username', 'client_id', 'password', 'code_hash'];
export const TRIES = { n: 10, window: 3600 }, TRIES_ALL = { n: 300, window: 3600 };
// A code may be loaded until this long before its expiry is reached, at most (the generator's cap).
export const EXPIRES_MAX = 3 * 366 * DAY;
// The one refusal for every code that grants nothing: no hint of which it was.
export const UNKNOWN = Object.freeze({ ok: false, check: 'gift', detail: 'no gift code this relay can redeem: mistyped, used already, or past its date; check it with whoever gave it to you' });

// WITHOUT ROWID (db.mjs's header): rows keyed by a hash keep no order of writing.
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS gifts (
  code_hash TEXT PRIMARY KEY,      -- hex SHA-256("sigelo-gift/0" ‖ the code's 8 characters): never the code
  campaign  TEXT NOT NULL,
  months    INTEGER NOT NULL,      -- 1, 6 or 12
  expires   INTEGER NOT NULL,      -- the start of the UTC day from which it no longer redeems; the row goes then
  redeemed  INTEGER NOT NULL DEFAULT 0  -- 1 once used: no time, no account
) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS gift_campaigns (
  campaign TEXT PRIMARY KEY,
  issued   INTEGER NOT NULL DEFAULT 0,  -- codes loaded
  redeemed INTEGER NOT NULL DEFAULT 0   -- codes used
) STRICT, WITHOUT ROWID;
`;

// The start of the UTC day of t, and t moved on by n calendar months (the day of the month kept,
// or the month's last: 31 January + 1 = 28 or 29 February).
export const dayOf = (t) => Math.floor(t / DAY) * DAY;
export function addMonths(t, n) {
  const d = new Date(t * 1000), y = d.getUTCFullYear(), m = d.getUTCMonth() + n;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return Date.UTC(y, m, Math.min(d.getUTCDate(), last), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()) / 1000;
}

/** The records of a load file (JSON lines), each checked: → [{code_hash, months, expires, campaign}]
 *  or throws naming the line. Fail closed: one bad line refuses the file. now: Unix seconds. */
export function readRecords(text, now) {
  const out = [], seen = new Set();
  const lines = String(text).split('\n');
  for (const [i, line] of lines.entries()) {
    if (line.trim() === '') continue;
    const at = `line ${i + 1}`;
    let r;
    try { r = JSON.parse(line); } catch { throw new Error(`${at}: not JSON`); }
    if (r === null || typeof r !== 'object' || Array.isArray(r) || Object.keys(r).sort().join() !== 'campaign,code_hash,expires,months') throw new Error(`${at}: want exactly {code_hash, months, expires, campaign}`);
    if (typeof r.code_hash !== 'string' || !HASH_RE.test(r.code_hash)) throw new Error(`${at}: code_hash: 64 lowercase hex digits`);
    if (!MONTHS.includes(r.months)) throw new Error(`${at}: months: ${MONTHS.join(', ')}`);
    if (!Number.isSafeInteger(r.expires) || r.expires % DAY !== 0) throw new Error(`${at}: expires: the start of a UTC day, Unix seconds`);
    if (r.expires <= now) throw new Error(`${at}: expired already (${new Date(r.expires * 1000).toISOString().slice(0, 10)})`);
    if (r.expires > now + EXPIRES_MAX + DAY) throw new Error(`${at}: expires more than 3 × 366 days from now`);
    if (typeof r.campaign !== 'string' || !CAMPAIGN_RE.test(r.campaign)) throw new Error(`${at}: campaign: 1 to 32 of a-z, 0-9 and -, starting with a letter or digit`);
    if (seen.has(r.code_hash)) throw new Error(`${at}: the same code_hash twice in the file`);
    seen.add(r.code_hash);
    out.push({ code_hash: r.code_hash, months: r.months, expires: r.expires, campaign: r.campaign });
  }
  if (out.length === 0) throw new Error('no records in the file');
  return out;
}

// raw: a node:sqlite DatabaseSync holding SCHEMA (the relay's db.raw, or the loader's own).
// → { load, peek, take, sweep, counts }. Callers own the transactions (allowance.mjs, load below).
export function giftStore(raw) {
  const q = (sql) => raw.prepare(sql);
  const s = {
    get: q('SELECT campaign, months FROM gifts WHERE code_hash = ? AND redeemed = 0 AND expires > ?'),
    put: q('INSERT INTO gifts (code_hash, campaign, months, expires) VALUES (?, ?, ?, ?) ON CONFLICT (code_hash) DO NOTHING'),
    use: q('UPDATE gifts SET redeemed = 1 WHERE code_hash = ?'),
    issued: q('INSERT INTO gift_campaigns (campaign, issued) VALUES (?1, ?2) ON CONFLICT (campaign) DO UPDATE SET issued = issued + ?2'),
    redeemed: q('UPDATE gift_campaigns SET redeemed = redeemed + 1 WHERE campaign = ?'),
    sweep: q('DELETE FROM gifts WHERE expires <= ?'),
    counts: q('SELECT campaign, issued, redeemed FROM gift_campaigns ORDER BY campaign'),
  };
  return {
    // records: readRecords's. A code already here (the same file loaded again) is left as it is,
    // used or not, and not counted twice. → { added, present }.
    load(records) {
      const added = new Map();
      for (const r of records) if (Number(s.put.run(r.code_hash, r.campaign, r.months, r.expires).changes) === 1) added.set(r.campaign, (added.get(r.campaign) ?? 0) + 1);
      for (const [c, n] of added) s.issued.run(c, n);
      const n = [...added.values()].reduce((a, b) => a + b, 0);
      return { added: n, present: records.length - n };
    },
    // The code's { campaign, months } while it can be redeemed, else null. A malformed hash looks
    // up the empty string: every miss takes one path.
    peek: (hash, now) => s.get.get(typeof hash === 'string' && HASH_RE.test(hash) ? hash : '', now) ?? null,
    // Used: once, inside the transaction that grants it.
    take(hash, campaign) { s.use.run(hash); s.redeemed.run(campaign); },
    sweep: (now) => Number(s.sweep.run(now).changes),
    // { campaign: { issued, redeemed } }: counts only; totals(): { issued, redeemed } over all.
    totals: () => { const t = { issued: 0, redeemed: 0 }; for (const r of s.counts.all()) { t.issued += r.issued; t.redeemed += r.redeemed; } return t; },
    counts: () => Object.fromEntries(s.counts.all().map((r) => [r.campaign, { issued: r.issued, redeemed: r.redeemed }])),
  };
}

// The brakes (the header): fixed windows, as park.mjs. → charge(prefix, now), or throws
// { check: 'rate', detail, retryAfter }.
export function giftBrake({ tries = TRIES, triesAll = TRIES_ALL } = {}) {
  const rates = new Map(), all = { window: -1, n: 0 };
  const rated = (w, window, now, detail) => { throw Object.assign(new Error(`rate: ${detail}`), { check: 'rate', detail, retryAfter: Math.max(1, Math.ceil((w + 1) * window - now)) }); };
  return (prefix, now) => {
    const w = Math.floor(now / tries.window);
    let r = rates.get(prefix);
    if (!r || r.window !== w) {
      if (rates.size > 100000) for (const [p, x] of rates) if (x.window !== w) rates.delete(p);
      r = { window: w, n: 0 };
      rates.set(prefix, r);
    }
    if (++r.n > tries.n) rated(w, tries.window, now, `more than ${tries.n} gift codes tried from this network in ${tries.window / 60} minutes: wait`);
    const wa = Math.floor(now / triesAll.window);
    if (all.window !== wa) { all.window = wa; all.n = 0; }
    if (++all.n > triesAll.n) rated(wa, triesAll.window, now, `more than ${triesAll.n} gift codes tried on this relay in ${triesAll.window / 60} minutes: wait`);
  };
}

// node gifts.mjs load <file|->: beside the running relay (SQLite's WAL lets both write; the
// relay's own tables are made at its start, so the relay must have run this version once).
// Imported (allowance.mjs, a script read from stdin as `node -`): nothing runs.
const isMain = () => { try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } };
if (process.argv[1] && isMain()) {
  const [verb, file] = process.argv.slice(2);
  const die = (why) => { console.error(`gifts: ${why}`); process.exit(1); };
  if (!((verb === 'load' && file) || (verb === 'counts' && !file))) die('usage: node gifts.mjs load <file|-> | counts   (RELAY_DB: the relay database, default /var/lib/sigelo-relay/relay.db)');
  const path = process.env.RELAY_DB || '/var/lib/sigelo-relay/relay.db';
  let records;
  if (verb === 'load') try { records = readRecords(readFileSync(file === '-' ? 0 : file, 'utf8'), Math.floor(Date.now() / 1000)); } catch (e) { die(`${file}: ${e.message}`); }
  if (!existsSync(path)) die(`no relay database at ${path} (RELAY_DB)`);
  let db;
  try { db = new DatabaseSync(path); } catch (e) { die(`${path}: ${e.message}`); }
  db.exec('PRAGMA busy_timeout = 5000');
  const has = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('gifts', 'gift_campaigns')").get().n === 2;
  if (!has) die(`${path} has no gifts table: start this relay version once, then load`);
  if (verb === 'counts') { console.log(JSON.stringify(giftStore(db).counts())); db.close(); process.exit(0); }
  db.exec('BEGIN IMMEDIATE');
  let r;
  try { r = giftStore(db).load(records); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); die(e.message); }
  db.close();
  const campaigns = [...new Set(records.map((x) => x.campaign))].join(', ');
  console.log(`gifts: ${r.added} codes loaded, ${r.present} here already (campaign ${campaigns})`);
}
