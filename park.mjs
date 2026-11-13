// SPDX-License-Identifier: AGPL-3.0-only
// relay/park.mjs — short invite codes (contract sigelo-park/0: apps/contact/short.mjs; ROADMAP §8 item 1).
//
//   POST /park           {username, client_id, password, code_hash, invite, exp}: the login fields of
//                        POST /check (auth.mjs: a fresh GET /challenge nonce, signed, spent here),
//                        then what to park → {ok: true, exp} | {ok: false, check, detail}
//   GET  /park/<hash>    → 200 {ok: true, invite}, replaced at once by a tombstone (one use)
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
// 2^40, about 1 in 6,100), and a crowd under its own brakes no longer locks out a new one (review
// 2026-10-19). One given code is guessed with odds that grow linearly with its life: at most
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
// gets that instead of the park_unknown that tells the inviter (review 2026-10-28, MEDIUM 3). A
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
import { createHash } from 'node:crypto';

// PARK_TTL: the longest a code is kept (the inviter's exp, invite --ttl 60 s to an hour; 600 before).
export const PARK_TTL = 3600, PARK_MAX = 50000;
// Seconds an inviter's clock may run ahead of the relay's (apps/contact/carrier.mjs SKEW).
export const PARK_SKEW = 300;
export const LOOKUPS = { n: 20, window: 600 }, PARKS = { n: 10, window: 3600 }, LOOKUPS_ALL = { n: 600, window: 600 };
export const HASH_RE = /^[0-9a-f]{64}$/;
export const PARK_FIELDS = ['username', 'client_id', 'password', 'code_hash', 'invite', 'exp'];
// DELETE /park/<hash>: the login fields only, the hash in the path.
export const CANCEL_FIELDS = ['username', 'client_id', 'password'];
// apps/contact/invite.mjs: version 1 | DID digest 32 | secret 32 | expiry 4 | relay length 1 | relay | checksum 4.
const PREFIX = 'sgl1', MAX_DIGITS = 188, AT_DID = 1, AT_EXP = 65, AT_RLEN = 69, AT_RELAY = 70, FIXED = 74;
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;

export class ParkError extends Error { constructor(check, why) { super(`${check}: ${why}`); this.check = check; this.detail = why; } }
const fail = (check, why) => { throw new ParkError(check, why); };
// A brake's refusal, with the seconds until its window ends (auth.mjs retryAfter): the 429's Retry-After.
const rated = (w, window, now, why) => { throw Object.assign(new ParkError('rate', why), { retryAfter: Math.max(1, Math.ceil((w + 1) * window - now)) }); };

/**
 * A relay-wide ceiling that one crowd of networks cannot pin (review 2026-10-19: ~30 networks,
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

/** The long code's inviter DID digest, relay and expiry, or throws park. */
export function readInvite(text) {
  if (typeof text !== 'string' || !text.startsWith(PREFIX)) fail('park', 'invite: not a long code (sgl1…)');
  const digits = text.slice(PREFIX.length);
  if (digits.length === 0 || digits.length > MAX_DIGITS || !B58_RE.test(digits)) fail('park', 'invite: not a long code (sgl1…)');
  const b = b58decode(digits);
  if (b.length < FIXED + 1) fail('park', 'invite: too short');
  const sum = createHash('sha256').update(b.subarray(0, b.length - 4)).digest();
  if (!sum.subarray(0, 4).equals(b.subarray(b.length - 4))) fail('park', 'invite: checksum');
  if (b[0] !== 1 || b.length !== FIXED + b[AT_RLEN]) fail('park', 'invite: not a version 1 code');
  return { digest: b.subarray(AT_DID, AT_DID + 32), exp: b.readUInt32BE(AT_EXP), relay: b.subarray(AT_RELAY, AT_RELAY + b[AT_RLEN]).toString('latin1') };
}

const didDigest = (d) => (typeof d === 'string' && /^did:sigelo:z[1-9A-HJ-NP-Za-km-z]{1,63}$/.test(d) ? b58decode(d.slice('did:sigelo:z'.length)) : null);

/** host: this relay's name; clock: Unix seconds; ttl: PARK_TTL (tests: an older relay's 600). → { charge, park, fetch, cancel, sweep, size }. */
export function parking({ host, clock, max = PARK_MAX, lookups = LOOKUPS, parks = PARKS, lookupsAll = LOOKUPS_ALL, ttl = PARK_TTL }) {
  const held = new Map();    // code_hash → { invite, exp, owner }; invite null: a tombstone (fetched or cancelled)
  const rates = new Map();   // kind + prefix → { window, n }
  const all = fairCeiling(lookupsAll);   // lookups from every network

  // Fixed windows per prefix, as auth.mjs charge. → throws rate.
  function charge(kind, prefix, now) {
    const rule = kind === 'lookup' ? lookups : parks, w = Math.floor(now / rule.window), k = `${kind} ${prefix}`;
    let r = rates.get(k);
    if (!r || r.window !== w) {
      if (rates.size > 100000) for (const [p, x] of rates) if (x.window !== Math.floor(now / (p.startsWith('lookup ') ? lookups : parks).window)) rates.delete(p);
      r = { window: w, n: 0 };
      rates.set(k, r);
    }
    if (++r.n > rule.n) {
      rated(w, rule.window, now, kind === 'lookup'
        ? `more than ${rule.n} short-code lookups from this network in ${rule.window / 60} minutes: wait, or use the long code (invite --long)`
        : `more than ${rule.n} short codes parked from this network in ${rule.window / 60} minutes: wait, or use the long code (invite --long)`);
    }
    if (kind !== 'lookup') return;
    const o = all(prefix, now);
    if (o !== undefined) rated(o.w, o.window, now, o.over === 'share'
      ? `more than ${o.share} short-code lookups from this network, its share of this relay's, in ${o.window / 60} minutes: wait, or use the long code (invite --long)`
      : `more than ${lookupsAll.n} short-code lookups on this relay in ${o.window / 60} minutes: wait, or use the long code (invite --long)`);
  }

  function sweep(now = clock()) {
    let n = 0;
    for (const [h, e] of held) if (e.exp <= now) { held.delete(h); n++; }
    return n;
  }

  // did: the current DID the login proved; owner: its account (auth.mjs), who may cancel. → { exp }.
  function park({ code_hash, invite, exp }, did, now = clock(), owner = did) {
    if (typeof code_hash !== 'string' || !HASH_RE.test(code_hash)) fail('park', 'code_hash: 64 lowercase hex digits, SHA-256("sigelo-park/0" ‖ the normalised short code)');
    if (!Number.isSafeInteger(exp) || exp <= now || exp > now + ttl + PARK_SKEW) fail('park', `exp: Unix seconds, within ${ttl} s from now (the code's life: 60 s to ${ttl === PARK_TTL ? 'an hour' : `${ttl} s`})`);
    const code = readInvite(invite), mine = didDigest(did);
    if (code.relay !== host) fail('park', `invite: names ${JSON.stringify(code.relay)}, not this relay`);
    if (!mine || !mine.equals(code.digest)) fail('park', 'invite: its inviter is not the DID that logged in');
    if (exp > code.exp) fail('park', 'exp: after the invite\'s own expiry');
    const was = held.get(code_hash);
    if (was && was.exp > now) fail('park_taken', 'a code is parked under this hash: make another');
    if (held.size >= max && sweep(now) === 0 && !was) fail('park_full', `${max} short codes are parked on this relay, its most: try again in a few minutes, or use the long code (invite --long)`);
    // Kept PARK_TTL at most by this relay's clock, whatever the inviter's says.
    const until = Math.min(exp, now + ttl);
    held.set(code_hash, { invite, exp: until, owner });
    return { exp: until };
  }

  // → the long code, gone from here at once (a tombstone holds the hash until its exp); or null
  // (unknown, fetched, expired, malformed).
  function fetch(hash, now = clock()) {
    const k = typeof hash === 'string' && HASH_RE.test(hash) ? hash : '';
    const e = held.get(k);
    if (e === undefined) return null;
    if (e.exp <= now) { held.delete(k); return null; }
    if (e.invite === null) return null;
    held.set(k, { invite: null, exp: e.exp, owner: e.owner });
    return e.invite;
  }

  // owner: the account the login proved. → true: a tombstone now (or already one); false: unknown,
  // expired, malformed, or another's (one answer).
  function cancel(hash, owner, now = clock()) {
    const k = typeof hash === 'string' && HASH_RE.test(hash) ? hash : '';
    const e = held.get(k);
    if (e === undefined) return false;
    if (e.exp <= now) { held.delete(k); return false; }
    if (owner === undefined || e.owner !== owner) return false;
    if (e.invite !== null) held.set(k, { invite: null, exp: e.exp, owner });
    return true;
  }

  // size: the codes parked, not yet fetched (tombstones count against max, not here).
  const size = () => { let n = 0; for (const e of held.values()) if (e.invite !== null) n++; return n; };
  return { charge, park, fetch, cancel, sweep, size };
}
