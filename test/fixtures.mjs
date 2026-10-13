// SPDX-License-Identifier: AGPL-3.0-only
// relay/test/fixtures.mjs — fixture identities from fixed seeds, for test/run.mjs and test/load.mjs.
// secret = SHA-256("sigelo-relay-fixture/0 " + label); its recovery key from label + " recovery",
// its genesis nonce from label + " nonce", so every DID below is the same on every run.
import { createHash, generateKeyPairSync, randomBytes, sign as cryptoSign } from 'node:crypto';
import { canonicalize, keygen, rotate, sign } from 'sigelo';
import { clientIdOf } from '../db.mjs';

export const CREATED = '2026-10-06T00:00:00Z';
export const seed = (label) => new Uint8Array(createHash('sha256').update(`sigelo-relay-fixture/0 ${label}`).digest());

const publicKeyOf = (secret) => keygen({ seed: secret, recovery: 'sha256:' + '0'.repeat(64), created: CREATED, nonce: new Uint8Array(16) }).key;

// An identity: the original genesis, a recovery key, and rotations applied so far.
//   id.did / id.secret / id.genesis   the CURRENT ones;  id.original   the first DID
export function identity(label) {
  const recovery = seed(`${label} recovery`);
  const k = keygen({ seed: seed(label), recovery: publicKeyOf(recovery), created: CREATED, nonce: seed(`${label} nonce`).slice(0, 16) });
  return { label, did: k.did, original: k.did, secret: k.secret, genesis: k.genesis, origin: k.genesis, recovery, rotations: [] };
}

// A rotation to the key of `label2`, voluntary (signed by the current key) or recovery (signed by
// the recovery key; the new genesis keeps the same commitment). → a new identity object; `from`
// is unchanged, so a test can keep using the old key as a thief would.
export function rotated(from, label2, reason = 'voluntary', iat = 1760000000) {
  const next = keygen({ seed: seed(label2), recovery: from.genesis.recovery, created: CREATED, nonce: seed(`${label2} nonce`).slice(0, 16) });
  const r = rotate({ genesis: from.genesis, next_genesis: next.genesis, iat, reason, secret: reason === 'recovery' ? from.recovery : from.secret });
  return { ...from, label: label2, did: next.did, secret: next.secret, genesis: next.genesis, rotations: [...from.rotations, r] };
}

export const bundleOf = (id, extra = {}) => ({ v: 'sigelo/0', typ: 'bundle', genesis: id.origin, rotations: id.rotations, bindings: [], attestations: [], issuers: [], ...extra });
export const clientId = (id) => clientIdOf(id.original);

// The CONNECT password for a login body from GET /challenge (JCS, as the relay requires). The body
// signed is spelled out here, not taken from auth.mjs, so the wire format is pinned by the tests:
// {v: "sigelo-relay/0", typ: "relay-login", did: the signer's current DID, relay, nonce}.
export const loginBody = (id, body) => ({ v: 'sigelo-relay/0', typ: 'relay-login', did: id.did, relay: body.relay, nonce: body.nonce });
export function password(id, body, { bundle = true, extra = {} } = {}) {
  const sig = sign(id.secret, loginBody(id, body));
  return canonicalize({ v: 'sigelo-relay/0', nonce: body.nonce, sig, ...(bundle === true ? { bundle: bundleOf(id) } : bundle ? { bundle } : {}), ...extra });
}

// A self-signed Ed25519 certificate for the TLS listener, generated per run (no key is kept in the
// repository and no openssl is needed): the minimal X.509 v3 DER, signed by node:crypto.
const der = (tag, ...parts) => {
  const body = Buffer.concat(parts), n = body.length;
  return Buffer.concat([Buffer.from([tag]), Buffer.from(n < 128 ? [n] : n < 256 ? [0x81, n] : [0x82, n >> 8, n & 255]), body]);
};
const seq = (...parts) => der(0x30, ...parts);
const ED25519 = seq(der(0x06, Buffer.from([0x2b, 0x65, 0x70])));                       // 1.3.101.112
const cnName = (cn) => seq(der(0x31, seq(der(0x06, Buffer.from([0x55, 0x04, 0x03])), der(0x0c, Buffer.from(cn)))));
const utcTime = (ms) => der(0x17, Buffer.from(new Date(ms).toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z'));
const pem = (label, bytes) => `-----BEGIN ${label}-----\n${bytes.toString('base64').replace(/.{64}/g, '$&\n').replace(/\n?$/, '\n')}-----END ${label}-----\n`;
export function selfSigned(cn) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const day = 86400000, t = Date.now();
  const tbs = seq(der(0xa0, der(0x02, Buffer.from([2]))), der(0x02, Buffer.concat([Buffer.from([1]), randomBytes(7)])), ED25519,
    cnName(cn), seq(utcTime(t - day), utcTime(t + day)), cnName(cn), publicKey.export({ type: 'spki', format: 'der' }));
  const cert = seq(tbs, ED25519, der(0x03, Buffer.from([0]), cryptoSign(null, tbs, privateKey)));
  return { cert: pem('CERTIFICATE', cert), key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}
