#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// relay/test/run.mjs — the relay on loopback (plain MQTT, an injected clock and disk gauge), the
// fixture identities as agents: login, every login error by name through POST /check (a nonce
// altered anywhere in its head, the pow bits and network included: challenge_unknown), claims,
// delivery, the offline queue, acknowledgement, expiry, mailbox_taken, too_large, invite topics,
// a restart, the M4 hooks, and a broker-eye dump that must hold random topics and the random
// payloads sent, no DID, and no order of writing across accounts (no rowid, no relay-wide message
// number, no commit in the WAL holding a sender's row beside its reader's message). Also: packets
// left unfinished (a deadline, a budget, a cap before the CONNACK), a keepalive required, the
// session caps after the login so they tell nobody who is online, and a database of an earlier
// version rebuilt, and `node server.mjs` as systemd runs it (its environment, SIGHUP, SIGTERM).
// design/relay-plan.md §3, §7 M3. Prints "ALL PASS (n)".
//   node relay/test/run.mjs
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes, X509Certificate } from 'node:crypto';
import { connect as tcpConnect } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { connect } from 'mqtt';
import { attest, bind, canonicalize, challenge as challengeSig, keygen, multibase, rotate, sign, verify } from 'sigelo';
import { MAX_EARLY, startRelay } from '../server.mjs';
import { ACCOUNT_ROW, CLAIM_ROW, DID_ROW, accountOf, clientIdOf, openDb } from '../db.mjs';
import { CHECKS, MAX_BODY, MAX_OPERATOR, OPERATOR_CTX } from '../auth.mjs';
import { relayPolicy } from '../allowance.mjs';
import { mailboxes } from '../mailbox.mjs';
import { solve } from '../pow.mjs';
import { CREATED, bundleOf, clientId, identity, password, rotated, seed, selfSigned } from './fixtures.mjs';

let n = 0, failed = 0;
const ok = (cond, what) => { n++; if (cond) console.log(`ok ${what}`); else { failed++; console.log(`FAIL ${what}`); } };
setTimeout(() => { console.log(`FAIL the run did not finish in 240 s (${n} checks so far)`); process.exit(1); }, 240000).unref();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (cond, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (cond()) return true; await sleep(10); } return cond(); };

const dir = mkdtempSync(join(tmpdir(), 'sigelo-relay-'));
const DAY = 86400;
let now = Date.parse('2026-10-07T00:00:00Z') / 1000, disk = 0.10;
const lines = [];
// verifyBudget: every login here comes from 127.0.0.1, one prefix, so the budget gets its own relay.
const cfg = { host: 'relay.test', db: join(dir, 'relay.db'), tcpPort: 0, httpPort: 0, loginRate: 1000, verifyBudget: 1e6, clock: () => now, diskUsed: () => disk, log: (l) => lines.push(l) };
let relay = await startRelay(cfg);
const rows = (sql, ...p) => relay.db.raw.prepare(sql).all(...p);
const count = (sql, ...p) => relay.db.raw.prepare(sql).get(...p).n;

// ---- agents ----
const alice = identity('alice'), bob = identity('bob'), carol = identity('carol'), hana = identity('hana'), ivan = identity('ivan');
const issuer = identity('issuer');
const everyone = [alice, bob, carol, hana, ivan, issuer];
const sent = [];   // every payload handed to the relay: the dump may hold nothing else
const payload = (size) => { const p = randomBytes(size); sent.push(p); return p; };
const topic = (kind = 'm') => `${kind}/${randomBytes(16).toString('hex')}`;
// n voluntary rotations in a row from `from`, to the keys of label 1 … label n.
const chained = (from, label, n) => { let id = from; for (let i = 1; i <= n; i++) id = rotated(id, `${label} ${i}`); return id; };

const base = (r = relay) => `http://127.0.0.1:${r.ports.http}`;
// ip: the client address nginx would send as X-Real-IP (documentation ranges, RFC 5737).
const realIp = (ip) => (ip ? { 'x-real-ip': ip } : {});
const getChallenge = async (d, r = relay, ip) => (await fetch(`${base(r)}/challenge?did=${encodeURIComponent(d)}`, { headers: realIp(ip) })).json();
const postCheck = async (body, r = relay, ip) => {
  const res = await fetch(`${base(r)}/check`, { method: 'POST', headers: realIp(ip), body: typeof body === 'string' ? body : JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
};
// CONNECT → { client } on CONNACK 0, else { error } (error.code = the CONNACK return code).
const mqttConnect = ({ username, clientId: cid, password: pw, clean, keepalive }, r = relay) => new Promise((resolve) => {
  const c = connect({ host: '127.0.0.1', port: r.ports.tcp, protocolVersion: 4, clean, clientId: cid, username, password: pw, reconnectPeriod: 0, connectTimeout: 5000, ...(keepalive !== undefined && { keepalive }) });
  c.box = [];
  c.on('message', (t, p, packet) => c.box.push({ t, p, packet }));
  c.once('connect', () => resolve({ client: c }));
  c.once('error', (error) => { c.end(true); resolve({ error }); });
  c.once('close', () => resolve({ error: new Error('closed') }));
});
// Log in as id. opts: bundle (false = none), extra password fields, signer, username, clientId,
// clean, challengeDid, password (verbatim), ip (the challenge's X-Real-IP).
async function login(id, opts = {}, r = relay) {
  const { challenge } = await getChallenge(opts.challengeDid ?? id.did, r, opts.ip);
  const pw = opts.password ?? password(opts.signer ?? id, challenge, { bundle: opts.bundle ?? true, extra: opts.extra });
  const creds = { username: opts.username ?? id.did, clientId: opts.clientId ?? clientId(id), password: pw, clean: opts.clean ?? false };
  return { ...(await mqttConnect(creds, r)), creds, challenge };
}
const asCheck = (c) => ({ username: c.username, client_id: c.clientId, password: c.password, ...(c.clean ? { clean: true } : {}) });
// A refused CONNECT, and the check POST /check names for it.
async function refused(id, opts, want, what, r = relay) {
  const l = await login(id, opts, r);
  const c = await postCheck(asCheck(l.creds), r);
  ok(!l.client && c.json.ok === false && c.json.check === want, `${what}: CONNECT refused, POST /check names ${want} (${c.json.check}: ${c.json.detail})`);
  l.client?.end(true);
  return { l, c };
}
// → the granted QoS, or 128 (MQTT.js reports a SUBACK 128 as a "Subscribe error").
const subscribe = (c, t, qos = 1) => new Promise((resolve) => c.subscribe(t, { qos }, (e, g) => resolve(e ? (/^Subscribe error/.test(e.message) ? 128 : -1) : g[0].qos)));
const publish = (c, t, p, opts = {}) => new Promise((resolve) => c.publish(t, p, { qos: 1, ...opts }, (e) => resolve(e ?? null)));
const notices = (c) => c.box.filter((m) => m.t === '$sigelo/notice').map((m) => JSON.parse(m.p));
const messages = (c, t) => c.box.filter((m) => m.t === t);
const end = (c) => new Promise((resolve) => c.end(false, {}, resolve));
// The packets c receives while f runs, in the order they came on the wire: a notice as
// "notice:<code>", any other packet as its type.
async function wireOf(c, f) {
  const wire = [], on = (p) => wire.push(p.cmd === 'publish' && p.topic === '$sigelo/notice' ? `notice:${JSON.parse(p.payload).code}` : p.cmd);
  c.on('packetreceive', on);
  try { await f(); } finally { c.off('packetreceive', on); }
  return wire.join();
}
const closed = (c) => new Promise((resolve) => { if (c.disconnected || !c.connected) resolve(true); c.once('close', () => resolve(true)); });

// ================================================================ HTTP surface
{
  const bad = await fetch(`${base()}/challenge?did=alice`);
  ok(bad.status === 400, `GET /challenge with a non-DID: 400 (${bad.status})`);
  const ch = await getChallenge(alice.did);
  ok(Object.keys(ch.challenge).sort().join() === 'did,nonce,relay,typ,v' && ch.challenge.v === 'sigelo-relay/0' && ch.challenge.typ === 'relay-login'
    && ch.challenge.did === alice.did && ch.challenge.relay === 'relay.test' && /^[A-Za-z0-9_-]{43}$/.test(ch.challenge.nonce),
  'GET /challenge: the login body, exactly five fields, typ "relay-login" (never a SPEC §5.2 challenge), relay = the relay host, a 32-byte base64url nonce');
  ok(ch.pow_bits === 0, 'GET /challenge: pow_bits 0 (proof of work is M4)');
  ok((await postCheck('{"username":')).status === 400, 'POST /check with broken JSON: 400');
  ok((await postCheck('{"username":"a","username":"b","client_id":"x","password":"p"}')).status === 400, 'POST /check with a duplicate key: 400 (strict parser)');
  ok((await postCheck({ username: 'a', client_id: 'x', password: 'p', more: 1 })).status === 400, 'POST /check with an unknown field: 400');
  ok((await postCheck(JSON.stringify({ pad: 'x'.repeat(300 * 1024) }))).status === 413, 'POST /check with a 300 KB body: 413');
  ok((await fetch(`${base()}/nothing`)).status === 404 && (await fetch(`${base()}/challenge`, { method: 'POST' })).status === 405, 'unknown path 404, wrong method 405');
}

// ---- plan §3 "Login", pinned from the fixture seeds: the bytes a client written elsewhere must
// produce, not this relay's own derivation checked against itself.
{
  const ALICE = 'did:sigelo:zCDFLqw3LyauWECBARhAVhEN4rG3vbfVx2baQD6y5RDXm', ALICE_CLIENT = 's1296f1d5b2c502a16414944c';
  ok(alice.original === ALICE, 'pinned: alice\'s original DID from her fixture seed');
  ok('s' + createHash('sha256').update(ALICE, 'utf8').digest('hex').slice(0, 24) === ALICE_CLIENT && clientIdOf(ALICE) === ALICE_CLIENT,
    'pinned: client id = "s" + the first 24 hex digits of SHA-256(original DID), and the relay derives the same');
  // sig = Ed25519 over "sigelo\n" + {"did":ALICE,"nonce":"AAA…","relay":"relay.test","typ":"relay-login","v":"sigelo-relay/0"},
  // computed with node:crypto's own Ed25519 from alice's seed when it was pinned.
  const PASSWORD = '{"nonce":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","sig":"z5L5HeQyxyYCoLNyVyGSCMN6e6FGDDCpYhqcpWWuNnmdsX4w8AKyWmyZ92WXfDXeJNfqW4noqAW1pAygGQ9hWwbeQ","v":"sigelo-relay/0"}';
  ok(password(alice, { relay: 'relay.test', nonce: 'A'.repeat(43) }, { bundle: false }) === PASSWORD,
    'pinned: password = JCS of {v, nonce, sig}, sig over the login body {v: "sigelo-relay/0", typ: "relay-login", did: current DID, relay: relay host, nonce}');
}

// ---- challenges store nothing: a flood of GET /challenge pushes out nobody's pending one
{
  const mine = await getChallenge(alice.did);
  const others = Array.from({ length: 50 }, (_, i) => identity(`junk ${i}`).did);
  let issued = 0;
  await Promise.all(Array.from({ length: 25 }, async (_, w) => {
    for (let i = w; i < 2100; i += 25) if ((await getChallenge(others[i % 50], relay, `2001:db8:${i % 8}::1`)).challenge) issued++;
  }));
  const r = await mqttConnect({ username: alice.did, clientId: clientId(alice), password: password(alice, mine.challenge), clean: false });
  ok(issued === 2100 && r.client?.connected === true, `after ${issued} challenges to 50 other DIDs from 8 networks (more than the old ring of 2,048), alice's earlier challenge still logs in`);
  if (r.client) await end(r.client);
}

// ================================================================ TLS, and a certificate reload
{
  const certFile = join(dir, 'tls.crt'), keyFile = join(dir, 'tls.key');
  const newPair = () => { const c = selfSigned('relay.test'); writeFileSync(certFile, c.cert); writeFileSync(keyFile, c.key, { mode: 0o600 }); return new X509Certificate(c.cert).fingerprint256; };
  const first = newPair();
  const tlsLines = [];
  const t = await startRelay({ ...cfg, db: join(dir, 'tls.db'), tcpPort: undefined, tlsCert: certFile, tlsKey: keyFile, tlsPort: 0, log: (l) => tlsLines.push(l) });
  const viaTls = async (id) => {
    const { challenge } = await getChallenge(id.did, t);
    return new Promise((resolve) => {
      const c = connect({ protocol: 'mqtts', host: '127.0.0.1', port: t.ports.tls, rejectUnauthorized: false, protocolVersion: 4, clean: false,
        clientId: clientId(id), username: id.did, password: password(id, challenge), reconnectPeriod: 0, connectTimeout: 5000 });
      c.once('connect', () => resolve(c));
      c.once('error', () => { c.end(true); resolve(null); });
    });
  };
  const presented = (c) => new X509Certificate(c.stream.getPeerCertificate(true).raw).fingerprint256;
  const c1 = await viaTls(alice);
  ok(c1?.connected === true && presented(c1) === first, 'MQTT over TLS: alice logs in, the relay presents the configured certificate');
  const second = newPair();
  t.reloadTls();
  const c2 = await viaTls(bob);
  ok(c2?.connected === true && presented(c2) === second && c1.connected, 'after a reload (SIGHUP) a new connection gets the new certificate; an open one stays');
  writeFileSync(keyFile, 'not a key');
  t.reloadTls();
  ok(tlsLines.some((l) => l.startsWith('tls reload failed, old certificate kept')), 'a broken key file at reload is refused and logged');
  const c3 = await viaTls(carol);
  ok(c3?.connected === true && presented(c3) === second, 'and the previous certificate stays in use');
  for (const c of [c1, c2, c3]) c?.end(true);
  await t.close();
  // The process itself: fromEnv, the M4 policy from the environment, and the two signals main()
  // wires, which the checks above stand in for by calling reloadTls() and close().
  newPair();
  const env = { PATH: process.env.PATH, RELAY_HOST: 'relay.test', RELAY_DB: join(dir, 'process.db'), RELAY_TLS_CERT: certFile, RELAY_TLS_KEY: keyFile, RELAY_TLS_PORT: '0',
    RELAY_TCP_PORT: '0', RELAY_HTTP_PORT: '0', RELAY_FREE_QUEUE_MB: '64' };
  const child = spawn(process.execPath, [fileURLToPath(new URL('../server.mjs', import.meta.url))], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  for (const s of [child.stdout, child.stderr]) s.on('data', (b) => { out += b; });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve(code ?? signal)));
  const up = await until(() => /^sigelo relay: mqtt tls :\d+, tcp 127\.0\.0\.1:\d+, http 127\.0\.0\.1:\d+$/m.test(out), 15000);
  const ch = up ? await (await fetch(`http://127.0.0.1:${out.match(/http 127\.0\.0\.1:(\d+)/)[1]}/challenge?did=${encodeURIComponent(alice.did)}`)).json() : {};
  ok(up && ch.pow_bits === 22, `node server.mjs from its environment: TLS, TCP and HTTP listening, the M4 policy in place (pow_bits ${ch.pow_bits}: the default 22)`);
  child.kill('SIGHUP');
  const reloaded = await until(() => out.includes('tls reloaded'), 5000);
  child.kill('SIGTERM');
  const code = await Promise.race([exited, sleep(10000).then(() => 'still running')]);
  if (code === 'still running') child.kill('SIGKILL');
  ok(reloaded && code === 0, `SIGHUP reloads the certificate ("tls reloaded"); SIGTERM closes the relay (exit ${code})`);
}

// ================================================================ login
let a, b;
{
  const l = await login(alice);
  a = l.client;
  ok(a?.connected === true, 'alice logs in: current DID, client id from the original DID, JCS password with her bundle');
  ok(lines.includes('login 127.0.0.0/24'), 'the login is logged with the address cut to /24');
  ok((await postCheck(asCheck(l.creds))).json.ok === true, 'POST /check on the credentials of that login: ok');
  await end(a);
  const again = await login(alice, { bundle: false });
  ok(again.client?.connected === true, 'alice logs in again without a bundle: the relay cached her original DID');
  a = again.client;
  // The replay of a used password: refused, and POST /check now names the replay's failure.
  const replay = await mqttConnect(l.creds);
  const rc = await postCheck(asCheck(l.creds));
  ok(!replay.client && rc.json.check === 'challenge_unknown', `a used password replayed: challenge_unknown (single use) (${rc.json.check})`);
  b = (await login(bob)).client;
  ok(b?.connected === true, 'bob logs in');
}

// ---- every login check by name ----
{
  // password: shape first, and a refused shape does not spend the nonce.
  const { challenge } = await getChallenge(carol.did);
  const good = JSON.parse(password(carol, challenge));
  const viaPw = (pw) => mqttConnect({ username: carol.did, clientId: clientId(carol), password: pw, clean: false });
  const cases = [
    [JSON.stringify(good, null, 1), 'not JCS (pretty-printed)'],
    [canonicalize({ ...good, extra: 1 }), 'an unknown key'],
    [canonicalize({ ...good, v: 'sigelo-relay/1' }), 'another version'],
    [`{"nonce":"a",${canonicalize(good).slice(1)}`, 'a duplicate key'],
    [canonicalize({ ...good, sig: 7 }), 'a number for sig'],
  ];
  for (const [pw, what] of cases) {
    const r = await viaPw(pw);
    const c = await postCheck({ username: carol.did, client_id: clientId(carol), password: pw });
    ok(!r.client && c.json.check === 'password', `password with ${what}: password (${c.json.check}: ${c.json.detail})`);
  }
  const notDid = await mqttConnect({ username: 'carol', clientId: clientId(carol), password: canonicalize(good), clean: false });
  ok(!notDid.client && (await postCheck({ username: 'carol', client_id: clientId(carol), password: canonicalize(good) })).json.check === 'password', 'a username that is not a DID: password');
  const after = await viaPw(canonicalize(good));
  ok(after.client?.connected === true, 'the same nonce still logs in after those refusals: a malformed password does not spend it');
  await end(after.client);
}
{
  await refused(alice, { password: canonicalize({ v: 'sigelo-relay/0', nonce: 'z' + 'A'.repeat(22), sig: 'z1' }) }, 'challenge_unknown', 'a nonce never issued');
  await refused(alice, { challengeDid: bob.did }, 'challenge_unknown', 'a challenge issued to bob, answered by alice');
  // The nonce's head (exp 0-3 ‖ pow bits 4 ‖ network 5-8 ‖ random 9-15) is under its MAC (16-31):
  // a client that lowers the difficulty it was told, or moves its arrival to another network,
  // holds a nonce never issued. One byte changed at each place, signed as a client would sign it:
  // CONNECT refused (POST /check on its credentials names why), and POST /check given a second such
  // nonce, never tried, names the same check there and then.
  // A fresh identity: logging in as alice here would take over her session, which the tests below use.
  const tam = identity('tamper');
  everyone.push(tam);
  const forge = async (at) => {
    const { challenge } = await getChallenge(tam.did);
    const raw = Buffer.from(challenge.nonce, 'base64url');
    raw[at] ^= 1;
    return { challenge, pw: password(tam, { ...challenge, nonce: raw.toString('base64url') }) };
  };
  let kept;
  for (const [what, at] of [['expiry', 0], ['pow bits', 4], ['network', 5], ['network', 8], ['random part', 15]]) {
    const viaConnect = await forge(at), viaCheck = await forge(at);
    const r = await mqttConnect({ username: tam.did, clientId: clientId(tam), password: viaConnect.pw, clean: false });
    const cc = await postCheck({ username: tam.did, client_id: clientId(tam), password: viaConnect.pw });
    const c = await postCheck({ username: tam.did, client_id: clientId(tam), password: viaCheck.pw });
    ok(!r.client && cc.json.check === 'challenge_unknown' && c.json.check === 'challenge_unknown',
      `a nonce with its ${what} changed (byte ${at}): challenge_unknown, from the CONNECT (${cc.json.check}) and from POST /check alone (${c.json.check})`);
    r.client?.end(true);
    kept = viaCheck.challenge;
  }
  const real = await mqttConnect({ username: tam.did, clientId: clientId(tam), password: password(tam, kept), clean: false });
  ok(real.client?.connected === true, 'the nonce as issued still logs in after its altered copy was refused: a forgery spends nothing');
  if (real.client) await end(real.client);
  const { challenge } = await getChallenge(alice.did);
  now += 300;
  const late = await mqttConnect({ username: alice.did, clientId: clientId(alice), password: password(alice, challenge), clean: false });
  const lc = await postCheck({ username: alice.did, client_id: clientId(alice), password: password(alice, challenge) });
  ok(!late.client && lc.json.check === 'challenge_expired', `a challenge answered 300 s later: challenge_expired (${lc.json.check})`);
}
{
  // Review finding: spent nonces are forgotten once expired, and were judged by the clock of the
  // moment, so a clock stepped back (an NTP step, a VM restored) made a used and forgotten nonce
  // good again: its captured password logged in a second time. On a relay with a clock of its own:
  // a login, the clock 301 s on and another login (which forgets the first nonce), the clock back
  // to 10 s after the first; the first password is refused, and a fresh challenge still logs in.
  let k = now;
  const K = await startRelay({ ...cfg, db: join(dir, 'clock.db'), clock: () => k, log: () => {} });
  const ck = identity('clock step');
  const first = await login(ck, {}, K);
  ok(first.client?.connected === true, 'clock: a login');
  await end(first.client);
  k += 301;
  const second = await login(ck, { bundle: false }, K);
  await end(second.client);
  k -= 291;
  const replay = await mqttConnect(first.creds, K), why = (await postCheck(asCheck(first.creds), K)).json;
  const fresh = await login(ck, { bundle: false }, K);
  ok(second.client && !replay.client && why.check === 'challenge_expired' && fresh.client?.connected === true,
    `the clock set back 291 s: the first password, used and forgotten, is refused (${why.check}); a challenge issued now still logs in`);
  fresh.client?.end(true);
  await K.close();
}
{
  await refused(hana, { bundle: false }, 'bundle', 'a first login without a bundle');
  const other = await refused(alice, { signer: bob, bundle: bundleOf(bob) }, 'bundle', 'alice\'s username with bob\'s bundle');
  ok(!other.c.json.detail.includes('did:sigelo:'), 'and the refusal names no DID (it would tell what the rotations kept resolve to)');
  // Without a bundle, an unknown DID and a known DID with a wrong signature read the same: POST
  // /check does not tell an outsider who logs in here.
  const probe = async (d) => {
    const { challenge } = await getChallenge(d);
    return (await postCheck({ username: d, client_id: clientIdOf(d), password: canonicalize({ v: 'sigelo-relay/0', nonce: challenge.nonce, sig: 'z1' }) })).json;
  };
  const [known, unknown] = [await probe(alice.did), await probe(identity('eve').did)];
  ok(known.check === 'bundle' && unknown.check === known.check && unknown.detail === known.detail, `no bundle, junk signature: alice (known here) and eve (never seen) get the same answer (${known.check}, ${unknown.check})`);
  // The 64-item cap, first and inclusive (world/server.mjs): 64 attestations log in, 65 do not.
  const att = attest({ secret: issuer.secret, iss: issuer.did, sub: carol.did, iat: now - 60, exp: now + 30 * DAY, ctx: 'relay.test', admission: 'open', claims: {} });
  const fat = (k) => bundleOf(carol, { attestations: Array(k).fill(att), issuers: [issuer.origin] });
  await refused(carol, { bundle: fat(65) }, 'bundle', 'a bundle of 65 items (cap 64)');
  const l64 = await login(carol, { bundle: fat(64) });
  ok(l64.client?.connected === true, 'a bundle of 64 items logs in: the cap is inclusive');
  await end(l64.client);
  // Issuers have a cap of their own, checked before any work: verify() decodes the key of every
  // issuer it is given (~0.4 ms each), and as many copies of one genesis as a POST /check body
  // holds once cost ~350 ms, charged to no budget.
  const floodBody = (nonce, k) => JSON.stringify({ username: carol.did, client_id: clientId(carol),
    password: canonicalize({ v: 'sigelo-relay/0', nonce, sig: 'z1', bundle: bundleOf(carol, { issuers: Array(k).fill(issuer.origin) }) }) });
  let k = 1000;
  while (floodBody('A'.repeat(43), k).length > MAX_BODY) k -= 10;
  const { challenge: fc } = await getChallenge(carol.did);
  const flooded = await postCheck(floodBody(fc.nonce, k));
  ok(flooded.status === 200 && flooded.json.check === 'bundle' && /issuers/.test(flooded.json.detail), `${k} copies of one issuer in a POST /check body: refused before verify (${flooded.json.check}: ${flooded.json.detail})`);
  await refused(carol, { bundle: bundleOf(carol, { issuers: Array(65).fill(issuer.origin) }) }, 'bundle', 'a CONNECT with 65 issuers (cap 64)');
  // A fork: two voluntary rotations from one node REJECT the chain (SPEC §7.3).
  const dave = identity('dave'), d1 = rotated(dave, 'dave 1'), d1b = rotated(dave, 'dave 1b');
  everyone.push(dave, d1, d1b);
  await refused(d1, { bundle: bundleOf(dave, { rotations: [d1.rotations[0], d1b.rotations[0]] }) }, 'bundle', 'a forked chain');
  // A key rotated away from cannot log in once the relay has seen the rotation.
  const frank = identity('frank'), f1 = rotated(frank, 'frank 1');
  everyone.push(frank, f1);
  const lf = await login(f1);
  ok(lf.client?.connected === true, 'frank logs in after a voluntary rotation (current DID f1)');
  await end(lf.client);
  await refused(frank, {}, 'bundle', 'frank\'s old key with a genesis-only bundle, after the relay saw his rotation');
  await refused(frank, { bundle: false }, 'bundle', 'frank\'s old DID without a bundle');
  // With a bundle too, no answer before the signature depends on the rotations kept. An outsider
  // sends a public genesis-only bundle and a junk signature for frank (his rotation kept here) and
  // for quinn (who rotated elsewhere: nothing kept), under the original DID and the current one.
  const quinn = identity('quinn'), q1 = rotated(quinn, 'quinn 1');
  everyone.push(quinn, q1);
  const junk = async (who, username) => {
    const { challenge } = await getChallenge(username);
    return (await postCheck({ username, client_id: clientId(who), password: canonicalize({ v: 'sigelo-relay/0', nonce: challenge.nonce, sig: 'z1', bundle: bundleOf(who) }) })).json;
  };
  const [fo, qo, fc1, qc1] = [await junk(frank, frank.did), await junk(quinn, quinn.did), await junk(frank, f1.did), await junk(quinn, q1.did)];
  ok(fo.check === 'sig' && qo.check === fo.check && qo.detail === fo.detail && fc1.check === 'bundle' && qc1.check === fc1.check && qc1.detail === fc1.detail,
    `genesis-only bundle, junk signature: frank (rotation kept) and quinn (none) read the same, as the original DID (${fo.check}, ${qo.check}) and the current one (${fc1.check}, ${qc1.check})`);
  // Recovery beats a thief (SPEC §7.1), as accept/node/sigelo-pair.mjs merges rotations.
  const gina = identity('gina'), thief = rotated(gina, 'gina thief'), back = rotated(gina, 'gina recovered', 'recovery', 1750000000);
  everyone.push(gina, thief, back);
  const lt = await login(thief);
  ok(lt.client?.connected === true, 'a thief\'s voluntary rotation logs in first (nothing offline can tell)');
  const lb = await login(back);
  ok(lb.client?.connected === true, 'the owner\'s recovery rotation, presented without the thief\'s, logs in: recovery wins after the merge');
  await closed(lt.client);
  ok(lt.client.connected === false, 'the owner\'s session took over the thief\'s (one client id per identity)');
  await end(lb.client);
  await refused(thief, {}, 'bundle', 'the thief again, after the relay saw the recovery');
  // A thief's long chain must not crowd the owner's recovery out of the merge: 64 voluntary
  // rotations from the stolen key (the cap, 36 KB), then the owner's genesis and one recovery.
  const kim = identity('kim'), kimBack = rotated(kim, 'kim recovered', 'recovery', 1750000000), thief64 = chained(kim, 'kim thief', 64);
  everyone.push(kim, thief64, kimBack);
  const lt64 = await login(thief64);
  ok(lt64.client?.connected === true, 'a thief\'s chain of 64 voluntary rotations from a stolen key logs in (64 items: the cap)');
  const lb64 = await login(kimBack);
  ok(lb64.client?.connected === true, 'then the owner\'s genesis plus one recovery logs in: the 64 rotations kept do not count against the cap on what was sent');
  ok(relay.db.chainOf(accountOf(kim.original), kim.original).length === 1, 'and the relay keeps only the chain followed: the recovery, none of the thief\'s 64');
  await closed(lt64.client);
  await end(lb64.client);
  await refused(thief64, {}, 'bundle', 'the 64-rotation thief again, after the recovery');
  // The same lockout with attestations: 4 thief rotations, then an owner bundle of 61 items.
  const lena = identity('lena'), lenaBack = rotated(lena, 'lena recovered', 'recovery', 1750000000), thief4 = chained(lena, 'lena thief', 4);
  everyone.push(lena, thief4, lenaBack);
  const lt4 = await login(thief4);
  const atts = Array.from({ length: 60 }, (_, i) => attest({ secret: issuer.secret, iss: issuer.did, sub: lenaBack.did, iat: now - 60, exp: now + DAY, ctx: 'relay.test', admission: 'open', claims: { i } }));
  const lb61 = await login(lenaBack, { bundle: bundleOf(lenaBack, { attestations: atts, issuers: [issuer.origin] }) });
  ok(lt4.client?.connected === true && lb61.client?.connected === true, 'after 4 thief rotations, an owner bundle of 61 items (60 attestations and a recovery) logs in');
  await closed(lt4.client);
  await end(lb61.client);
  // A thief holding opal's key before she ever logs in here puts a genesis of its own in front of
  // hers (a voluntary rotation into it, carrying her recovery commitment, which is public), then
  // rotates on to a key of its own. Opal takes her DID back with a recovery rotation from her
  // genesis, signed by the recovery key no thief of her key holds: from then on the thief's chain
  // is refused, with its bundle or without (its cached login is dropped). Her genesis alone takes
  // nothing back: else a key's genesis alone took it from the chain that holds it (below).
  const opal = identity('opal');
  const pstart = keygen({ seed: seed('opal thief start'), recovery: opal.origin.recovery, created: CREATED, nonce: seed('opal thief start nonce').slice(0, 16) });
  const into = rotate({ genesis: pstart.genesis, next_genesis: opal.origin, iat: now - 300, reason: 'voluntary', secret: pstart.secret });
  const t1 = rotated({ ...opal, original: pstart.did, origin: pstart.genesis, rotations: [into] }, 'opal thief 1');
  everyone.push(opal, t1, { did: pstart.did, original: pstart.did });
  const lp0 = await login(t1);
  ok(lp0.client?.connected === true, 'a chain of the thief\'s own in front of opal\'s genesis logs in first: nothing here says her genesis is anyone\'s yet');
  await end(lp0.client);
  const lpc = await login(t1, { bundle: false });
  ok(lpc.client?.connected === true, 'and again without a bundle (cached)');
  await end(lpc.client);
  const alone = await refused(opal, {}, 'bundle', 'opal from her genesis alone, which the thief\'s chain holds');
  ok(/recovery rotation/.test(alone.c.json.detail) && !alone.c.json.detail.includes('did:sigelo:'), `and the refusal names the remedy, and no DID (${alone.c.json.detail})`);
  const opalBack = rotated(opal, 'opal recovered', 'recovery', now - 60);
  everyone.push(opalBack);
  const lpo = await login(opalBack);
  ok(lpo.client?.connected === true, 'opal recovers from her genesis and logs in: the recovery takes her DID back from the thief\'s chain');
  if (lpo.client) await end(lpo.client);
  await refused(t1, {}, 'bundle', 'the thief\'s chain again, through opal\'s DID');
  await refused(t1, { bundle: false }, 'bundle', 'the thief without a bundle: its cached login went when opal took her DID back');
  // The audit's case: una's chain is una -> una 1 -> una 2, and she logs in. A thief holding the
  // key of una 1, which she rotated away from, logs in with its genesis alone as an original of
  // its own. Before, that took the row of una 1 from her account, and every later login of hers
  // was refused "bundle", a recovery from her head included.
  const una = identity('una'), u1 = rotated(una, 'una 1'), u2 = rotated(u1, 'una 2'), u3 = rotated(u2, 'una 3', 'recovery', now - 60);
  const u1Alone = { ...u1, original: u1.did, origin: u1.genesis, rotations: [] };
  everyone.push(una, u1, u2, u3);
  const lu = await login(u2);
  ok(lu.client?.connected === true, 'una logs in with her chain of two rotations');
  if (lu.client) await end(lu.client);
  await refused(u1Alone, {}, 'bundle', 'a thief with the key una rotated away from, its genesis alone: refused, that DID is in her chain here');
  const lu2 = await login(u2);
  if (lu2.client) await end(lu2.client);
  const lu3 = await login(u3);
  ok(lu2.client && lu3.client?.connected === true, 'una logs in as before, and after a recovery from her head');
  if (lu3.client) await end(lu3.client);
  // A thief that came first, through a genesis of its own put in front of the key of vera 1 it
  // holds: vera, logging in later, takes that key back with a recovery rotation from it.
  const vera = identity('vera'), v1 = rotated(vera, 'vera 1'), v2 = rotated(v1, 'vera 2'), v3 = rotated(v1, 'vera 3', 'recovery', now - 60);
  const vs = keygen({ seed: seed('vera thief start'), recovery: vera.origin.recovery, created: CREATED, nonce: seed('vera thief start nonce').slice(0, 16) });
  const intoV1 = rotate({ genesis: vs.genesis, next_genesis: v1.genesis, iat: now - 300, reason: 'voluntary', secret: vs.secret });
  const vt = rotated({ ...v1, original: vs.did, origin: vs.genesis, rotations: [intoV1] }, 'vera thief');
  everyone.push(vera, v1, v2, v3, vt, { did: vs.did, original: vs.did });
  const lvt = await login(vt);
  ok(lvt.client?.connected === true, 'a thief\'s chain through the key of vera 1 logs in first');
  if (lvt.client) await end(lvt.client);
  await refused(v2, {}, 'bundle', 'vera\'s own chain through that key, by her voluntary rotation from it');
  const lv3 = await login(v3);
  ok(lv3.client?.connected === true, 'vera\'s chain with a recovery rotation from that key logs in, and takes it back');
  if (lv3.client) await end(lv3.client);
  await refused(vt, {}, 'bundle', 'the thief\'s chain again');
}
{
  await refused(alice, { signer: bob, bundle: bundleOf(alice) }, 'sig', 'alice\'s bundle, bob\'s signature');
  const { challenge } = await getChallenge(alice.did);
  const elsewhere = canonicalize({ v: 'sigelo-relay/0', nonce: challenge.nonce, sig: sign(alice.secret, { ...challenge, relay: 'other.relay' }), bundle: bundleOf(alice) });
  const r = await mqttConnect({ username: alice.did, clientId: clientId(alice), password: elsewhere, clean: false });
  ok(!r.client && (await postCheck({ username: alice.did, client_id: clientId(alice), password: elsewhere })).json.check === 'sig', 'a signature over another relay\'s name: sig (no replay across relays)');
  // What a world gets from an agent's general challenge signer (sigelo-agent sign-challenge, the MCP
  // tool): a SPEC §5.2 challenge {v, typ: "challenge", did, ctx, nonce} signed for any ctx. A world
  // that passed this relay's nonce on as its own challenge, ctx = the relay host, holds exactly
  // that signature: it must not log in as the agent.
  const { challenge: c2 } = await getChallenge(alice.did);
  const oracle = canonicalize({ v: 'sigelo-relay/0', nonce: c2.nonce, sig: challengeSig({ secret: alice.secret, genesis: alice.genesis, ctx: 'relay.test', nonce: c2.nonce }).sig, bundle: bundleOf(alice) });
  const ro = await mqttConnect({ username: alice.did, clientId: clientId(alice), password: oracle, clean: false });
  const co = await postCheck({ username: alice.did, client_id: clientId(alice), password: oracle });
  ok(!ro.client && co.json.check === 'sig', `a SPEC §5.2 challenge signature over the relay's nonce, ctx = the relay host (what a world gets from sign-challenge): sig (${co.json.check})`);
  const wrongId = await refused(alice, { clientId: clientId(bob) }, 'client_id', 'bob\'s client id for alice');
  ok(wrongId.l.error?.code === 2, `client_id refusals carry CONNACK code 2, identifier rejected (${wrongId.l.error?.code})`);
  await refused(alice, { clean: true }, 'client_id', 'a clean session');
  await refused(alice, { extra: { pow: 5 } }, 'pow', 'a pow that is not a string');
  const powOk = await login(carol, { extra: { pow: 'c0ffee' } });
  ok(powOk.client?.connected === true, 'a pow string is accepted: the M4 hook accepts absence and only shape-checks presence');
  await end(powOk.client);
  disk = 0.75;
  await refused(hana, {}, 'relay_full', 'a new identity at 75 % disk');
  const known = await login(carol);
  ok(known.client?.connected === true, 'a known identity still logs in at 75 % disk (to drain its queue)');
  await end(known.client);
  disk = 0.10;
  // POST /check on credentials no CONNECT used runs the checks itself, spending the nonce.
  const { challenge: fresh } = await getChallenge(carol.did);
  const creds = { username: carol.did, client_id: clientId(carol), password: password(carol, fresh) };
  ok((await postCheck(creds)).json.ok === true, 'POST /check on fresh credentials: ok');
  const spent = await mqttConnect({ username: creds.username, clientId: creds.client_id, password: creds.password, clean: false });
  ok(!spent.client && (await postCheck(creds)).json.check === 'challenge_unknown', 'a CONNECT after that check: challenge_unknown (the check spent the nonce)');
  // rate: a relay that allows 2 logins, 2 POST /check and 2 challenges a minute per /24 or /48.
  // Challenges come from other networks (X-Real-IP) where only the CONNECTs are counted.
  const slow = await startRelay({ ...cfg, db: join(dir, 'rate.db'), loginRate: 2, log: () => {} });
  const r1 = await login(carol, { ip: '2001:db8:1::1' }, slow), r2 = await login(carol, { ip: '2001:db8:2::1' }, slow);
  ok(r1.client && r2.client, 'two logins a minute pass on a relay with RELAY_LOGIN_RATE=2');
  await refused(carol, { ip: '2001:db8:3::1' }, 'rate', 'the third CONNECT from 127.0.0.0/24 in that minute', slow);
  r1.client.end(true); r2.client.end(true);
  const ask = (ip) => fetch(`${base(slow)}/challenge?did=${encodeURIComponent(carol.did)}`, { headers: realIp(ip) }).then((x) => x.status);
  const asked = [await ask('2001:db8:9::1'), await ask('2001:db8:9::2'), await ask('2001:db8:9:ffff::3'), await ask('2001:db8:a::1')];
  ok(asked.join() === '200,200,429,200', `GET /challenge: two a minute per /48 by X-Real-IP, the third 429, another /48 unaffected (${asked.join()})`);
  const asked429 = await fetch(`${base(slow)}/challenge?did=${encodeURIComponent(carol.did)}`, { headers: realIp('2001:db8:9::4') });
  ok(asked429.status === 429 && asked429.headers.get('retry-after') === String(60 - (now % 60)), `GET /challenge 429: Retry-After = the seconds left in the minute (${asked429.headers.get('retry-after')}, want ${60 - (now % 60)})`);
  await asked429.body?.cancel();
  const freshCheck = async (challengeIp, ip) => {
    const { challenge } = await getChallenge(carol.did, slow, challengeIp);
    return (await postCheck({ username: carol.did, client_id: clientId(carol), password: password(carol, challenge) }, slow, ip)).json;
  };
  const checked = [await freshCheck('2001:db8:b::1', '192.0.2.7'), await freshCheck('2001:db8:c::1', '192.0.2.8'), await freshCheck('2001:db8:d::1', '192.0.2.9'), await freshCheck('2001:db8:e::1', '198.51.100.7')];
  ok(checked[0].ok && checked[1].ok && checked[2].check === 'rate' && checked[3].ok, `POST /check with fresh credentials: two a minute per /24 by X-Real-IP, the third refused rate, another /24 unaffected (${checked.map((x) => x.check ?? 'ok').join()})`);
  // The rate comes before the body is read: parsing 256 KB is work too.
  const early = await postCheck('{"username":', slow, '192.0.2.10'), fresh24 = await postCheck('{"username":', slow, '203.0.113.70');
  ok(early.status === 200 && early.json.check === 'rate' && fresh24.status === 400, `POST /check over the rate is refused before its body is parsed: broken JSON from that /24 gets rate, from another /24 400 (${early.status} ${early.json.check}, ${fresh24.status})`);
  await slow.close();
  // CONNECTs and POST /check share one count: one of each from 127.0.0.0/24, then a CONNECT is over.
  const shared = await startRelay({ ...cfg, db: join(dir, 'shared.db'), loginRate: 2, log: () => {} });
  const s1 = await login(carol, { ip: '2001:db8:21::1' }, shared);
  const { challenge: sc } = await getChallenge(carol.did, shared, '2001:db8:22::1');
  const s2 = await postCheck({ username: carol.did, client_id: clientId(carol), password: password(carol, sc) }, shared);
  ok(s1.client?.connected === true && s2.json.ok === true, 'RELAY_LOGIN_RATE=2: a CONNECT, then a POST /check on fresh credentials, from 127.0.0.0/24');
  await refused(carol, { ip: '2001:db8:23::1' }, 'rate', 'and the next CONNECT from that /24: the two shared one count', shared);
  s1.client?.end(true);
  await shared.close();
  // Sessions connected at once (all MQTT here comes from 127.0.0.0/24): 2 per network on one relay,
  // 2 in all on another. A login costs no work, so without caps held sessions grew until the
  // process ran out of memory and every client was dropped.
  {
    const capRelay = await startRelay({ ...cfg, db: join(dir, 'caps.db'), maxPerPrefix: 2, log: () => {} });
    const c1 = await login(alice, {}, capRelay), c2 = await login(bob, {}, capRelay);
    ok(c1.client?.connected && c2.client?.connected && capRelay.auth.sessions() === 2, 'two sessions from 127.0.0.0/24 on a relay holding 2 per network');
    const third = await refused(carol, {}, 'rate', 'a third session from that /24 while the two are connected', capRelay);
    ok(third.l.error?.code === 3 && /sessions from this network/.test(third.c.json.detail), `refused after its login checks pass, CONNACK 3 (${third.l.error?.code})`);
    // The caps come after the login, so a CONNECT with junk credentials reads the same whether its
    // client id (public: a hash of the original DID) is connected now or not. Before, the caps came
    // first and passed a live client id: CONNACK 4 said "online", 3 "not", an oracle on any DID.
    const probe = (cid) => mqttConnect({ username: 'x', clientId: cid, password: 'x', clean: false }, capRelay);
    const online = await probe(clientId(alice)), offline = await probe(clientId(identity('never here')));
    ok(online.error?.code === 4 && offline.error?.code === 4, `at the cap, junk credentials with alice's live client id and with one never seen: the same CONNACK (${online.error?.code}, ${offline.error?.code})`);
    const again = await login(alice, { bundle: false }, capRelay);
    await closed(c1.client);
    ok(again.client?.connected === true && c1.client.connected === false, 'alice reconnecting takes her own session over: no cap refuses that');
    await end(again.client);
    ok(await until(() => capRelay.auth.sessions() === 1), 'her socket closed: one session left');
    const c3 = await login(carol, {}, capRelay);
    ok(c3.client?.connected === true, 'and a new session from that /24 is taken');
    for (const c of [c2.client, c3.client]) await end(c);
    await capRelay.close();
    const allRelay = await startRelay({ ...cfg, db: join(dir, 'caps-all.db'), maxSessions: 2, log: () => {} });
    const d1 = await login(alice, {}, allRelay), d2 = await login(bob, {}, allRelay);
    const over = await refused(carol, {}, 'relay_full', 'a third session on a relay holding 2 in all', allRelay);
    ok(d1.client?.connected && d2.client?.connected && /holds 2 sessions/.test(over.c.json.detail), `the relay's own cap names itself (${over.c.json.detail})`);
    for (const c of [d1.client, d2.client]) await end(c);
    await allRelay.close();
  }
  // The budget of signature checks per network: 256 a minute; a bundle of 64 rotations costs 65.
  const v = await startRelay({ ...cfg, verifyBudget: undefined, db: join(dir, 'budget.db'), log: () => {} });
  const heavy = chained(identity('nina'), 'nina', 64);
  const viaCheck = async (ip) => {
    const { challenge } = await getChallenge(heavy.did, v, ip);
    return (await postCheck({ username: heavy.did, client_id: clientId(heavy), password: password(heavy, challenge) }, v, ip)).json;
  };
  const costly = [];
  for (let i = 0; i < 4; i++) costly.push(await viaCheck('198.51.100.20'));
  const otherNet = await viaCheck('203.0.113.20');
  ok(costly.slice(0, 3).every((x) => x.ok) && costly[3].check === 'rate' && otherNet.ok, `bundles of 64 rotations from one /24: three a minute, the fourth refused rate; another /24 still logs in (${[...costly, otherNet].map((x) => x.check ?? 'ok').join()})`);
  await v.close();
  const named = new Set(lines.filter((l) => l.startsWith('refused ')).map((l) => l.split(' ')[2]));
  ok(CHECKS.filter((c) => c !== 'rate').every((c) => named.has(c)), `every login check was hit and logged by name: ${[...named].sort().join(' ')}`);
}

// ================================================================ what M4's hooks see and set
{
  // A relay with every hook, on its own clock, recording what its login hook is shown.
  let pnow = now;
  const shown = [];
  const bobAccount = accountOf(bob.original), carolAccount = accountOf(carol.original);
  const p = await startRelay({ ...cfg, db: join(dir, 'policy.db'), clock: () => pnow, log: () => {}, policy: {
    login: (ctx) => { shown.push(ctx.result); return null; },
    pow: ({ pow }) => (pow === undefined || pow === 42 ? null : 'want 42'),
    maxMessage: ({ reader }) => (reader === bobAccount ? 1024 * 1024 : undefined),
    retention: (account) => (account === bobAccount ? 30 * DAY : undefined),
    rate: ({ kind, account }) => (kind === 'publish' && account === carolAccount ? { code: 'rate', detail: 'carol publishes too fast' } : null),
  } });
  // Only what the relay uses is verified: the chain and up to 4 operator attestations for this relay.
  const op = (relayName, i) => attest({ secret: issuer.secret, iss: issuer.did, sub: hana.did, iat: pnow - 60, exp: pnow + DAY, ctx: OPERATOR_CTX, admission: 'invite', admission_by: issuer.did, claims: { relay: relayName, i } });
  const others = Array.from({ length: 20 }, (_, i) => attest({ secret: issuer.secret, iss: issuer.did, sub: hana.did, iat: pnow - 60, exp: pnow + DAY, ctx: 'relay.test', admission: 'open', claims: { i } }));
  const ops = [op('other.relay', 0), ...Array.from({ length: MAX_OPERATOR + 2 }, (_, i) => op('relay.test', i + 1))];
  const binds = Array.from({ length: 30 }, () => bind({ secret: hana.secret, id: hana.did, method: 'ed25519-test', addr: issuer.genesis.key, iat: pnow - 60, exp: pnow + DAY, addr_secret: issuer.secret }));
  const lh = await login(hana, { bundle: bundleOf(hana, { attestations: [...others, ...ops], bindings: binds, issuers: [issuer.origin] }) }, p);
  const r = shown.at(-1);
  const kept = r?.attestations[issuer.did] ?? [];
  ok(lh.client?.connected === true && r.bindings.length === 0 && r.rejected.bindings === 0 && r.rejected.attestations === 0
    && kept.length === MAX_OPERATOR && kept.every((x) => x.ctx === OPERATOR_CTX && x.claims.relay === 'relay.test'),
    `a bundle of 57 items (30 bindings, 20 other attestations, 7 operator ones): verify sees the chain and the first ${MAX_OPERATOR} operator attestations for this relay, nothing else (${kept.length} kept)`);
  lh.client?.end(true);
  // Issuers likewise: verify() is given only those a kept operator attestation names. 64 issuers:
  // 62 copies of an unused one, one that would REJECT any bundle verify() is given (an unknown
  // field), and last the operator attestation's issuer.
  const unusedIss = identity('unused issuer').origin;
  const withIssuers = bundleOf(hana, { attestations: [op('relay.test', 9)], issuers: [...Array(62).fill(unusedIss), { ...unusedIss, extra: 1 }, issuer.origin] });
  let fatal = '';
  try { verify(withIssuers, pnow); } catch (e) { fatal = e.message; }
  const li = await login(hana, { bundle: withIssuers }, p);
  const ri = shown.at(-1);
  ok(/unknown field/.test(fatal) && li.client?.connected === true && ri.attestations[issuer.did]?.length === 1 && ri.rejected.attestations === 0,
    `64 issuers, one that verify() REJECTs (${fatal}): logs in, the named issuer reaches verify (its operator attestation kept), the unused ones do not`);
  li.client?.end(true);
  // policy.pow decides the value and its shape (an integer here), not the relay.
  const pw42 = await login(bob, { extra: { pow: 42 } }, p);
  ok(pw42.client?.connected === true, 'with policy.pow, an integer pow reaches the hook and is accepted');
  await refused(bob, { extra: { pow: 'c0ffee' } }, 'pow', 'with policy.pow, a pow the hook refuses', p);
  // policy.maxMessage: bob reads messages up to 1 MB; others keep 256 KB.
  const pb = pw42.client, B = topic();
  await subscribe(pb, B);
  const pc = (await login(carol, {}, p)).client, pa = (await login(alice, {}, p)).client;
  const big = payload(300 * 1024);
  await publish(pa, B, big);
  ok(await until(() => messages(pb, B).some((m) => m.p.equals(big))), 'policy.maxMessage: a 300 KB message to a reader allowed 1 MB is delivered');
  // policy.rate: every publish asks it first.
  await publish(pc, B, randomBytes(10));
  ok(await until(() => notices(pc).some((x) => x.code === 'rate')), 'policy.rate: a publish it refuses gets {code: "rate"} and is not stored');
  // policy.retention lengthens the idle sweep: 30 days + 7 for bob, 14 days for alice.
  const Aidle = topic();
  await subscribe(pa, Aidle);
  for (const c of [pa, pb, pc]) await end(c);
  pnow += 15 * DAY;
  p.sweep();
  const left = (t) => p.db.raw.prepare('SELECT count(*) AS n FROM claims WHERE topic = ?').get(t).n;
  ok(left(B) === 1 && left(Aidle) === 0, 'policy.retention: after 15 idle days alice\'s mailbox is gone, bob\'s (30-day retention) stays');
  pnow += 23 * DAY;
  p.sweep();
  ok(left(B) === 0, 'and bob\'s goes after 30 + 7 idle days');
  // A kept chain that does not open (an altered file) fails the login as the relay's own error,
  // never as "no rotation kept": CONNACK 3, POST /check 503.
  const olgaP = rotated(identity('olga p'), 'olga p 1');
  everyone.push(olgaP);
  (await login(olgaP, {}, p)).client?.end(true);
  p.db.raw.prepare('UPDATE accounts SET chain = ? WHERE account = ?').run(Buffer.alloc(60), accountOf(olgaP.original));
  const broken = await login(olgaP, {}, p);
  const bc = await postCheck(asCheck(broken.creds), p);
  ok(!broken.client && broken.error?.code === 3 && bc.status === 503, `a kept chain that does not open: CONNACK 3 and POST /check 503 (${broken.error?.code}, ${bc.status})`);
  await p.close();
}

// ================================================================ mailboxes
const A = topic();
{
  ok(await subscribe(a, A) === 1, 'alice subscribes to a fresh m/ topic: granted QoS 1 (claimed)');
  const claim = rows('SELECT * FROM claims WHERE topic = ?', A)[0];
  ok(claim?.account === accountOf(alice.original) && claim.client_id === clientId(alice) && claim.expires === null, 'the claim names alice\'s account (a hash of her original DID) and client id');
  // The refusal's notice comes before the SUBACK on the wire: a client keeps one request in
  // flight and reads a notice that arrives before its acknowledgement as that request's refusal.
  // Written after it (as Aedes does a QoS 0 publish, in a setImmediate), it was counted against
  // the client's next request whenever the two reached it in separate reads.
  const wire = await wireOf(b, async () => { ok(await subscribe(b, A) === 128, 'bob subscribes to alice\'s topic: refused (granted 128)'); });
  ok(await until(() => notices(b).some((x) => x.code === 'mailbox_taken')), 'bob gets a $sigelo/notice {code: "mailbox_taken"}');
  ok(wire === 'notice:mailbox_taken,suback', `the notice is on the wire before the SUBACK (${wire})`);
  const p = payload(1000);
  ok(await publish(b, A, p) === null, 'bob publishes to alice\'s mailbox: acknowledged');
  ok(await until(() => messages(a, A).length === 1) && messages(a, A)[0].p.equals(p), 'alice receives the payload byte for byte');
  ok(await until(() => count('SELECT count(*) AS n FROM messages') === 0), 'acknowledged by alice: deleted from the queue');
  ok(await subscribe(a, 'm/#') === 128 && await subscribe(a, 'x/' + '0'.repeat(32)) === 128 && await subscribe(a, 'm/' + 'A'.repeat(32)) === 128, 'wildcards, other prefixes and upper-case hex: refused');
  ok(await subscribe(a, topic(), 0) === 128, 'a QoS 0 subscription to a mailbox: refused (it would never acknowledge)');
  ok(await subscribe(a, '$sigelo/notice') === 1, '$sigelo/notice: granted');
  // No new claim on a disk 70 % full: a claim is a row that lives for weeks. Those held still work.
  disk = 0.75;
  const k = notices(a).length;
  ok(await subscribe(a, topic()) === 128 && await until(() => notices(a).slice(k).some((x) => x.code === 'relay_full')), 'at 75 % disk a new claim is refused with {code: "relay_full"}');
  ok(await subscribe(a, A) === 1, 'and alice\'s own mailbox still subscribes');
  disk = 0.10;
}
{
  // One SUBSCRIBE carries at most 128 topics (each is a transaction); a restored session costs
  // reads and one statement, not a write per claim.
  const mira = identity('mira');
  everyone.push(mira);
  const subscribeAll = (c, ts) => new Promise((resolve) => c.subscribe(ts, { qos: 1 }, (e, g) => resolve(e ? null : g.map((x) => x.qos))));
  const m1 = (await login(mira)).client;
  m1.subscribe(Array.from({ length: 129 }, () => topic()), { qos: 1 });
  ok(await until(() => !m1.connected), 'a SUBSCRIBE of 129 topics: connection closed before the parser reads it');
  m1.end(true);
  ok(count('SELECT count(*) AS n FROM claims WHERE client_id = ?', clientId(mira)) === 0, 'and none of its topics is claimed');
  const m2 = (await login(mira, { bundle: false })).client;
  const ts = Array.from({ length: 128 }, () => topic());
  const granted = await subscribeAll(m2, ts);
  ok(granted?.length === 128 && granted.every((q) => q === 1), 'a SUBSCRIBE of 128 topics: all granted');
  await end(m2);
  now += 60;
  // A claim keeps the day of its last use: dated a day back, as if mira had been away since.
  relay.db.raw.prepare('UPDATE claims SET last_used = last_used - ? WHERE client_id = ?').run(DAY, clientId(mira));
  const { tx: realTx, touchClaim: realTouch } = relay.db;
  let txs = 0, touches = 0;
  relay.db.tx = (fn) => { txs++; return realTx(fn); };
  relay.db.touchClaim = (...args) => { touches++; return realTouch(...args); };
  const m3 = (await login(mira, { bundle: false })).client;
  await sleep(100);
  const stamped = () => count('SELECT count(*) AS n FROM claims WHERE client_id = ? AND last_used = ?', clientId(mira), Math.floor(now / DAY) * DAY);
  const before = stamped();
  Object.assign(relay.db, { tx: realTx, touchClaim: realTouch });
  relay.sweep();
  ok(m3?.connected === true && before === 0 && txs <= 1 && touches === 0 && stamped() === 128,
    `mira reconnects with 128 claims: nothing written for them then (${before} stamped: the day of use waits in memory), ${txs} transaction (the login's), ${touches} touches per claim; the sweep stamps all 128 at once (${stamped()})`);
  const p = payload(50);
  await publish(b, ts[77], p);
  ok(await until(() => messages(m3, ts[77]).some((x) => x.p.equals(p))), 'and the restored subscriptions deliver without a new SUBSCRIBE');
  await until(() => count('SELECT count(*) AS n FROM messages') === 0);
  await end(m3);
}
{
  // The offline queue: alice away, three messages, then her persistent session delivers them in order.
  await end(a);
  const ps = [payload(10), payload(2000), payload(70000)];
  for (const p of ps) await publish(b, A, p);
  ok(count('SELECT count(*) AS n FROM messages WHERE topic = ?', A) === 3, 'alice offline: three messages queued');
  const ca = relay.db.counters(accountOf(alice.original), now), cb = relay.db.counters(accountOf(bob.original), now);
  ok(ca.bytes_queued === 72010 && ca.mailboxes === 1, `bytes queued are charged to the reader (${ca.bytes_queued} bytes, ${ca.mailboxes} mailbox)`);
  ok(cb.msgs_today === 5 && cb.bytes_queued === 0, `messages today are charged to the sender: bob sent 5 (${cb.msgs_today})`);
  a = (await login(alice, { bundle: false })).client;
  ok(await until(() => messages(a, A).length === 3), 'alice back: the session is restored and the three are delivered without a new SUBSCRIBE');
  ok(messages(a, A).every((m, i) => m.p.equals(ps[i])), 'in the order they arrived, byte for byte');
  ok(await until(() => count('SELECT count(*) AS n FROM messages') === 0) && relay.db.counters(accountOf(alice.original), now).bytes_queued === 0, 'all acknowledged: the queue and alice\'s bytes queued are back to 0');
}
{
  // A message published while the reader's queue goes out comes after the queue, not into it. Aedes
  // restores the subscriptions before it streams the queue and forwards a live publish at once: one
  // sent at the reader's first delivery arrived 5th of 301, and a contact's envelope more than 64
  // behind the one opened fails out_of_order (contact/envelope.mjs WINDOW), so 296 were lost.
  await end(a);
  const queuedPs = Array.from({ length: 300 }, (_, i) => Buffer.concat([Buffer.from(`q${String(i).padStart(3, '0')}`), randomBytes(1996)]));
  for (const p of queuedPs) { sent.push(p); await publish(b, A, p); }
  const livePs = [payload(2000), payload(2000)];
  let triggered = false;
  a = (await login(alice, { bundle: false })).client;
  const arrive = () => messages(a, A).length;
  a.on('message', () => { if (!triggered) { triggered = true; for (const p of livePs) b.publish(A, p, { qos: 1 }); } });
  ok(await until(() => arrive() === 302, 8000), `the 300 queued and the 2 sent at the first delivery all arrive (${arrive()})`);
  const got = messages(a, A).map((m) => m.p);
  ok(got.slice(0, 300).every((p, i) => p.equals(queuedPs[i])) && got[300].equals(livePs[0]) && got[301].equals(livePs[1]),
    `in the order stored: the queue first, then the two live ones (live at ${got.findIndex((p) => p.equals(livePs[0]))} and ${got.findIndex((p) => p.equals(livePs[1]))})`);
  await sleep(200);
  ok(arrive() === 302 && await until(() => count('SELECT count(*) AS n FROM messages WHERE topic = ?', A) === 0), 'each once, and all acknowledged');
  const late = payload(100);
  await publish(b, A, late);
  ok(await until(() => arrive() === 303) && messages(a, A)[302].p.equals(late), 'once the queue is out, a publish is forwarded at once');
  await until(() => count('SELECT count(*) AS n FROM messages') === 0);
}
{
  // Deleted only when acknowledged: a delivery without PUBACK stays queued and comes again.
  await end(a);
  const p = payload(500);
  await publish(b, A, p);
  const held = (await login(alice, { bundle: false })).client;
  held.handleMessage = () => {};   // never acknowledges
  ok(await until(() => messages(held, A).length === 1), 'alice receives a message and withholds the PUBACK');
  ok(count('SELECT count(*) AS n FROM messages WHERE topic = ? AND message_id IS NOT NULL', A) === 1, 'the message stays queued, marked in flight');
  held.end(true);
  await sleep(100);
  a = (await login(alice, { bundle: false })).client;
  ok(await until(() => messages(a, A).length === 1) && messages(a, A)[0].p.equals(p), 'after a reconnect it is delivered again');
  ok(await until(() => count('SELECT count(*) AS n FROM messages') === 0), 'and deleted once acknowledged');
  // Deleted means gone: secure_delete overwrites the row in the file, and the sweep truncates the
  // WAL, which still held the page images with the payload.
  const marked = payload(3000), mark = marked.subarray(1000, 1064);
  await publish(b, A, marked);
  await until(() => messages(a, A).some((m) => m.p.equals(marked)));
  await until(() => count('SELECT count(*) AS n FROM messages') === 0);
  const inWal = () => existsSync(`${cfg.db}-wal`) && readFileSync(`${cfg.db}-wal`).includes(mark);
  const before = inWal();
  relay.sweep();
  ok(before && !inWal() && !readFileSync(cfg.db).includes(mark), 'an acknowledged message, still in the WAL, is gone from it and from the database file after the sweep');
}
{
  // Retention: a message nobody acknowledges goes at 7 days, to the start of that UTC day (the
  // database keeps no time finer than a day): kept at most 7 days, as privacy.md says.
  await end(a);
  const sentAt = now, gone = Math.floor((sentAt + 7 * DAY) / DAY) * DAY;
  await publish(b, A, payload(100));
  ok(gone - sentAt <= 7 * DAY && gone - sentAt > 6 * DAY && rows('SELECT expires FROM messages')[0]?.expires === gone, 'a queued message expires at the start of the UTC day 7 days on: at most 7 days');
  now = gone - 1;
  ok(relay.sweep().expired === 0, 'it survives until a second before');
  now = gone;
  ok(relay.sweep().expired === 1 && count('SELECT count(*) AS n FROM messages') === 0, 'then it is deleted (the retention limit)');
  a = (await login(alice, { bundle: false })).client;
  await sleep(300);
  ok(messages(a, A).length === 0, 'alice back after expiry: nothing is delivered');
}
{
  // too_large: acknowledged, dropped, a notice; the connection stays.
  const big = randomBytes(256 * 1024 + 1);
  ok(await publish(b, A, big) === null, 'a message of 256 KB + 1 byte: acknowledged (so the client does not retransmit it)');
  ok(await until(() => notices(b).some((x) => x.code === 'too_large')), 'the sender gets a $sigelo/notice {code: "too_large"}');
  await sleep(200);
  ok(messages(a, A).length === 0 && count('SELECT count(*) AS n FROM messages') === 0 && b.connected, 'nothing stored or delivered, and the sender is still connected');
  const max = payload(256 * 1024);
  await publish(b, A, max);
  ok(await until(() => messages(a, A).length === 1) && messages(a, A)[0].p.equals(max), 'a message of exactly 256 KB is delivered');
  // relay_full: nothing is queued at 70 % disk.
  disk = 0.70;
  await publish(b, A, randomBytes(10));
  ok(await until(() => notices(b).some((x) => x.code === 'relay_full')), 'at 70 % disk a publish gets {code: "relay_full"}');
  await sleep(100);
  ok(messages(a, A).length === 1, 'and is not delivered');
  disk = 0.10;
  // A topic nobody claimed: dropped like any publish without a subscriber, and the writer is told
  // (no_reader). Silent, it cost the writer the rest of an epoch whose first envelope this was.
  const before = notices(b).length;
  let mid;
  const wire = await wireOf(b, () => new Promise((resolve) => b.publish(topic(), payload(10), { qos: 1 }, (e, p) => { mid = e ? null : p?.messageId; resolve(); })));
  ok(Number.isInteger(mid), 'a publish to an unclaimed m/ topic: acknowledged');
  ok(await until(() => notices(b).slice(before).some((x) => x.code === 'no_reader')), 'and the writer gets {code: "no_reader"}');
  ok(wire === 'notice:no_reader,puback' && notices(b).slice(before).find((x) => x.code === 'no_reader').id === mid,
    `the notice is on the wire before the PUBACK, and names the PUBLISH's packet id (${wire}; id ${notices(b).slice(before).find((x) => x.code === 'no_reader')?.id}, packet ${mid})`);
  ok(count('SELECT count(*) AS n FROM messages') === 0, 'nothing is stored');
}
{
  // Publishes no correct client sends close the connection.
  const tries = [['x/' + '0'.repeat(32), {}, 'another topic prefix'], ['$sigelo/notice', {}, '$sigelo/notice'], [A, { qos: 0 }, 'QoS 0'], [A, { qos: 2 }, 'QoS 2']];
  for (const [t, o, what] of tries) {
    const c = (await login(bob, { bundle: false })).client;
    c.publish(t, Buffer.from('x'), { qos: 1, ...o });
    ok(await until(() => !c.connected), `a publish with ${what}: connection closed`);
    c.end(true);
  }
  b = (await login(bob, { bundle: false })).client;
  // The size caps sit before the MQTT parser: 1 MB + header after login, 256 KB for the CONNECT.
  const c = (await login(carol, { bundle: false })).client;
  c.publish(A, randomBytes(1100 * 1024), { qos: 1 });
  ok(await until(() => !c.connected), 'a 1.1 MB publish: connection closed before the parser buffers it');
  c.end(true);
  const raw = tcpConnect(relay.ports.tcp, '127.0.0.1');
  const gone = new Promise((resolve) => raw.on('close', () => resolve(true)));
  raw.on('error', () => {});
  const len = 300 * 1024;
  raw.write(Buffer.from([0x10, (len & 127) | 128, ((len >> 7) & 127) | 128, len >> 14]));
  ok(await Promise.race([gone, sleep(2000).then(() => false)]), 'a CONNECT announcing 300 KB: closed before login');
}
{
  // Unsubscribe gives the mailbox up, with what is queued in it.
  const C = topic();
  await subscribe(a, C);
  await end(a);
  await publish(b, C, payload(300));
  const held = (await login(alice, { bundle: false })).client;
  held.handleMessage = () => {};
  await until(() => messages(held, C).length === 1);
  // Not awaited: MQTT.js handles no further packet (the UNSUBACK) while a message is unacknowledged.
  held.unsubscribe(C);
  ok(await until(() => rows('SELECT * FROM claims WHERE topic = ?', C).length === 0) && count('SELECT count(*) AS n FROM messages WHERE topic = ?', C) === 0, 'UNSUBSCRIBE: the claim and its queued message are gone');
  held.end(true);
  await sleep(100);
  a = (await login(alice, { bundle: false })).client;
  const cc = (await login(carol, { bundle: false })).client;
  ok(await subscribe(cc, C) === 1, 'a released topic can be claimed again');
  await end(cc);
  // A second session with alice's client id takes over the first.
  const second = (await login(alice, { bundle: false })).client;
  await closed(a);
  ok(a.connected === false && second.connected === true, 'a second login with the same client id takes the session over');
  a = second;
}

// ================================================================ invite topics
const X = topic('i'), Y = topic('i');
{
  ok(await subscribe(a, X) === 1 && await subscribe(a, Y) === 1, 'alice claims two invite topics');
  const claim = rows('SELECT * FROM claims WHERE topic = ?', X)[0];
  ok(claim.expires === Math.ceil((now + 7 * DAY) / DAY) * DAY, 'an invite claim lives 7 days, to the end of that UTC day');
  await end(a);
  for (let i = 0; i < 4; i++) await publish(b, X, payload(1000));
  await publish(b, X, randomBytes(1000));
  ok(await until(() => notices(b).some((x) => x.code === 'quota_storage' && /4 messages/.test(x.detail))), 'a fifth message on an invite topic: {code: "quota_storage"}');
  ok(count('SELECT count(*) AS n FROM messages WHERE topic = ?', X) === 4, 'four are queued');
  await publish(b, Y, payload(40 * 1024));
  const k = notices(b).length;
  await publish(b, Y, randomBytes(30 * 1024));
  ok(await until(() => notices(b).length > k) && count('SELECT count(*) AS n FROM messages WHERE topic = ?', Y) === 1, '40 KB then 30 KB on an invite topic: the second exceeds 64 KB and is refused');
  a = (await login(alice, { bundle: false })).client;
  ok(await until(() => rows('SELECT dead FROM claims WHERE topic = ?', X)[0]?.dead === 1), 'alice reads the invite topic: it dies at the first answer she acknowledges');
  ok(count('SELECT count(*) AS n FROM messages WHERE topic = ?', X) === 0, 'what else was queued on it is deleted');
  await publish(b, X, payload(100));
  await sleep(100);
  ok(count('SELECT count(*) AS n FROM messages WHERE topic = ?', X) === 0, 'a later answer to the dead topic is not stored');
  ok(await subscribe(b, X) === 128 && await subscribe(a, X) === 128, 'nobody can subscribe to a dead invite topic, its reader included');
  ok(await until(() => notices(a).some((x) => x.code === 'mailbox_taken' && /used up/.test(x.detail))), 'its reader is told it is used up');
  const Z = topic('i'), claimedAt = now;
  await subscribe(a, Z);
  const zEnd = rows('SELECT expires FROM claims WHERE topic = ?', Z)[0].expires;
  now = zEnd - 1;
  const s0 = relay.sweep();
  ok(zEnd - claimedAt >= 7 * DAY && zEnd - claimedAt < 8 * DAY && rows('SELECT * FROM claims WHERE topic = ?', Z).length === 1, 'an invite topic stays at least 7 days after its claim, to the end of that UTC day');
  now = zEnd;
  const s = relay.sweep();
  ok(s0.invites + s.invites >= 1 && rows('SELECT * FROM claims WHERE topic = ?', Z).length === 0, `and goes then (${s0.invites + s.invites} invites swept)`);
}

// ================================================================ a reader that stops reading holds up no one else
{
  // Sam subscribes, then his client stops reading its socket while tess writes him 100 messages of
  // 128 KB and 150 small ones, not waiting for her acknowledgements (each waits for its delivery).
  // Before, each delivery to sam held one of the broker's 100 publishes in flight until a 60 s
  // drain timeout: vic's message to uma waited behind them.
  const sam = identity('sam'), tess = identity('tess'), uma = identity('uma'), vic = identity('vic');
  everyone.push(sam, tess, uma, vic);
  const S = topic(), U = topic();
  const rs = (await login(sam)).client, wt = (await login(tess)).client, ru = (await login(uma)).client, wv = (await login(vic)).client;
  ok(await subscribe(rs, S) === 1 && await subscribe(ru, U) === 1, 'sam and uma claim a mailbox each');
  rs.stream.unpipe();
  rs.stream.pause();
  const big = randomBytes(128 * 1024);
  for (let i = 0; i < 100; i++) wt.publish(S, big, { qos: 1 });
  for (let i = 0; i < 150; i++) wt.publish(S, randomBytes(300), { qos: 1 });
  ok(await until(() => lines.some((l) => /^error \S+ slow_reader$/.test(l)), 15000), 'sam, past 1 MB written to him and not taken, is closed (logged "slow_reader")');
  const live = randomBytes(64), t0 = Date.now();
  await publish(wv, U, live);
  ok(await until(() => messages(ru, U).some((m) => m.p.equals(live)), 2000), `vic's message reaches uma at once all the same (${Date.now() - t0} ms)`);
  ok(await until(() => count('SELECT count(*) AS n FROM messages WHERE topic = ?', S) === 250, 10000),
    `nothing sam did not acknowledge is deleted: all 250 wait for his next connection (${count('SELECT count(*) AS n FROM messages WHERE topic = ?', S)})`);
  rs.end(true);
  const back = (await login(sam, { bundle: false })).client;
  await new Promise((r) => back.unsubscribe(S, r));
  ok(await until(() => count('SELECT count(*) AS n FROM messages WHERE topic = ?', S) === 0), 'sam gives the mailbox up: what was queued goes with it');
  for (const c of [back, wt, ru, wv]) await end(c);
}

// ================================================================ idle mailboxes, accounts, restart
{
  const D = topic();
  const cc = (await login(carol, { bundle: false })).client;
  await subscribe(cc, D);
  await end(cc);
  const iv = (await login(ivan)).client;
  await end(iv);
  now += 14 * DAY;
  relay.sweep();
  ok(rows('SELECT * FROM claims WHERE topic = ?', D).length === 1, 'an idle mailbox stays 14 days after its last use: its stamp is that day\'s start, so the day counts in full');
  now += DAY;
  const s = relay.sweep();
  ok(rows('SELECT * FROM claims WHERE topic = ?', D).length === 0, `an idle mailbox goes after retention + 7 days (${s.idle} idle)`);
  ok(rows('SELECT * FROM claims WHERE topic = ?', A).length === 1, 'alice\'s mailbox stays: she is connected');
  now += 16 * DAY;
  relay.sweep();
  ok(!relay.db.account(accountOf(ivan.original)), 'an account without claims goes 30 days after its last login');
  ok(!!relay.db.account(accountOf(alice.original)), 'alice\'s account stays: she holds a claim');
}
{
  // A restart: claims, queue and the rotations seen are in the file, the DID cache is not.
  const E = topic();
  await subscribe(a, E);
  await end(a);
  const kept = [payload(64), payload(4096), payload(333)];
  for (const p of kept) await publish(b, E, p);
  // Olga rotated and logged in; then three messages are queued for her.
  const olga = identity('olga'), o1 = rotated(olga, 'olga 1'), oThief = rotated(olga, 'olga thief');
  everyone.push(olga, o1, oThief);
  const lo = (await login(o1)).client, O = topic();
  await subscribe(lo, O);
  await end(lo);
  const forOlga = [payload(100), payload(200), payload(300)];
  for (const p of forOlga) await publish(b, O, p);
  const stale = await getChallenge(alice.did);
  await relay.close();
  relay = await startRelay(cfg);
  await refused(alice, { bundle: false }, 'bundle', 'after a restart, a login without a bundle (the DID cache is memory only)');
  const st = await mqttConnect({ username: alice.did, clientId: clientId(alice), password: password(alice, stale.challenge), clean: false });
  ok(!st.client && (await postCheck({ username: alice.did, client_id: clientId(alice), password: password(alice, stale.challenge) })).json.check === 'challenge_unknown', 'a challenge issued before the restart: challenge_unknown (its key is gone with the process)');
  await refused(olga, {}, 'bundle', 'after a restart, olga\'s old key with a genesis-only bundle: the relay kept her rotation');
  await refused(oThief, {}, 'bundle', 'after a restart, a thief\'s own rotation from olga\'s old key: a fork with the rotation kept');
  const lo1 = (await login(o1)).client;
  ok(lo1?.connected === true && await until(() => messages(lo1, O).length === 3) && messages(lo1, O).every((m, i) => m.p.equals(forOlga[i])), 'olga at her current key logs in and gets the three messages queued before the restart');
  await end(lo1);
  a = (await login(alice)).client;
  ok(await until(() => messages(a, E).length === 3) && messages(a, E).every((m, i) => m.p.equals(kept[i])), 'after a restart alice\'s session and queue are intact: the three messages arrive in order');
  await until(() => count('SELECT count(*) AS n FROM messages') === 0);
  b = (await login(bob)).client;
}

// ================================================================ GET /stats: counts, no identifier
// stats.mjs: whole numbers of the relay as a whole; never a DID, account, client id, topic or
// address. The shape is pinned key by key, so a field added later is a decision, not a leak.
const STATS_KEYS = 'at,day,days,free_queue_used_pct,gifts,identities,logins_refused_today,logins_today,mailboxes_claimed,messages,pow_solved_today,pro_licences_active,sessions,v';
const DAY_KEYS = 'day,delivered,identities,login_refused,logins,new_identities,pow_solved,refused,sessions_peak,stored';
const whole = (v) => Number.isSafeInteger(v) && v >= 0;
const named = (o) => o !== null && typeof o === 'object' && !Array.isArray(o) && Object.entries(o).every(([k, v]) => /^[a-z][a-z_]{0,31}$/.test(k) && whole(v) && v > 0);
const statsShape = (s) => {
  const why = [];
  if (Object.keys(s).sort().join() !== STATS_KEYS) why.push(`keys ${Object.keys(s).sort().join()}`);
  if (s.v !== 'sigelo-relay-stats/0' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(s.at) || !/^\d{4}-\d\d-\d\d$/.test(s.day)) why.push('v, at or day');
  if (Object.keys(s.identities ?? {}).sort().join() !== 'new_today,total' || !Object.values(s.identities).every(whole)) why.push('identities');
  if (Object.keys(s.sessions ?? {}).sort().join() !== 'now,peak_today' || !Object.values(s.sessions).every(whole)) why.push('sessions');
  if (Object.keys(s.messages ?? {}).sort().join() !== 'delivered_today,queued,refused_today,stored_today' || ![s.messages.queued, s.messages.stored_today, s.messages.delivered_today].every(whole) || !named(s.messages.refused_today)) why.push('messages');
  if (![s.logins_today, s.mailboxes_claimed, s.pow_solved_today, s.pro_licences_active].every(whole) || !named(s.logins_refused_today)) why.push('counts');
  // gifts: codes loaded and used over all campaigns, totals only (no campaign label); 0s without M4.
  if (Object.keys(s.gifts ?? {}).sort().join() !== 'issued,redeemed' || !whole(s.gifts.issued) || !whole(s.gifts.redeemed) || s.gifts.redeemed > s.gifts.issued) why.push('gifts');
  if (!(s.free_queue_used_pct === null || (typeof s.free_queue_used_pct === 'number' && s.free_queue_used_pct >= 0))) why.push('free_queue_used_pct');
  if (!Array.isArray(s.days) || s.days.length < 1 || s.days.length > 30 || s.days.some((d) => Object.keys(d).sort().join() !== DAY_KEYS || !/^\d{4}-\d\d-\d\d$/.test(d.day) || !Object.entries(d).every(([k, v]) => k === 'day' || whole(v)))
    || s.days.at(-1).day !== s.day) why.push('days');
  return why;
};
const getStats = async (r = relay) => { const res = await fetch(`${base(r)}/stats`); return { status: res.status, type: res.headers.get('content-type'), text: await res.text() }; };
{
  const got = await getStats(), s = JSON.parse(got.text), why = statsShape(s);
  ok(got.status === 200 && got.type === 'application/json' && why.length === 0, `GET /stats: 200, JSON, exactly the counts of stats.mjs, whole numbers${why.length ? ` (wrong: ${why.join(', ')})` : ''}`);
  ok(s.identities.total === count('SELECT count(*) AS n FROM accounts') && s.mailboxes_claimed === count('SELECT count(*) AS n FROM claims WHERE dead = 0 AND expires IS NULL')
    && s.messages.queued === count('SELECT count(*) AS n FROM messages') && s.sessions.now === relay.auth.sessions(),
  `GET /stats: identities, mailboxes, messages queued and sessions as the tables and auth.mjs hold them (${s.identities.total}, ${s.mailboxes_claimed}, ${s.messages.queued}, ${s.sessions.now})`);
  ok(s.logins_today > 0 && s.messages.delivered_today > 0 && s.sessions.peak_today >= s.sessions.now && Object.keys(s.logins_refused_today).every((c) => [...CHECKS, 'internal'].includes(c)),
  `GET /stats: today's logins and deliveries counted, refusals by the check's name (${s.logins_today} logins, ${s.messages.stored_today} stored, ${s.messages.delivered_today} delivered, refused ${JSON.stringify(s.messages.refused_today)})`);
  // No identifier of this run in it: every DID (whole and its key part), account, client id,
  // topic held, and no address or prefix.
  const ids = [...new Set(everyone.flatMap((id) => [id.did, id.original, id.did.slice(11), accountOf(id.original), clientId(id)]))];
  const held = rows('SELECT topic FROM claims').map((r) => r.topic.slice(2));
  const leak = [...ids, ...held].filter((x) => got.text.includes(x));
  ok(held.length > 0 && leak.length === 0 && !/did:|127\.0\.0|\/24|\/48|[0-9a-f]{24}/.test(got.text),
    `GET /stats names no DID, account, client id, topic or address (${ids.length} identifiers and ${held.length} topics of this run looked for${leak.length ? `; found ${leak.length}` : ''})`);
  const again = JSON.parse((await getStats()).text);
  ok(again.at === s.at, 'GET /stats is computed at most once a minute (the same answer within it)');
  ok((await fetch(`${base()}/stats`, { method: 'POST' })).status === 404, 'POST /stats: 404 (a GET only)');
}
{
  // The day's counts survive a restart (written by the sweep), a new UTC day starts at zero with
  // the day before kept as a row, and every row is numbers only, keyed by the start of its day.
  let snow = now;
  const S = await startRelay({ ...cfg, db: join(dir, 'stats.db'), clock: () => snow, log: () => {} });
  const r1 = (await login(alice, {}, S)).client, r2 = (await login(bob, {}, S)).client, T = topic();
  await subscribe(r1, T);
  await publish(r2, T, payload(100));
  await until(() => messages(r1, T).length === 1);
  ok(await subscribe(r2, T) === 128, 'stats relay: a mailbox another identity holds is refused (mailbox_taken)');
  await sleep(100);
  await refused(carol, { bundle: false }, 'bundle', 'stats relay: an unknown identity without a bundle', S);
  const before = (await getStats(S)).text, b1 = JSON.parse(before);
  S.sweep(snow);
  await end(r1); await end(r2);
  await S.close();
  const S2 = await startRelay({ ...cfg, db: join(dir, 'stats.db'), clock: () => snow, log: () => {} });
  const b2 = JSON.parse((await getStats(S2)).text);
  ok(b1.logins_today === 2 && b1.messages.stored_today === 1 && b1.messages.delivered_today === 1 && b1.logins_refused_today.bundle === 1 && b1.messages.refused_today.mailbox_taken === 1 && b1.identities.new_today === 2 && b1.sessions.peak_today === 2,
    `GET /stats on a fresh relay: 2 logins, 1 stored, 1 delivered, 1 login refused (bundle), 1 notice (mailbox_taken), 2 new identities, peak 2 sessions (${before.trim()})`);
  ok(b2.logins_today === 2 && b2.messages.delivered_today === 1 && b2.logins_refused_today.bundle === 1 && b2.sessions.now === 0,
    'GET /stats after a restart: today\'s counts read back from stats_days, no session connected');
  snow += DAY;
  const r3 = (await login(alice, {}, S2)).client;
  S2.sweep(snow);
  const c = JSON.parse((await getStats(S2)).text);
  ok(c.logins_today === 1 && c.messages.delivered_today === 0 && c.days.length === 2 && c.days[0].logins === 2 && c.days[0].delivered === 1 && c.days[0].refused === 1 && c.days[0].identities === 2 && c.days[1].logins === 1 && statsShape(c).length === 0,
    `GET /stats on the next UTC day: today's counts from zero, yesterday kept in days (${JSON.stringify(c.days)})`);
  const kept = S2.db.raw.prepare('SELECT day, counts FROM stats_days ORDER BY day').all();
  ok(kept.length === 2 && kept.every((r) => r.day % DAY === 0 && /^[{}\[\]":,a-z_0-9]*$/.test(r.counts)), 'stats_days: one row a day, keyed by the start of the UTC day, numbers and names of checks only');
  snow += 95 * DAY;
  S2.sweep(snow);
  ok(S2.db.raw.prepare('SELECT count(*) AS n FROM stats_days').get().n === 1, 'stats_days: rows older than 90 days go at the sweep');
  await end(r3);
  await S2.close();
}

// ================================================================ the broker-eye dump
{
  // Leave messages queued so the dump holds payloads, then read everything the operator could.
  const F = topic(), G = topic('i');
  await subscribe(a, F); await subscribe(a, G);
  await end(a);
  for (let i = 0; i < 3; i++) await publish(b, F, payload(512 + i));
  await publish(b, G, payload(2048));
  await end(b);
  relay.db.raw.exec('PRAGMA wal_checkpoint(PASSIVE)');
  const tables = rows("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").map((r) => r.name);
  const dump = {};
  for (const t of tables) dump[t] = rows(`SELECT * FROM ${t}`).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v instanceof Uint8Array ? Buffer.from(v).toString('hex') : v])));
  const files = [cfg.db, `${cfg.db}-wal`, `${cfg.db}-shm`].filter(existsSync).map((f) => readFileSync(f));
  const text = [JSON.stringify(dump), ...files.map((f) => f.toString('latin1')), lines.join('\n')].join('\n');
  const dids = [...new Set(everyone.flatMap((id) => [id.did, id.original]))];
  ok(!text.includes('did:sigelo:') && dids.every((d) => !text.includes(d) && !text.includes(d.slice(11))), `no DID anywhere in the database file, its WAL or the log (${dids.length} DIDs, ${files.length} files, ${lines.length} log lines)`);
  const topics = [...dump.claims.map((r) => r.topic), ...dump.messages.map((r) => r.topic)];
  ok(topics.length > 0 && topics.every((t) => /^[mi]\/[0-9a-f]{32}$/.test(t)), `every topic stored is a random m/ or i/ name (${topics.length})`);
  // Who wrote to whom, and when, is not in the file (plan §5 "Privacy"): every time it holds is the
  // start of a UTC day, and a message row has no time of its own. A second-exact time on the
  // writer's account and on the reader's message or claim joined the two, and a log line's time to both.
  const TIMES = { accounts: ['created', 'last_seen'], claims: ['created', 'last_used', 'expires'], messages: ['expires'] };
  const stamps = Object.entries(TIMES).flatMap(([t, cols]) => dump[t].flatMap((r) => cols.filter((c) => r[c] !== null).map((c) => [`${t}.${c}`, r[c]])));
  const finer = [...new Set(stamps.filter(([, v]) => v % DAY !== 0).map(([c]) => c))];
  // pool: the reader's operator pool (allowance.mjs charges the message there), no time.
  const own = rows("SELECT name FROM pragma_table_info('messages')").map((r) => r.name).filter((c) => !['id', 'seq', 'topic', 'client_id', 'account', 'payload', 'bytes', 'expires', 'message_id', 'pool'].includes(c));
  ok(stamps.length > 0 && finer.length === 0 && own.length === 0 && dump.messages.length > 0,
    `every time in the database is the start of a UTC day (${stamps.length} values${finer.length ? `; finer: ${finer.join(', ')}` : ''}), and a message row holds no time of its own${own.length ? ` (${own.join(', ')})` : ''}`);
  const queued = rows('SELECT payload FROM messages').map((r) => Buffer.from(r.payload));
  ok(queued.length === 4 && queued.every((p) => sent.some((s) => s.equals(p))), 'every payload stored is one of the random payloads sent, unchanged: ciphertext in, ciphertext kept');
  const LINE = /^(login|disconnect) \d+\.\d+\.\d+\.0\/24$|^(refused|error) \d+\.\d+\.\d+\.0\/24 [a-z_]+$|^sweep expired=\d+ invites=\d+ idle=\d+ accounts=\d+$/;
  const odd = lines.filter((l) => !LINE.test(l));
  ok(odd.length === 0, `every log line is a login, refusal, disconnect, error or sweep with a /24 and nothing else${odd.length ? `: ${odd.slice(0, 3).join(' | ')}` : ''}`);
  ok(topics.every((t) => !lines.join('\n').includes(t.slice(2))), 'no topic in the log');
  // Nor the order rows were written in, across accounts: a rowid numbers rows as they are inserted
  // (the claims of a pairing are written within one round trip, its two sides' rows side by side),
  // and a relay-wide message number orders every reader's messages together. Every table but
  // messages is WITHOUT ROWID; a message's id is random, its order a sequence of its reader's own.
  const withRowid = rows("SELECT name FROM pragma_table_list WHERE schema = 'main' AND type = 'table' AND name NOT LIKE 'sqlite_%' AND wr = 0").map((r) => r.name);
  const ids = dump.messages.map((r) => r.id), seqs = rows('SELECT client_id, seq FROM messages ORDER BY client_id, seq');
  const sequence = rows("SELECT name FROM sqlite_master WHERE name = 'sqlite_sequence'").length ? rows('SELECT name FROM sqlite_sequence') : [];
  ok(withRowid.join() === 'messages' && sequence.length === 0, `every table keyed by a hash or a random name has no rowid (with one: ${withRowid.join()}), and nothing numbers messages relay-wide`);
  ok(ids.length === 4 && Math.max(...ids) - Math.min(...ids) > 2 ** 32 && seqs.map((r) => r.seq).join() === '1,2,3,4',
    `message ids are random (${ids.length} spread over ${(Math.max(...ids) - Math.min(...ids)).toExponential(1)}), their order a sequence per reader (${seqs.map((r) => r.seq).join()})`);
}

// ================================================================ the WAL holds no sender beside the message it wrote
// The database file of relay r (database file <name>.db) alone, then as each commit in its WAL left
// it, replayed on copies: accounts, chain_dids, claims, pool rows and proofs of work as JSON text
// (the last two '' without the M4 policy), and the ids of the queued messages.
function walStates(r, name, tag = name) {
  const snap = join(dir, `${tag}-snap`), states = [];
  mkdirSync(snap);
  copyFileSync(r.db.raw.prepare("SELECT file FROM pragma_database_list WHERE name = 'main'").get().file, join(snap, 'db'));
  const read = (d, wal) => {
    mkdirSync(d);
    copyFileSync(join(snap, 'db'), join(d, 'db'));
    if (wal) writeFileSync(join(d, 'db-wal'), wal);
    const x = new DatabaseSync(join(d, 'db'));
    const rows = (t, order) => (x.prepare('SELECT 1 FROM sqlite_master WHERE name = ?').get(t) ? JSON.stringify(x.prepare(`SELECT * FROM ${t} ORDER BY ${order}`).all()) : '');
    states.push({ accounts: JSON.stringify(x.prepare('SELECT account, last_seen, day, msgs_day, hex(chain) AS chain FROM accounts ORDER BY account').all()),
      dids: rows('chain_dids', 'did'), claims: rows('claims', 'topic'), pool: rows('pool_members', 'account'), proofs: rows('pow_proofs', 'account'),
      messages: x.prepare('SELECT id FROM messages').all().map((r) => r.id) });
    x.close();
  };
  read(join(snap, 'file'), null);
  const wal = readFileSync(join(dir, `${name}.db-wal`));
  if (wal.length < 32) return states;
  const page = wal.readUInt32BE(8), frame = 24 + page;
  for (let off = 32, n = 0; off + frame <= wal.length; off += frame) {
    if (wal.readUInt32BE(off + 4) === 0) continue;   // a commit frame says the database's size; others 0
    read(join(snap, String(n++)), wal.subarray(0, off + frame));
  }
  return states;
}
{
  // A copy of the running relay's files (a snapshot, a seizure) holds its WAL: every commit since
  // the last sweep. A sender's count bumped in the commit that stored the reader's message named,
  // commit by commit, who wrote to whom. Messages sent and the day of a login are now written by
  // the sweep, all accounts in one transaction, just before it truncates the WAL.
  const W = await startRelay({ ...cfg, db: join(dir, 'wal.db'), log: () => {} });
  const ws = [alice, bob, carol].map(async (id) => (await login(id, {}, W)).client);
  const [wa, wb, wc] = await Promise.all(ws);
  const T = topic(), U = topic();
  ok(await subscribe(wb, T) === 1 && await subscribe(wc, U) === 1, 'bob and carol claim a mailbox each');
  W.sweep();   // the WAL starts empty here: the logins and claims are in the file
  for (let i = 0; i < 3; i++) { await publish(wa, T, randomBytes(300)); await publish(wb, U, randomBytes(300)); await publish(wc, T, randomBytes(300)); }
  await sleep(100);
  const states = walStates(W, 'wal');
  const withMessage = states.filter((st, i) => i > 0 && st.messages.some((id) => !states[i - 1].messages.includes(id)));
  const mixed = states.filter((st, i) => i > 0 && withMessage.includes(st) && (st.accounts !== states[i - 1].accounts || st.dids !== states[i - 1].dids));
  ok(withMessage.length >= 8 && mixed.length === 0, `${states.length - 1} commits in the WAL, ${withMessage.length} storing a message: none of them changes an account or a chain (${mixed.length})`);
  const counted = () => W.db.raw.prepare('SELECT sum(msgs_day) AS n FROM accounts').get().n;
  ok(counted() === 0 && W.db.counters(accountOf(alice.original), now).msgs_today === 3, 'the counts wait in memory, and the quota reads them there (alice: 3)');
  W.sweep();
  ok(counted() === 9 && readFileSync(join(dir, 'wal.db-wal')).length === 0, `the sweep writes them, in one transaction, and truncates the WAL (${counted()} counted)`);
  // A login whose chain did not change writes nothing: each rewrite was a commit beside what followed.
  const before = readFileSync(join(dir, 'wal.db-wal')).length;
  for (const c of [wa, wb, wc]) await end(c);
  const again = (await login(alice, {}, W)).client;
  ok(readFileSync(join(dir, 'wal.db-wal')).length === before, 'alice logs in again with the same bundle: nothing is written');
  await end(again);
  await W.close();
}
{
  // The same with the M4 policy, whose hourly tidy of licences and proofs ran from a login and
  // wrote every sender's count (db.mjs flush) mid-minute, in a commit after the reader's message,
  // and left both in the WAL: a fresh DID logging in an hour later, at no cost, made the pairing
  // appear on demand. The tidy now runs inside the sweep's transaction.
  const W = await startRelay({ ...cfg, db: join(dir, 'wal-m4.db'), log: () => {},
    policy: (ctx) => relayPolicy(ctx, { pow: { bits: 8, loadBits: 12, loadPerHour: 1000 }, freeQueue: 64 * 1024 * 1024 }) });
  const proven = async (id) => {
    const { challenge, pow_bits } = await getChallenge(id.did, W);
    return (await mqttConnect({ username: id.did, clientId: clientId(id), clean: false, password: password(id, challenge, { extra: { pow: solve('relay.test', id.original, challenge.nonce, pow_bits) } }) }, W)).client;
  };
  const [wa, wb] = [await proven(alice), await proven(bob)];
  const T = topic();
  ok(wa?.connected && wb?.connected && await subscribe(wb, T) === 1, 'alice and bob log in with their proofs of work under the M4 policy; bob claims a mailbox');
  if (wb) await end(wb);
  W.sweep();   // the WAL starts empty here; the first tidy has run
  await publish(wa, T, randomBytes(300));
  await sleep(100);
  now += 3601;
  const dave = identity('dave m4');
  everyone.push(dave);
  (await login(dave, {}, W)).client?.end(true);   // a fresh DID, no proof: free
  const states = walStates(W, 'wal-m4');
  const stored = states.findIndex((st) => st.messages.length > 0);
  ok(stored >= 0 && states.every((st) => JSON.parse(st.accounts).every((a) => a.msgs_day === 0)),
    `${states.length} commits in the WAL, the message stored in commit ${stored}: none writes a sender's count`);
  ok(W.db.raw.prepare('SELECT sum(msgs_day) AS n FROM accounts').get().n === 0 && W.db.counters(accountOf(alice.original), now).msgs_today === 1, 'alice\'s count waits in memory');
  W.sweep();
  ok(W.db.raw.prepare('SELECT sum(msgs_day) AS n FROM accounts').get().n === 1 && readFileSync(join(dir, 'wal-m4.db-wal')).length === 0, 'the sweep writes it and truncates the WAL');
  if (wa) await end(wa);
  await W.close();
}
{
  // The audit of the WAL's order: what was written for a writer landed just before the commit of
  // the message it wrote next: (a) its claims' day of use, at its first connection of a UTC day;
  // (b) its chain and chain_dids, at its login after a rotation; (c) a new identity's proof,
  // account and claim. Now a claim's day waits in memory for the sweep, as a login's does, and
  // what must be written at once is followed by a checkpoint that empties the WAL (db.mjs settle).
  const W = await startRelay({ ...cfg, db: join(dir, 'wal-order.db'), log: () => {},
    policy: (ctx) => relayPolicy(ctx, { pow: { bits: 8, loadBits: 12, loadPerHour: 1000 }, freeQueue: 64 * 1024 * 1024 }) });
  const proven = async (id) => {
    const { challenge, pow_bits } = await getChallenge(id.did, W);
    return (await mqttConnect({ username: id.did, clientId: clientId(id), clean: false, password: password(id, challenge, { extra: { pow: solve('relay.test', id.original, challenge.nonce, pow_bits) } }) }, W)).client;
  };
  const ann = identity('ann wal'), ben = identity('ben wal'), zed = identity('zed wal'), ann1 = rotated(ann, 'ann wal 1');
  everyone.push(ann, ben, zed, ann1);
  const wa = await proven(ann), wb = await proven(ben), B = topic();
  ok(await subscribe(wa, topic()) === 1 && await subscribe(wb, B) === 1, 'ann and ben, proven, claim a mailbox each; ben stays connected');
  await end(wa);
  W.sweep();   // the WAL starts empty here
  // The WAL as each case leaves it: → [commits, those storing a message, those changing anything but messages].
  const rest = (st) => [st.accounts, st.dids, st.claims, st.pool, st.proofs].join('\n');
  const wal = (tag) => {
    const states = walStates(W, 'wal-order', tag);
    return [states.length - 1, states.filter((st, i) => i > 0 && st.messages.some((id) => !states[i - 1].messages.includes(id))).length, states.filter((st) => rest(st) !== rest(states[0])).length];
  };
  now += DAY;
  const a1 = (await login(ann, {}, W)).client;   // (a) her first connection of the day restores her claim
  await publish(a1, B, randomBytes(300));
  await until(() => messages(wb, B).length === 1);
  const wa1 = wal('wal-a');
  await end(a1);
  const a2 = (await login(ann1, {}, W)).client;  // (b) her login after a rotation
  await publish(a2, B, randomBytes(300));
  await until(() => messages(wb, B).length === 2);
  const wa2 = wal('wal-b');
  await end(a2);
  const z = await proven(zed);                   // (c) new here
  ok(await subscribe(z, topic()) === 1, 'zed, new here, proves work and claims a mailbox');
  await publish(z, B, randomBytes(300));
  await until(() => messages(wb, B).length === 3);
  const wz = wal('wal-c');
  ok([wa1, wa2, wz].every(([, stored, moved]) => stored === 1 && moved === 0),
    `the WAL after each case (commits, storing a message, changing an account, chain, claim or proof of work): (a) ${wa1.join('/')}, (b) ${wa2.join('/')}, (c) ${wz.join('/')}: the message in it, nothing written for its writer`);
  const day = () => W.db.raw.prepare('SELECT count(*) AS n FROM claims WHERE account = ? AND last_used = ?').get(accountOf(ann.original), Math.floor(now / DAY) * DAY).n;
  const before = day();
  W.sweep();
  ok(W.db.chainOf(accountOf(ann.original), ann.original).length === 1 && W.db.account(accountOf(zed.original)) !== undefined && before === 0 && day() === 1,
    'ann\'s chain and zed\'s account are in the file; her claim\'s day of use waits for the sweep, which writes it');
  for (const c of [z, wb]) await end(c);
  await W.close();
}
{
  // The audit of the pages: a WITHOUT ROWID table has no rowid, but SQLite places each new cell
  // below the last in a b-tree page, so sorting a page's cells by offset gave the order they were
  // inserted in, across accounts: an invite, its answer and both sides of each pairing side by
  // side. The sweep rebuilds the tables of identities in key order every hour (db.mjs keepSorted),
  // so each page holds its cells with offsets falling as the key rises: their offsets tell the key
  // order, which is a hash's, and nothing more. inOrder → the pages of these tables and their
  // indexes whose cells do not lie so.
  const C = await startRelay({ ...cfg, db: join(dir, 'cells.db'), log: () => {},
    policy: (ctx) => relayPolicy(ctx, { pow: { bits: 0, loadBits: 0, loadPerHour: 1000 }, freeQueue: 64 * 1024 * 1024 }) });
  const NAMES = ['accounts', 'claims', 'claims_client', 'claims_account', 'chain_dids', 'chain_dids_account', 'pow_proofs', 'pool_members', 'pool_members_operator', 'vouched', 'licences', 'licences_current', 'operator_retired'];
  const outOfOrder = () => {
    const x = new DatabaseSync(join(dir, 'cells.db'), { readOnly: true }), size = x.prepare('PRAGMA page_size').get().page_size;
    const pages = x.prepare(`SELECT name, pageno FROM dbstat WHERE pagetype IN ('leaf', 'internal') AND name IN (${NAMES.map(() => '?').join()})`).all(...NAMES);
    x.close();
    const file = readFileSync(join(dir, 'cells.db'));
    return pages.filter(({ pageno }) => {
      const pg = file.subarray((pageno - 1) * size, pageno * size), h = pageno === 1 ? 100 : 0, at = h + (pg[h] === 2 || pg[h] === 5 ? 12 : 8);
      const offsets = Array.from({ length: pg.readUInt16BE(h + 3) }, (_, i) => pg.readUInt16BE(at + 2 * i));
      return !offsets.every((o, i) => i === 0 || o < offsets[i - 1]);
    }).map((p) => p.name);
  };
  C.sweep();   // its first: the hourly rebuild is due
  const pairs = [['ann', 'ben'], ['cat', 'dan'], ['eve', 'fay']].map((p) => p.map((l) => identity(`cells ${l}`)));
  everyone.push(...pairs.flat());
  for (const pair of pairs) {
    for (const id of pair) {
      const c = (await login(id, { extra: { pow: '0' } }, C)).client;
      for (let i = 0; i < 3; i++) await subscribe(c, topic());
      await end(c);
    }
  }
  C.sweep();   // within the hour: the WAL goes to the file, the pages keep their order
  const before = outOfOrder();
  now += 3600;
  C.sweep();
  const after = outOfOrder();
  ok(before.includes('claims') && after.length === 0,
    `three pairings' claims: before the hourly rebuild their offsets show the order written (${[...new Set(before)].join(', ')}); after it every page of the identity tables and their indexes holds its cells in key order (${after.join(', ') || 'none out of order'})`);
  const n = (t) => C.db.raw.prepare(`SELECT count(*) AS n FROM ${t}`).get().n;
  const fk = C.db.raw.prepare("SELECT \"table\" AS t, on_delete AS d FROM pragma_foreign_key_list('messages')").get();
  ok(n('claims') === 18 && n('accounts') === 6 && n('chain_dids') === 6 && n('pow_proofs') === 6 && fk?.t === 'claims' && fk?.d === 'CASCADE',
    'and the rebuild kept every row, and messages still refer to claims, deleted with them');
  await C.close();
}

// ================================================================ packets left unfinished; a keepalive
{
  // A session holds what the parser buffers of its unfinished packet: up to 1 MB, and logging in
  // costs no work. 200 sessions each leaving a 1 MB PUBLISH unfinished took the relay from 108 to
  // 381 MB. Here: a deadline per packet, a budget per network and in all, MAX_EARLY before the CONNACK.
  const P = await startRelay({ ...cfg, db: join(dir, 'partial.db'), frameMs: 1500, partialPerPrefix: 1536 * 1024, earlyPerPrefix: 400 * 1024, earlyMax: 4 * 1024 * 1024, log: (l) => lines.push(l) });
  const raw = async (id) => {
    const { challenge } = await getChallenge(id.did, P);
    const c = (await mqttConnect({ username: id.did, clientId: clientId(id), password: password(id, challenge), clean: false }, P)).client;
    return c;
  };
  // A PUBLISH header announcing `len` bytes and its first `part` written: the rest never comes.
  const announce = (c, len, part) => {
    const t = Buffer.from(topic(), 'utf8'), body = 2 + t.length + 2 + len, head = [0x32];
    let n = body; do { let b = n % 128; n = Math.floor(n / 128); if (n > 0) b |= 128; head.push(b); } while (n > 0);
    c.stream.write(Buffer.concat([Buffer.from(head), Buffer.from([t.length >> 8, t.length & 255]), t, Buffer.from([0, 1]), randomBytes(part)]));
  };
  const s1 = await raw(alice), s2 = await raw(bob);
  announce(s1, 1024 * 1024, 1000 * 1000);
  await until(() => P.partial() >= 1000038);
  ok(P.partial() === 1000038, `a session announces a 1 MB PUBLISH and sends 1,000,000 bytes of it: the bytes it sent are held against the budget (${P.partial()})`);
  announce(s2, 1024 * 1024, 10);
  await sleep(100);
  ok(s2.connected && P.partial() === 1000038 + 48, `a second one from the same /24 announces 1 MB and sends 48 bytes: 48 held, not the 1 MB announced (${P.partial() - 1000038})`);
  s2.stream.write(randomBytes(600 * 1024));
  ok(await until(() => !s2.connected) && s1.connected, 'it sends 600 KB more, past the /24\'s budget of 1.5 MB: closed at once; the first stays');
  ok(await until(() => !s1.connected, 4000) && P.partial() === 0, 'the first is closed once its packet is not whole 1.5 s after it began, and the budget is free again');
  for (const c of [s1, s2]) c.end(true);
  // The audit's case: sockets that never log in, each announcing a CONNECT of 256 KB (the largest)
  // and sending 4 bytes of it. Counted by the length announced, 128 of them from 8 networks held
  // 32 MB, past this relay's 4 MB for packets before the CONNACK, and every login was closed before
  // its CONNACK; counted by the bytes they hold, 512.
  const CONNECT_256K = Buffer.from([0x10, 0x80, 0x80, 0x10, 0, 4, 0x4d, 0x51]);   // remaining length 262,144, then 4 bytes of it
  const flood = [];
  for (let net = 2; net < 10; net++) {
    for (let i = 0; i < 16; i++) {
      const so = tcpConnect({ port: P.ports.tcp, host: '127.0.0.1', localAddress: `127.0.${net}.1` });
      so.on('error', () => {});
      so.write(CONNECT_256K);
      flood.push(so);
    }
  }
  await until(() => P.early() >= 512);
  await sleep(100);
  const honest = await raw(carol);
  ok(P.early() === 512 && honest?.connected === true && flood.every((so) => !so.destroyed),
    `128 sockets from 8 networks announce a 256 KB CONNECT each and send 4 bytes: ${P.early()} bytes held before the CONNACK, and a login from another network connects`);
  honest?.end(true);
  for (const so of flood) so.destroy();
  await until(() => P.early() === 0);
  // Bytes sent count: one network's packets before the CONNACK stop at its 400 KB here.
  const big = (n) => { const so = tcpConnect({ port: P.ports.tcp, host: '127.0.0.1', localAddress: '127.0.2.1' }); so.on('error', () => {}); so.write(Buffer.concat([CONNECT_256K.subarray(0, 4), randomBytes(n)])); return so; };
  const e1 = big(250 * 1024);
  await until(() => P.early() === 250 * 1024);
  const e2 = big(200 * 1024), gone2 = new Promise((resolve) => e2.on('close', () => resolve(true)));
  ok(await Promise.race([gone2, sleep(2000).then(() => false)]) && !e1.destroyed && P.early() === 250 * 1024,
    `a second CONNECT from that network sending 200 KB, past its 400 KB before the CONNACK: closed; the first stays (${P.early()} held)`);
  e1.destroy();
  // Before the CONNACK nothing larger than MAX_EARLY: a correct client waits for it.
  const sock = tcpConnect(P.ports.tcp, '127.0.0.1');
  const gone = new Promise((resolve) => sock.on('close', () => resolve(true)));
  sock.on('error', () => {});
  const cid = Buffer.from(clientId(carol)), connectPkt = Buffer.concat([Buffer.from([0x10, 10 + 2 + cid.length, 0, 4]), Buffer.from('MQTT'), Buffer.from([4, 0, 0, 60, cid.length >> 8, cid.length & 255]), cid]);
  const n0 = lines.length;
  sock.write(Buffer.concat([connectPkt, Buffer.from([0x32, 0x80, 0x50])]));   // a PUBLISH of 10,240 bytes, announced right after the CONNECT
  ok(await Promise.race([gone, sleep(2000).then(() => false)]) && lines.slice(n0).some((l) => / size$/.test(l)) && MAX_EARLY < 10240,
    `a 10 KB packet announced before the CONNACK: the connection closes before the parser reads the CONNECT (MAX_EARLY ${MAX_EARLY})`);
  // A keepalive of 0 never times out: refused (Aedes returns 6, outside MQTT 3.1.1's codes).
  const { challenge: kc } = await getChallenge(carol.did, P);
  const k0 = await mqttConnect({ username: carol.did, clientId: clientId(carol), password: password(carol, kc), clean: false, keepalive: 0 }, P);
  ok(!k0.client && k0.error?.code === 6, `a CONNECT with keepalive 0: refused (${k0.error?.code})`);
  await P.close();
}

// ================================================================ the queue read from where it was, and back to its start
{
  // mailbox.mjs reads a reader's queue a page at a time from the seq it read last. A new row's seq
  // is one past the reader's highest left (db.mjs store), so once the newest rows are acknowledged
  // a message stored meanwhile can fall behind that point: it moves the next read back to it, or
  // the stream would end without it and hold its live delivery. Driven by hand, as Aedes
  // drives the persistence: two rows read, delivered and acknowledged, then a third stored, all
  // before the stream's next read.
  const db = openDb(join(dir, 'rewind.db')), U = topic(), t = Date.parse('2026-10-07T00:00:00Z') / 1000;
  const sessions = { X: { account: 'ax', clientId: 'X', prefix: 'p' }, W: { account: 'aw', clientId: 'W', prefix: 'p' } };
  const m = mailboxes({ db, clock: () => t, diskFull: () => false, sessionOf: (c) => sessions[c.id], online: () => true, policy: {} });
  const reader = { id: 'X' }, writer = { id: 'W' };
  db.tx(() => db.insertClaim(U, 'ax', 'X', t, null));
  for (const p of ['one', 'two']) db.tx(() => db.store({ topic: U, clientId: 'X', account: 'ax', payload: Buffer.from(p), expires: t + DAY }));
  const it = m.persistence.outgoingStream(reader)[Symbol.asyncIterator]();
  const p1 = (await it.next()).value, p2 = (await it.next()).value;
  m.forward(reader, p1); await m.persistence.outgoingUpdate(reader, { ...p1, messageId: 1 });
  m.forward(reader, p2); m.persistence.outgoingUpdate(reader, { ...p2, messageId: 2 });
  m.persistence.outgoingClearMessageId(reader, { cmd: 'puback', messageId: 1 });
  m.persistence.outgoingClearMessageId(reader, { cmd: 'puback', messageId: 2 });
  let stored = null;
  m.authorizePublish(writer, { topic: U, qos: 1, payload: Buffer.from('three') }, (e) => { stored = e ?? true; });
  const seq = db.raw.prepare('SELECT seq FROM messages').all().map((r) => r.seq).join();
  const next = await Promise.race([it.next(), sleep(2000).then(() => ({ timeout: true }))]);
  ok(stored === true && seq === '1' && String(next.value?.payload) === 'three',
    `rows 1 and 2 read and acknowledged, a third stored as seq ${seq}: the stream's next read goes back and delivers it (${next.timeout ? 'timed out' : next.done ? 'the stream ended without it' : String(next.value?.payload)})`);
  m.close(); db.close();
}

// ================================================================ a database file of an earlier version
{
  // Tables with a rowid, messages numbered relay-wide with a time of their own: rebuilt at start,
  // rows kept, each reader's order kept as its sequence, the foreign key still cascading.
  const file = join(dir, 'old.db'), old = new DatabaseSync(file);
  old.exec(`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;
    CREATE TABLE accounts (account TEXT PRIMARY KEY, created INTEGER NOT NULL, last_seen INTEGER NOT NULL, day INTEGER NOT NULL DEFAULT 0, msgs_day INTEGER NOT NULL DEFAULT 0, chain BLOB) STRICT;
    CREATE TABLE claims (topic TEXT PRIMARY KEY, account TEXT NOT NULL, client_id TEXT NOT NULL, created INTEGER NOT NULL, last_used INTEGER NOT NULL, expires INTEGER, dead INTEGER NOT NULL DEFAULT 0) STRICT;
    CREATE INDEX claims_client ON claims (client_id);
    CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, topic TEXT NOT NULL REFERENCES claims (topic) ON DELETE CASCADE, client_id TEXT NOT NULL, account TEXT NOT NULL, payload BLOB NOT NULL, bytes INTEGER NOT NULL, expires INTEGER NOT NULL, created INTEGER NOT NULL, message_id INTEGER) STRICT;
    CREATE INDEX messages_client ON messages (client_id, message_id);
    CREATE TABLE chain_dids (did TEXT PRIMARY KEY, account TEXT NOT NULL) STRICT;`);
  const T1 = topic(), T2 = topic();
  old.prepare('INSERT INTO accounts (account, created, last_seen, msgs_day) VALUES (?, 0, 0, 7)').run('a1');
  for (const [t, c] of [[T1, 'c1'], [T2, 'c2']]) old.prepare('INSERT INTO claims (topic, account, client_id, created, last_used) VALUES (?, ?, ?, 0, 0)').run(t, 'a1', c);
  for (const [t, c, p] of [[T1, 'c1', 'x'], [T2, 'c2', 'y'], [T1, 'c1', 'z']]) old.prepare('INSERT INTO messages (topic, client_id, account, payload, bytes, expires, created) VALUES (?, ?, ?, ?, 1, 9, 5)').run(t, c, 'a1', Buffer.from(p));
  old.prepare("INSERT INTO chain_dids VALUES ('d1', 'a1')").run();
  old.close();
  const db = openDb(file);
  const tables = db.raw.prepare("SELECT name, wr FROM pragma_table_list WHERE schema = 'main' AND type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => `${r.name}:${r.wr}`).join();
  const order = db.raw.prepare('SELECT client_id, seq, payload FROM messages ORDER BY client_id, seq').all().map((r) => `${r.client_id}.${r.seq}=${Buffer.from(r.payload)}`).join();
  const pooled = ['claims', 'messages'].every((t) => db.raw.prepare('SELECT 1 FROM pragma_table_info(?) WHERE name = ?').get(t, 'pool'));
  ok(tables === 'accounts:1,chain_dids:1,claims:1,messages:0,pool_sent:1,row_totals:1' && pooled && db.rowBytes() === ACCOUNT_ROW + 2 * CLAIM_ROW + DID_ROW && db.account('a1')?.msgs_day === 7 && db.ownerOf('d1') === 'a1' && order === 'c1.1=x,c1.2=z,c2.1=y'
    && !db.raw.prepare("SELECT 1 FROM pragma_table_info('messages') WHERE name = 'created'").get() && db.raw.prepare("SELECT count(*) AS n FROM sqlite_sequence WHERE name LIKE 'messages%'").get().n === 0,
  `a file of an earlier version is rebuilt: no rowid tables, rows kept, each reader's order as its seq, claims and messages gain their pool (free), its identity rows counted (${tables}; ${order}; ${db.rowBytes()} bytes)`);
  db.release('c1', [T1]);
  ok(db.raw.prepare('SELECT count(*) AS n FROM messages').get().n === 1 && db.raw.prepare("SELECT count(*) AS n FROM pragma_foreign_key_check").get().n === 0, 'and giving a claim up still deletes its messages (the foreign key survived)');
  db.close();
}

// ================================================================ short invite codes: POST /park, GET /park/<hash> (park.mjs)
{
  // A relay of its own, so the park brakes and cap below count nothing else; at most 3 parked.
  const pr = await startRelay({ ...cfg, db: join(dir, 'park.db'), park: { max: 3 } });
  const from = lines.length;
  const H = (b) => createHash('sha256').update(b).digest();
  // A long code (contact/invite.mjs, spelled out here): version 1 | DID digest | secret | exp | relay length | relay | checksum.
  const longCode = (id, { relay = 'relay.test', exp = now + DAY, flip = false } = {}) => {
    const host = Buffer.from(relay), e = Buffer.alloc(4);
    e.writeUInt32BE(exp);
    const body = Buffer.concat([Buffer.from([1]), H(canonicalize(id.genesis)), randomBytes(32), e, Buffer.from([host.length]), host]), sum = H(body).subarray(0, 4);
    if (flip) sum[0] ^= 1;
    return 'sgl1' + multibase(Buffer.concat([body, sum])).slice(1);
  };
  const hashOf = (code) => H(`sigelo-park/0${code}`).toString('hex');
  // Each park from a /24 of its own unless one is named: the park brake (10 an hour) is tested apart.
  let net = 0;
  const park = async (id, fields, ip = `10.${Math.floor(++net / 256)}.${net % 256}.7`) => {
    const { challenge } = await getChallenge(id.did, pr, ip);
    const res = await fetch(`${base(pr)}/park`, { method: 'POST', headers: realIp(ip), body: JSON.stringify({ username: id.did, client_id: clientId(id), password: password(id, challenge), ...fields }) });
    return { status: res.status, json: await res.json(), after: res.headers.get('retry-after') };
  };
  const fetchPark = async (h, ip = '203.0.113.9') => { const res = await fetch(`${base(pr)}/park/${h}`, { headers: realIp(ip) }); return { status: res.status, json: await res.json(), after: res.headers.get('retry-after') }; };
  const inv = longCode(alice), h = hashOf('K7F3Q9ZP');
  let r = await park(alice, { code_hash: h, invite: inv, exp: now + 600 });
  ok(r.status === 200 && r.json.ok === true && r.json.exp === now + 600 && pr.park.size() === 1, `POST /park: alice parks her long code under a short code's hash (${JSON.stringify(r.json)})`);
  r = await fetchPark(h);
  ok(r.status === 200 && r.json.ok === true && r.json.invite === inv, 'GET /park/<hash>: the long code, as parked');
  const again = await fetchPark(h), unknown = await fetchPark(hashOf('00000000')), malformed = await fetchPark('K7F3-Q9ZP');
  ok([again, unknown, malformed].every((x) => x.status === 404 && x.json.check === 'park_unknown') && JSON.stringify(again.json) === JSON.stringify(unknown.json) && JSON.stringify(unknown.json) === JSON.stringify(malformed.json),
    'one use: the second fetch is park_unknown (404), word for word as a hash nobody parked and a malformed one');
  r = await park(alice, { code_hash: h, invite: longCode(alice), exp: now + 600 });
  const late = await (async () => { now += 600; const x = await fetchPark(h); now -= 600; return x; })();
  ok(r.json.ok === true && late.status === 404 && late.json.check === 'park_unknown' && pr.park.size() === 0, 'expiry: parked, then fetched 10 minutes later: park_unknown, and gone');
  // What may be parked: an invite to its parker, at this relay, for at most 10 minutes and within its own life.
  const refusal = async (id, fields, what) => {
    const x = await park(id, { code_hash: hashOf('ZZZZZZZZ'), invite: longCode(id), exp: now + 600, ...fields });
    ok(x.status === 200 && x.json.ok === false && x.json.check === 'park', `POST /park refuses ${what} (park: ${x.json.detail})`);
  };
  await refusal(alice, { invite: longCode(bob) }, 'a code whose inviter is not the DID that logged in');
  await refusal(alice, { invite: longCode(alice, { relay: 'relay.other' }) }, 'a code naming another relay');
  await refusal(alice, { invite: longCode(alice, { flip: true }) }, 'a code with a bad checksum');
  await refusal(alice, { invite: 'sgl1' + '2'.repeat(300) }, 'a code past 188 digits');
  await refusal(alice, { exp: now + 901 }, 'an exp past 10 minutes and the 5 minutes an inviter\'s clock may run ahead');
  // An inviter's clock ahead of the relay's: parked, for 10 minutes by the relay's clock.
  r = await park(alice, { code_hash: hashOf('ZZZZZZZY'), invite: longCode(alice), exp: now + 630 });
  ok(r.json.ok === true && r.json.exp === now + 600 && pr.park.fetch(hashOf('ZZZZZZZY')) !== null, `POST /park: an exp 30 s past 10 minutes (the inviter's clock ahead) parks until 10 minutes from now (${JSON.stringify(r.json)})`);
  await refusal(alice, { exp: now }, 'an exp already passed');
  await refusal(alice, { invite: longCode(alice, { exp: now + 300 }) }, 'an exp after the code\'s own');
  await refusal(alice, { code_hash: 'K7F3Q9ZP' }, 'a code_hash that is not 64 hex digits (the code itself)');
  r = await park(alice, { code_hash: hashOf('11111111'), invite: longCode(alice), exp: now + 600 });
  const taken = await park(bob, { code_hash: hashOf('11111111'), invite: longCode(bob), exp: now + 600 });
  ok(r.json.ok === true && taken.json.check === 'park_taken', 'a hash already parked: park_taken, the first kept');
  const { challenge: ch } = await getChallenge(alice.did, pr);
  const forged = await fetch(`${base(pr)}/park`, { method: 'POST', body: JSON.stringify({ username: alice.did, client_id: clientId(alice), password: password(bob, ch), code_hash: hashOf('22222222'), invite: longCode(alice), exp: now + 600 }) }).then((x) => x.json());
  ok(forged.ok === false && ['bundle', 'sig'].includes(forged.check) && pr.park.size() === 1, `a login signed by another key parks nothing (${forged.check})`);
  const junk = await fetch(`${base(pr)}/park`, { method: 'POST', headers: realIp('198.18.5.200'), body: JSON.stringify({ code_hash: h }) });
  ok(junk.status === 400, 'a body without the login fields: 400');
  // The cap: 3 at once; a fourth is park_full until the sweep purges expired ones.
  r = await park(bob, { code_hash: hashOf('33333333'), invite: longCode(bob), exp: now + 600 }, '198.51.100.8');
  const r3 = await park(carol, { code_hash: hashOf('44444444'), invite: longCode(carol), exp: now + 60 }, '198.51.100.9');
  const full = await park(hana, { code_hash: hashOf('55555555'), invite: longCode(hana), exp: now + 600 }, '198.51.100.10');
  ok(r.json.ok && r3.json.ok && full.json.check === 'park_full' && pr.park.size() === 3, `the global cap: a fourth parked code is park_full (${full.json.check})`);
  now += 61;
  pr.sweep();
  const after = await park(hana, { code_hash: hashOf('55555555'), invite: longCode(hana), exp: now + 600 }, '198.51.100.10');
  ok(pr.park.size() === 3 && after.json.ok === true, 'the sweep purges an expired code; then the fourth parks');
  // Brakes per /24: 20 lookups per 10 minutes, a hit or a miss; 10 parks an hour, before the login.
  const looks = [];
  let look21;
  for (let i = 0; i < 21; i++) { look21 = await fetchPark(hashOf('66666666'), '192.0.2.50'); looks.push(look21.status); }
  ok(look21.status === 429 && look21.after === String(600 - (now % 600)), `GET /park 429: Retry-After = the seconds left in the 10 minutes (${look21.after}, want ${600 - (now % 600)})`);
  const other = await fetchPark(hashOf('66666666'), '192.0.2.51'), elsewhere = await fetchPark(hashOf('66666666'), '198.18.0.1');
  ok(looks.slice(0, 20).every((s) => s === 404) && looks[20] === 429 && other.status === 429 && elsewhere.status === 404, 'lookups: 20 per 10 minutes per /24, the 21st rate (429), the same /24 too, another network not');
  now += 600;
  ok((await fetchPark(hashOf('66666666'), '192.0.2.50')).status === 404, 'lookups: the next 10 minutes count afresh');
  const parks = [];
  for (let i = 0; i < 11; i++) parks.push((await fetch(`${base(pr)}/park`, { method: 'POST', headers: realIp('192.0.2.77'), body: '{}' })).status);
  const parkRate = await park(alice, { code_hash: hashOf('77777777'), invite: longCode(alice), exp: now + 600 }, '192.0.2.78');
  ok(parkRate.after === String(3600 - (now % 3600)), `POST /park 429: Retry-After = the seconds left in the hour (${parkRate.after}, want ${3600 - (now % 3600)})`);
  ok(parks.slice(0, 10).every((s) => s === 400) && parks[10] === 429 && parkRate.status === 429 && parkRate.json.check === 'rate', `parks: 10 an hour per /24, counted before the body and the login: the 11th rate (429) (${parks.join()}; ${parkRate.status} ${JSON.stringify(parkRate.json)})`);
  // Nothing of a code in the log or on disk: the hashes, the long codes, the short codes.
  const said = lines.slice(from).join('\n');
  const disk = ['park.db', 'park.db-wal'].filter((f) => existsSync(join(dir, f))).map((f) => readFileSync(join(dir, f)).toString('latin1')).join('');
  ok(![h, hashOf('11111111'), hashOf('33333333'), 'K7F3Q9ZP', inv.slice(0, 40)].some((x) => said.includes(x) || disk.includes(x)), 'the relay\'s log and database hold no code hash, short code or long code (memory only)');
  // A relay restart drops what is parked.
  await pr.close();
  const pr2 = await startRelay({ ...cfg, db: join(dir, 'park.db') });
  ok(pr2.park.size() === 0, 'a restart drops the parked codes (memory only)');
  await pr2.close();
  // An identity with no proof of work yet (allowance.mjs keep says no) parks nothing: a fresh DID costs nothing.
  const pr3 = await startRelay({ ...cfg, db: join(dir, 'park-new.db'), policy: { keep: () => false } });
  const { challenge: c3 } = await getChallenge(ivan.did, pr3);
  const fresh = await fetch(`${base(pr3)}/park`, { method: 'POST', body: JSON.stringify({ username: ivan.did, client_id: clientId(ivan), password: password(ivan, c3), code_hash: hashOf('88888888'), invite: longCode(ivan), exp: now + 600 }) }).then((x) => x.json());
  ok(fresh.ok === false && fresh.check === 'pow' && pr3.park.size() === 0, `a new identity that has proven no work parks nothing (${fresh.check})`);
  await pr3.close();
  // The relay-wide brake: LOOKUPS_ALL across every network (here 3), the same 429 rate as a network's own.
  const pr4 = await startRelay({ ...cfg, db: join(dir, 'park-all.db'), park: { lookupsAll: { n: 3, window: 600 } } });
  const look4 = async (ip) => { const res = await fetch(`${base(pr4)}/park/${hashOf('99999999')}`, { headers: realIp(ip) }); return { status: res.status, json: await res.json(), after: res.headers.get('retry-after') }; };
  const spread = [];
  for (let i = 0; i < 4; i++) spread.push(await look4(`100.64.${i}.1`));
  ok(spread.slice(0, 3).every((x) => x.status === 404 && x.json.check === 'park_unknown') && spread[3].status === 429 && spread[3].json.check === 'rate' && /on this relay/.test(spread[3].json.detail),
    `lookups: at most LOOKUPS_ALL per 10 minutes across all networks, the next rate (429) from a network of its own (${spread.map((x) => x.status).join()}; ${spread[3].json.detail})`);
  ok(spread[3].after === String(600 - (now % 600)) && spread.slice(0, 3).every((x) => x.after === null), `the relay-wide 429: Retry-After the seconds left in its 10 minutes, none on a 404 (${spread[3].after})`);
  now += 600;
  ok((await look4('100.64.9.1')).status === 404, 'lookups: the relay-wide count starts afresh the next 10 minutes');
  now -= 600;
  await pr4.close();
  now -= 661;
}

await relay.close();
rmSync(dir, { recursive: true, force: true });
console.log(failed ? `FAILED ${failed} of ${n}` : `ALL PASS (${n})`);
process.exit(failed ? 1 : 0);
