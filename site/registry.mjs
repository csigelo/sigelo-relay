// SPDX-License-Identifier: AGPL-3.0-only
// relay/site/registry.mjs — the relay registry sigelo.ai serves as /relays.json (ROADMAP §9 item 4).
//
// A relay tag is the first 20 bits of SHA-256(UTF-8 "sigelo-relay-tag/0" ‖ UTF-8 host[:port]) in
// Crockford's base32 (contact/short.mjs relayTag, copied: relay/ is published alone; test.mjs
// checks the two agree in sigelo's tree). A short code made on a relay other than relay.sigelo.ai
// carries it; clients resolve it from what they know, then from this registry (contact/relays.mjs).
//
// Three files:
//   relays.src.json  the list as maintained, unsigned: {"relays": {<tag>: {host, did, tier?, note?, added}}}.
//                    registry-add.mjs appends to it; first host for a tag keeps it.
//   relays.json      what sigelo.ai serves: a sigelo bundle (SPEC §8) of the RELEASE identity
//                    (release/release-identity.json, the scheme of release/sign-release.sh's
//                    release.json): no bindings, one self-issued attestation (iss = sub = its current
//                    DID, admission "open"), ctx "sigelo.ai/relays", claims {relays: <the src's relays>}.
//                    sign-relays.mjs writes it with the release identity file given on its command
//                    line; no key is in this tree. build.mjs copies it to dist/ when it verifies.
//   /.well-known/sigelo-relay.json   on the joining relay's own host: a bundle of the relay's
//                    identity (its operator's, any sigelo identity) with one self-issued attestation,
//                    ctx "sigelo-relay/host", claims {host}, at most 366 days (relay/host-statement.mjs).
import { createHash } from 'node:crypto';
import { attest, did as didOf, verify } from 'sigelo';

export const TAG_LABEL = 'sigelo-relay-tag/0', REGISTRY_CTX = 'sigelo.ai/relays', HOST_CTX = 'sigelo-relay/host';
export const WELL_KNOWN = '/.well-known/sigelo-relay.json', HOST_DAYS = 366, REGISTRY_DAYS = 366;
export const RELEASE_DID = 'did:sigelo:zE1ikihiqKQ7KoFL492kfFrJdUSzPeHNunGnMXLqgVfci';
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
// contact/invite.mjs RELAY: a lowercase host[:port], at most 63 characters (what a long code carries).
const HOST_RE = /^(?=.{1,63}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(?::([1-9][0-9]{0,4}))?$/;
export const isHost = (h) => typeof h === 'string' && HOST_RE.test(h) && !(h.includes(':') && Number(h.split(':')[1]) > 65535);
export const TAG_RE = /^[0-9A-HJKMNP-TV-Z]{4}$/;

export class RegistryError extends Error { constructor(check, why) { super(`${check}: ${why}`); this.check = check; } }
const fail = (check, why) => { throw new RegistryError(check, why); };

/** The relay tag of host[:port]. */
export function relayTag(host) {
  const h = createHash('sha256').update(TAG_LABEL + host, 'utf8').digest();
  const x = (h[0] << 12) | (h[1] << 4) | (h[2] >> 4);
  return [3, 2, 1, 0].map((i) => ALPHABET[(x >> (5 * i)) & 31]).join('');
}

// The one attestation an identity's bundle makes about itself with ctx, verified at now. → { body, did, original }.
function selfStatement(bundle, now, ctx, what) {
  let r;
  try { r = verify(bundle, now); } catch (e) { fail(what, `does not verify: ${e.message}`); }
  const mine = r.attestations[r.did] ?? [];
  const body = mine.length === 1 ? (mine[0].body ?? mine[0]) : null;
  if (!body || body.sub !== r.did || body.ctx !== ctx) fail(what, `not one ${ctx} attestation of the identity about itself, valid now`);
  return { body, did: r.did, original: r.chain[0] };
}

/** A relay's /.well-known/sigelo-relay.json for `host`, checked → { did (the relay identity's original DID), tag }. */
export function checkHostStatement(bundle, host, now) {
  if (!isHost(host)) fail('host', `${JSON.stringify(host)} is not a lowercase host[:port]`);
  const { body, original } = selfStatement(bundle, now, HOST_CTX, 'host_statement');
  const keys = Object.keys(body.claims ?? {});
  if (keys.length !== 1 || body.claims.host !== host) fail('host_statement', `its claims name ${JSON.stringify(body.claims?.host)}, not ${host} (exactly {host})`);
  if (body.exp - body.iat > HOST_DAYS * 86400) fail('host_statement', `valid for more than ${HOST_DAYS} days`);
  return { did: original, tag: relayTag(host) };
}

/** The registry's entries from relays.json, checked: SPEC §9 at now, the release identity, every tag its host's. */
export function checkRegistry(bundle, now, pin = RELEASE_DID) {
  const { body, original, did } = selfStatement(bundle, now, REGISTRY_CTX, 'registry');
  if (original !== pin) fail('registry', `signed by ${original}, not the release identity ${pin}`);
  const relays = body.claims?.relays;
  checkEntries(relays);
  return { relays, iat: body.iat, exp: body.exp, did };
}

/** The relays of relays.src.json (or of claims.relays) are well-formed: tag → its host's tag, one host once. */
export function checkEntries(relays) {
  if (relays === null || typeof relays !== 'object' || Array.isArray(relays)) fail('registry', 'relays: an object, tag → entry');
  const hosts = new Set();
  for (const [tag, e] of Object.entries(relays)) {
    if (!TAG_RE.test(tag) || !isHost(e?.host) || relayTag(e.host) !== tag) fail('registry', `${tag}: not the tag of ${JSON.stringify(e?.host)}`);
    if (hosts.has(e.host)) fail('registry', `${e.host} is listed twice`);
    hosts.add(e.host);
    for (const [k, v] of Object.entries(e)) if (!['host', 'did', 'tier', 'note', 'added'].includes(k) || typeof v !== 'string') fail('registry', `${tag}.${k}: not a field of an entry (host, did, tier, note, added: strings)`);
  }
}

/** relays with host added under its tag; a tag already taken (first host keeps it) or a host listed is refused. */
export function addEntry(relays, entry) {
  checkEntries(relays);
  const tag = relayTag(entry.host);
  if (Object.hasOwn(relays, tag)) {
    fail(relays[tag].host === entry.host ? 'listed' : 'collision', relays[tag].host === entry.host
      ? `${entry.host} is listed already (${tag})`
      : `the tag ${tag} of ${entry.host} is ${relays[tag].host}'s, listed first: it keeps it. Serve the relay under another host name`);
  }
  const out = { ...relays, [tag]: entry };
  checkEntries(out);
  // Sorted by tag, so a diff of relays.src.json shows one line group per change.
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}

/**
 * A bundle of the identity in `store` (sigelo-agent's identity file: secret, genesis, rotations)
 * with one self-issued attestation: ctx, claims, iat, exp; checked before it is returned.
 */
export function signSelf(store, { ctx, claims, iat, exp }) {
  if (typeof store?.secret !== 'string' || !store.genesis || !Array.isArray(store.rotations ?? [])) fail('identity', 'not an identity file (secret, genesis, rotations)');
  const rotations = store.rotations ?? [];
  const current = rotations.length ? rotations.at(-1).next_genesis : store.genesis;
  const iss = didOf(current);
  const att = attest({ secret: Uint8Array.from(Buffer.from(store.secret, 'hex')), iss, sub: iss, iat, exp, ctx, admission: 'open', claims });
  const bundle = { v: 'sigelo/0', typ: 'bundle', genesis: store.genesis, rotations, bindings: [], attestations: [att], issuers: [current] };
  selfStatement(bundle, iat, ctx, 'identity');
  return bundle;
}
