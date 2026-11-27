#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// relay/test/push.mjs — UnifiedPush wakes (push.mjs, sigelo-push/0):
// RFC 8291's own example (Appendix A) byte for byte, the sigelo wake under the same keys (the
// vector apps/android/test/WebPushTest.java opens), VAPID, the address guard, the POST guard against
// fake endpoints over HTTPS on loopback (a redirect, a big reply, a slow one, a private address),
// then the relay on loopback with a fake distributor: register over the session, one wake per gap
// for a reader not connected, none while it is, the gap, a 410 forgetting, a 500 retried, unregister,
// refusals by name, the endpoint sealed at rest, the 90 days. Prints "ALL PASS (n)".
//   node relay/test/push.mjs
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify as cryptoVerify } from 'node:crypto';
import { mkdtempSync, readFileSync, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'mqtt';
import { startRelay } from '../server.mjs';
import { GAP_MS, KEEP_DAYS, POST_MS, PUSH_TOPIC, PUSH_V, REPLY_MAX, RS, TTL, WAKE, encrypt, parseRegistration, post, publicAddress, pushKeys, vapid } from '../push.mjs';
import { clientId, identity, password, selfSigned } from './fixtures.mjs';

let n = 0, failed = 0;
const ok = (cond, what) => { n++; if (cond) console.log(`ok ${what}`); else { failed++; console.log(`FAIL ${what}`); } };
setTimeout(() => { console.log(`FAIL the run did not finish in 120 s (${n} checks so far)`); process.exit(1); }, 120000).unref();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (cond, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (cond()) return true; await sleep(10); } return cond(); };
const b = (s) => Buffer.from(s, 'base64url');

// ---- RFC 8291 Appendix A (also §5): the example's keys, salt and message
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};
// The sigelo wake under the same keys and salt: pinned here, opened by apps/android/test/WebPushTest.java.
const WAKE_BODY = 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_WltxQDr23ZlTPu6FJ-lJe9mCE1ds1aqnlkxh84dqQK5ZvIRol0qJAL4Pvsj2TZUMR';
const asKey = () => { const e = createECDH('prime256v1'); e.setPrivateKey(b(RFC.asPrivate)); return e; };

// What the phone does (WebPush.java's steps): the header, the shared secret, the keys, the record.
function decrypt(body, uaPrivate, auth) {
  const salt = body.subarray(0, 16), rs = body.readUInt32BE(16), idlen = body[20], asPublic = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
  const u = createECDH('prime256v1');
  u.setPrivateKey(uaPrivate);
  const uaPublic = u.getPublicKey(), secret = u.computeSecret(asPublic);
  const ikm = Buffer.from(hkdfSync('sha256', secret, auth, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const rec = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  let end = rec.length - 1;
  while (end >= 0 && rec[end] === 0) end--;
  if (rec[end] !== 2) throw new Error('not the last record');
  return { rs, plaintext: rec.subarray(0, end) };
}

{
  const body = encrypt(Buffer.from(RFC.plaintext), b(RFC.uaPublic), b(RFC.auth), { salt: b(RFC.salt), ecdh: asKey() });
  ok(asKey().getPublicKey().toString('base64url') === RFC.asPublic && body.toString('base64url') === RFC.body, 'RFC 8291 Appendix A: the example body, byte for byte (aes128gcm, rs 4096, one record)');
  const d = decrypt(b(RFC.body), b(RFC.uaPrivate), b(RFC.auth));
  ok(d.plaintext.toString() === RFC.plaintext && d.rs === RS, 'RFC 8291 Appendix A: the example opens under the user agent\'s key');
  ok(WAKE.length === 32 && WAKE.subarray(0, 18).toString() === 'sigelo-push/0 wake' && WAKE.subarray(18).every((x) => x === 0), 'WAKE: 32 bytes, "sigelo-push/0 wake" then zeros: the same for every cause');
  const w = encrypt(WAKE, b(RFC.uaPublic), b(RFC.auth), { salt: b(RFC.salt), ecdh: asKey() });
  ok(w.toString('base64url') === WAKE_BODY && w.length === 86 + 33 + 16, `the wake under the RFC's keys and salt: the pinned vector, ${w.length} bytes`);
  const r1 = encrypt(WAKE, b(RFC.uaPublic), b(RFC.auth)), r2 = encrypt(WAKE, b(RFC.uaPublic), b(RFC.auth));
  ok(!r1.equals(r2) && decrypt(r1, b(RFC.uaPrivate), b(RFC.auth)).plaintext.equals(WAKE), 'a wake: a fresh salt and sender key each time, opens to WAKE');
  let bad = null;
  try { decrypt(r1, b(RFC.uaPrivate), randomBytes(16)); } catch (e) { bad = e; }
  ok(bad !== null, 'a wake does not open under another auth secret');
}

// ---- VAPID (RFC 8292)
{
  const dir = mkdtempSync(join(tmpdir(), 'sigelo-push-keys-'));
  const file = join(dir, 'push.key'), k1 = pushKeys(file), k2 = pushKeys(file);
  ok(existsSync(file) && (statSync(file).mode & 0o777) === 0o600 && k1.seal.equals(k2.seal), 'the key file: made once, 0600, read back the same');
  const h = vapid(k1.vapid, 'https://push.example.org/upAbc?up=1', 'relay.test', 1800000000);
  const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(h);
  const head = m && JSON.parse(b(m[1])), claims = m && JSON.parse(b(m[2])), pub = m && b(m[4]);
  const key = m && createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }, format: 'jwk' });
  ok(m && head.alg === 'ES256' && claims.aud === 'https://push.example.org' && claims.exp === 1800000000 + 12 * 3600 && claims.sub === 'https://relay.test' && pub.length === 65
    && cryptoVerify('sha256', Buffer.from(`${m[1]}.${m[2]}`), { key, dsaEncoding: 'ieee-p1363' }, b(m[3])),
  'VAPID: "vapid t=<ES256 JWT>, k=<the key>", aud the endpoint\'s origin, 12 hours, sub the relay; the signature verifies under k');
}

// ---- the address guard and the registration's shape
{
  const pub = ['1.1.1.1', '9.9.9.9', '2606:4700::1111'], priv = ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '224.0.0.1', '64:ff9b::a00:1', '2001:db8::1', '::127.0.0.1', '::a00:1', '::ffff:0:7f00:1', '3fff::1'];
  ok(pub.every(publicAddress) && !priv.some(publicAddress) && !publicAddress('example.org'), `publicAddress: public ones pass; loopback, private, link-local (the metadata address), CGNAT, IPv4-compatible, mapped, SIIT, NAT64, multicast and documentation do not`);
  const good = { v: PUSH_V, endpoint: 'https://push.example.org/upAbc?up=1', p256dh: RFC.uaPublic, auth: RFC.auth };
  const reg = (o) => parseRegistration(Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)));
  const g = reg(good);
  ok(g.endpoint === good.endpoint && g.p256dh.length === 65 && g.auth.length === 16, 'a registration: {v, endpoint, p256dh, auth} decoded');
  const refusals = [
    ['not JSON', '{'], ['another version', { ...good, v: 'sigelo-push/1' }], ['a field more', { ...good, more: 1 }], ['http', { ...good, endpoint: 'http://push.example.org/x' }],
    ['a user in the URL', { ...good, endpoint: 'https://a:b@push.example.org/x' }], ['loopback', { ...good, endpoint: 'https://127.0.0.1/x' }], ['localhost', { ...good, endpoint: 'https://localhost:8080/x' }],
    ['the metadata address', { ...good, endpoint: 'https://169.254.169.254/latest' }], ['an IPv6 ULA', { ...good, endpoint: 'https://[fd00::1]/x' }], ['too long', { ...good, endpoint: `https://push.example.org/${'a'.repeat(1100)}` }],
    ['a short key', { ...good, p256dh: RFC.auth }], ['a key off the curve', { ...good, p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString('base64url') }],
    ['a long auth', { ...good, auth: RFC.uaPrivate }], ['base64 with padding', { ...good, auth: 'BTBZMqHH6r4Tts7J_aSIgg==' }],
  ];
  const bad = refusals.filter(([, o]) => !reg(o).why).map(([w]) => w);
  ok(bad.length === 0, `a registration refused, each with why: ${refusals.map(([w]) => w).join(', ')} (taken: ${bad})`);
}

// ---- the POST guard, against fake endpoints on loopback
const cert = selfSigned('localhost');
const hits = [];
let answer = (req, res) => { res.writeHead(201); res.end(); };
const fake = createServer({ cert: cert.cert, key: cert.key }, (req, res) => {
  const parts = [];
  req.on('data', (d) => parts.push(d));
  req.on('end', () => { hits.push({ url: req.url, headers: req.headers, body: Buffer.concat(parts) }); answer(req, res); });
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
const port = fake.address().port, url = (p = '/upTest') => `https://localhost:${port}${p}`;
const T = { anyAddress: true, ca: cert.cert };
{
  hits.length = 0;
  ok(await post(url(), Buffer.from('x'), {}, T) === 201 && hits.length === 1 && hits[0].body.toString() === 'x', 'post: one POST to an https endpoint, its status');
  const code = async (f) => { try { await f(); return 'accepted'; } catch (e) { return e.code; } };
  ok(await code(() => post(url(), Buffer.from('x'), {}, { ca: cert.cert })) === 'ENOTPUBLIC', 'post: a name that resolves to loopback (localhost) is refused before any connection');
  ok(await code(() => post(`https://127.0.0.1:${port}/x`, Buffer.from('x'), {}, { ca: cert.cert })) === 'ENOTPUBLIC' && hits.length === 1, 'post: a loopback IP literal is refused; nothing reached the endpoint');
  ok(await code(() => post(`http://localhost:${port}/x`, Buffer.from('x'), {}, T)) === 'ENOTHTTPS', 'post: http:// refused');
  answer = (req, res) => { res.writeHead(301, { Location: url('/elsewhere') }); res.end(); };
  hits.length = 0;
  ok(await post(url(), Buffer.from('x'), {}, T) === 301 && hits.length === 1, 'post: a redirect is a status, never followed');
  answer = (req, res) => { res.writeHead(200); res.write(Buffer.alloc(REPLY_MAX * 4)); setTimeout(() => res.end(), 2000); };
  const t0 = Date.now(), big = await post(url(), Buffer.from('x'), {}, T);
  ok(big === 200 && Date.now() - t0 < 1500, `post: a reply past ${REPLY_MAX} bytes is cut there, not read on (${Date.now() - t0} ms)`);
  answer = () => {};   // never answers
  const t1 = Date.now(), slow = await code(() => post(url(), Buffer.from('x'), {}, T));
  ok(slow === 'ETIMEDOUT' && Date.now() - t1 >= POST_MS - 100 && Date.now() - t1 < POST_MS + 1500, `post: no answer in ${POST_MS} ms: given up (${Date.now() - t1} ms)`);
  answer = (req, res) => { res.writeHead(201); res.end(); };
}

// ---- the relay with a fake distributor
const dir = mkdtempSync(join(tmpdir(), 'sigelo-relay-push-'));
let now = Date.parse('2026-11-24T00:00:00Z') / 1000, ms = 1e9;
const lines = [];
const cfg = { host: 'relay.test', db: join(dir, 'relay.db'), tcpPort: 0, httpPort: 0, loginRate: 1000, verifyBudget: 1e6, clock: () => now, diskUsed: () => 0.1, log: (l) => lines.push(l),
  push: { ...T, now: () => ms } };
let relay = await startRelay(cfg);
const base = () => `http://127.0.0.1:${relay.ports.http}`;
const mq = (creds) => new Promise((resolve) => {
  const c = connect({ host: '127.0.0.1', port: relay.ports.tcp, protocolVersion: 4, clean: false, reconnectPeriod: 0, connectTimeout: 5000, ...creds });
  c.box = [];
  c.on('message', (t, p) => c.box.push({ t, p }));
  c.once('connect', () => resolve(c));
  c.once('error', (e) => { c.end(true); resolve({ error: e }); });
});
const login = async (id) => {
  const ch = await (await fetch(`${base()}/challenge?did=${encodeURIComponent(id.did)}`)).json();
  return mq({ username: id.did, clientId: clientId(id), password: password(id, ch.challenge) });
};
const publish = (c, t, p) => new Promise((resolve) => c.publish(t, p, { qos: 1 }, (e) => resolve(e ?? null)));
const subscribe = (c, t) => new Promise((resolve) => c.subscribe(t, { qos: 1 }, (e, g) => resolve(e ? 128 : g[0].qos)));
const end = (c) => new Promise((resolve) => c.end(false, {}, resolve));
const notices = (c) => c.box.filter((m) => m.t === '$sigelo/notice').map((m) => JSON.parse(m.p));
const bob = identity('bob'), alice = identity('alice'), carol = identity('carol');
const ENDPOINT = url('/upBob?up=1');
const regBytes = (endpoint = ENDPOINT) => Buffer.from(JSON.stringify({ v: PUSH_V, endpoint, p256dh: RFC.uaPublic, auth: RFC.auth }));
const box = `m/${randomBytes(16).toString('hex')}`;
const wakes = () => hits.filter((h) => h.url === '/upBob?up=1');
try {
  const ch = await (await fetch(`${base()}/challenge?did=${encodeURIComponent(bob.did)}`)).json();
  ok(ch.push === PUSH_V, 'GET /challenge says push: "sigelo-push/0": a client registers only where it is taken');
  hits.length = 0;
  let B = await login(bob);
  ok(await subscribe(B, box) === 1, 'bob claims a mailbox');
  ok(await publish(B, PUSH_TOPIC, regBytes()) === null && notices(B).length === 0 && relay.db.raw.prepare('SELECT count(*) AS n FROM push').get().n === 1, 'bob registers his endpoint over his session: no notice');
  const A = await login(alice);
  await subscribe(A, PUSH_TOPIC);
  ok(await publish(A, box, randomBytes(64)) === null, 'alice writes while bob is connected');
  await sleep(200);
  ok(wakes().length === 0, 'bob connected: no wake');
  await end(B);
  await until(() => relay.broker.clients[clientId(bob)] === undefined);
  await publish(A, box, randomBytes(64));
  ok(await until(() => wakes().length === 1), 'bob gone: one POST to his endpoint');
  const w = wakes()[0];
  ok(decrypt(w.body, b(RFC.uaPrivate), b(RFC.auth)).plaintext.equals(WAKE) && w.body.length === 135, 'the wake opens under bob\'s key to WAKE: 135 bytes, nothing of the message, sender or count');
  ok(w.headers['content-encoding'] === 'aes128gcm' && w.headers.ttl === String(TTL) && w.headers.urgency === 'high' && /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]{87}$/.test(w.headers.authorization)
    && w.headers['content-type'] === 'application/octet-stream', 'the POST: Content-Encoding aes128gcm, TTL, Urgency high, VAPID');
  for (let i = 0; i < 3; i++) await publish(A, box, randomBytes(64));
  await sleep(300);
  ok(wakes().length === 1, 'three more messages before bob connects: no second wake (one per gap)');
  ok(A.box.filter((m) => m.t === PUSH_TOPIC).length === 0, 'a subscriber of $sigelo/push gets nothing: a registration is never delivered');

  // bob's app wakes, connects, takes his mail, leaves; a ring comes 1 s later: it waits out the gap, never dropped.
  B = await login(bob);
  await sleep(100);
  await end(B);
  await until(() => relay.broker.clients[clientId(bob)] === undefined);
  ms += 1000;
  await publish(A, box, randomBytes(64));
  await sleep(200);
  ok(wakes().length === 1 && relay.push.pending().waiting === 1, `a message within ${GAP_MS} ms of the last wake: held for the gap`);
  ms += GAP_MS;
  ok(await until(() => wakes().length === 2, GAP_MS + 2000), 'then sent: the gap delays a wake, never drops it');

  // A failing distributor: the next message tries again; a 410 forgets the registration.
  B = await login(bob); await end(B); await until(() => relay.broker.clients[clientId(bob)] === undefined);
  ms += GAP_MS;
  answer = (req, res) => { res.writeHead(500); res.end(); };
  await publish(A, box, randomBytes(64));
  ok(await until(() => wakes().length === 3) && await until(() => lines.some((l) => l === 'push failed 500')), 'a 500: logged "push failed 500" (no endpoint, no account)');
  ms += GAP_MS;
  answer = (req, res) => { res.writeHead(410); res.end(); };
  await publish(A, box, randomBytes(64));
  ok(await until(() => wakes().length === 4) && await until(() => relay.db.raw.prepare('SELECT count(*) AS n FROM push').get().n === 0), 'after the 500 the next message wakes again; a 410: the registration is deleted');
  ms += GAP_MS;
  answer = (req, res) => { res.writeHead(201); res.end(); };
  await publish(A, box, randomBytes(64));
  await sleep(300);
  ok(wakes().length === 4, 'no registration: no wake');

  // Refusals by name; unregister.
  B = await login(bob);
  for (const bad of [Buffer.from('{'), regBytes('http://push.example.org/x'), regBytes(`https://127.0.0.1:${port}/x`)]) await publish(B, PUSH_TOPIC, bad);
  // anyAddress is on for this relay (loopback endpoints): the loopback literal is refused only without it (above).
  const ns = notices(B).filter((x) => x.code === 'push');
  ok(ns.length === 2 && ns.every((x) => typeof x.detail === 'string' && x.detail.length > 0), `a malformed registration: notice {code: "push", detail} (${ns.map((x) => x.detail).join(' / ')})`);
  ok(B.connected, 'a refused registration ends no session');
  await publish(B, PUSH_TOPIC, regBytes());
  await publish(B, PUSH_TOPIC, Buffer.alloc(0));
  ok(relay.db.raw.prepare('SELECT count(*) AS n FROM push').get().n === 0, 'an empty publish unregisters');
  await publish(B, PUSH_TOPIC, regBytes());
  await end(B); await until(() => relay.broker.clients[clientId(bob)] === undefined);

  // At rest: sealed; nothing of the endpoint or keys in the file, the WAL or the log.
  relay.db.raw.exec('PRAGMA wal_checkpoint(PASSIVE)');
  const raw = Buffer.concat([cfg.db, `${cfg.db}-wal`].filter(existsSync).map((f) => readFileSync(f)));
  const leaks = ['upBob', 'localhost', RFC.uaPublic, RFC.auth].filter((s) => raw.includes(Buffer.from(s)) || lines.some((l) => l.includes(s)))
    .concat([b(RFC.uaPublic), b(RFC.auth)].filter((x) => raw.includes(x)).map(() => 'raw key'));
  ok(leaks.length === 0, `the database, WAL and log hold no endpoint and no key, in text or bytes (${leaks})`);
  const row = relay.db.raw.prepare('SELECT day, sealed FROM push').get();
  ok(row && row.day % 86400 === 0 && row.sealed.length === 12 + 16 + Buffer.byteLength(JSON.stringify({ endpoint: ENDPOINT, p256dh: RFC.uaPublic, auth: RFC.auth })), 'one row: the day only, the registration sealed (nonce, ciphertext, tag)');

  // A restart keeps the registration (and its key file); a new process wakes bob as before.
  await relay.close();
  ms += GAP_MS;
  relay = await startRelay(cfg);
  const A2 = await login(alice);
  hits.length = 0;
  await publish(A2, box, randomBytes(64));
  ok(await until(() => wakes().length === 1) && decrypt(wakes()[0].body, b(RFC.uaPrivate), b(RFC.auth)).plaintext.equals(WAKE), 'after a restart: the registration opens under the same key file, the wake goes');
  await end(A2);

  // 90 days without a registration: the sweep deletes it.
  now += (KEEP_DAYS + 1) * 86400;
  relay.sweep(now);
  ok(relay.db.raw.prepare('SELECT count(*) AS n FROM push').get().n === 0, `${KEEP_DAYS} days without a registration: the row goes at the sweep`);
  await end(A);

  // RELAY_PUSH off: GET /challenge says nothing; no table is written.
  await relay.close();
  relay = await startRelay({ ...cfg, db: join(dir, 'off.db'), push: false });
  const off = await (await fetch(`${base()}/challenge?did=${encodeURIComponent(carol.did)}`)).json();
  ok(off.push === undefined && relay.push === null, 'push off: GET /challenge has no push field');
} finally {
  await relay.close();
  fake.closeAllConnections?.();
  fake.close();
}
console.log(failed ? `${failed} FAILED, ${n - failed} passed` : `ALL PASS (${n})`);
process.exit(failed ? 1 : 0);
