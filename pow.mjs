// SPDX-License-Identifier: AGPL-3.0-only
// relay/pow.mjs — proof of work for a new identity (design/relay-plan.md §3 "Proof of work", §5,
// §11 "Allowances (pricing leak)").
//
// Once per new original DID, before its first claim (a mailbox or an invite topic): the client
// finds c, a string of 1 to 16 decimal digits, such that
//
//   Argon2id(password = "sigelo-relay-pow/1\n" ‖ relay host ‖ original DID ‖ nonce ‖ c,
//            salt = the first 16 bytes of SHA-256(nonce), m = 65536 KiB, t = 3, p = 1, 32 bytes)
//
// (RFC 9106, version 0x13, no secret, no associated data; strings UTF-8) has at least b leading
// zero bits, nonce = the login nonce (GET /challenge), and sends c as the CONNECT password's `pow`.
// GET /challenge states the function beside pow_bits, `pow: {v: 1, alg: "argon2id", m, t, p}`, so
// a client refuses what it does not know. Checking costs one evaluation; the nonce is single use,
// so the proof is too, and it names this relay and this identity, so it is good nowhere else.
// Argon2id, not SHA-256 (sigelo-relay-pow/0, dropped 2026-11-13, no outside clients yet): a GPU or
// ASIC does SHA-256 thousands of times faster than a phone, so any difficulty a phone bears was free
// for a minter. Every Argon2id attempt fills 64 MiB, so the edge is memory bandwidth, single digits.
//
// Measured 2026-11-13 on a phone-class ARM CPU (Snapdragon 845, Node 24, hash-wasm 4.12.0): one
// evaluation takes 485 ms on a big core (in the main thread and in a worker alike), 1.64 s on a
// little one; Node's native crypto.argon2 (OpenSSL) 404 ms, 1.2 times faster; @noble's pure
// JavaScript 5.5 s. So 2^6 evaluations, the base, take 31 s on average; 2^8 2 minutes, 2^10 8.
//
// b is fixed when the challenge is issued, and GET /challenge gives it as pow_bits; auth.mjs
// carries it inside the nonce, under the nonce's MAC, with the network that asked. So a proof is
// checked against exactly the difficulty its client was told, whatever happened since: a raise
// in the meantime refuses no honest client mid-search. b is the highest of:
//   - the base, 6 bits;
//   - 8 while more new identities prove work in a clock hour than the relay is configured for
//     (that hour and the next), challenges waiting counted with them: a flood of new DIDs from
//     everywhere;
//   - by the asking network (the address cut to /24 or /48): the base while fewer than 8 new
//     identities from it proved work in the last 24 hours, the base + 2 from 8, the base + 4 from
//     64 (NETWORK_STEPS: 6, 8, 10), challenges waiting counted with them. Free allowances are
//     per DID, so DIDs minted from one network must cost more and more (§11); an honest household
//     or office mints a few a day. With the defaults the cap below (NETWORK_DAY good proofs) is the
//     top step's 64, so 10 is stated only while challenges waiting bring the count to 64 before
//     the 64th good proof: in practice the curve runs 6, 8, closed.
// The steps slow an honest client, and now a minter nearly as much: all 8 cores of the same CPU
// evaluate 13 a second natively (measured), where SHA-256 ran 20 million, so the 64 new identities
// a network may bring in a day (8 × 2^6 + 56 × 2^8 evaluations) cost it ~19 minutes, not seconds;
// a GPU gains little, every attempt being 64 MiB of memory traffic. What still bounds the identities one network mints is a count: past
// NETWORK_DAY good proofs from a network in the last 24 hours, its next new identity is refused "pow"
// however good its proof, and GET /challenge states CLOSED_BITS to it meanwhile, so an honest client
// there spends no search on a refusal (one that has proven work already sends none: its logins go
// on). A shared network (carrier NAT, an office, a cloud provider's /24) that brings NETWORK_DAY new
// identities in a day waits for the next, a licensed operator's new agents included: GET /challenge
// states the cap before the relay sees any bundle. One co-tenant can close it so for those ~19
// minutes of one phone, and again every day (relay/README.md says so).
// Waiting: a challenge issued (auth.mjs calls issue()) and neither spent by a login (spent()) nor
// expired. Each counts as an arrival to come, because its difficulty is frozen in its nonce:
// counting good proofs alone, a network fetched as many challenges as it liked at the base before
// redeeming any, and every one of its DIDs came in at the base. A login spends its nonce within a
// second or two, a known identity's included, so honest logins leave nothing waiting. The cost:
// whoever keeps 64 challenges unredeemed (13 a minute, under the challenge rate) holds its own
// network at the base + 4 for new DIDs without any work, until 5 minutes after it stops. Without
// counting them, the same took 64 proofs (about 2^14 evaluations) and lasted 24 hours. Challenges
// held slow a shared network (carrier NAT, an office) down and never close it: only good proofs count
// towards the cap above. The load raise likewise: 1,000 unredeemed from 7 networks put every new
// DID at 8, where every client gets in.
// Arrivals are counted against the network the challenge was issued to (from the nonce), not the
// one the CONNECT came from: else challenges asked from one network and logins made from another
// kept the first at the base for ever. A heavier proof slows new DIDs only, never a known
// identity: it proves work once. Many networks (IPv6 address rotation) still beat the per-network
// steps: plan §10, R15.
// The relay's cost: one evaluation per proof checked, ~0.5 s of a core and 64 MiB, so a check runs
// only after every cheap one passed (auth.mjs: the password's shape, the nonce, the signature and
// chain, the client id; allowance.mjs: c's shape, a proof already held, the network's cap), off the
// event loop in a worker thread, at most RELAY_POW_CHECKS (CHECKS, 4) at once: 256 MiB at most.
// Up to WAITING_PER (4) times as many wait their turn, in order, a second or two; their nonce was
// checked unexpired when the login arrived, and a wait never expires it. Past that, a login that
// sends a proof is refused `rate` before its nonce is spent (busy()): the same CONNECT, proof and
// all, is good again until the nonce's 300 s are up (apps/contact/carrier.mjs sends it again).
import { createHash } from 'node:crypto';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import hashWasm from 'hash-wasm';

export const POW_V = 1, POW_PREFIX = 'sigelo-relay-pow/1\n';
// The dropped SHA-256 proof (sigelo-relay-pow/0, 50a2960): a client of before 2026-11-13 (npm 0.1.14 to
// 0.1.17) still computes it, and passed the Argon2id check by chance at a low pow_bits (1 in 4 at 2 bits),
// so it failed "at random" with a formula it could not act on (the agent-setup feedback, point 1). No grace: a proof
// that misses Argon2id but is the old solver's answer (oldProof) is refused client_old, its one line below.
// Checked only after Argon2id failed, so a current client's good proof never reaches it.
export const OLD_PREFIX = 'sigelo-relay-pow/0\n', CLIENT_OLD = 'client too old: npm i -g sigelo-agent@latest';
// The function's cost: memory in KiB, passes, lanes. A relay may be built cheaper for tests
// (powCheck's cost); GET /challenge states whichever it checks, and a client refuses more than this.
export const ARGON = Object.freeze({ m: 65536, t: 3, p: 1 });
// One evaluation at ARGON on the phone-class CPU of the header, in ms (apps/contact/page.mjs's
// estimate of a search scales it by m × t).
export const EVAL_MS = 485;
// The proof must be found within the login nonce's 300 s (auth.mjs TTL): 2^6 evaluations take 31 s
// on average, 2^8 2 minutes, 2^10 8 minutes. So the load raise stops at 8, where every client
// still gets in; only a network whose good proofs and challenges waiting reach 64 in a day reaches
// 10 (the header: with the defaults, only by holding challenges), where such a client finds a proof
// within apps/contact/carrier.mjs's 280 s search about half the time (1 - e^(-280/497)) and may
// need a second challenge.
export const POW_BITS = 6, POW_LOAD_BITS = 8, HOUR = 3600, DAY = 86400;
export const NETWORK_STEPS = Object.freeze([Object.freeze({ from: 8, add: 2 }), Object.freeze({ from: 64, add: 4 })]);
// New identities one network may bring in 24 hours (the header), and the difficulty GET /challenge
// states to a network that has: more than any client searches for (apps/contact/carrier.mjs stops at 10).
export const NETWORK_DAY = 64, CLOSED_BITS = 64;
// Evaluations at once (RELAY_POW_CHECKS), and how many times as many may wait (the header).
export const CHECKS = 4, WAITING_PER = 4;
export const C_RE = /^[0-9]{1,16}$/;
// Networks whose arrivals and waiting challenges are kept in memory (an address never reaches the
// file). Past this, those with nothing left in the last day go first, then the oldest.
const NETWORKS = 100000;
// A worker with nothing to check for this long ends (its 64 MiB goes with it).
const IDLE_MS = 30000;

// Whether c is what a client of the dropped SHA-256 proof sends: the FIRST counter (0, 1, 2, …) whose SHA-256 over
// the same string has `bits` leading zero bits, as its solver searched. A current client's failed Argon2id proof meets
// the bits by chance 1 time in 2^bits, and is also the first such counter far more rarely still. At most OLD_SCAN hashes.
const OLD_SCAN = 1 << 20;
const oldDigest = (prefix, c) => createHash('sha256').update(prefix + c, 'utf8').digest();
export function oldProof(host, original, nonce, c, bits) {
  const prefix = OLD_PREFIX + host + original + nonce, n = Number(c);
  if (!/^(0|[1-9][0-9]*)$/.test(c) || !Number.isSafeInteger(n) || n > OLD_SCAN || leadingZeroBits(oldDigest(prefix, c)) < bits) return false;
  for (let i = 0; i < n; i++) if (leadingZeroBits(oldDigest(prefix, String(i))) >= bits) return false;
  return true;
}

/** GET /challenge's `pow`: the function and its cost, beside pow_bits. */
export const powParams = (cost = ARGON) => ({ v: POW_V, alg: 'argon2id', m: cost.m, t: cost.t, p: cost.p });
export function checkCost(cost) {
  if (!Number.isInteger(cost?.m) || cost.m < 8 || cost.m > 4194304 || !Number.isInteger(cost.t) || cost.t < 1 || cost.t > 16 || cost.p !== 1) {
    throw new Error('pow cost: want {m: 8 to 4194304 KiB, t: 1 to 16 passes, p: 1}');
  }
  return Object.freeze({ m: cost.m, t: cost.t, p: 1 });
}
/** The salt: the first 16 bytes of SHA-256(nonce). */
export const powSalt = (nonce) => createHash('sha256').update(nonce, 'utf8').digest().subarray(0, 16);
const evaluate = ({ password, salt, m, t, p }) => hashWasm.argon2id({ password, salt, parallelism: p, iterations: t, memorySize: m, hashLength: 32, outputType: 'binary' });
/** → the 32-byte Argon2id output for this c (the header), in this thread. */
export const powDigest = async (host, original, nonce, c, cost = ARGON) => evaluate({ password: POW_PREFIX + host + original + nonce + c, salt: powSalt(nonce), ...cost });

export function leadingZeroBits(digest) {
  let n = 0;
  for (const byte of digest) {
    if (byte !== 0) return n + Math.clz32(byte) - 24;
    n += 8;
  }
  return n;
}

// The tests' side (a client's is apps/contact/platform-node.mjs): the first c (0, 1, 2, …) that
// meets `bits`. 2^bits evaluations on average.
export async function solve(host, original, nonce, bits, cost = ARGON) {
  for (let i = 0; ; i++) {
    const c = String(i);
    if (leadingZeroBits(await powDigest(host, original, nonce, c, cost)) >= bits) return c;
  }
}

// The worker threads a relay checks proofs in: at most `size` at once, started when needed and
// ended IDLE_MS after their last, `size` × WAITING_PER waiting in order. run(job) → the output.
// busy(): none would start now and the waiting are at their most.
export function argonPool(size = CHECKS) {
  if (!Number.isInteger(size) || size < 1 || size > 64) throw new Error('pow checks: want a whole number from 1 to 64');
  const idle = [], queue = [], max = size * WAITING_PER;
  let workers = 0;
  const start = () => {
    const w = new Worker(new URL(import.meta.url), { workerData: { pow: POW_PREFIX } });
    w.unref();
    workers++;
    w.on('error', (e) => { w.job?.reject(e); w.job = null; });
    w.on('exit', () => { workers--; const i = idle.indexOf(w); if (i >= 0) idle.splice(i, 1); w.job?.reject(new Error('pow worker exited')); w.job = null; next(); });
    w.on('message', ({ out, error }) => {
      const j = w.job;
      w.job = null;
      if (error) j?.reject(new Error(error)); else j?.resolve(new Uint8Array(out));
      give(w);
    });
    return w;
  };
  const give = (w) => {
    if (queue.length > 0) { send(w, queue.shift()); return; }
    w.timer = setTimeout(() => w.terminate(), IDLE_MS);
    w.timer.unref();
    idle.push(w);
  };
  const send = (w, j) => { clearTimeout(w.timer); w.job = j; w.postMessage(j.job); };
  const next = () => { while (queue.length > 0 && workers < size) send(start(), queue.shift()); };
  return {
    busy: () => idle.length === 0 && workers >= size && queue.length >= max,
    run: (job) => new Promise((resolve, reject) => {
      const j = { job, resolve, reject };
      if (idle.length > 0) send(idle.pop(), j);
      else if (workers < size) send(start(), j);
      else queue.push(j);
    }),
  };
}
// One pool per size in a process, started at the first check (a relay that checks none starts no
// worker), shared by the relays a process runs (the tests run many).
const pools = new Map();
const poolOf = (size) => pools.get(size) ?? pools.set(size, argonPool(size)).get(size);
if (!isMainThread && workerData?.pow === POW_PREFIX) {
  parentPort.on('message', (job) => evaluate(job).then((out) => parentPort.postMessage({ out }), (e) => parentPort.postMessage({ error: String(e?.message ?? e) })));
}

function checkSteps(steps, bits) {
  if (!Array.isArray(steps) || steps.length === 0) throw new Error('pow steps: want [{from, add}, …], at least one');
  steps.forEach((s, i) => {
    const prev = steps[i - 1];
    if (!Number.isSafeInteger(s?.from) || s.from < 1 || (prev && s.from <= prev.from)) throw new Error('pow steps: want each from a whole number of new identities, at least 1, rising');
    if (!Number.isInteger(s.add) || s.add < 1 || (prev && s.add <= prev.add)) throw new Error('pow steps: want each add a whole number of bits, at least 1, rising');
  });
  if (bits + steps.at(-1).add > 64) throw new Error(`pow bits: at most ${64 - steps.at(-1).add}, so the highest network step stays within 64`);
}

// The relay's side. bits: the base difficulty; loadBits: the difficulty under load; loadPerHour:
// good proofs from new identities in a clock hour (challenges waiting added) above which loadBits
// applies, for the rest of that hour and the next (undefined: never); steps: the per-network curve
// (NETWORK_STEPS); perDay: the new identities one network may bring in 24 hours (NETWORK_DAY);
// cost: the function's ({m, t, p}, ARGON; the tests' relays use less); checks: evaluations at once
// (CHECKS). A network is whatever key auth.mjs gives for it; undefined counts towards no network.
export function powCheck({ bits = POW_BITS, loadBits = POW_LOAD_BITS, loadPerHour, steps = NETWORK_STEPS, perDay = NETWORK_DAY, cost = ARGON, checks = CHECKS } = {}) {
  for (const [name, v] of [['bits', bits], ['loadBits', loadBits]]) {
    if (!Number.isInteger(v) || v < 0 || v > 64) throw new Error(`pow ${name}: want a whole number of bits, 0 to 64`);
  }
  if (loadBits < bits) throw new Error('pow loadBits: want at least bits');
  if (loadPerHour !== undefined && (!Number.isInteger(loadPerHour) || loadPerHour < 1)) throw new Error('pow loadPerHour: want a whole number of new identities, at least 1');
  checkSteps(steps, bits);
  if (!Number.isSafeInteger(perDay) || perDay < 1) throw new Error('pow perDay: want a whole number of new identities, at least 1');
  const argon = checkCost(cost), params = Object.freeze(powParams(argon));
  if (!Number.isInteger(checks) || checks < 1 || checks > 64) throw new Error('pow checks: want a whole number from 1 to 64');
  // Arrivals kept per network: enough for the highest step and for the cap.
  const top = Math.max(steps.at(-1).from, perDay);

  let hour = -1, arrivals = 0, previous = 0;
  const roll = (now) => {
    const h = Math.floor(now / HOUR);
    if (h !== hour) { previous = h === hour + 1 ? arrivals : 0; arrivals = 0; hour = h; }
  };
  // Challenges waiting on every network together, for the load raise: exp → how many, and the sum.
  // Issued in time order, so the map runs in exp order and the expired go from its front; a clock
  // set back leaves some behind until those before them expire: counted too long, never too short.
  const waiting = new Map();
  let waitingAll = 0;
  const expire = (now) => {
    for (const [exp, k] of waiting) { if (exp > now) break; waiting.delete(exp); waitingAll -= k; }
  };
  const loaded = (now) => { roll(now); expire(now); return loadPerHour !== undefined && (arrivals + waitingAll > loadPerHour || previous > loadPerHour); };

  // network → { arrived: the times of its latest good proofs within the last DAY, oldest first, at
  // most `top` (the highest step needs no more), waiting: the exp of each of its challenges neither
  // spent nor expired, oldest first }. Every waiting challenge is kept, so a spend always finds one
  // of its own exp: with a cap, the spends of challenges left out removed kept ones issued in the
  // same second, and the count fell below what waits. auth.mjs's challenge rate per network bounds
  // them (loginRate a minute, for the 5 minutes a challenge lives).
  const nets = new Map();
  const recent = (network, now) => {
    const e = nets.get(network);
    if (!e) return 0;
    while (e.arrived.length > 0 && e.arrived[0] <= now - DAY) e.arrived.shift();
    while (e.waiting.length > 0 && e.waiting[0] <= now) e.waiting.shift();
    if (e.arrived.length === 0 && e.waiting.length === 0) nets.delete(network);
    return e.arrived.length + e.waiting.length;
  };
  function forget(now) {
    for (const [k, e] of nets) if ((e.arrived.at(-1) ?? -Infinity) <= now - DAY && (e.waiting.at(-1) ?? -Infinity) <= now) nets.delete(k);
    while (nets.size > NETWORKS * 0.9) nets.delete(nets.keys().next().value);
  }
  const entry = (network, now) => {
    let e = nets.get(network);
    if (!e) {
      if (nets.size >= NETWORKS) forget(now);
      e = { arrived: [], waiting: [] };
      nets.set(network, e);
    }
    return e;
  };
  const networkAdd = (network, now) => {
    const n = network === undefined ? 0 : recent(network, now);
    let add = 0;
    for (const s of steps) if (n >= s.from) add = s.add;
    return add;
  };
  const required = (now, network) => Math.max(loaded(now) ? loadBits : bits, bits + networkAdd(network, now));
  // Whether `network` has brought perDay new identities in the last 24 hours: good proofs only, so
  // challenges held unredeemed close no network.
  const capped = (now, network) => {
    if (network === undefined) return false;
    recent(network, now);
    return (nets.get(network)?.arrived.length ?? 0) >= perDay;
  };

  return {
    // → the difficulty for a new identity whose challenge `network` would ask for now. Counts nothing.
    required,
    capped,
    perDay,
    // GET /challenge's `pow` beside pow_bits (the header).
    params,
    // Whether a login with a proof is refused `rate` now, before its nonce is spent (the header).
    busy: () => pools.get(checks)?.busy() ?? false,
    // A challenge issued now to `network`, valid until `exp` (auth.mjs's GET /challenge): → its
    // difficulty, from what came before it (CLOSED_BITS to a network at its cap), and from now on it
    // waits (above) until spent or expired.
    // enrol: the challenge names a live enrolment code (park.mjs enrolGrace): the base, not the load or the
    // network's step (the agent-setup feedback, point 10: a machine whose own model held its CPU could not solve 8
    // bits in time, and its code was spent). Still counted as waiting, and still closed at the cap.
    issue(now, network, exp, enrol = false) {
      const b = capped(now, network) ? CLOSED_BITS : enrol ? bits : required(now, network);
      waiting.set(exp, (waiting.get(exp) ?? 0) + 1);
      waitingAll++;
      if (network !== undefined) entry(network, now).waiting.push(exp);
      return b;
    },
    // A login spent the nonce of a challenge issued to `network` with this `exp` (auth.mjs, once per
    // nonce): it waits no more. Whether it brought a good proof is arrived()'s business.
    spent(now, network, exp) {
      const k = waiting.get(exp);
      if (k !== undefined) {
        if (k > 1) waiting.set(exp, k - 1); else waiting.delete(exp);
        waitingAll--;
      }
      const e = network === undefined ? undefined : nets.get(network);
      const i = e ? e.waiting.indexOf(exp) : -1;
      if (i >= 0) e.waiting.splice(i, 1);
    },
    // A new identity's good proof (allowance.mjs), on a challenge issued to `network`: one arrival.
    arrived(now, network) {
      roll(now);
      arrivals++;
      if (network === undefined) return;
      const e = entry(network, now);
      e.arrived.push(now);
      if (e.arrived.length > top) e.arrived.shift();
    },
    // → a promise of null when c is a proof for this login at `stated` bits (what GET /challenge gave
    // with its nonce), else of why not. Never below the base: a stated difficulty under it can only
    // be a bug. One evaluation, in a worker (argonPool), after the shape.
    async check({ pow, host, original, nonce, bits: stated }) {
      if (typeof pow !== 'string' || !C_RE.test(pow)) return 'want c as a string of 1 to 16 decimal digits';
      const need = Math.max(stated, bits);
      if (need === 0) return null;   // every output has at least 0 zero bits: nothing to evaluate
      const out = await poolOf(checks).run({ password: POW_PREFIX + host + original + nonce + pow, salt: powSalt(nonce), ...argon });
      if (leadingZeroBits(out) >= need) return null;
      if (oldProof(host, original, nonce, pow, need)) return CLIENT_OLD;
      return `does not meet ${need} bits: compute it over this login's nonce, the relay host and your original DID, to the pow_bits GET /challenge gave with that nonce`;
    },
  };
}
