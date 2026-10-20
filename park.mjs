// SPDX-License-Identifier: AGPL-3.0-only
// relay/park.mjs — short invite codes (contract sigelo-park/0: contact/short.mjs; ROADMAP §8 item 1).
//
//   POST /park           {username, client_id, password, code_hash, invite, exp}: the login fields of
//                        POST /check (auth.mjs: a fresh GET /challenge nonce, signed, spent here),
//                        then what to park → {ok: true, exp} | {ok: false, check, detail}
//   GET  /park/<hash>    → 200 {ok: true, invite}, deleted at once (one use)
//                        | 404 {ok: false, check: "park_unknown", detail} | 429 {ok: false, check: "rate", detail}
//
// The inviter parks its long code (contact/invite.mjs, sgl1…) under code_hash = hex SHA-256
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
// (with 2^40 codes and PARK_MAX parked at most, one network's guesses hit with odds of at most
// 20 × PARK_MAX / 2^40 per 10 minutes: under 1 in a million), and PARKS parks an hour, counted
// before the login is checked. Across all networks, LOOKUPS_ALL fetches per 10 minutes, charged after
// the network's own brake passes, with a fair share (`fairCeiling`: no network more than 75 of
// it; 525 for any network, then a reserve of 75 that gives a network not seen this window one
// try), so many networks guess at most 600 × PARK_MAX / 2^40 per 10 minutes in all (about 1 in
// 37,000), and a crowd under its own brakes no longer locks out a new one (review 2026-10-19).
// PARK_MAX entries at once in all (park_full). Expired entries are
// purged at every sweep (server.mjs, each minute) and when the cap is reached.
// A miss and a hit cost one Map lookup each; a malformed hash looks up the empty string, so every
// miss takes one path.
import { createHash } from 'node:crypto';

export const PARK_TTL = 600, PARK_MAX = 50000;
// Seconds an inviter's clock may run ahead of the relay's (contact/carrier.mjs SKEW).
export const PARK_SKEW = 300;
export const LOOKUPS = { n: 20, window: 600 }, PARKS = { n: 10, window: 3600 }, LOOKUPS_ALL = { n: 600, window: 600 };
export const HASH_RE = /^[0-9a-f]{64}$/;
export const PARK_FIELDS = ['username', 'client_id', 'password', 'code_hash', 'invite', 'exp'];
// contact/invite.mjs: version 1 | DID digest 32 | secret 32 | expiry 4 | relay length 1 | relay | checksum 4.
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

/** host: this relay's name; clock: Unix seconds. → { charge, park, fetch, sweep, size }. */
export function parking({ host, clock, max = PARK_MAX, lookups = LOOKUPS, parks = PARKS, lookupsAll = LOOKUPS_ALL }) {
  const held = new Map();    // code_hash → { invite, exp }
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

  // did: the current DID the login proved. → { exp }.
  function park({ code_hash, invite, exp }, did, now = clock()) {
    if (typeof code_hash !== 'string' || !HASH_RE.test(code_hash)) fail('park', 'code_hash: 64 lowercase hex digits, SHA-256("sigelo-park/0" ‖ the normalised short code)');
    if (!Number.isSafeInteger(exp) || exp <= now || exp > now + PARK_TTL + PARK_SKEW) fail('park', `exp: Unix seconds, within ${PARK_TTL} s from now`);
    const code = readInvite(invite), mine = didDigest(did);
    if (code.relay !== host) fail('park', `invite: names ${JSON.stringify(code.relay)}, not this relay`);
    if (!mine || !mine.equals(code.digest)) fail('park', 'invite: its inviter is not the DID that logged in');
    if (exp > code.exp) fail('park', 'exp: after the invite\'s own expiry');
    const was = held.get(code_hash);
    if (was && was.exp > now) fail('park_taken', 'a code is parked under this hash: make another');
    if (held.size >= max && sweep(now) === 0 && !was) fail('park_full', `${max} short codes are parked on this relay, its most: try again in a few minutes, or use the long code (invite --long)`);
    // Kept PARK_TTL at most by this relay's clock, whatever the inviter's says.
    const until = Math.min(exp, now + PARK_TTL);
    held.set(code_hash, { invite, exp: until });
    return { exp: until };
  }

  // → the long code, gone from here at once; or null (unknown, expired, malformed).
  function fetch(hash, now = clock()) {
    const k = typeof hash === 'string' && HASH_RE.test(hash) ? hash : '';
    const e = held.get(k);
    if (e === undefined) return null;
    held.delete(k);
    return e.exp > now ? e.invite : null;
  }

  return { charge, park, fetch, sweep, size: () => held.size };
}
