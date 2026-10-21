// SPDX-License-Identifier: AGPL-3.0-only
// relay/auth.mjs — login with a sigelo identity (design/relay-plan.md §3 "Login", "Errors").
//
//   GET  /challenge?did=<current DID>   → { challenge: {v:"sigelo-relay/0", typ:"relay-login", did,
//                 relay: the relay host, nonce}, pow_bits: what a new identity proves with this
//                 nonce (policy.powBits, M4: pow.mjs, which counts it as waiting until a login
//                 spends it, policy.powSpent; 0 without it) }
//   MQTT CONNECT  username = current DID, client id = "s" + 24 hex of SHA-256(original DID),
//                 clean session off, password = JCS of {v:"sigelo-relay/0", nonce, sig, bundle?, pow?},
//                 sig over that login body ("sigelo\n" ‖ JCS, SPEC §3), did = the username
//   POST /check   {username, client_id, password, clean?} → {ok: true} | {ok: false, check, detail}
//   GET  /stats   the relay's counts, no identifier (stats.mjs)
//   POST /park, GET /park/<hash>   short invite codes (park.mjs), when a parking is given
//   POST /licence a Pro licence file → {ok: true, operator, exp, chain, claims} | {ok: false, check, detail}
//                 (policy.licence, M4: operator.mjs)
//   POST /gift    {username, client_id, password, code_hash}: a gift code redeemed by the operator
//                 identity → {ok: true, exp, months} | {ok: false, check, detail} (policy.gift: gifts.mjs)
//
// MQTT 3.1.1 can only say "bad user name or password", so the outcome of every CONNECT is kept for
// 5 minutes under a hash of its credentials: POST /check with the same credentials names the
// failing check. Credentials never used in a CONNECT are checked there and then, which spends the
// nonce exactly as a CONNECT would (single use).
//
// Checks, in order (accept/node/sigelo-pair.mjs's order where they overlap): rate (before any
// work), password (shape), challenge_unknown (single use), challenge_expired, bundle (the caps
// first, then on the bundle as sent: a genesis with the username's DID), sig (under that key),
// bundle (SPEC §9 over the bundle with the rotations this relay keeps merged in: it must resolve
// to the username, and pass through a DID of another identity's chain here, its original
// included, only by a recovery rotation from it), client_id, closed (a closed relay: closed.mjs), pow,
// relay_full (disk), then the session caps (rate per network, relay_full in all: seat). A login
// without a bundle fails bundle unless its signature verifies under a key cached from an earlier
// login and its identity is stored here (a new one is stored with its chain). As in
// pairing, the signature is checked before
// the rotations already seen, so no answer before it depends on what the relay keeps. "password"
// (the shape) is not in the plan's code list: it is pairing's "card" check, for the container. A
// relay failure is no check: CONNACK 3, and POST /check answers 503. No crypto for identities
// here: every signature check is the sigelo library.
// Loopback HTTP behind nginx, with world/server.mjs's body limit and timeouts.
import { createServer } from 'node:http';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { canonicalize, did as didOf, keygen, parseBytes, verify, verifySig } from 'sigelo';
import { accountOf, clientIdOf, hashHex } from './db.mjs';
import { PARK_FIELDS, ParkError } from './park.mjs';
import { GIFT_FIELDS } from './gifts.mjs';

export const V = 'sigelo-relay/0';
// The body a login signs: a type of its own, never a SPEC §5.2 challenge. An agent's general-purpose
// challenge signer (sigelo-agent's signChallenge, the MCP tool sigelo_sign_challenge) signs typ
// "challenge" for any ctx and nonce, so a world that passed this relay's challenge on as its own
// would get back the agent's relay login. "relay-login" is signed by no such signer and fits no
// bundle slot (SPEC §3.1), as contact/invite.mjs's TYP_ANSWER and TYP_REPLY. `relay` = this relay's
// host: no replay at another relay.
export const TYP_LOGIN = 'relay-login';
export const loginBody = (did, relay, nonce) => ({ v: V, typ: TYP_LOGIN, did, relay, nonce });
export const TTL = 300, MAX_ITEMS = 64, MAX_BODY = 256 * 1024, WINDOW = 60;
export const DID_RE = /^did:sigelo:z[1-9A-HJ-NP-Za-km-z]{40,50}$/;
export const CHECKS = ['rate', 'password', 'challenge_unknown', 'challenge_expired', 'bundle', 'sig', 'client_id', 'closed', 'pow', 'relay_full'];
// Plan §3 "Operator attestation": the only attestations the relay reads (M4), at most this many.
export const OPERATOR_CTX = 'sigelo-relay/operator', MAX_OPERATOR = 4;
// Signature checks bundles may cost per address prefix and minute: one bundle at its largest (64
// sent + 64 kept rotations, 4 attestations) fits, and 256 checks are ~1.3 s of the one thread.
// Issuers cost no signature check, only a point decode each in verify(), and at most 4 reach it.
export const VERIFY_BUDGET = 4 * MAX_ITEMS;
// Sessions connected at once, per address prefix and in all. A login costs no work and an idle
// session ~124 KB over TLS (deploy/README.md), so without a cap the sessions of one network, or of
// many, grew until the process ran out of memory and every client was dropped. 16,000 sessions are
// ~2 GB, under the unit's MemoryMax=3G; past either cap a CONNECT is refused (rate, relay_full)
// after every other check (seat), and a CONNECT taking over its identity's own session is never
// refused by them.
export const MAX_SESSIONS = 16000, MAX_PER_PREFIX = 1000;
// A session of an identity that has proven no work (nothing is stored for it: allowance.mjs keep)
// can claim and send nothing; it exists to be told "pow" and log in again with a proof. It is
// closed after this many seconds, and an identity that has proven work takes the seat of the
// oldest such session when a cap is reached: else free sessions held the caps for as long as they
// liked, and one network locked every agent of its /24 out, a few networks the whole relay.
export const UNPROVEN_SECONDS = 60;
// CONNACK return codes (MQTT 3.1.1 §3.2.2.3), so a client learns something before POST /check.
const RETURN_CODE = { rate: 3, relay_full: 3, internal: 3, client_id: 2, pow: 5 };
// The current-DID cache holds this many identities; an evicted one sends its bundle again.
const CACHE = 100000;
// Used challenges kept until they expire. Logins cost an Ed25519 check each, so 5 minutes of them
// stay far below this; reaching it refuses logins rather than forgetting a used nonce.
const SPENT_MAX = 200000, OUTCOMES = 2048;
const PASSWORD_KEYS = new Set(['v', 'nonce', 'sig', 'bundle', 'pow']);
const NONCE_RE = /^[A-Za-z0-9_-]{43}$/;   // 32 bytes, base64url without padding
// A key nobody holds. A login without a bundle checks its signature against it when the relay does
// not know the DID, so "unknown" and "known, wrong signature" cost the same and read the same: POST
// /check must not tell an outsider which DIDs log in here.
const NOBODY = keygen({ seed: new Uint8Array(32), recovery: 'sha256:' + '0'.repeat(64) }).key;

export class LoginError extends Error { constructor(check, why) { super(`${check}: ${why}`); this.check = check; this.detail = why; } }
const fail = (check, why) => { throw new LoginError(check, why); };
// Seconds until fixed window w of `window` seconds ends: a 429's Retry-After (RFC 9110 §10.2.3).
export const retryAfter = (w, window, now) => Math.max(1, Math.ceil((w + 1) * window - now));
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Address cut to /24 (IPv4, IPv4-mapped IPv6) or /48 (IPv6): all that is ever logged or counted.
export function prefixOf(address) {
  const a = String(address ?? '').replace(/%.*$/, '');
  const v4 = a.replace(/^::ffff:/i, '');
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v4)) return v4.split('.').slice(0, 3).join('.') + '.0/24';
  if (!a.includes(':')) return 'unknown';
  const [head, tail] = a.split('::');
  const h = head ? head.split(':') : [], t = tail ? tail.split(':') : [];
  const groups = [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  return groups.slice(0, 3).map((g) => (parseInt(g, 16) || 0).toString(16)).join(':') + '::/48';
}

// MQTT over WebSocket: the path of the upgrade on the loopback HTTP port (server.mjs), and its subprotocol.
export const WS_PATH = '/mqtt', WS_PROTOCOL = 'mqtt';
// The client's address for a request on the loopback HTTP port, a WebSocket upgrade (server.mjs)
// included: X-Real-IP is believed only from loopback (nginx on this host); else the peer's own
// address. Every per-address and per-network limit counts what this returns: believed from any
// peer, a client could name a new network for every request.
export function clientAddress(req) {
  const peer = req.socket?.remoteAddress ?? '', real = req.headers['x-real-ip'];
  const loopback = /^(127\.|::1$|::ffff:127\.)/.test(peer);
  return loopback && typeof real === 'string' ? real : peer;
}

// world/server.mjs's guard: verify() costs one Ed25519 check per rotation, attestation and binding
// (~5 ms each; a Monero proof more), on the one thread every client shares, so a bundle far larger
// than any real identity is refused before the work starts. Counted on the bundle as sent.
// Issuers are capped on their own, at the same number: verify() decodes the key of each one it
// is given (~0.4 ms), and the 980 copies of one genesis a 256 KB body holds cost ~350 ms.
const itemCount = (b) => isObject(b)
  ? (Array.isArray(b.rotations) ? b.rotations.length : 0) + (Array.isArray(b.attestations) ? b.attestations.length : 0) + (Array.isArray(b.bindings) ? b.bindings.length : 0)
  : 0;
const verifyBundle = (bundle, now) => { try { return verify(bundle, now); } catch (e) { return fail('bundle', `REJECT: ${e.message}`); } };
const edgeOf = (r) => `${r.body.id} ${r.body.next}`;
// A DID is the SHA-256 of its genesis, so the genesis with DID d is the one whose hash is d. An
// object that does not hash (not canonical JSON) is no genesis of anything: it never matches.
const hashesTo = (g, d) => { try { return didOf(g) === d; } catch { return false; } };
// The key of DID d among the geneses a bundle carries (its own and each rotation's next), or
// undefined. Nothing is verified yet: a junk key just fails the signature check that follows.
const keyIn = (bundle, d) => [bundle.genesis, ...(Array.isArray(bundle.rotations) ? bundle.rotations.map((r) => r?.next_genesis) : [])].find((g) => hashesTo(g, d))?.key;
// The issuers verify() needs: the first genesis for each DID that a kept attestation names. An
// issuer no kept attestation names is never read, as the attestations dropped are not.
function issuersNamed(issuers, attestations) {
  const named = new Set(attestations.map((a) => a.body.iss)), out = new Map();
  if (named.size === 0) return [];
  for (const g of issuers) {
    let d;
    try { d = didOf(g); } catch { continue; }   // no hash, no DID: it can be no attestation's issuer
    if (named.has(d) && !out.has(d)) out.set(d, g);
  }
  return [...out.values()];
}

// M4: proof of work (plan §3 "Proof of work", relay/pow.mjs). A new original DID proves work at its
// first mailbox claim. policy.pow, when M4 supplies it, decides the value and its shape, given the
// bits the nonce states and the network it was issued to (newNonce); without it absence is
// accepted and a present value is only shape-checked, so a client that already sends one is not
// refused.
function checkPow(pow, ctx, policy) {
  if (!policy.pow) {
    if (pow !== undefined && (typeof pow !== 'string' || pow.length < 1 || pow.length > 128)) fail('pow', 'want a string of 1 to 128 characters');
    return;
  }
  const refusal = policy.pow({ pow, ...ctx });
  if (refusal) fail('pow', refusal);
}

// db: relay/db.mjs. host: the relay's public name, the login body's `relay` (no replay at another relay).
// clock() → unix seconds. diskFull() → true at 70 %. loginRate: CONNECTs and POST /check together
// per address prefix per minute; GET /challenge has its own count at the same number.
// verifyBudget: signature checks bundles may cost per prefix per minute. maxSessions, maxPerPrefix:
// sessions connected at once, in all and per prefix. unprovenSeconds: how long a session of an
// identity that has proven no work stays (UNPROVEN_SECONDS). policy: M4's hooks (powBits: the proof
// of work a challenge states, by the network asking; powSpent: its nonce spent by a login; pow,
// login, keep: whether a new identity's account and chain are stored), none by default (no work
// asked, all stored).
// log(line): never a DID or topic. closed: closed.mjs's, on a closed relay (null: open): a login it
// does not admit is refused `closed`, and no challenge asks proof of work.
export function auth({ db, host, clock, diskFull, loginRate, verifyBudget = VERIFY_BUDGET, maxSessions = MAX_SESSIONS, maxPerPrefix = MAX_PER_PREFIX, unprovenSeconds = UNPROVEN_SECONDS, policy = {}, log, stats = null, park = null, closed = null }) {
  const sessions = new WeakMap();   // Aedes client → { account, clientId, prefix }
  const prefixes = new WeakMap();   // Aedes client → address cut to /24 or /48
  const counted = new WeakMap();    // Aedes client with a session → its prefix, until its socket closes
  const live = new Map();           // prefix → sessions connected from it
  const liveIds = new Map();        // client id → the Aedes client whose session it is
  const unproven = new Map();       // Aedes client of an identity with no proof of work → { prefix, timer }, oldest first
  const ending = new WeakMap();     // Aedes client admitted to a closed relay until a time → the timer that closes it then
  let total = 0;
  // The cache of plan §3: current DID → account, account → { current, original, key }, for logins
  // without a bundle. Memory only. The rotations themselves are in the database (db.chainOf), so a
  // restart or an eviction costs a client one bundle, never the relay's memory of a rotation.
  const byCurrent = new Map(), byAccount = new Map();
  const outcomes = new Map();       // hash of credentials → { exp, check, detail }
  const rates = new Map();          // kind + prefix → { window, n }
  const spent = new Map();          // used nonce → its expiry

  const forget = (account) => { const e = byAccount.get(account); if (e) { byAccount.delete(account); byCurrent.delete(e.current); } };
  const remember = (account, entry) => {
    const prev = byAccount.get(account);
    if (prev) { byAccount.delete(account); if (prev.current !== entry.current) byCurrent.delete(prev.current); }
    byAccount.set(account, entry); byCurrent.set(entry.current, account);
    if (byAccount.size > CACHE) { const [old, e] = byAccount.entries().next().value; byAccount.delete(old); byCurrent.delete(e.current); }
  };

  // Per address prefix and minute, by kind: "login" (every CONNECT and every POST /check, one
  // count), "challenge", and "verify" (the signature checks bundles cost). Over the limit → rate.
  function charge(kind, prefix, now, n, limit, why) {
    const w = Math.floor(now / WINDOW), k = `${kind} ${prefix}`;
    let r = rates.get(k);
    if (!r || r.window !== w) {
      if (rates.size > 100000) for (const [p, x] of rates) if (x.window !== w) rates.delete(p);
      r = { window: w, n: 0 };
      rates.set(k, r);
    }
    r.n += n;
    if (r.n > limit) throw Object.assign(new LoginError('rate', why), { retryAfter: retryAfter(w, WINDOW, now) });
  }
  const verifyCost = (prefix, now, n) => charge('verify', prefix, now, n, verifyBudget, `bundles from this network cost more than ${verifyBudget} signature checks this minute: wait`);
  const chargeLogin = (prefix, now) => charge('login', prefix, now, 1, loginRate, `more than ${loginRate} logins a minute from this network: wait`);

  // The challenge nonce carries its own proof (plan §3 "Login"; single use, as world/server.mjs):
  // base64url of head = exp (4 bytes) ‖ pow bits (1) ‖ network (4) ‖ 7 random bytes, then the first
  // 16 bytes of HMAC-SHA256(key, "sigelo-relay/challenge\n" ‖ DID ‖ "\n" ‖ head). bits: the proof
  // of work a new identity owes with this nonce, as GET /challenge gave it (policy.powBits), so a
  // raise after the challenge refuses no client mid-search; network: a key for the /24 or /48 that
  // asked, so a proof counts against the network that was told its difficulty, not the one the
  // CONNECT came from (pow.mjs), and no address is in the nonce. Issuing one stores nothing, so no
  // flood of GET /challenge can push out anyone's pending challenge; a used one is kept in `spent`
  // until it expires. The key is new at every start: a restart voids the outstanding challenges
  // (5 minutes' worth) and the network keys with them, so neither need outlive the process.
  const macKey = randomBytes(32);
  const tagOf = (d, head) => createHmac('sha256', macKey).update(`sigelo-relay/challenge\n${d}\n`, 'utf8').update(head).digest().subarray(0, 16);
  const networkOf = (prefix) => createHmac('sha256', macKey).update(`sigelo-relay/network\n${prefix}`, 'utf8').digest().subarray(0, 4).toString('hex');
  function newNonce(d, exp, bits, network) {
    const head = Buffer.alloc(16);
    head.writeUInt32BE(exp, 0);
    head.writeUInt8(bits, 4);
    Buffer.from(network, 'hex').copy(head, 5);
    randomBytes(7).copy(head, 9);
    return Buffer.concat([head, tagOf(d, head)]).toString('base64url');
  }
  // → { exp, bits, network } of a nonce this relay issued to d, spelled as issued; else null.
  function nonceOf(nonce, d) {
    if (!NONCE_RE.test(nonce)) return null;
    const raw = Buffer.from(nonce, 'base64url');
    if (raw.length !== 32 || raw.toString('base64url') !== nonce || !timingSafeEqual(raw.subarray(16), tagOf(d, raw.subarray(0, 16)))) return null;
    return { exp: raw.readUInt32BE(0), bits: raw[4], network: raw.subarray(5, 9).toString('hex') };
  }
  // Nonces are issued, checked and forgotten by the latest clock() seen, which never goes back. A
  // spent nonce is forgotten once expired, so judged by a clock stepped back (an NTP step, a VM
  // restored) a nonce already used and forgotten was good again, its captured password with it.
  // Judged so, a fresh challenge after a step back lives longer by the step, and none is refused.
  let latest = 0;
  const nonceTime = (now) => (latest = Math.max(latest, now));
  function spend(nonce, exp, now) {
    for (const [k, e] of spent) { if (e > now) break; spent.delete(k); }   // in use order, near enough expiry order
    if (spent.size >= SPENT_MAX) for (const [k, e] of spent) if (e <= now) spent.delete(k);
    if (spent.size >= SPENT_MAX) fail('rate', 'too many logins on this relay in the last 5 minutes: try again shortly');
    spent.set(nonce, exp);
  }

  // What the relay keeps of a chain: the rotation the walk followed at each node, so what it stores
  // is bounded by the chain's length and holds no superseded rotation (a thief's 64 must not crowd
  // out the owner's recovery at the next login). A rotation whose id → next is an edge of the chain
  // was followed when it is the only one on its edge. Two on one edge can only be a copy that
  // differs (SPEC §7.3 passes over an invalid one): the first is kept, kept rotations ahead of sent
  // ones, and the walk over the kept ones alone must give the same chain.
  function chainRotations(result, rotations, genesis, prefix, now) {
    const c = result.chain, edge = new Map(c.slice(1).map((d, i) => [`${c[i]} ${d}`, i]));
    const onChain = rotations.filter((r) => edge.has(edgeOf(r)));
    const picked = [];
    for (const r of onChain) picked[edge.get(edgeOf(r))] ??= r;
    if (onChain.length === picked.length) return picked;
    verifyCost(prefix, now, picked.length);
    const again = verifyBundle({ v: 'sigelo/0', typ: 'bundle', genesis, rotations: picked, bindings: [], attestations: [], issuers: [] }, now);
    if (again.chain.join(' ') !== c.join(' ')) fail('bundle', 'two rotations on one edge of the chain, the first not valid: send each rotation once');
    return picked;
  }

  // bundle, sig, bundle, in accept/node/sigelo-pair.mjs's order: what was sent, the signature,
  // then the rotations already seen. What was sent: the caps (world/server.mjs), then a genesis
  // with the username's DID (pairing's own §9 run on the sent bundle is left out: the one below
  // covers every item sent). Then the signature under that key. Only then the rotations this relay
  // keeps for the identity are merged in: a client cannot hide a rotation the relay has seen, and
  // SPEC §7.3 decides (recovery beats voluntary), as pairing merges its store. Every answer before
  // the signature depends only on what was sent, so an outsider with someone's public genesis and
  // a junk signature learns nothing of what is kept here. SPEC §9 then runs on what the relay
  // uses: the chain, up to 4 operator attestations for this relay (M4) and their issuers. Other
  // attestations, bindings and issuers are never read, so they cost nothing.
  function resolve(bundle, username, challenge, sig, prefix, now) {
    if (itemCount(bundle) > MAX_ITEMS) fail('bundle', `more than ${MAX_ITEMS} rotations+attestations+bindings: too large to verify here`);
    if (Array.isArray(bundle.issuers) && bundle.issuers.length > MAX_ITEMS) fail('bundle', `more than ${MAX_ITEMS} issuers: too large to verify here`);
    let original;
    try { original = didOf(bundle.genesis); } catch (e) { fail('bundle', `REJECT: genesis: ${e.message}`); }
    const key = keyIn(bundle, username) ?? fail('bundle', 'no genesis in the bundle has the username\'s DID: send your current chain');
    // sig: over the login body this relay issued, under the username's key (SPEC §3 signing input).
    verifyCost(prefix, now, 1);
    if (!verifySig(key, challenge, sig)) fail('sig', 'does not verify under the username\'s key over the login body issued ({v, typ: "relay-login", did, relay, nonce})');
    const kept = db.chainOf(accountOf(original), original);   // a sealed chain that does not open throws: the relay's error
    let rotations = bundle.rotations;
    if (Array.isArray(rotations) && kept.length > 0) {
      let sent;
      try { sent = new Set(rotations.map(canonicalize)); } catch (e) { fail('bundle', `REJECT: rotations: ${e.message}`); }
      rotations = [...kept.filter((x) => !sent.has(canonicalize(x))), ...rotations];
    }
    const attestations = Array.isArray(bundle.attestations)
      ? bundle.attestations.filter((a) => a?.body?.ctx === OPERATOR_CTX && a.body.claims?.relay === host).slice(0, MAX_OPERATOR)
      : bundle.attestations;
    const bindings = Array.isArray(bundle.bindings) ? [] : bundle.bindings;
    const issuers = Array.isArray(bundle.issuers) && Array.isArray(attestations) ? issuersNamed(bundle.issuers, attestations) : bundle.issuers;
    verifyCost(prefix, now, (Array.isArray(rotations) ? rotations.length : 0) + (Array.isArray(attestations) ? attestations.length : 0));
    const result = verifyBundle({ ...bundle, rotations, attestations, bindings, issuers }, now);
    // The username's genesis is the chain's last one exactly when this holds (a DID is the hash of
    // its genesis), so the key checked above is the current key.
    if (result.did !== username) fail('bundle', 'the bundle, with the rotations this relay has seen, does not resolve to the username: send your current chain');
    if (result.chain.length - 1 > MAX_ITEMS) fail('bundle', `a chain of more than ${MAX_ITEMS} rotations: too long to keep here`);
    const chain = chainRotations(result, rotations, bundle.genesis, prefix, now);
    // The rotations kept are found by the first DID alone, so a chain that passes through a DID of
    // another identity's chain here is refused, as contact/store.mjs admit() refuses one reaching a
    // contact from another start. Whoever holds a key can put a genesis of its own in front of that
    // identity's (a voluntary rotation into it, carrying its recovery commitment, which is public):
    // the rotations kept for it (a recovery, SPEC §7.1) would not be merged, and the chain would
    // log in through a key the owner has recovered from. The first DID too: whoever holds a key the
    // owner rotated away from, or its current one, logged in with that key's genesis alone as an
    // original of its own, took its row, and locked the owner out for good, a recovery from the
    // head included. So a DID another identity's chain holds is taken from it only by a recovery
    // rotation from that DID (SPEC §7.1: recovery beats key): the owner of a key stolen before it
    // logged in here takes it back so, and a thief, holding no recovery key, cannot.
    const account = accountOf(original), taken = new Set();
    for (const [i, d] of result.chain.entries()) {
      const owner = db.ownerOf(hashHex(d));
      if (owner === undefined || owner === account) continue;
      if (chain[i]?.body.reason !== 'recovery') {
        fail('bundle', 'the chain runs through a key of another identity on this relay: an identity logs in from its own original genesis, and takes a key of its chain back from another only with a recovery rotation from that key');
      }
      taken.add(owner);
    }
    return { original, key, chain, result, taken };
  }

  // The whole login. prefix: the client's address cut to /24 or /48. charged: the login rate was
  // already charged (POST /check charges it before reading the body).
  function login({ username, clientId, clean, password, prefix, charged = false }) {
    const now = clock();
    if (!charged) chargeLogin(prefix, now);
    // password: strict JSON (fatal UTF-8, duplicate keys refused: SPEC §3), these keys only, JCS.
    if (typeof username !== 'string' || !DID_RE.test(username)) fail('password', 'username: want your current DID, in full');
    if (!(password instanceof Uint8Array)) fail('password', 'missing');
    let p;
    try { p = parseBytes(password); } catch (e) { fail('password', `not strict JSON: ${e.message}`); }
    if (!isObject(p) || Object.keys(p).some((k) => !PASSWORD_KEYS.has(k))) fail('password', 'want exactly {v, nonce, sig, bundle?, pow?}');
    if (p.v !== V) fail('password', `v: want "${V}"`);
    if (typeof p.nonce !== 'string' || typeof p.sig !== 'string') fail('password', 'nonce and sig: want strings');
    if (p.bundle !== undefined && !isObject(p.bundle)) fail('password', 'bundle: want a bundle object');
    let jcs;
    try { jcs = canonicalize(p); } catch (e) { fail('password', `no canonical form: ${e.message}`); }
    if (Buffer.compare(Buffer.from(jcs, 'utf8'), password) !== 0) fail('password', 'not the JCS of its value (SPEC §3): send canonicalize(password)');
    // challenge_unknown: issued here to this DID and not used before; spent whatever happens next.
    const issued = nonceOf(p.nonce, username), t = nonceTime(now);
    if (issued === null || spent.has(p.nonce)) fail('challenge_unknown', 'not issued here to this DID, or already used: GET /challenge again');
    if (issued.exp <= t) fail('challenge_expired', `expired (${TTL} s): GET /challenge again`);
    spend(p.nonce, issued.exp, t);
    // Spent once, here, whatever follows: the proof of work counts it as waiting no more (pow.mjs).
    // Told on every login, a known identity's too, or its challenges kept its network's new DIDs
    // at a higher difficulty until they expired.
    if (!closed) policy.powSpent?.({ network: issued.network, exp: issued.exp, now });
    const challenge = loginBody(username, host, p.nonce);
    let original, key, chain, result, taken;
    if (p.bundle === undefined) {
      const entry = byAccount.get(byCurrent.get(username));
      const good = verifySig(entry?.key ?? NOBODY, challenge, p.sig);
      // A cached key that another identity's chain holds by now (that identity logged in from its
      // own genesis, which the cached chain passed through): the bundle decides again (resolve).
      const owner = entry && good ? db.ownerOf(hashHex(username)) : undefined;
      if (!entry || !good || (owner !== undefined && owner !== accountOf(entry.original))) {
        fail('bundle', 'no login without a bundle (first login, a rotation, a relay restart, or a signature that does not verify): send your bundle');
      }
      ({ original, key } = entry);
      // An identity is stored with its chain (setChain below), and this login carries none: stored
      // without it, only its original DID was its own here (db.ownerOf), so whoever holds a key it
      // rotated away from took that DID as an original of its own and locked it out, and an
      // operator's licence followed its original key (operator.mjs). Its key is cached from a
      // login that stored nothing (no proof of work yet).
      if (db.account(accountOf(original)) === undefined) fail('bundle', 'a new identity sends its bundle with its proof of work: the relay stores its chain with its account');
    } else {
      ({ original, key, chain, result, taken } = resolve(p.bundle, username, challenge, p.sig, prefix, now));
    }
    // client_id: one persistent session per identity.
    const account = accountOf(original), want = clientIdOf(original);
    if (clientId !== want) fail('client_id', `want ${want} ("s" + 24 hex of SHA-256 of your original DID)`);
    if (clean !== false) fail('client_id', 'connect with clean session off: the relay keeps one persistent session per identity');
    // closed: admitted by its operator's attestation (closed.mjs), read again at every login with
    // a bundle; without one, as admitted at the last, while that holds. → when the admission ends.
    let admitted;
    if (closed) {
      const held = p.bundle === undefined ? byAccount.get(account)?.admitted : undefined;
      const a = held > now ? held : closed.admit(original, result);
      if (typeof a !== 'number') fail('closed', a.why);
      admitted = a;
    }
    const isNew = db.account(account) === undefined;
    checkPow(p.pow, { host, account, original, nonce: p.nonce, isNew, now, bits: issued.bits, network: issued.network, admitted: admitted !== undefined }, policy);
    if (isNew && diskFull()) fail('relay_full', 'this relay takes no new identities until disk use falls below 70 %');
    // Nothing durable for a new identity until policy.keep says so (M4: once it has proven work):
    // a login costs no work, so rows written for every fresh DID would let free identities alone
    // fill the disk for everyone. Its session, and the cache below, are memory only.
    const durable = !isNew || (policy.keep?.({ account, now }) ?? true);
    const evict = seat(want, prefix, durable);
    const refusal = policy.login?.({ account, original, current: username, result, rotations: chain, isNew, now });   // M4: operator, licence
    if (refusal) fail(refusal.check, refusal.detail);
    if (durable) {
      // A chain that held a DID this login took by recovery (resolve) loses it now (setChain): its
      // cached logins without a bundle go too, so it must send the chain the next check refuses.
      for (const other of taken ?? []) forget(other);
      // A known account's day of login is kept in memory (db.mjs); a chain is written only when it
      // changed. Most logins write nothing.
      db.tx(() => { db.touchAccount(account, now); if (chain) db.setChain(account, original, chain, result.chain); closed?.record(account, admitted); });
    }
    remember(account, { current: username, original, key, admitted });
    return { account, clientId: want, durable, evict, admitted };
  }

  // The oldest session of an identity with no proof of work, from `prefix` (null: anywhere), or undefined.
  function oldestUnproven(prefix) {
    for (const [client, u] of unproven) if (prefix === null || u.prefix === prefix) return client;
    return undefined;
  }
  // The session caps, after every other check of the login. Their answer must depend on nothing an
  // outsider can ask about: they used to come first and pass a CONNECT whose client id was live, so
  // junk credentials got CONNACK 4 (bad user name or password) for a client id connected now and 3
  // (a cap) for one that was not, and the client id is public (db.mjs clientIdOf): whether any DID
  // was online, free of the login rate. Here only the identity itself gets this far, and its
  // CONNECT taking over its own live session passes. A durable identity (proven work, or no M4
  // policy) takes the seat of the oldest session of one that has proven none: from its network at
  // the per-network cap, from anywhere at the relay's. → that session, to close once this login is
  // admitted (authenticate), or null; else throws rate (per network) or relay_full (in all).
  function seat(clientId, prefix, durable) {
    if (liveIds.has(clientId)) return null;
    const perPrefix = (live.get(prefix) ?? 0) >= maxPerPrefix;
    if (!perPrefix && total < maxSessions) return null;
    const victim = durable ? oldestUnproven(perPrefix ? prefix : null) : undefined;
    if (victim) return victim;
    if (perPrefix) fail('rate', `${maxPerPrefix} sessions from this network are connected, the most this relay holds: close one, or try again later`);
    return fail('relay_full', `this relay holds ${maxSessions} sessions, its most: try again later`);
  }

  const outcomeKey = (username, clientId, password) => createHmac('sha256', macKey).update(`${username}\n${clientId}\n`).update(Buffer.from(password ?? [])).digest('hex');
  function record(key, outcome) {
    const now = clock();
    for (const [k, o] of outcomes) if (o.exp <= now || outcomes.size >= OUTCOMES) outcomes.delete(k); else break;
    outcomes.set(key, { exp: now + TTL, ...outcome });
  }
  // → { ok: true, session } or { ok: false, check, detail }. Anything but a LoginError is the
  // relay failing (a full disk, a bug): "internal", logged without its message (it may quote the
  // request). What a login writes (a new account, a proof, a changed chain or pool row) is settled:
  // no commit of it stays in the WAL in front of what this identity sends next (db.mjs's header).
  function attempt(fields) {
    let outcome;
    try { outcome = { ok: true, session: db.settle(() => login(fields)) }; } catch (e) {
      if (!(e instanceof LoginError)) { log(`login bug ${e.name} ${String(e.stack).split('\n')[1]?.trim()}`); outcome = { ok: false, check: 'internal', detail: 'the relay failed: try again later' }; }
      else outcome = { ok: false, check: e.check, detail: e.detail };
    }
    record(outcomeKey(fields.username, fields.clientId, fields.password), { ok: outcome.ok, check: outcome.check, detail: outcome.detail });
    return outcome;
  }

  // ---- MQTT ----
  const attach = (client, prefix) => { prefixes.set(client, prefix); };
  const prefixOfClient = (client) => prefixes.get(client) ?? 'unknown';
  // The socket of `client` closed (server.mjs), or its seat was given to another (authenticate):
  // its session, if it had one, no longer counts.
  function detach(client) {
    const u = unproven.get(client);
    if (u) { clearTimeout(u.timer); unproven.delete(client); }
    clearTimeout(ending.get(client)); ending.delete(client);
    const prefix = counted.get(client);
    if (prefix === undefined) return;
    counted.delete(client);
    const n = live.get(prefix) - 1;
    if (n > 0) live.set(prefix, n); else live.delete(prefix);
    total--;
    if (liveIds.get(client.id) === client) liveIds.delete(client.id);
  }
  function authenticate(client, username, password, cb) {
    const prefix = prefixOfClient(client);
    const o = attempt({ username, clientId: client.id, clean: client.clean, password, prefix });
    if (!o.ok) {
      log(`refused ${prefix} ${o.check}`);
      stats?.count('login_refused', o.check);
      return cb(Object.assign(new Error(o.check), { returnCode: RETURN_CODE[o.check] ?? 4, login: true }), false);   // login: logged once, above
    }
    // The seat this login takes (seat): that session stops counting now and is closed.
    if (o.session.evict) { const victim = o.session.evict; detach(victim); setImmediate(() => victim.close()); }
    // A will is published after the session ends, outside any login: the relay keeps none.
    client._will = null;
    sessions.set(client, { account: o.session.account, clientId: o.session.clientId, prefix });
    counted.set(client, prefix); live.set(prefix, (live.get(prefix) ?? 0) + 1); total++; liveIds.set(client.id, client);
    if (!o.session.durable) {
      const timer = setTimeout(() => client.close(), unprovenSeconds * 1000);
      timer.unref();
      unproven.set(client, { prefix, timer });
    }
    // A closed relay's session ends with the attestation it was admitted by (a timer holds at most
    // 2^31 - 1 ms, ~24.8 days: closed then, the client logs in again and is checked again).
    if (Number.isSafeInteger(o.session.admitted)) {
      const timer = setTimeout(() => client.close(), Math.min(Math.max(0, o.session.admitted - clock()) * 1000, 2 ** 31 - 1));
      timer.unref();
      ending.set(client, timer);
    }
    log(`login ${prefix}`);
    stats?.count('logins'); stats?.sessions(total);
    cb(null, true);
  }

  // ---- HTTP (loopback; nginx fronts it and sends the client's address as X-Real-IP) ----
  const httpFail = (status, error) => Object.assign(new Error(error), { status });
  const httpPrefix = (req) => prefixOf(clientAddress(req));
  function challenge(url, prefix) {
    const d = url.searchParams.get('did') ?? '';
    if (!DID_RE.test(d)) throw httpFail(400, 'did: want ?did=did:sigelo:z… (your current DID, in full)');
    const now = clock();
    try { charge('challenge', prefix, now, 1, loginRate, `more than ${loginRate} challenges a minute from this network: wait`); } catch (e) { throw Object.assign(httpFail(429, e.message), { retryAfter: e.retryAfter }); }
    // pow_bits: the difficulty a new identity must meet with this nonce (M4: by the network asking
    // and what it holds unredeemed, pow.mjs, which counts this one from now on); 0 = none asked (a
    // closed relay asks none: closed.mjs). A
    // policy answering anything else is the relay's fault: 500.
    const network = networkOf(prefix), exp = nonceTime(now) + TTL, bits = closed ? 0 : policy.powBits?.({ network, exp, now }) ?? 0;
    if (!Number.isInteger(bits) || bits < 0 || bits > 64) throw new Error('policy.powBits: not a whole number of bits, 0 to 64');
    return { challenge: loginBody(d, host, newNonce(d, exp, bits, network)), pow_bits: bits };
  }
  // prefix: the login rate is already charged to it (before the body was read).
  function check(body, prefix) {
    const keys = Object.keys(body);
    if (typeof body.username !== 'string' || typeof body.client_id !== 'string' || typeof body.password !== 'string'
      || (body.clean !== undefined && typeof body.clean !== 'boolean') || keys.some((k) => !['username', 'client_id', 'password', 'clean'].includes(k)))
      throw httpFail(400, 'want {username, client_id, password, clean?}: the CONNECT fields, password as the string sent');
    const password = Buffer.from(body.password, 'utf8');
    const seen = outcomes.get(outcomeKey(body.username, body.client_id, password));
    const o = seen && seen.exp > clock() ? seen : attempt({ username: body.username, clientId: body.client_id, clean: body.clean ?? false, password, prefix, charged: true });
    if (o.check === 'internal') throw httpFail(503, o.detail);
    return o.ok ? { ok: true } : { ok: false, check: o.check, detail: o.detail };
  }

  const readBody = (req) => new Promise((resolve, reject) => {
    if (Number(req.headers['content-length'] ?? 0) > MAX_BODY) return reject(httpFail(413, `body over ${MAX_BODY} bytes`));
    const parts = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reject(httpFail(413, `body over ${MAX_BODY} bytes`)); req.destroy(); } else parts.push(c); });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
  const http = createServer(async (req, res) => {
    // after: a refusal's Retry-After, in seconds (charge, park.charge).
    const send = (status, v, after) => {
      if (res.headersSent) return;
      res.writeHead(status, { 'content-type': 'application/json', ...(Number.isSafeInteger(after) && after > 0 && { 'retry-after': String(after) }) });
      res.end(JSON.stringify(v) + '\n');
    };
    try {
      const url = new URL(req.url, 'http://relay');
      const route = `${req.method} ${url.pathname}`;
      if (route === 'GET /challenge') return send(200, challenge(url, httpPrefix(req)));
      if (route === 'GET /stats' && stats) return send(200, stats.report());   // counts only (stats.mjs)
      if (route === 'POST /licence' && policy.licence) { const r = await policy.licence({ prefix: httpPrefix(req), read: async () => parseBytes(await readBody(req)) }); return send(r.status, r.body); }   // M4: operator.mjs
      if (route === 'POST /check') {
        // The login rate first: reading and strictly parsing up to 256 KB is work too (~10 ms).
        const prefix = httpPrefix(req);
        try { chargeLogin(prefix, clock()); } catch (e) { return send(200, { ok: false, check: e.check, detail: e.detail }); }
        let body;
        try { body = parseBytes(await readBody(req)); } catch (e) { if (e.status) throw e; throw httpFail(400, `body is not strict JSON: ${e.message}`); }
        if (!isObject(body)) throw httpFail(400, 'body is not a JSON object');
        return send(200, check(body, prefix));
      }
      // Short invite codes (park.mjs). The park brake first, before the body or the login.
      if (park && route === 'POST /park') {
        const prefix = httpPrefix(req);
        try { park.charge('park', prefix, clock()); } catch (e) { return send(429, { ok: false, check: e.check, detail: e.detail }, e.retryAfter); }
        let body;
        try { body = parseBytes(await readBody(req)); } catch (e) { if (e.status) throw e; throw httpFail(400, `body is not strict JSON: ${e.message}`); }
        if (!isObject(body) || Object.keys(body).length !== PARK_FIELDS.length || !PARK_FIELDS.every((k) => Object.hasOwn(body, k))
          || typeof body.username !== 'string' || typeof body.client_id !== 'string' || typeof body.password !== 'string') {
          throw httpFail(400, `want {${PARK_FIELDS.join(', ')}}: POST /check's login fields, then what to park`);
        }
        const o = attempt({ username: body.username, clientId: body.client_id, clean: false, password: Buffer.from(body.password, 'utf8'), prefix });
        if (o.check === 'internal') throw httpFail(503, o.detail);
        if (!o.ok) return send(200, { ok: false, check: o.check, detail: o.detail });
        // Only an identity that has proven its work (allowance.mjs keep) parks: a fresh DID costs nothing.
        if (!o.session.durable) return send(200, { ok: false, check: 'pow', detail: 'a new identity parks after its first login with proof of work: run inbox, then invite again' });
        try { return send(200, { ok: true, ...park.park(body, body.username, clock()) }); } catch (e) { if (!(e instanceof ParkError)) throw e; return send(200, { ok: false, check: e.check, detail: e.detail }); }
      }
      // Gift codes (gifts.mjs): the brake first, before the body or the login, as /park. Neither the
      // hash nor anything of the code is logged, nor quoted in a refusal.
      if (route === 'POST /gift' && policy.gift) {
        const prefix = httpPrefix(req);
        try { policy.gift.charge(prefix, clock()); } catch (e) { if (e.check !== 'rate') throw e; return send(429, { ok: false, check: e.check, detail: e.detail }, e.retryAfter); }
        let body;
        try { body = parseBytes(await readBody(req)); } catch (e) { if (e.status) throw e; throw httpFail(400, `body is not strict JSON: ${e.message}`); }
        if (!isObject(body) || Object.keys(body).length !== GIFT_FIELDS.length || !GIFT_FIELDS.every((k) => typeof body[k] === 'string')) {
          throw httpFail(400, `want {${GIFT_FIELDS.join(', ')}}: POST /check's login fields, then the code's hash`);
        }
        const o = attempt({ username: body.username, clientId: body.client_id, clean: false, password: Buffer.from(body.password, 'utf8'), prefix });
        if (o.check === 'internal') throw httpFail(503, o.detail);
        if (!o.ok) return send(200, { ok: false, check: o.check, detail: o.detail });
        // An identity with no proof of work has no account here to be an operator's.
        if (!o.session.durable) return send(200, { ok: false, check: 'pow', detail: 'a new identity redeems after its first login with proof of work: run inbox, then redeem again' });
        let r;
        try { r = policy.gift.redeem({ account: o.session.account, current: body.username, code_hash: body.code_hash }, clock()); } catch (e) {
          log(`gift bug ${e.name}`);
          throw httpFail(503, 'the relay failed: try again later');
        }
        return send(200, r);
      }
      if (park && req.method === 'GET' && url.pathname.startsWith('/park/')) {
        try { park.charge('lookup', httpPrefix(req), clock()); } catch (e) { return send(429, { ok: false, check: e.check, detail: e.detail }, e.retryAfter); }
        const invite = park.fetch(url.pathname.slice('/park/'.length), clock());
        if (invite === null) return send(404, { ok: false, check: 'park_unknown', detail: 'no code parked under this hash: mistyped, used, or older than 10 minutes' });
        return send(200, { ok: true, invite });
      }
      // MQTT over WebSocket is an upgrade (server.mjs); a plain request gets here.
      if (url.pathname === WS_PATH) throw httpFail(426, 'MQTT over WebSocket: send a WebSocket upgrade with subprotocol mqtt');
      throw httpFail(['/challenge', '/check', '/park'].includes(url.pathname) || (policy.gift && url.pathname === '/gift') ? 405 : 404, `no ${req.method} ${url.pathname}: GET /challenge?did=…, POST /check${park ? ', POST /park, GET /park/<hash>' : ''}`);
    } catch (e) {
      if (!e.status) log(`http bug ${e.name}`);
      send(e.status ?? 500, { error: e.status ? e.message : 'internal error' }, e.retryAfter);
    }
  });
  // world/server.mjs's timeouts: a slow client must not hold a connection open.
  http.requestTimeout = 20000;
  http.headersTimeout = 10000;
  http.keepAliveTimeout = 5000;

  return { http, authenticate, attach, detach, prefixOf: prefixOfClient, sessionOf: (client) => sessions.get(client), login: attempt, sessions: () => total };
}
