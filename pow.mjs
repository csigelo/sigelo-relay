// SPDX-License-Identifier: AGPL-3.0-only
// relay/pow.mjs — proof of work for a new identity (design/relay-plan.md §3 "Proof of work", §5,
// §11 "Allowances (pricing leak)").
//
// Once per new original DID, before its first claim (a mailbox or an invite topic): the client
// finds c, a string of 1 to 16 decimal digits, such that
//
//   SHA-256("sigelo-relay-pow/0\n" ‖ relay host ‖ original DID ‖ nonce ‖ c)
//
// has at least b leading zero bits, nonce = the login nonce (GET /challenge), and sends c as the
// CONNECT password's `pow`. Checking costs one hash; the nonce is single use, so the proof is too,
// and it names this relay and this identity, so it is good nowhere else.
//
// b is fixed when the challenge is issued, and GET /challenge gives it as pow_bits; auth.mjs
// carries it inside the nonce, under the nonce's MAC, with the network that asked. So a proof is
// checked against exactly the difficulty its client was told, whatever happened since: a raise
// in the meantime refuses no honest client mid-search. b is the highest of:
//   - the base, 22 bits;
//   - 24 while more new identities prove work in a clock hour than the relay is configured for
//     (that hour and the next), challenges waiting counted with them: a flood of new DIDs from
//     everywhere;
//   - by the asking network (the address cut to /24 or /48): the base while fewer than 8 new
//     identities from it proved work in the last 24 hours, the base + 2 from 8, the base + 4 from
//     64 (NETWORK_STEPS: 22, 24, 26), challenges waiting counted with them. Free allowances are
//     per DID, so DIDs minted from one network must cost more and more (§11); an honest household
//     or office mints a few a day. With the defaults the cap below (NETWORK_DAY good proofs) is the
//     top step's 64, so 26 is stated only while challenges waiting bring the count to 64 before
//     the 64th good proof: in practice the curve runs 22, 24, closed.
// The steps slow an honest client, not a minter: a native SHA-256 on the same phone-class CPU
// does ~20 million candidates a second on one core (OpenSSL, the proof's fixed prefix hashed once),
// ~130 times Node's createHash, so 2^26 takes it ~3 s, and a GPU milliseconds. What bounds the
// identities one network mints is a count: past NETWORK_DAY good proofs from a network in the last
// 24 hours, its next new identity is refused "pow" however good its proof, and GET /challenge
// states CLOSED_BITS to it meanwhile, so an honest client there spends no search on a refusal (one
// that has proven work already sends none: its logins go on). A shared network (carrier NAT, an
// office, a cloud provider's /24) that brings NETWORK_DAY new identities in a day waits for the
// next, a licensed operator's new agents included: GET /challenge states the cap before the relay
// sees any bundle. One co-tenant can close it so for a minute of native compute (8 × 2^22 + 56 ×
// 2^24 hashes), and again every day (relay/README.md says so).
// Waiting: a challenge issued (auth.mjs calls issue()) and neither spent by a login (spent()) nor
// expired. Each counts as an arrival to come, because its difficulty is frozen in its nonce:
// counting good proofs alone, a network fetched as many challenges as it liked at the base before
// redeeming any, and every one of its DIDs came in at the base. A login spends its nonce within a
// second or two, a known identity's included, so honest logins leave nothing waiting. The cost:
// whoever keeps 64 challenges unredeemed (13 a minute, under the challenge rate) holds its own
// network at the base + 4 for new DIDs without any work, until 5 minutes after it stops. Without
// counting them, the same took 64 proofs (about 2^30 hashes) and lasted 24 hours. Challenges held
// slow a shared network (carrier NAT, an office) down and never close it: only good proofs count
// towards the cap above. The load raise likewise: 1,000 unredeemed from 7 networks put every new
// DID at 24, where every client gets in.
// Arrivals are counted against the network the challenge was issued to (from the nonce), not the
// one the CONNECT came from: else challenges asked from one network and logins made from another
// kept the first at the base for ever. A heavier proof slows new DIDs only, never a known
// identity: it proves work once. Many networks (IPv6 address rotation) still beat the per-network
// steps: plan §10, R15.
import { createHash } from 'node:crypto';

export const POW_PREFIX = 'sigelo-relay-pow/0\n';
// The proof must be found within the login nonce's 300 s (auth.mjs TTL). Node's createHash on a
// phone-class CPU does ~160,000 a second (a native solver ~130 times that: the header): 2^22 takes
// it 26 s on average, 2^24 105 s, 2^26 419 s. So the load
// raise stops at 24, where every client still gets in; only a network whose good proofs and
// challenges waiting reach 64 in a day reaches 26 (the header: with the defaults, only by holding
// challenges), where such a client finds a proof within contact/carrier.mjs's 280 s search about
// half the time (1 - e^(-280/419)) and may need a second challenge.
export const POW_BITS = 22, POW_LOAD_BITS = 24, HOUR = 3600, DAY = 86400;
export const NETWORK_STEPS = Object.freeze([Object.freeze({ from: 8, add: 2 }), Object.freeze({ from: 64, add: 4 })]);
// New identities one network may bring in 24 hours (the header), and the difficulty GET /challenge
// states to a network that has: more than any client searches for (contact/carrier.mjs stops at 26).
export const NETWORK_DAY = 64, CLOSED_BITS = 64;
export const C_RE = /^[0-9]{1,16}$/;
// Networks whose arrivals and waiting challenges are kept in memory (an address never reaches the
// file). Past this, those with nothing left in the last day go first, then the oldest.
const NETWORKS = 100000;

export const powDigest = (host, original, nonce, c) => createHash('sha256').update(POW_PREFIX + host + original + nonce + c, 'utf8').digest();

export function leadingZeroBits(digest) {
  let n = 0;
  for (const byte of digest) {
    if (byte !== 0) return n + Math.clz32(byte) - 24;
    n += 8;
  }
  return n;
}

// The client's side, and the tests': the first c (0, 1, 2, …) that meets `bits`. 2^bits hashes on
// average.
export function solve(host, original, nonce, bits) {
  for (let i = 0; ; i++) {
    const c = String(i);
    if (leadingZeroBits(powDigest(host, original, nonce, c)) >= bits) return c;
  }
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
// (NETWORK_STEPS); perDay: the new identities one network may bring in 24 hours (NETWORK_DAY). A
// network is whatever key auth.mjs gives for it; undefined counts towards no network.
export function powCheck({ bits = POW_BITS, loadBits = POW_LOAD_BITS, loadPerHour, steps = NETWORK_STEPS, perDay = NETWORK_DAY } = {}) {
  for (const [name, v] of [['bits', bits], ['loadBits', loadBits]]) {
    if (!Number.isInteger(v) || v < 0 || v > 64) throw new Error(`pow ${name}: want a whole number of bits, 0 to 64`);
  }
  if (loadBits < bits) throw new Error('pow loadBits: want at least bits');
  if (loadPerHour !== undefined && (!Number.isInteger(loadPerHour) || loadPerHour < 1)) throw new Error('pow loadPerHour: want a whole number of new identities, at least 1');
  checkSteps(steps, bits);
  if (!Number.isSafeInteger(perDay) || perDay < 1) throw new Error('pow perDay: want a whole number of new identities, at least 1');
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
    // A challenge issued now to `network`, valid until `exp` (auth.mjs's GET /challenge): → its
    // difficulty, from what came before it (CLOSED_BITS to a network at its cap), and from now on it
    // waits (above) until spent or expired.
    issue(now, network, exp) {
      const b = capped(now, network) ? CLOSED_BITS : required(now, network);
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
    // → null when c is a proof for this login at `stated` bits (what GET /challenge gave with its
    // nonce), else why not. Never below the base: a stated difficulty under it can only be a bug.
    check({ pow, host, original, nonce, bits: stated }) {
      if (typeof pow !== 'string' || !C_RE.test(pow)) return 'want c as a string of 1 to 16 decimal digits';
      const need = Math.max(stated, bits);
      if (leadingZeroBits(powDigest(host, original, nonce, pow)) >= need) return null;
      return `does not meet ${need} bits: compute it over this login's nonce, the relay host and your original DID, to the pow_bits GET /challenge gave with that nonce`;
    },
  };
}
