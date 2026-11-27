// SPDX-License-Identifier: AGPL-3.0-only
// relay/push.mjs — UnifiedPush wakes, sigelo-push/0 (relay/deploy/README.md "Push (ntfy)"): the relay is the
// push "application server" of a phone whose app is not connected.
//
// Register: a session publishes (QoS 1) to $sigelo/push the JSON
//   {"v": "sigelo-push/0", "endpoint": <https URL>, "p256dh": <base64url, 65 bytes>, "auth": <base64url, 16 bytes>}
// (the endpoint its UnifiedPush distributor gave it, a capability URL, and its RFC 8291 keys), or an
// empty payload to unregister. One registration per identity (account): a new one replaces the last.
// A refusal comes on $sigelo/notice as {code: "push", detail}; the publish is never delivered to
// anyone. GET /challenge says `push: "sigelo-push/0"` when this relay takes it, so a client never
// sends the topic to a relay that would close its session for it.
//
// Wake: a message stored for an account whose session is not connected (mailbox.mjs) → one POST to
// its endpoint: RFC 8291 (aes128gcm, RFC 8188) encrypting WAKE, 32 bytes that are the same for every
// cause: no account, no sender, no kind, no count. VAPID (RFC 8292) names this relay. At most one
// until the account next logs in (connected), at least GAP_MS apart (a later one waits, never
// dropped), at most IN_FLIGHT POSTs at once and QUEUE waiting relay-wide (past that: dropped and
// logged). A 404 or 410 deletes the registration (the distributor forgot it); any other failure
// lets the next message try again.
//
// The POST: https only, to a public address (every address the name resolves to, an IP literal
// too: no loopback, private, link-local, CGNAT, multicast, documentation or translation range), no
// redirect followed, at most REPLY_MAX bytes of the reply read, POST_MS in all: no SSRF.
//
// At rest (db.mjs's rules): the table push, keyed by account, holds the day of the last
// registration and the registration sealed (ChaCha20-Poly1305 under the key file's `seal`, the
// account as additional data). The key file (RELAY_PUSH_KEY, default push.key beside the
// database, 0600, made at the first start) also holds the VAPID key. A copy of the database alone
// names no endpoint. A row goes 90 days after its last registration (KEEP_DAYS) or with its account.
import { createCipheriv, createDecipheriv, createECDH, createPrivateKey, generateKeyPairSync, hkdfSync, randomBytes, sign } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns';
import { readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { DAY, dayOf } from './db.mjs';

export const PUSH_TOPIC = '$sigelo/push', PUSH_V = 'sigelo-push/0';
// What every wake carries: the label, then zeros, 32 bytes. The phone opens it under its keys
// (RFC 8291) and wants exactly this.
export const WAKE = Buffer.concat([Buffer.from(`${PUSH_V} wake`, 'utf8'), Buffer.alloc(32 - Buffer.byteLength(`${PUSH_V} wake`))]);
export const RS = 4096, TTL = 86400, POST_MS = 5000, REPLY_MAX = 4096, URL_MAX = 1024, KEEP_DAYS = 90, GAP_MS = 5000, IN_FLIGHT = 32, QUEUE = 4096, VAPID_HOURS = 12;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS push (
  account TEXT PRIMARY KEY,   -- hex SHA-256 of the original DID (db.mjs accountOf)
  day     INTEGER NOT NULL,   -- the start of the UTC day of the last registration (db.mjs dayOf)
  sealed  BLOB NOT NULL       -- nonce ‖ ChaCha20-Poly1305(JSON {endpoint, p256dh, auth}) ‖ tag, AAD the account
) STRICT, WITHOUT ROWID;`;

const b64u = (b) => Buffer.from(b).toString('base64url');
const unb64u = (s) => (typeof s === 'string' && /^[A-Za-z0-9_-]*$/.test(s) ? Buffer.from(s, 'base64url') : null);

// ---------------------------------------------------------------- RFC 8291 and RFC 8292

/**
 * RFC 8291 §3.4 with RFC 8188 aes128gcm, one record: plaintext for the user agent's p256dh (65
 * bytes, uncompressed P-256) and auth (16 bytes). salt and the sender's ECDH key (createECDH
 * 'prime256v1' with its keys set) are random unless given (the test vectors). → the body.
 */
export function encrypt(plaintext, p256dh, auth, { salt = randomBytes(16), ecdh = null } = {}) {
  const e = ecdh ?? createECDH('prime256v1');
  if (!ecdh) e.generateKeys();
  const asPublic = e.getPublicKey(), secret = e.computeSecret(p256dh);
  const ikm = Buffer.from(hkdfSync('sha256', secret, auth, Buffer.concat([Buffer.from('WebPush: info\0'), p256dh, asPublic]), 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const c = createCipheriv('aes-128-gcm', cek, nonce);
  // The one record is the last: its delimiter 0x02, no padding.
  const ct = Buffer.concat([c.update(Buffer.concat([plaintext, Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(RS);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, ct]);
}

/** A VAPID (RFC 8292) Authorization header for endpoint's origin: an ES256 JWT, sub the relay's https URL. */
export function vapid(key, endpoint, host, now) {
  const jwk = key.export({ format: 'jwk' }), k = b64u(Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]));
  const part = (o) => b64u(Buffer.from(JSON.stringify(o)));
  const input = `${part({ typ: 'JWT', alg: 'ES256' })}.${part({ aud: new URL(endpoint).origin, exp: now + VAPID_HOURS * 3600, sub: `https://${host}` })}`;
  const sig = sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${input}.${b64u(sig)}, k=${k}`;
}

// ---------------------------------------------------------------- where a POST may go

// One list per family: a list holding ::ffff:0:0/96 matches every IPv4 address checked against it.
const BLOCKED4 = new BlockList(), BLOCKED6 = new BlockList();
for (const [a, n] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]]) BLOCKED4.addSubnet(a, n, 'ipv4');
for (const [a, n] of [['::', 96], ['::ffff:0:0', 96], ['::ffff:0:0:0', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 23], ['2001:db8::', 32], ['2002::', 16],
  ['3fff::', 20], ['5f00::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8]]) BLOCKED6.addSubnet(a, n, 'ipv6');

/** Is this IP address one a wake may go to? (Not loopback, private, link-local, CGNAT, multicast, documentation, IPv4-compatible, mapped or translated.) */
export function publicAddress(ip) {
  const v = isIP(ip);
  if (v === 0) return false;
  return v === 4 ? !BLOCKED4.check(ip, 'ipv4') : !BLOCKED6.check(ip, 'ipv6');
}

// dns.lookup, refusing a name any of whose addresses is not public (a name that resolves to a
// public and a private address could be dialled at the private one).
const guardedLookup = (hostname, options, cb) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return cb(err);
    if (addrs.length === 0 || !addrs.every((a) => publicAddress(a.address))) return cb(Object.assign(new Error('the endpoint resolves to an address that is not public'), { code: 'ENOTPUBLIC' }));
    if (options?.all) cb(null, addrs); else cb(null, addrs[0].address, addrs[0].family);
  });
};

/**
 * One POST: url (https), body, headers. → the status, or throws (the network, a refused address,
 * the deadline). The reply is read to REPLY_MAX bytes and dropped; a redirect is a status like
 * any other, never followed. anyAddress, ca: for tests on loopback.
 */
export function post(url, body, headers, { anyAddress = false, ca } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    if (u.protocol !== 'https:') return reject(Object.assign(new Error('https only'), { code: 'ENOTHTTPS' }));
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (!anyAddress && isIP(host) && !publicAddress(host)) return reject(Object.assign(new Error('not a public address'), { code: 'ENOTPUBLIC' }));
    let done = false;
    const end = (f, v) => { if (!done) { done = true; clearTimeout(timer); f(v); } };
    const req = request(u, { method: 'POST', headers: { ...headers, 'Content-Length': body.length }, agent: false, ...(anyAddress ? {} : { lookup: guardedLookup }), ...(ca && { ca }) }, (res) => {
      let n = 0;
      res.on('data', (d) => { n += d.length; if (n > REPLY_MAX) { res.destroy(); end(resolve, res.statusCode); } });
      res.on('end', () => end(resolve, res.statusCode));
      res.on('error', () => end(resolve, res.statusCode));
    });
    const timer = setTimeout(() => { req.destroy(); end(reject, Object.assign(new Error('no answer in time'), { code: 'ETIMEDOUT' })); }, POST_MS);
    req.on('error', (e) => end(reject, e));
    req.end(body);
  });
}

// ---------------------------------------------------------------- registrations

/** A registration's JSON payload → { endpoint, p256dh, auth } (decoded), or { why }. */
export function parseRegistration(bytes, { anyAddress = false } = {}) {
  let v;
  try { v = JSON.parse(Buffer.from(bytes).toString('utf8')); } catch { return { why: `not JSON: want {"v": "${PUSH_V}", "endpoint", "p256dh", "auth"}` }; }
  if (v === null || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).sort().join() !== 'auth,endpoint,p256dh,v' || v.v !== PUSH_V) return { why: `want exactly {"v": "${PUSH_V}", "endpoint", "p256dh", "auth"}` };
  if (typeof v.endpoint !== 'string' || v.endpoint.length > URL_MAX) return { why: `endpoint: an https URL of at most ${URL_MAX} characters` };
  let u;
  try { u = new URL(v.endpoint); } catch { return { why: 'endpoint: not a URL' }; }
  if (u.protocol !== 'https:' || u.username || u.password || u.hash) return { why: 'endpoint: https only, no user, no fragment' };
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!anyAddress && (host === 'localhost' || host.endsWith('.localhost') || (isIP(host) && !publicAddress(host)))) return { why: 'endpoint: not a public address' };
  const p256dh = unb64u(v.p256dh), auth = unb64u(v.auth);
  if (!p256dh || p256dh.length !== 65 || p256dh[0] !== 4) return { why: 'p256dh: base64url of an uncompressed P-256 point (65 bytes)' };
  try { const e = createECDH('prime256v1'); e.generateKeys(); e.computeSecret(p256dh); } catch { return { why: 'p256dh: not a point on P-256' }; }
  if (!auth || auth.length !== 16) return { why: 'auth: base64url of 16 bytes' };
  return { endpoint: v.endpoint, p256dh, auth };
}

/** The key file: { seal (32 bytes), vapid (a P-256 private KeyObject) }, made at the first start (0600). */
export function pushKeys(file) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    text = JSON.stringify({ v: 'sigelo-relay-push/0', seal: b64u(randomBytes(32)), vapid: privateKey.export({ format: 'jwk' }) });
    try { writeFileSync(file, text, { mode: 0o600, flag: 'wx' }); } catch (e2) { if (e2.code !== 'EEXIST') throw e2; text = readFileSync(file, 'utf8'); }
  }
  const k = JSON.parse(text), seal = unb64u(k.seal);
  if (k.v !== 'sigelo-relay-push/0' || !seal || seal.length !== 32) throw new Error(`${file}: not a sigelo-relay-push/0 key file`);
  return { seal, vapid: createPrivateKey({ key: k.vapid, format: 'jwk' }) };
}

/**
 * db: db.mjs; host: the relay's name (VAPID's sub); clock() → unix seconds; log(line); keyFile;
 * online(account) → is its session connected now; send(url, body, headers) → status (post, by
 * default; tests: anyAddress, ca); now(): milliseconds, for the gap.
 * → { register, wake, connected, tidy, has, close, pending }.
 */
export function pushWakes({ db, host, clock, log = () => {}, keyFile, anyAddress = false, ca, send = null, now = () => Date.now() }) {
  const keys = pushKeys(keyFile);
  db.rebuild(SCHEMA, ['push']);
  db.keepSorted(SCHEMA, ['push']);
  const q = (sql) => db.raw.prepare(sql);
  const s = {
    get: q('SELECT day, sealed FROM push WHERE account = ?'),
    set: q('INSERT INTO push (account, day, sealed) VALUES (?, ?, ?) ON CONFLICT (account) DO UPDATE SET day = excluded.day, sealed = excluded.sealed'),
    del: q('DELETE FROM push WHERE account = ?'),
    old: q('DELETE FROM push WHERE day < ?'),
    orphans: q('DELETE FROM push WHERE account NOT IN (SELECT account FROM accounts)'),
  };
  const sealReg = (account, reg) => {
    const nonce = randomBytes(12), c = createCipheriv('chacha20-poly1305', keys.seal, nonce, { authTagLength: 16 });
    c.setAAD(Buffer.from(account, 'utf8'));
    const ct = Buffer.concat([c.update(JSON.stringify({ endpoint: reg.endpoint, p256dh: b64u(reg.p256dh), auth: b64u(reg.auth) }), 'utf8'), c.final()]);
    return Buffer.concat([nonce, ct, c.getAuthTag()]);
  };
  // A row that does not open (another key file, an altered row) is no registration.
  const openReg = (account, blob) => {
    try {
      const b = Buffer.from(blob), d = createDecipheriv('chacha20-poly1305', keys.seal, b.subarray(0, 12), { authTagLength: 16 });
      d.setAAD(Buffer.from(account, 'utf8'));
      d.setAuthTag(b.subarray(b.length - 16));
      const v = JSON.parse(Buffer.concat([d.update(b.subarray(12, b.length - 16)), d.final()]).toString('utf8'));
      return { endpoint: v.endpoint, p256dh: unb64u(v.p256dh), auth: unb64u(v.auth) };
    } catch { return null; }
  };
  const doPost = send ?? ((url, body, headers) => post(url, body, headers, { anyAddress, ca }));

  const woken = new Set();     // accounts woken since their last login: no second wake until then
  const last = new Map();      // account → ms of its last POST (the gap)
  const timers = new Map();    // account → the timer of a wake waiting for the gap
  const queue = [];            // accounts waiting for a POST slot
  let inFlight = 0, closed = false;

  // A registration (payload: bytes) for the account → null when kept (or removed), else { code: "push", detail }.
  // Written only when it changed or its day did: at most once a day per account for the same endpoint.
  function register(account, payload, t = clock()) {
    if (payload.length === 0) {
      if (s.get.get(account) !== undefined) db.settle(() => s.del.run(account));
      woken.delete(account);
      return null;
    }
    const reg = parseRegistration(payload, { anyAddress });
    if (reg.why) return { code: 'push', detail: reg.why };
    const row = s.get.get(account), had = row ? openReg(account, row.sealed) : null;
    const same = had && had.endpoint === reg.endpoint && had.p256dh.equals(reg.p256dh) && had.auth.equals(reg.auth);
    if (!same || row.day !== dayOf(t)) db.settle(() => s.set.run(account, dayOf(t), sealReg(account, reg)));
    return null;
  }

  async function fire(account) {
    timers.delete(account);
    if (closed) return;
    const row = s.get.get(account), reg = row ? openReg(account, row.sealed) : null;
    if (!reg) { woken.delete(account); return; }
    last.set(account, now());
    inFlight++;
    let status = null, why = null;
    try {
      status = await doPost(reg.endpoint, encrypt(WAKE, reg.p256dh, reg.auth), {
        'Content-Type': 'application/octet-stream', 'Content-Encoding': 'aes128gcm', TTL: String(TTL), Urgency: 'high', Authorization: vapid(keys.vapid, reg.endpoint, host, clock()),
      });
    } catch (e) { why = e.code ?? e.name; }
    inFlight--;
    if (!closed) {
      if (status === 404 || status === 410) {
        // Gone at the distributor: the registration with it (its sealed copy still being this one).
        const now2 = s.get.get(account);
        if (now2 && Buffer.from(now2.sealed).equals(Buffer.from(row.sealed))) db.settle(() => s.del.run(account));
        woken.delete(account);
        log(`push gone ${status}`);
      } else if (status === null || status < 200 || status > 299) {
        woken.delete(account);   // the next message tries again
        log(`push failed ${why ?? status}`);
      }
    }
    next();
  }
  const next = () => {
    while (!closed && inFlight < IN_FLIGHT && queue.length > 0) void fire(queue.shift());
  };
  const enqueue = (account) => {
    if (inFlight < IN_FLIGHT && queue.length === 0) return void fire(account);
    if (queue.length >= QUEUE) { woken.delete(account); log('push dropped queue_full'); return; }
    queue.push(account);
  };

  // A message was stored for the account, whose session is not connected.
  function wake(account) {
    if (closed || woken.has(account) || s.get.get(account) === undefined) return;
    woken.add(account);
    const wait = (last.get(account) ?? -Infinity) + GAP_MS - now();
    if (wait > 0) { timers.set(account, setTimeout(() => { timers.delete(account); enqueue(account); }, wait)); return; }
    enqueue(account);
  }

  // The account logged in: its app is awake; the next gap may wake it again.
  function connected(account) {
    woken.delete(account);
    clearTimeout(timers.get(account));
    timers.delete(account);
  }

  // The sweep's transaction (mailbox.mjs tidy): registrations not renewed in KEEP_DAYS, and those whose account went.
  function tidy(t) {
    s.old.run(dayOf(t) - KEEP_DAYS * DAY);
    s.orphans.run();
    for (const [a, at] of last) if (at < now() - GAP_MS) last.delete(a);
  }

  return {
    register, wake, connected, tidy,
    has: (account) => s.get.get(account) !== undefined,
    pending: () => ({ inFlight, queued: queue.length, waiting: timers.size, woken: woken.size }),
    vapidPublic: () => { const j = keys.vapid.export({ format: 'jwk' }); return b64u(Buffer.concat([Buffer.from([4]), Buffer.from(j.x, 'base64url'), Buffer.from(j.y, 'base64url')])); },
    close() { closed = true; for (const t of timers.values()) clearTimeout(t); timers.clear(); queue.length = 0; },
  };
}
