// SPDX-License-Identifier: AGPL-3.0-only
// relay/closed.mjs — a closed relay (ROADMAP §9.1): it admits its operators and the identities
// their operator attestation names, and nobody else.
//
// Operators: original DIDs (RELAY_CLOSED_OPERATOR, comma-separated, at most MAX_CLOSED). An
// operator logs in as itself; an agent logs in with a bundle carrying the operator attestation of
// operator.mjs (ctx "sigelo-relay/operator", sub = the agent's ORIGINAL DID, admission "invite",
// admission_by = iss, claims exactly {relay: <this host>}, at most 90 days), which auth.mjs runs
// SPEC §9 over (signature, iat <= now < exp, the issuer's genesis in `issuers`). Its iss must be an
// operator's CURRENT key as this relay knows it: the head of the chain kept from the operator's own
// logins (auth.mjs keeps it with recovery first), else its original DID. So an attestation by a key
// the operator rotated away from admits nobody once the operator has logged in after the rotation;
// until then the relay cannot know of it, and one by the new key is refused (the operator logs in
// after every rotation of its key, as operator.mjs asks of a licensed one).
//
// Everyone else is refused `closed` at login, after the signature: no account, no proof of work,
// no mailbox, invite topic or short code. An admitted identity proves no work (allowance.mjs pow:
// `admitted`) and GET /challenge asks none. Its account and chain are kept while its attestation
// runs (closed_members), an operator's for good: with the chain gone, a key its owner recovered
// from would log in as it again. A session ends when the attestation it logged in with expires.
import { accountOf } from './db.mjs';
import { DID_RE } from './auth.mjs';
import { attestationRefusal } from './operator.mjs';

export const MAX_CLOSED = 8;
const SCHEMA = `
CREATE TABLE IF NOT EXISTS closed_members (
  account TEXT PRIMARY KEY,   -- hex SHA-256 of an admitted agent's original DID
  exp     INTEGER NOT NULL    -- the latest exp of the operator attestations it logged in with
) STRICT, WITHOUT ROWID;`;

// RELAY_CLOSED_OPERATOR's value → the operators' original DIDs, or throws why not.
export function closedOperators(text) {
  const dids = [...new Set(String(text).split(/[\s,]+/).filter(Boolean))];
  if (dids.length === 0 || dids.length > MAX_CLOSED || !dids.every((d) => DID_RE.test(d))) {
    throw new Error(`want 1 to ${MAX_CLOSED} original DIDs (did:sigelo:z…), comma-separated`);
  }
  return dids;
}

// db: db.mjs; host: the relay's public name; operators: original DIDs (closedOperators).
export function closedRelay({ db, host, operators }) {
  const dids = closedOperators(operators.join(','));
  const ops = new Map(dids.map((d) => [accountOf(d), d]));
  db.rebuild(SCHEMA, ['closed_members']);
  db.keepSorted(SCHEMA, ['closed_members']);
  const q = (sql) => db.raw.prepare(sql);
  const s = {
    get: q('SELECT exp FROM closed_members WHERE account = ?'),
    set: q('INSERT INTO closed_members (account, exp) VALUES (?, ?) ON CONFLICT (account) DO UPDATE SET exp = excluded.exp'),
    tidy: q('DELETE FROM closed_members WHERE exp <= ?'),
  };
  // An operator's current DID: the last of the chain kept from its own logins, else its original.
  const headOf = (account, did) => db.chainOf(account, did).at(-1)?.body.next ?? did;

  // A login's identity: original DID, result = verify()'s over its chain and up to 4 operator
  // attestations for this host (auth.mjs resolve; undefined without a bundle). → the time its
  // admission ends (Infinity for an operator), or { why } when it is not admitted.
  function admit(original, result) {
    if (ops.has(accountOf(original))) return Infinity;
    if (result === undefined) return { why: 'a closed relay reads its operator\'s attestation at every login: send your bundle' };
    const all = Object.values(result.attestations).flat();
    const heads = new Set([...ops].map(([account, did]) => headOf(account, did)));
    let exp = 0, why = null;
    for (const a of all) {
      const bad = attestationRefusal(a, host, result.chain[0]);
      if (bad) { why ??= bad; continue; }
      if (!heads.has(a.iss)) { why ??= 'the attestation is not signed by an operator of this relay with its current key (an operator logs in here after each rotation of its key)'; continue; }
      exp = Math.max(exp, a.exp);
    }
    if (exp > 0) return exp;
    return { why: `this relay admits only its operators (${dids.join(', ')}) and the identities they attest for it (sigelo-relay/operator, claims {"relay": "${host}"})${why ? `; ${why}` : result.rejected.attestations > 0 ? '; an operator attestation in your bundle does not verify (SPEC §9: signature, issuer genesis, iat <= now < exp)' : ''}` };
  }

  return {
    operators: dids,
    admit,
    // Inside the login's transaction: an agent's account is kept until its admission ends.
    record(account, exp) {
      if (!Number.isSafeInteger(exp) || exp <= (s.get.get(account)?.exp ?? 0)) return;
      s.set.run(account, exp);
    },
    // The sweep (mailbox.mjs): the accounts it keeps idle, and the rows that ran out.
    kept: (account, now) => ops.has(account) || (s.get.get(account)?.exp ?? 0) > now,
    tidy: (now) => { s.tidy.run(now); },
  };
}
