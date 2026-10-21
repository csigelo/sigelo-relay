// SPDX-License-Identifier: AGPL-3.0-only
// relay/operator.mjs — the Pro licence and the operator attestation (design/relay-plan.md §3
// "Operator attestation", "Licence", "Errors"; §5).
//
// Licence: what the offline issuer writes, {attestation, issuer,
// rotations}: an attestation by the vendor's current key, ctx "sigelo-relay", claims {tier: "pro",
// storage_mb, msgs_day, retention_days, groups, support} (design/relay-plan.md §11: what Pro sells).
// support ("none", "email" or "priority") is what the vendor owes, not a limit the relay applies:
// absent, it reads as Pro's "email". It is checked by licence.ts's own vendor rules (the keeper's,
// copied; checkVendorAttestation: the vendor genesis pin, the longest vendor chain seen, recovery
// precedence, the signer is the chain's current key, term at most 3 × 366 days), so the keeper and
// the relay cannot drift. `sub` is the operator's ORIGINAL DID: the relay keys every account by it
// (db.mjs), so a licence binds exactly one account and an operator's rotation needs no new
// licence. Uploaded by POST /licence and kept per operator, once the operator has logged in: the
// relay keeps the operator's chain with its account, and takes its current key from there.
//
// Operator attestation: a SPEC §5 attestation with iss = the operator's current DID, sub = the
// agent's ORIGINAL DID, ctx "sigelo-relay/operator", admission "invite", admission_by = iss, claims
// exactly {relay: <this host>}, exp - iat at most 90 days, carried in the agent's own bundle with
// the operator's genesis in `issuers`. auth.mjs runs SPEC §9 over it at login (signature, iat <=
// now < exp, sub in the agent's chain). Here: its shape; that sub is the first DID of the chain,
// the one the relay keys the account by, as a licence's sub is the operator's; then that iss is the
// CURRENT key of an operator holding a valid licence. A sub anywhere in the chain let a chain that
// put a genesis of its own in front of the agent's (a thief holding the agent's key) pool under a
// separate account, the operator's vouch reaching accounts it never named. The relay learns an operator's current key from the operator's own
// logins, whose chain auth.mjs keeps with recovery first (SPEC §7.1): an attestation by a key the
// operator has rotated away from pools nothing, which is what ends a stolen operator key's
// attestations once the operator recovers and logs in. So an operator logs in after every rotation
// of its key: until then the relay cannot know of it. Of two licences for one operator the one the
// vendor issued later is kept (iat), whatever their terms, so the vendor can end a term early by
// reissuing it shorter (a payment reversed, a breach: relay/site/terms.md §8, §10); an older copy,
// which anyone may hold, is refused. A licence is kept until LICENCE_KEEP after it expires, or
// after the licence it replaced would have if later (replaced_exp), used or not, and the
// operator's account and chain with it (licensed: the sweep keeps the account): kept only until 30 days after its last use, the licence went, the account and its chain
// with the recovery went at the same sweep, and a thief holding a key the operator had recovered
// from logged in with the old chain and uploaded the public licence again. A login or an upload
// moves the licence's key only along a chain through the key it is on, or by a recovery rotation
// from a key the operator held here (moves): with the operator's chain gone (an erasure), a thief's
// chain one voluntary rotation past a stolen key moved it.
//
// No DID is stored in the clear (db.mjs): a licence is kept as the hashes and numbers the relay
// needs, not as the file. The vendor's chain is public and kept as it is.
//
// Gift codes (gifts.mjs, POST /gift): a redeemed code makes its redeemer an operator as a licence
// does, on the same row: gift_exp, the end of the Pro its gifts give. An operator with no licence
// gets a row with no licence in it (vendor_key '', iat and exp 0), so its key is followed, its
// agents pool, its account and chain are kept, and the row goes LICENCE_KEEP after its last term
// ends, exactly as for a licence. Pro holds while the licence holds or until gift_exp; while the
// licence holds its claims apply, otherwise the relay's Pro tier (allowance.mjs tierOfLicence). A
// gift adds: its months run from the end of the Pro the operator holds when it redeems (the
// licence's exp while it holds, else a running gift's, else now), rounded up to a UTC day, and a
// licence uploaded later replaces the licence and leaves gift_exp as it is. So a vendor renewing a
// licence (issue-licence.mjs --extend-from) runs on from the old licence's exp, over any gift months
// redeemed since: the runbook's renewal adds them. Pro is never extended past GIFT_TERM from now.
import { canonicalize, parse } from 'sigelo';
// licence.ts is sigelo's spend/licence.ts (MIT) byte for byte, copied because relay/ is published
// alone; in sigelo's tree relay/site/test.mjs and release/publish.sh --relay refuse a copy that differs.
import { checkVendorAttestation, LICENCE_SKEW, resolveVendorChain, vendorDid } from './licence.ts';
import { DID_RE, OPERATOR_CTX } from './auth.mjs';
import { DAY, dayOf, hashHex } from './db.mjs';
import { addMonths } from './gifts.mjs';

export const LICENCE_CTX = 'sigelo-relay', OPERATOR_DAYS = 90;
// Plan §1 "Tiers": support none / e-mail / priority.
export const SUPPORT = Object.freeze(['none', 'email', 'priority']);
// A licence is kept until 30 days after its expiry (or the expiry of the licence it replaced, if
// later), used or not, and its operator's account and chain with it (allowance.mjs accountKept):
// that chain holds any recovery from a stolen key (the header).
export const LICENCE_KEEP = 30 * DAY;
// The vendor rotations a licence may carry here. spend/licence.ts reads up to 256 from a keeper's
// own file; here anyone may upload, and each rotation costs a signature check, twice once a vendor
// chain is kept (the licence's chain, then its union with the kept one). A vendor rotates rarely.
export const RELAY_ROTATIONS_MAX = 16;
// The furthest a gift extends an operator's Pro from now: a licence's longest term.
export const GIFT_TERM = 3 * 366 * DAY;
// vendor_key of a row that holds gift months and no licence.
const NO_LICENCE = '';
// POST /licence per address prefix and minute. An upload costs at most 2 × 16 signature checks
// plus the kept chain (16 junk rotations: ~105 ms of the one thread, measured on a phone-class
// CPU), so 3 a minute stay under the login verify budget per prefix (auth.mjs VERIFY_BUDGET,
// ~1 s). An operator uploads once a term.
export const LICENCE_RATE = 3;
// The claims' keys, sorted: without support, and with it.
const CLAIMS = 'groups,msgs_day,retention_days,storage_mb,tier', CLAIMS_SUPPORT = 'groups,msgs_day,retention_days,storage_mb,support,tier';
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const iso = (t) => new Date(t * 1000).toISOString().replace('.000Z', 'Z');
const message = (e) => (e instanceof Error ? e.message : String(e));

// WITHOUT ROWID: a rowid would number rows in the order they were written (db.mjs's header).
const SCHEMA = `
CREATE TABLE IF NOT EXISTS licences (
  operator       TEXT PRIMARY KEY,  -- hex SHA-256 of the licence's sub, the operator's original DID: its account
  current        TEXT NOT NULL,     -- hex SHA-256 of the operator's current DID as last seen; at first its sub
  vendor_key     TEXT NOT NULL,     -- the vendor DID that signed it: the head of the vendor chain then
  iat            INTEGER NOT NULL,
  exp            INTEGER NOT NULL,
  storage_mb     INTEGER NOT NULL,  -- the claims as sold; allowance.mjs grants at most its Pro tier
  msgs_day       INTEGER NOT NULL,
  retention_days INTEGER NOT NULL,
  groups         INTEGER NOT NULL,  -- version 2: kept, not enforced yet
  support        TEXT NOT NULL,     -- none, email or priority: what the vendor owes; nothing the relay applies
  replaced_exp   INTEGER NOT NULL DEFAULT 0, -- the latest exp of the licences this one replaced (0: none): the row is kept until LICENCE_KEEP after the later of the two, so a licence a reissue ended early cannot be uploaded again while it would still hold
  gift_exp       INTEGER NOT NULL DEFAULT 0  -- the end of the Pro its gift codes give (gifts.mjs; 0: none), the start of a UTC day; vendor_key '' and iat, exp 0: gifts only, no licence
) STRICT, WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS licences_current ON licences (current);
CREATE TABLE IF NOT EXISTS operator_retired (
  key      TEXT PRIMARY KEY,        -- hex SHA-256 of a DID a licensed operator has rotated away from
  operator TEXT NOT NULL
) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS vendor_chain (
  vendor    TEXT PRIMARY KEY,       -- the pinned vendor DID (chain[0])
  head      TEXT NOT NULL,          -- its current DID: the only vendor key whose licences count
  genesis   TEXT NOT NULL,          -- JCS of the vendor's genesis
  rotations TEXT NOT NULL           -- JCS of the rotations on the chain's path: the longest chain seen
) STRICT, WITHOUT ROWID;
`;

// The claims a relay licence carries: whole numbers, groups may be 0; support, when there, one of
// SUPPORT. → undefined, or the refusal.
export function relayClaimsRefusal(c) {
  const whole = (v, min) => Number.isSafeInteger(v) && v >= min;
  const keys = isObject(c) ? Object.keys(c).sort().join() : '';
  return (keys === CLAIMS || (keys === CLAIMS_SUPPORT && SUPPORT.includes(c.support))) && c.tier === 'pro'
    && whole(c.storage_mb, 1) && whole(c.msgs_day, 1) && whole(c.retention_days, 1) && whole(c.groups, 0)
    ? undefined
    : `the licence's claims are not {"tier": "pro", "storage_mb": N, "msgs_day": N, "retention_days": N, "groups": N, "support": ${SUPPORT.map((x) => `"${x}"`).join(' | ')}} (support may be left out: "email")`;
}

// The licence check without the relay's store: spend/licence.ts's vendor rules with this ctx and
// these claims, then the subject. seen() → the longest vendor chain seen before, or undefined.
// → spend's { ok: true, attestation, legacy, chain, head } or { ok: false, why }.
export function checkRelayLicence(raw, now, { vendor = vendorDid(), seen = () => undefined } = {}) {
  // Before spend's walk, which costs a signature check per rotation: more vendor rotations than
  // any real vendor chain holds are refused unread.
  if (isObject(raw) && Array.isArray(raw.rotations) && raw.rotations.length > RELAY_ROTATIONS_MAX) {
    return { ok: false, why: `the licence carries ${raw.rotations.length} vendor rotations, more than the ${RELAY_ROTATIONS_MAX} this relay reads: ask the vendor` };
  }
  const v = checkVendorAttestation(raw, now, {
    vendor, ctx: LICENCE_CTX, claims: relayClaimsRefusal, seen,
    seenRefusal: (e) => `the vendor chain this relay keeps does not verify (${message(e)}): the relay's own fault, tell its operator`,
    seenBy: 'this relay',
  });
  if (!v.ok) return v;
  if (!DID_RE.test(v.attestation.body.sub)) return { ok: false, why: 'the licence\'s sub is not a did:sigelo DID: it names the operator by its original DID' };
  return v;
}

// The operator attestation's own shape, after SPEC §9 accepted it; original: the first DID of the
// agent's chain. → undefined, or the refusal.
export function attestationRefusal(a, host, original) {
  if (a.ctx !== OPERATOR_CTX) return `an attestation for ${JSON.stringify(a.ctx)}, not ${OPERATOR_CTX}`;
  if (a.sub !== original) return 'an operator attestation names the agent by its ORIGINAL DID (the first of its chain, which the relay keys its account by), and this one names another';
  if (a.admission !== 'invite' || a.admission_by !== a.iss) return 'an operator attestation must say admission "invite", admission_by = its iss';
  if (!isObject(a.claims) || Object.keys(a.claims).join() !== 'relay' || a.claims.relay !== host) return `an operator attestation's claims must be exactly {"relay": "${host}"}`;
  if (a.exp - a.iat > OPERATOR_DAYS * DAY) return `an operator attestation lives at most ${OPERATOR_DAYS} days (exp - iat)`;
  return undefined;
}

// db: relay/db.mjs. host: the relay's public name. vendor: the pinned vendor DID. clock() → unix
// seconds. rate: POST /licence per prefix and minute. log(line): never a DID.
export function operators({ db, host, vendor, clock, rate = LICENCE_RATE, log = () => {} }) {
  if (!DID_RE.test(vendor)) throw new Error('vendor: want the vendor\'s genesis DID (did:sigelo:z…)');
  db.rebuild(SCHEMA, ['licences', 'operator_retired', 'vendor_chain']);
  // A file of an earlier version kept each licence's day of last use, by which it went, and no
  // support: its licences were issued without one, which reads as "email". Before the sweep's first
  // rebuild in key order, which copies the columns of the table as made now.
  const column = (c) => db.raw.prepare("SELECT 1 FROM pragma_table_info('licences') WHERE name = ?").get(c) !== undefined;
  if (column('last_used')) db.raw.exec('ALTER TABLE licences DROP COLUMN last_used');
  if (!column('support')) db.raw.exec("ALTER TABLE licences ADD COLUMN support TEXT NOT NULL DEFAULT 'email'");
  // Before licences were ordered by issue: none had replaced another.
  if (!column('replaced_exp')) db.raw.exec('ALTER TABLE licences ADD COLUMN replaced_exp INTEGER NOT NULL DEFAULT 0');
  // Before gift codes: no row held any.
  if (!column('gift_exp')) db.raw.exec('ALTER TABLE licences ADD COLUMN gift_exp INTEGER NOT NULL DEFAULT 0');
  db.keepSorted(SCHEMA, ['licences', 'operator_retired', 'vendor_chain']);
  const q = (sql) => db.raw.prepare(sql);
  const s = {
    licence: q('SELECT * FROM licences WHERE operator = ?'),
    byCurrent: q('SELECT * FROM licences WHERE current = ?'),
    licenceSet: q(`INSERT INTO licences (operator, current, vendor_key, iat, exp, storage_mb, msgs_day, retention_days, groups, support, replaced_exp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (operator) DO UPDATE SET current = excluded.current, vendor_key = excluded.vendor_key, iat = excluded.iat, exp = excluded.exp,
      storage_mb = excluded.storage_mb, msgs_day = excluded.msgs_day, retention_days = excluded.retention_days, groups = excluded.groups, support = excluded.support,
      replaced_exp = excluded.replaced_exp`),
    currentSet: q('UPDATE licences SET current = ? WHERE operator = ?'),
    retired: q('SELECT operator FROM operator_retired WHERE key = ?'),
    retire: q('INSERT OR IGNORE INTO operator_retired (key, operator) VALUES (?, ?)'),
    vendorGet: q('SELECT * FROM vendor_chain WHERE vendor = ?'),
    vendorSet: q('INSERT INTO vendor_chain (vendor, head, genesis, rotations) VALUES (?, ?, ?, ?) ON CONFLICT (vendor) DO UPDATE SET head = excluded.head, genesis = excluded.genesis, rotations = excluded.rotations'),
    tidyLicences: q('DELETE FROM licences WHERE max(exp, replaced_exp, gift_exp) <= ?'),
    giftNew: q(`INSERT INTO licences (operator, current, vendor_key, iat, exp, storage_mb, msgs_day, retention_days, groups, support, replaced_exp, gift_exp)
      VALUES (?, ?, '${NO_LICENCE}', 0, 0, 0, 0, 0, 0, 'email', 0, ?)`),
    giftSet: q('UPDATE licences SET gift_exp = ? WHERE operator = ?'),
    dids: q('SELECT did FROM chain_dids WHERE account = ?'),
    tidyRetired: q('DELETE FROM operator_retired WHERE operator NOT IN (SELECT operator FROM licences)'),
  };
  let head = s.vendorGet.get(vendor)?.head;   // the vendor's current key, as far as this relay has seen

  // The longest vendor chain this relay has seen, resolved again by SPEC §7.3, or undefined.
  const seenVendor = (now) => {
    const row = s.vendorGet.get(vendor);
    return row ? resolveVendorChain(parse(row.genesis), parse(row.rotations), now) : undefined;
  };

  // → undefined while the licence the vendor signed holds at `now`, else why not.
  function paidRefusal(lic, now) {
    if (lic.vendor_key === NO_LICENCE) return `your operator's Pro from a gift code ended at ${iso(lic.gift_exp)}`;
    if (now >= lic.exp) return `your operator's licence expired at ${iso(lic.exp)}`;
    if (lic.iat > now + LICENCE_SKEW) return `your operator's licence is dated ${iso(lic.iat)}, ahead of this relay's clock`;
    if (lic.vendor_key !== head) return 'your operator\'s licence is signed by a vendor key the vendor has since rotated away from: the operator asks for a reissue';
    return undefined;
  }
  // → undefined while the row gives Pro at `now`, its licence or its gift months, else why not.
  const licenceRefusal = (lic, now) => (now < lic.gift_exp ? undefined : paidRefusal(lic, now));

  // Whether a chain may move the licence `lic` of `operator` to the chain's last key. dids: the
  // hashes of the chain's DIDs; rotations: the rotation on each edge of it. Yes when the chain passes
  // through the licence's key, or leaves a key the operator held here (that one, or one in
  // operator_retired) by a recovery rotation (SPEC §7.1: recovery beats key, as after a thief's
  // rotation from the operator's key). Whoever holds a key the operator rotated away from can rotate
  // it again, voluntarily, to a key of its own: while the relay keeps the operator's chain auth.mjs
  // merges it (recovery first) and no such login gets here, but with that chain gone (an erasure)
  // one voluntary rotation past the stolen key moved the licence to the thief.
  function moves(lic, operator, dids, rotations) {
    if (dids.includes(lic.current)) return true;
    return rotations.some((r) => r.body.reason === 'recovery' && (hashHex(r.body.id) === lic.current || s.retired.get(hashHex(r.body.id))?.operator === operator));
  }

  // The operator's current key is now `currentKey`, and it has rotated away from each of
  // `retiredKeys` (hashes) and from the key that was current before, when that one differs.
  function follow(operator, previous, currentKey, retiredKeys) {
    const retire = previous !== undefined && previous !== currentKey ? [...retiredKeys, previous] : retiredKeys;
    s.currentSet.run(currentKey, operator);
    for (const k of retire) if (k !== currentKey) s.retire.run(k, operator);
  }

  // POST /licence's work. → { ok: true, operator, exp, chain, claims } or { ok: false, check, detail }.
  function upload(raw, now) {
    const refuse = (detail) => ({ ok: false, check: 'licence', detail });
    const v = checkRelayLicence(raw, now, { vendor, seen: () => seenVendor(now) });
    if (!v.ok) return refuse(v.why);
    const body = v.attestation.body, c = body.claims, operator = hashHex(body.sub);
    // The operator's account holds the chain the relay takes its current key from: without it, an
    // attestation by a thief's key could pool until the licence ends. Asked only once the licence
    // verifies, so POST /licence tells no outsider which DIDs log in here.
    if (db.account(operator) === undefined) {
      return refuse('no identity whose original DID is this licence\'s sub has logged in here: the licence names the operator by its ORIGINAL DID (the first of its chain), and the operator logs in once with its bundle before uploading, and again after any rotation of its key, so this relay knows its current key');
    }
    const old = s.licence.get(operator);
    // The licence the vendor issued last is kept (iat; issued together, the longer): an older one
    // uploaded again (anyone can hold a copy, it is public) neither cuts a term short nor swaps the
    // claims, and a reissue ending a term early replaces it. Ordered by exp, as before, a licence
    // the vendor reissued to end a term was refused, and the first ran on to its exp. Whether the
    // kept one still holds does not matter: once a shortened licence lapsed, the one it ended
    // would have come back. The kept licence's dates are not quoted.
    if (old && (old.iat > body.iat || (old.iat === body.iat && old.exp > body.exp))) {
      return refuse('this operator\'s licence here was issued later, or at the same time and runs longer: the one issued last is kept');
    }
    // The operator's chain as this relay keeps it (none while it has not rotated): its current
    // key; else the key a previous licence followed, else its original DID. A licence kept here
    // already (this one again, a renewal) moves to it only as a login would (moves).
    const kept = db.chainOf(operator, body.sub), dids = [body.sub, ...kept.map((r) => r.body.next)].map(hashHex), currentKey = dids[dids.length - 1];
    const follows = kept.length > 0 && (!old || moves(old, operator, dids, kept));
    db.settle(() => db.tx(() => {
      s.vendorSet.run(vendor, v.head, canonicalize(raw.issuer), canonicalize(v.chain.rotations));
      s.licenceSet.run(operator, follows ? currentKey : old?.current ?? currentKey, v.head, body.iat, body.exp, c.storage_mb, c.msgs_day, c.retention_days, c.groups, c.support ?? 'email',
        old ? Math.max(old.exp, old.replaced_exp) : 0);
      if (follows) follow(operator, old?.current, currentKey, dids.slice(0, -1));
    }));
    head = v.head;
    return { ok: true, operator: body.sub, exp: body.exp, chain: v.chain.chain.length, claims: c };
  }

  const rates = new Map();   // address prefix → { window, n }
  // POST /licence, from auth.mjs's HTTP server: prefix = the address cut to /24 or /48, read() →
  // the parsed body (a status error passes through: 413). → { status, body }.
  async function http({ prefix, read }) {
    const w = Math.floor(clock() / 60);
    let r = rates.get(prefix);
    if (!r || r.window !== w) {
      if (rates.size > 10000) for (const [p, x] of rates) if (x.window !== w) rates.delete(p);
      r = { window: w, n: 0 };
      rates.set(prefix, r);
    }
    if (++r.n > rate) return { status: 200, body: { ok: false, check: 'rate', detail: `more than ${rate} licence uploads a minute from this network: wait` } };
    let raw;
    try { raw = await read(); } catch (e) { if (e.status) throw e; return { status: 400, body: { error: `body is not strict JSON: ${message(e)}` } }; }
    try { return { status: 200, body: upload(raw, clock()) }; } catch (e) {
      log(`licence bug ${e.name}`);
      return { status: 503, body: { error: 'the relay failed: try again later' } };
    }
  }

  // Every login (policy.login): a licensed operator's own login says which key is its current one,
  // when its chain may move the licence there (moves). chain: the DIDs of the chain verified at this
  // login, rotations: the rotation on each of its edges (none without a bundle: then only the current
  // DID is known, and the licence moves nowhere).
  function loggedIn(account, current, chain, rotations) {
    const lic = s.licence.get(account);
    if (!lic) return;
    const dids = (chain ?? [current]).map(hashHex), currentKey = hashHex(current), retired = dids.slice(0, -1);
    if (lic.current === currentKey && retired.every((k) => s.retired.get(k))) return;   // nothing new: nothing written
    if (!moves(lic, account, dids, rotations ?? [])) return;
    db.tx(() => follow(account, lic.current, currentKey, retired));
  }

  // An agent's login with a bundle: result = verify()'s result over its chain and up to 4 operator
  // attestations for this relay (auth.mjs). → { member: { operator, key, exp } | null, notice:
  // { code, detail } | null, keep }: the pool of the first good attestation whose operator's licence
  // holds; else the first good one whose operator has a licence that lapsed (the agent pools again
  // as soon as the operator renews it), with why; else why none is good. keep: the latest exp of the
  // attestations of the right shape whose operator holds a licence here, held or lapsed (0 if none):
  // allowance.mjs keeps the agent's account and chain until then, so a key it recovered from cannot
  // log in as it with one of them once it is idle. Anyone can sign an attestation of the right
  // shape for itself: one from an operator with no licence here kept any free identity's rows up
  // to 90 days, renewable, instead of 30 days after its last login.
  function present(result, now) {
    const all = Object.values(result.attestations).flat();
    const keep = Math.max(0, ...all.filter((a) => attestationRefusal(a, host, result.chain[0]) === undefined && s.byCurrent.all(hashHex(a.iss)).length === 1).map((a) => a.exp));
    return { ...pick(all, result, now), keep };
  }
  function pick(all, result, now) {
    let notice = result.rejected.attestations > 0
      ? { code: 'operator', detail: 'an operator attestation in your bundle does not verify (SPEC §9 step 5: the operator\'s signature with its genesis in issuers, iat <= now < exp, sub in your chain): free tier' }
      : null;
    let lapsed = null;
    for (const a of all) {
      const why = attestationRefusal(a, host, result.chain[0]);
      if (why) { notice ??= { code: 'operator', detail: `${why}: free tier` }; continue; }
      const key = hashHex(a.iss);
      const lics = s.byCurrent.all(key);
      if (lics.length > 1) { notice ??= { code: 'operator', detail: 'the attestation\'s key is the current key of more than one licensed operator here: refused, free tier' }; continue; }
      if (lics.length === 0) {
        // The relay learns an operator's rotations only from the operator's own logins, so a key it
        // has not seen may be a licensed operator's new one: the "licence" notice says both.
        notice ??= s.retired.get(key)
          ? { code: 'operator', detail: 'the attestation is signed by a key your operator has rotated away from: ask it for a new one; free tier' }
          : { code: 'licence', detail: 'your operator holds no licence on this relay (it logs in, then POST /licence), or has rotated its key and not logged in here since (it logs in with its new key): free tier' };
        continue;
      }
      const member = { operator: lics[0].operator, key, exp: a.exp }, bad = licenceRefusal(lics[0], now);
      if (!bad) return { member, notice: null };
      lapsed ??= { member, notice: { code: 'licence', detail: `${bad}: free tier until it holds again` } };
    }
    return lapsed ?? { member: null, notice };
  }

  // The licence of `operator` while it holds at `now`, and, for an agent (key = the hash of its
  // attestation's iss), while that key is still the operator's current one. → the row, or null.
  // gift: true when only gift months give it (allowance.mjs grants the relay's Pro tier then).
  function licenceOf(operator, key, now) {
    const lic = s.licence.get(operator);
    if (!lic || (key !== null && lic.current !== key) || licenceRefusal(lic, now) !== undefined) return null;
    return paidRefusal(lic, now) === undefined ? lic : { ...lic, gift: true };
  }

  // POST /gift's grant, inside the caller's transaction (allowance.mjs gift): `months` more of Pro
  // for `operator` (an account that has proven its work, in no pool), from the end of the Pro it
  // holds (the header). current: the DID its login was signed by, its current key. A new row
  // follows that key and has rotated away from the chain's other DIDs (as upload's). → { ok: true,
  // exp } | { ok: false, check: 'gift_term', detail }: nothing written.
  function gift(operator, current, months, now) {
    const lic = s.licence.get(operator);
    const from = Math.max(now, lic && paidRefusal(lic, now) === undefined ? lic.exp : 0, lic?.gift_exp ?? 0);
    const t = addMonths(from, months), exp = t % DAY === 0 ? t : dayOf(t) + DAY;
    if (exp > now + GIFT_TERM) return { ok: false, check: 'gift_term', detail: `with ${months} more months this operator's Pro would run to ${iso(exp)}, past ${iso(now + GIFT_TERM)} (3 × 366 days from now), the furthest a gift code takes it: the code is not used; redeem it later` };
    if (lic) s.giftSet.run(exp, operator);
    else {
      const currentKey = hashHex(current);
      s.giftNew.run(operator, currentKey, exp);
      follow(operator, undefined, currentKey, s.dids.all(operator).map((r) => r.did));
    }
    return { ok: true, exp };
  }

  // Inside the sweep's transaction (allowance.mjs tidy). A licence goes LICENCE_KEEP after its exp,
  // or after that of the licence it replaced, if later (replaced_exp).
  function tidy(now) {
    s.tidyLicences.run(now - LICENCE_KEEP);
    s.tidyRetired.run();
  }

  // Whether `account` holds a licence row here: the sweep keeps its account and chain (db.mjs).
  const licensed = (account) => s.licence.get(account) !== undefined;

  return { upload, http, loggedIn, present, licenceOf, gift, tidy, licensed };
}
