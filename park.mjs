// SPDX-License-Identifier: AGPL-3.0-only
// relay/park.mjs — short invite codes (contract sigelo-park/0: apps/contact/short.mjs).
//
//   POST /park           {username, client_id, password, code_hash, invite, exp}: the login fields of
//                        POST /check (auth.mjs: a fresh GET /challenge nonce, signed, spent here),
//                        then what to park → {ok: true, exp} | {ok: false, check, detail}
//   GET  /park/<hash>    → 200 {ok: true, invite, enrol?}, replaced at once by a tombstone (one use;
//                        an enrolment code: enrol true, kept until the grant, below)
//                        | 404 {ok: false, check: "park_unknown", detail} | 429 {ok: false, check: "rate", detail}
//   DELETE /park/<hash>  {username, client_id, password}: the same login fields (a fresh nonce, spent
//                        here), and only the identity that parked the entry → 200 {ok: true}, the entry
//                        a tombstone until its exp (again, or already fetched: 200 {ok: true})
//                        | 404 {ok: false, check: "park_unknown", detail}: unknown, expired, or parked
//                        by another identity, one answer for all three (no oracle about whose it is)
//                        | 200 {ok: false, check, detail}: the login failed, as POST /park | 429 rate
//
// DELETE with a JSON body: Node's http and fetch, and nginx's proxy_pass (relay/deploy/nginx.conf,
// location ^~ /park/), carry it as POST's, so there is no second route. A client that never
// cancels sees nothing new: GET and POST are unchanged, and the label stays sigelo-park/0.
// The inviter parks its long code (apps/contact/invite.mjs, sgl1…) under code_hash = hex SHA-256
// ("sigelo-park/0" ‖ the normalised short code); the accepter, holding the short code, fetches it
// once. The relay never sees the short code, only its hash, and keeps neither in a log or the
// database: entries live in this process's memory, at most PARK_TTL seconds, and a restart drops
// them (the inviter makes a new code). The hash of 40 bits hides the code from a log reader, not
// from the relay, which holds the long code: it learns who invites, as it learns who pairs.
//
// What is parked is checked: a long code of version 1 with a good checksum, naming this relay and,
// as its inviter, the DID that logged in, with exp no later than the code's own expiry nor than
// PARK_TTL + PARK_SKEW from now. exp is the inviter's clock, which may run ahead of this one: it is
// kept at most PARK_TTL from now here. So a parked entry is an invite to its parker, nothing else,
// at 192 characters.
//
// Brakes, per /24 or /48 (auth.mjs prefixOf): LOOKUPS fetches per 10 minutes, a hit or a miss
// (with 2^40 codes and PARK_MAX parked at most, one network's guesses hit some code with odds of at
// most 20 × PARK_MAX / 2^40 per 10 minutes, under 1 in a million; 120 × PARK_MAX / 2^40 an hour,
// about 1 in 183,000), and PARKS parks an hour, counted before the login is checked. Across all
// networks, LOOKUPS_ALL fetches per 10 minutes, charged after the network's own brake passes, with
// a fair share (`fairCeiling`: no network more than 75 of it; 525 for any network, then a reserve
// of 75 that gives a network not seen this window one try), so many networks guess at most
// 600 × PARK_MAX / 2^40 per 10 minutes in all (about 1 in 37,000; an hour: 3,600 × PARK_MAX /
// 2^40, about 1 in 6,100), and a crowd under its own brakes no longer locks out a new one. One
// given code is guessed with odds that grow linearly with its life: at most
// 600 / 2^40 (5.5 × 10^-10) for each 10 minutes it lives, 3.3 × 10^-9 for a code of PARK_TTL, an
// hour (the inviter's invite --ttl; 10 minutes by default). A code fetched by a guesser pairs it with the
// inviter: the four words both operators compare differ, the backstop (THREAT-MODEL.md §2.10).
// PARK_MAX entries at once in all (park_full: with an hour's PARK_TTL, a flood of parks holds it up
// to an hour). Expired entries are purged at every sweep (server.mjs, each minute) and when the cap
// is reached.
//
// A fetched code leaves a tombstone until its original exp, and park refuses park_taken while an
// entry or a tombstone under the hash is unexpired: else a code holder (an eavesdropper, a lucky
// guesser) fetches the code, parks its own long code under the same hash, and the intended contact
// gets that instead of the park_unknown that tells the inviter. A
// tombstone counts against PARK_MAX as the entry did. A park that reaches the hash answers whether
// it is taken, so auth.mjs charges it as a lookup too (the brakes above), never a free oracle.
// A miss and a hit cost one Map lookup each; a malformed hash looks up the empty string, so every
// miss takes one path.
//
// Cancel ("Cancel this code", apps/contact/carrier.mjs cancelInvite): the entry keeps its parker's
// account (auth.mjs: the hash of the original DID, so a key rotation in between still cancels) and
// a cancel by that account turns it into the tombstone a fetch leaves, until the original exp: a
// code holder cannot park its own long code under the hash (park_taken, as above). It reaches the
// hash, so it is charged as a lookup before the body or the login (LOOKUPS, then LOOKUPS_ALL).
//
// Public codes (contract sigelo-public/0): a long code of version 2 (sgl2…)
// parked by POST /park with an optional `cap`, under SHA-256("sigelo-public/0" ‖ the PUB code), by
// an identity on Pro only (public_pro), at most PUBLIC_PER_ACCOUNT live per account (public_full),
// for up to PUBLIC_TTL_MAX. Its answer topic, an ordinary mailbox m/<32 hex> = HKDF-SHA256(the
// code's secret, no salt, "sigelo-public/0 answer topic", 16), must be claimed by the parker first
// (public_topic): a joiner holds the secret too. Kept in SQLite (table public_codes, a row per code,
// WITHOUT ROWID, rebuilt in key order by the sweep), so it survives a restart: the long code names
// its inviter's DID, which the relay stores nowhere else in the clear; here the inviter publishes
// it. GET /park/<hash> of a live public code hands it out without spending it, charged to a brake
// of its own (PUBLIC_FETCHES per network, PUBLIC_FETCHES_ALL relay-wide), never LOOKUPS: the hash
// is public, so it guesses nothing; any other hash is charged as before, so no free oracle. A
// paused one answers 409 public_paused. POST /park/<hash> {login, paused?, cap?} sets either, the
// parker only. DELETE /park/<hash> leaves a tombstone row until its exp. The mailbox's publishes go
// through `guard` (mailbox.mjs): revoked or expired (public_revoked), paused (public_paused), the
// day's cap reached (public_cap), one answer per account per code per UTC day (public_once). The
// day's count is kept in memory and written by the sweep each minute.
import { createHash, hkdfSync } from 'node:crypto';

// Enrolment codes (apps/contact/enrol.mjs issue: a worker placed unattended needs a code that outlives one fetch): a short code parked
// with `enrol: true` by the operator who will place a worker through it. Three rules differ from an
// invite's, nothing else:
//   - a fetch hands it out WITHOUT spending it, at most ENROL_FETCHES times: a machine whose first try
//     failed (a refused proof of work, a crash, a model that called the wrong verb) fetches it again.
//     It is spent when the operator's grant has gone (the parker's DELETE /park/<hash>, carrier.mjs
//     unparkHash after the worker's identity was sent), or at its exp. Whoever holds the code could
//     fetch it before; that is unchanged: the operator answers only the DID that paired through it
//     first (enrol.mjs "The marker"), and a second answer to a taken invite pairs nobody.
//   - its life is up to ENROL_TTL (a day: a local model on a busy CPU took 45 minutes to run the
//     command), so one code is guessed with odds of at most 600 / 2^40 per 10 minutes it lives:
//     7.9 × 10^-8 for a day, under the lookup brakes as ever.
//   - GET /challenge?did=…&enrol=<hash> of a live one states the BASE proof of work to a new identity
//     (enrolGrace, at most ENROL_GRACE challenges per code), not the load or the network's step, and
//     the code's answer topic does not count against its parker's mailboxes while it waits
//     (enrolTopics, allowance.mjs claim). The challenge is charged as a lookup, since it answers
//     whether a hash is parked: no free oracle.
export const ENROL_TTL = 86400, ENROL_FETCHES = 8, ENROL_GRACE = 4;
const INVITE_ANSWER_LABEL = 'sigelo-invite/0 answer topic';
/** An invite's answer topic from its 32-byte secret (apps/contact/invite.mjs inviteKeys): i/ + hex HKDF-SHA256(secret, no salt, label, 16). */
export const inviteAnswerTopic = (secret) => 'i/' + Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), INVITE_ANSWER_LABEL, 16)).toString('hex');

// PARK_TTL: the longest a code is kept (the inviter's exp, invite --ttl 60 s to an hour; 600 before).
export const PARK_TTL = 3600, PARK_MAX = 50000;
// Seconds an inviter's clock may run ahead of the relay's (apps/contact/carrier.mjs SKEW).
export const PARK_SKEW = 300;
export const LOOKUPS = { n: 20, window: 600 }, PARKS = { n: 10, window: 3600 }, LOOKUPS_ALL = { n: 600, window: 600 };
export const HASH_RE = /^[0-9a-f]{64}$/;
export const PARK_FIELDS = ['username', 'client_id', 'password', 'code_hash', 'invite', 'exp'];
// DELETE /park/<hash>: the login fields only, the hash in the path.
export const CANCEL_FIELDS = ['username', 'client_id', 'password'];
// Public codes (the header): a year at most, 3 per account, 50 answers a day unless set (1 to 500).
export const PUBLIC_V = 'sigelo-public/0', PUBLIC_TTL_MAX = 366 * 86400, PUBLIC_PER_ACCOUNT = 3, PUBLIC_CAP = 50, PUBLIC_CAP_MAX = 500;
export const PUBLIC_FETCHES = { n: 60, window: 600 }, PUBLIC_FETCHES_ALL = { n: 6000, window: 600 };
export const PUBLIC_ANSWER_LABEL = 'sigelo-public/0 answer topic';
// POST /park/<hash>: the login fields, then paused and/or cap.
export const SET_FIELDS = ['username', 'client_id', 'password'], SET_OPTIONAL = ['paused', 'cap'];
const DAY = 86400;
const PUBLIC_SCHEMA = `
CREATE TABLE IF NOT EXISTS public_codes (
  code_hash TEXT PRIMARY KEY,           -- hex SHA-256("sigelo-public/0" ‖ the PUB code)
  invite    TEXT,                       -- the long code (sgl2…), as its inviter publishes it; NULL: revoked (a tombstone until exp)
  owner     TEXT NOT NULL,              -- the parker's account (auth.mjs), who may set and revoke
  topic     TEXT NOT NULL,              -- its answer topic, m/<32 hex>
  exp       INTEGER NOT NULL,           -- the end of the UTC day it ends on
  paused    INTEGER NOT NULL DEFAULT 0,
  cap       INTEGER NOT NULL,           -- answers a UTC day
  day       INTEGER NOT NULL DEFAULT 0, -- the UTC day (unix seconds / 86400) that n counts
  n         INTEGER NOT NULL DEFAULT 0  -- answers taken that day
) STRICT, WITHOUT ROWID;
`;
/** The answer topic of a public code from its 32-byte secret: m/ + hex HKDF-SHA256(secret, no salt, PUBLIC_ANSWER_LABEL, 16). */
export const publicTopic = (secret) => 'm/' + Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), PUBLIC_ANSWER_LABEL, 16)).toString('hex');
// apps/contact/invite.mjs: version 1 | DID digest 32 | secret 32 | expiry 4 | relay length 1 | relay | checksum 4.
const MAX_DIGITS = 188, AT_DID = 1, AT_EXP = 65, AT_RLEN = 69, AT_RELAY = 70, FIXED = 74;
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;

export class ParkError extends Error { constructor(check, why) { super(`${check}: ${why}`); this.check = check; this.detail = why; } }
const fail = (check, why) => { throw new ParkError(check, why); };
// A brake's refusal, with the seconds until its window ends (auth.mjs retryAfter): the 429's Retry-After.
const rated = (w, window, now, why) => { throw Object.assign(new ParkError('rate', why), { retryAfter: Math.max(1, Math.ceil((w + 1) * window - now)) }); };

/**
 * A relay-wide ceiling that one crowd of networks cannot pin (~30 networks,
 * each under its own brake, held the hard global caps and denied every network never seen).
 * Fixed windows of `window` seconds; `n` tries in all, never more (the last defence), split:
 *   - no network takes more than `share` = n/8 (at least 1);
 *   - n - n/8 tries for any network (at least 1);
 *   - a reserve of n/8 (at least 1, when n > 1): once the rest is spent, a network not yet seen
 *     this window still gets ONE try from it, so a crowd does not lock out a newcomer.
 * → (prefix, now) => undefined (charged), or { over: 'share' | 'all', w, window, share }.
 * Memory: one entry per network charged this window, at most n.
 */
export function fairCeiling({ n, window }) {
  const share = Math.max(1, Math.floor(n / 8)), reserve = n > 1 ? Math.max(1, Math.floor(n / 8)) : 0, open = n - reserve;
  const by = new Map();
  let cur = -1, used = 0, spare = 0;
  return (prefix, now) => {
    const w = Math.floor(now / window);
    if (w !== cur) { cur = w; used = 0; spare = 0; by.clear(); }
    const mine = by.get(prefix) ?? 0;
    if (mine >= share) return { over: 'share', w, window, share };
    if (used < open) { used++; by.set(prefix, mine + 1); return undefined; }
    if (mine === 0 && spare < reserve) { spare++; by.set(prefix, 1); return undefined; }
    return { over: 'all', w, window, share };
  };
}

// Only on a string of base58 digits whose length is bounded (decoding is quadratic).
function b58decode(s) {
  let zeros = 0;
  while (zeros < s.length && s[zeros] === '1') zeros++;
  const out = [];
  for (const ch of s.slice(zeros)) {
    let carry = B58.indexOf(ch);
    for (let j = 0; j < out.length; j++) { const x = out[j] * 58 + carry; out[j] = x & 0xff; carry = x >> 8; }
    while (carry > 0) { out.push(carry & 0xff); carry >>= 8; }
  }
  return Buffer.from([...new Array(zeros).fill(0), ...out.reverse()]);
}

/** The long code's inviter DID digest, secret, relay and expiry, or throws park. version: 1 (a short code's), 2 (a public code's). */
export function readInvite(text, version = 1) {
  const prefix = `sgl${version}`;
  if (typeof text !== 'string' || !text.startsWith(prefix)) fail('park', `invite: not a long code (${prefix}…)`);
  const digits = text.slice(prefix.length);
  if (digits.length === 0 || digits.length > MAX_DIGITS || !B58_RE.test(digits)) fail('park', `invite: not a long code (${prefix}…)`);
  const b = b58decode(digits);
  if (b.length < FIXED + 1) fail('park', 'invite: too short');
  const sum = createHash('sha256').update(b.subarray(0, b.length - 4)).digest();
  if (!sum.subarray(0, 4).equals(b.subarray(b.length - 4))) fail('park', 'invite: checksum');
  if (b[0] !== version || b.length !== FIXED + b[AT_RLEN]) fail('park', `invite: not a version ${version} code${version === 1 ? '' : ' (sgl2…, a public code)'}`);
  return { version: b[0], digest: b.subarray(AT_DID, AT_DID + 32), secret: b.subarray(AT_DID + 32, AT_EXP), exp: b.readUInt32BE(AT_EXP), relay: b.subarray(AT_RELAY, AT_RELAY + b[AT_RLEN]).toString('latin1') };
}

const didDigest = (d) => (typeof d === 'string' && /^did:sigelo:z[1-9A-HJ-NP-Za-km-z]{1,63}$/.test(d) ? b58decode(d.slice('did:sigelo:z'.length)) : null);

/**
 * host: this relay's name; clock: Unix seconds; ttl: PARK_TTL (tests: an older relay's 600).
 * db: relay/db.mjs, for public codes (none: POST /park refuses them); pro(account, now): whether the
 * account draws on a Pro licence (allowance.mjs pool); claimOf(topic): db.mjs claim.
 * → { charge, park, fetch, cancel, set, publicOf, guard, sweep, size, publics, enrolGrace, enrolTopics, isEnrol }.
 */
export function parking({ host, clock, max = PARK_MAX, lookups = LOOKUPS, parks = PARKS, lookupsAll = LOOKUPS_ALL, ttl = PARK_TTL,
  db = null, pro = () => false, publicFetches = PUBLIC_FETCHES, publicFetchesAll = PUBLIC_FETCHES_ALL, perAccount = PUBLIC_PER_ACCOUNT }) {
  const held = new Map();    // code_hash → { invite, exp, owner }; invite null: a tombstone (fetched or cancelled)
  const rates = new Map();   // kind + prefix → { window, n }
  const all = fairCeiling(lookupsAll);   // lookups from every network
  const allPublic = fairCeiling(publicFetchesAll);   // public-code fetches from every network
  const rules = { lookup: lookups, park: parks, public: publicFetches };
  // Public codes: code_hash → { invite, owner, topic, exp, paused, cap, day, n, dirty }, and topic → code_hash;
  // once: code_hash → Set of the accounts answered today (memory only).
  const pub = new Map(), byTopic = new Map(), once = new Map();
  let q = null;
  if (db) {
    db.rebuild(PUBLIC_SCHEMA, ['public_codes']);
    db.keepSorted(PUBLIC_SCHEMA, ['public_codes']);
    const p = (sql) => db.raw.prepare(sql);
    q = {
      all: p('SELECT * FROM public_codes'),
      put: p('INSERT OR REPLACE INTO public_codes (code_hash, invite, owner, topic, exp, paused, cap, day, n) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
      state: p('UPDATE public_codes SET invite = ?, paused = ?, cap = ? WHERE code_hash = ?'),
      count: p('UPDATE public_codes SET day = ?, n = ? WHERE code_hash = ?'),
      drop: p('DELETE FROM public_codes WHERE code_hash = ?'),
    };
    for (const r of q.all.all()) {
      pub.set(r.code_hash, { invite: r.invite, owner: r.owner, topic: r.topic, exp: r.exp, paused: r.paused === 1, cap: r.cap, day: r.day, n: r.n, dirty: false });
      byTopic.set(r.topic, r.code_hash);
    }
  }
  const write = (fn) => db.settle(() => db.tx(fn));

  // Fixed windows per prefix, as auth.mjs charge. kind: lookup, park, public. → throws rate.
  function charge(kind, prefix, now) {
    const rule = rules[kind], w = Math.floor(now / rule.window), k = `${kind} ${prefix}`;
    let r = rates.get(k);
    if (!r || r.window !== w) {
      if (rates.size > 100000) for (const [p, x] of rates) if (x.window !== Math.floor(now / rules[p.slice(0, p.indexOf(' '))].window)) rates.delete(p);
      r = { window: w, n: 0 };
      rates.set(k, r);
    }
    if (++r.n > rule.n) {
      rated(w, rule.window, now, kind === 'lookup'
        ? `more than ${rule.n} short-code lookups from this network in ${rule.window / 60} minutes: wait, or use the long code (invite --long)`
        : kind === 'public' ? `more than ${rule.n} public-code lookups from this network in ${rule.window / 60} minutes: wait, or use the sgl2 code`
          : `more than ${rule.n} short codes parked from this network in ${rule.window / 60} minutes: wait, or use the long code (invite --long)`);
    }
    if (kind === 'public') {
      const o = allPublic(prefix, now);
      if (o !== undefined) rated(o.w, o.window, now, `more public-code lookups on this relay than it serves in ${o.window / 60} minutes: wait, or use the sgl2 code`);
      return;
    }
    if (kind !== 'lookup') return;
    const o = all(prefix, now);
    if (o !== undefined) rated(o.w, o.window, now, o.over === 'share'
      ? `more than ${o.share} short-code lookups from this network, its share of this relay's, in ${o.window / 60} minutes: wait, or use the long code (invite --long)`
      : `more than ${lookupsAll.n} short-code lookups on this relay in ${o.window / 60} minutes: wait, or use the long code (invite --long)`);
  }

  // Public codes: expired rows go, and the day's counts are written (the header).
  function sweep(now = clock()) {
    let n = 0;
    for (const [h, e] of held) if (e.exp <= now) { held.delete(h); n++; }
    if (db) {
      const gone = [...pub].filter(([, e]) => e.exp <= now), dirty = [...pub].filter(([, e]) => e.dirty && e.exp > now);
      if (gone.length || dirty.length) {
        db.tx(() => {
          for (const [h, e] of gone) { q.drop.run(h); pub.delete(h); byTopic.delete(e.topic); once.delete(h); }
          for (const [h, e] of dirty) { q.count.run(e.day, e.n, h); e.dirty = false; }
        });
      }
      const today = Math.floor(now / DAY);
      for (const [h, e] of pub) if (e.day !== today) once.delete(h);
    }
    return n;
  }

  const isCap = (c) => Number.isSafeInteger(c) && c >= 1 && c <= PUBLIC_CAP_MAX;
  // A public code (the header). claimOf(topic): who holds its answer topic. → { exp, public: true, cap, topic }.
  function parkPublic({ code_hash, invite, exp, cap = PUBLIC_CAP }, did, now, owner, claimOf) {
    if (!db) fail('park', 'invite: this relay takes no public codes (sgl2…)');
    if (!pro(owner, now)) fail('public_pro', 'a public code comes with Pro (one allowance for all your agents: sigelo.io/pro.html); this identity holds no Pro on this relay');
    if (!isCap(cap)) fail('park', `cap: answers a day, 1 to ${PUBLIC_CAP_MAX}`);
    if (!Number.isSafeInteger(exp) || exp <= now || exp > now + PUBLIC_TTL_MAX + PARK_SKEW) fail('park', `exp: Unix seconds, within ${PUBLIC_TTL_MAX} s (a year) from now`);
    const code = readInvite(invite, 2), mine = didDigest(did);
    if (code.relay !== host) fail('park', `invite: names ${JSON.stringify(code.relay)}, not this relay`);
    if (!mine || !mine.equals(code.digest)) fail('park', 'invite: its inviter is not the DID that logged in');
    if (exp > code.exp) fail('park', 'exp: after the invite\'s own expiry');
    const was = held.get(code_hash), had = pub.get(code_hash);
    if ((was && was.exp > now) || (had && had.exp > now)) fail('park_taken', 'a code is parked under this hash: make another');
    let mineLive = 0;
    for (const e of pub.values()) if (e.owner === owner && e.invite !== null && e.exp > now) mineLive++;
    if (mineLive >= perAccount) fail('public_full', `this identity has ${perAccount} public codes on this relay, its most: revoke one first`);
    const topic = publicTopic(code.secret);
    if (claimOf(topic)?.account !== owner) fail('public_topic', 'claim the code\'s answer topic before parking it (a joiner holds its secret too)');
    // Kept to the end of its UTC day, at most a year by this relay's clock.
    const until = Math.floor((Math.min(exp, now + PUBLIC_TTL_MAX) + DAY - 1) / DAY) * DAY;
    if (had) byTopic.delete(had.topic);
    write(() => q.put.run(code_hash, invite, owner, topic, until, 0, cap, 0, 0));
    pub.set(code_hash, { invite, owner, topic, exp: until, paused: false, cap, day: 0, n: 0, dirty: false });
    byTopic.set(topic, code_hash);
    once.delete(code_hash);
    return { exp: until, public: true, cap, topic };
  }

  // did: the current DID the login proved; owner: its account (auth.mjs), who may cancel. A long code
  // of version 2 is a public code (parkPublic). → { exp }.
  function park(body, did, now = clock(), owner = did, claimOf = () => undefined) {
    const { code_hash, invite, exp } = body;
    if (typeof code_hash !== 'string' || !HASH_RE.test(code_hash)) fail('park', 'code_hash: 64 lowercase hex digits, SHA-256("sigelo-park/0" ‖ the normalised short code)');
    if (typeof invite === 'string' && invite.startsWith('sgl2')) return parkPublic(body, did, now, owner, claimOf);
    if (Object.hasOwn(body, 'cap')) fail('park', 'cap: only with a public code (sgl2…)');
    if (Object.hasOwn(body, 'enrol') && body.enrol !== true) fail('park', 'enrol: true, or absent');
    const enrol = body.enrol === true, life = enrol ? Math.max(ttl, ENROL_TTL) : ttl;
    if (!Number.isSafeInteger(exp) || exp <= now || exp > now + life + PARK_SKEW) fail('park', `exp: Unix seconds, within ${life} s from now (the code's life: 60 s to ${life === PARK_TTL ? 'an hour' : life === ENROL_TTL ? 'a day for an enrolment code' : `${life} s`})`);
    const code = readInvite(invite), mine = didDigest(did);
    if (code.relay !== host) fail('park', `invite: names ${JSON.stringify(code.relay)}, not this relay`);
    if (!mine || !mine.equals(code.digest)) fail('park', 'invite: its inviter is not the DID that logged in');
    if (exp > code.exp) fail('park', 'exp: after the invite\'s own expiry');
    const was = held.get(code_hash);
    if ((was && was.exp > now) || pub.get(code_hash)?.exp > now) fail('park_taken', 'a code is parked under this hash: make another');
    if (held.size >= max && sweep(now) === 0 && !was) fail('park_full', `${max} short codes are parked on this relay, its most: try again in a few minutes, or use the long code (invite --long)`);
    // Kept PARK_TTL at most by this relay's clock, whatever the inviter's says.
    const until = Math.min(exp, now + life);
    held.set(code_hash, { invite, exp: until, owner, ...(enrol && { enrol: true, fetches: 0, grace: 0, topic: inviteAnswerTopic(code.secret) }) });
    return { exp: until, ...(enrol && { enrol: true }) };
  }

  // → the long code, gone from here at once (a tombstone holds the hash until its exp); or null
  // (unknown, fetched, expired, malformed).
  function fetch(hash, now = clock()) {
    const k = typeof hash === 'string' && HASH_RE.test(hash) ? hash : '';
    if (pub.has(k)) return null;
    const e = held.get(k);
    if (e === undefined) return null;
    if (e.exp <= now) { held.delete(k); return null; }
    if (e.invite === null) return null;
    // An enrolment code: handed out again until the grant (the parker's cancel), ENROL_FETCHES at most.
    if (e.enrol && ++e.fetches < ENROL_FETCHES) return e.invite;
    held.set(k, { invite: null, exp: e.exp, owner: e.owner });
    return e.invite;
  }

  // Whether a live enrolment code waits under `hash`: GET /park/<hash> says so (enrol: true), so the
  // machine refuses a pairing code given to init --enrol (an enrolment code and a pairing code are never interchangeable).
  function isEnrol(hash, now = clock()) {
    const e = typeof hash === 'string' && HASH_RE.test(hash) ? held.get(hash) : undefined;
    return e?.enrol === true && e.invite !== null && e.exp > now;
  }

  // GET /challenge?enrol=<hash> (auth.mjs): whether a live enrolment code waits under it, counting one of
  // its ENROL_GRACE challenges at the base. → true or false (auth.mjs then states the usual bits).
  function enrolGrace(hash, now = clock()) {
    const e = typeof hash === 'string' && HASH_RE.test(hash) ? held.get(hash) : undefined;
    if (!e?.enrol || e.invite === null || e.exp <= now || e.grace >= ENROL_GRACE) return false;
    e.grace++;
    return true;
  }

  // allowance.mjs claim: how many of `account`'s claims are answer topics of its enrolment codes still
  // waiting (claimOf(topic).account the account: the parker claims the topic before it parks).
  function enrolTopics(account, now = clock(), claimOf = () => undefined) {
    let n = 0;
    for (const e of held.values()) if (e.enrol && e.owner === account && e.invite !== null && e.exp > now && claimOf(e.topic)?.account === account) n++;
    return n;
  }

  // owner: the account the login proved. → true: a tombstone now (or already one); false: unknown,
  // expired, malformed, or another's (one answer).
  function cancel(hash, owner, now = clock()) {
    const k = typeof hash === 'string' && HASH_RE.test(hash) ? hash : '';
    const p = pub.get(k);
    if (p !== undefined) {
      if (p.exp <= now || owner === undefined || p.owner !== owner) return false;
      if (p.invite !== null) { write(() => q.state.run(null, p.paused ? 1 : 0, p.cap, k)); p.invite = null; }
      return true;
    }
    const e = held.get(k);
    if (e === undefined) return false;
    if (e.exp <= now) { held.delete(k); return false; }
    if (owner === undefined || e.owner !== owner) return false;
    if (e.invite !== null) held.set(k, { invite: null, exp: e.exp, owner });
    return true;
  }


  // A public code under this hash: null (none: a short code's hash, or nothing), { gone: true }
  // (revoked or expired), or { invite, paused, exp, cap }. Read before any brake (auth.mjs): the
  // hash is public, so it says nothing a guesser wants.
  function publicOf(hash, now = clock()) {
    const e = typeof hash === 'string' ? pub.get(hash) : undefined;
    if (e === undefined) return null;
    if (e.invite === null || e.exp <= now) return { gone: true };
    return { invite: e.invite, paused: e.paused, exp: e.exp, cap: e.cap };
  }

  // The parker sets paused and/or cap. → { paused, cap } | null (unknown, revoked, expired, another's: one answer).
  function set(hash, owner, { paused, cap }, now = clock()) {
    if (paused !== undefined && typeof paused !== 'boolean') fail('park', 'paused: true or false');
    if (cap !== undefined && !isCap(cap)) fail('park', `cap: answers a day, 1 to ${PUBLIC_CAP_MAX}`);
    const e = typeof hash === 'string' ? pub.get(hash) : undefined;
    if (e === undefined || e.invite === null || e.exp <= now || owner === undefined || e.owner !== owner) return null;
    const p = paused ?? e.paused, c = cap ?? e.cap;
    write(() => q.state.run(e.invite, p ? 1 : 0, c, hash));
    e.paused = p; e.cap = c;
    return { paused: p, cap: c };
  }

  // mailbox.mjs: a publish to `topic` by `account`. check → undefined (not a public code's topic, or
  // taken) or { code, detail }; count, once it is stored.
  const guard = {
    check(topic, account, now = clock()) {
      const h = byTopic.get(topic);
      if (h === undefined) return undefined;
      const e = pub.get(h), today = Math.floor(now / DAY);
      if (e.invite === null || e.exp <= now) return { code: 'public_revoked', detail: 'this public code was revoked or has ended: ask its owner for its new one' };
      if (e.paused) return { code: 'public_paused', detail: 'this public code is paused by its owner: try again later' };
      if (e.day === today && e.n >= e.cap) return { code: 'public_cap', detail: `this public code took its ${e.cap} new chats today: try again after 00:00 UTC` };
      if (once.get(h)?.has(account) && e.day === today) return { code: 'public_once', detail: 'this identity answered this public code today already: one a day' };
      return undefined;
    },
    count(topic, account, now = clock()) {
      const h = byTopic.get(topic);
      if (h === undefined) return;
      const e = pub.get(h), today = Math.floor(now / DAY);
      if (e.day !== today) { e.day = today; e.n = 0; once.delete(h); }
      e.n++; e.dirty = true;
      let s = once.get(h);
      if (!s) { s = new Set(); once.set(h, s); }
      s.add(account);
    },
  };

  // size: the codes parked, not yet fetched (tombstones count against max, not here). publics: the public codes held, live or not.
  const size = () => { let n = 0; for (const e of held.values()) if (e.invite !== null) n++; return n; };
  const publics = () => pub.size;
  return { charge, park, fetch, cancel, set, publicOf, guard, sweep, size, publics, enrolGrace, enrolTopics, isEnrol };
}
