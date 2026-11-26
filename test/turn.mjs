#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// relay/test/turn.mjs — TURN credentials (turn.mjs, sigelo-turn/0): coturn's REST password against
// vectors computed apart (Python's hmac, below), the username's hour and opaque tag, the secret file,
// then the relay on loopback: GET /challenge says turn only with a secret; a logged-in session asks on
// $sigelo/turn and gets {code: "turn", id, turn} before its PUBACK, nothing delivered; the hourly
// limit; nothing of a credential in the log; no secret: the topic closes the session. Prints "ALL PASS (n)".
//   node relay/test/turn.mjs
//
// coturn's scheme (https://github.com/coturn/coturn/blob/master/README.turnserver, "--use-auth-secret"
// and the TURN REST API section): temporary-username = timestamp ":" username, temporary-password =
// base64_encode(hmac-sha1(shared-secret, temporary-username)); the timestamp is the expiry
// (draft-uberti-behave-turn-rest-00 §2.2, §4.2: https://datatracker.ietf.org/doc/html/draft-uberti-behave-turn-rest-00).
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'mqtt';
import { startRelay } from '../server.mjs';
import { HOUR, TURN_TOPIC, TURN_V, credentialFor, readSecret, restPassword, turnCredentials, turnUrls } from '../turn.mjs';
import { clientId, identity, password } from './fixtures.mjs';

let n = 0, failed = 0;
const ok = (cond, what) => { n++; if (cond) console.log(`ok ${what}`); else { failed++; console.log(`FAIL ${what}`); } };
setTimeout(() => { console.log(`FAIL the run did not finish in 60 s (${n} checks so far)`); process.exit(1); }, 60000).unref();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (cond, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (cond()) return true; await sleep(10); } return cond(); };

// ---- coturn's REST password: vectors from python3 -c 'import hmac,hashlib,base64; base64.b64encode(hmac.new(K, U, hashlib.sha1).digest())'
const SECRET = '0123456789abcdef0123456789abcdef';
ok(restPassword('north', '1700000000:alice') === 'Cd/49soE35ICqcJF/bCTn8Z4OyE=', 'restPassword: base64(HMAC-SHA1(secret, username)), coturn\'s example secret "north"');
ok(restPassword(SECRET, '1764190800:abcdefghijklmnop') === 'jgRyIUsK9iH/TgB8kxcAGrIszNQ=', 'restPassword: a 32-character secret, a username of this relay\'s shape');
ok(restPassword('Jefe', 'what do ya want for nothing?') === Buffer.from('effcdf6ae5eb2fa2d27416d5f184df9c259a7c79', 'hex').toString('base64'), 'restPassword: RFC 2202 HMAC-SHA1 test case 2');

// ---- the username: the end of the next hour, an opaque tag
{
  const t = Date.parse('2026-11-26T14:20:00Z') / 1000, acct = 'a'.repeat(64);
  const c = credentialFor(SECRET, acct, t), c2 = credentialFor(SECRET, acct, t + 2000), c3 = credentialFor(SECRET, acct, t + HOUR);
  const m = /^(\d+):([A-Za-z0-9_-]{16})$/.exec(c.username);
  ok(m && Number(m[1]) === c.exp && c.exp === Date.parse('2026-11-26T16:00:00Z') / 1000, `exp: the end of the next hour (${c.exp - t} s from now: 1 to 2 hours); username "<exp>:<16 base64url>"`);
  ok(c.credential === restPassword(SECRET, c.username), 'credential: coturn\'s password for that username');
  ok(c2.username === c.username && c3.username !== c.username && c3.exp === c.exp + HOUR, 'one username per identity per clock hour (coturn\'s user-quota counts it); the next hour another');
  ok(credentialFor(SECRET, 'b'.repeat(64), t).username !== c.username && credentialFor('another-secret-of-thirty-two-chars', acct, t).username !== c.username, 'another identity, or another secret: another tag');
  ok(!c.username.includes(acct.slice(0, 8)) && !c3.username.includes(m[2]), 'the tag names no account and links no two hours');
}

// ---- the secret file and the URIs
{
  const dir = mkdtempSync(join(tmpdir(), 'sigelo-turn-'));
  const f = (name, text) => { const p = join(dir, name); writeFileSync(p, text, { mode: 0o600 }); return p; };
  const hex = 'ab'.repeat(32);
  ok(readSecret(f('good', `${hex}\n`)) === hex, 'readSecret: `openssl rand -hex 32` > file (one line, its newline dropped)');
  const bad = [['short', 'abc'], ['spaces', `${hex} x`], ['two lines', `${hex}\n${hex}\n`], ['empty', ''], ['a quote', `${hex}"`]]
    .filter(([name, text]) => { try { readSecret(f(name.replace(/ /g, '-'), text)); return true; } catch { return false; } }).map(([name]) => name);
  ok(bad.length === 0, `readSecret refuses: short, spaces, two lines, empty, a quote (taken: ${bad})`);
  ok(turnUrls('relay.example.org:8883').join() === 'turn:relay.example.org:3478?transport=udp,turn:relay.example.org:3478?transport=tcp', 'turnUrls: the relay\'s name, coturn\'s port 3478, UDP then TCP');
  const t = turnCredentials({ secret: SECRET, host: 'relay.test', clock: () => 1e9, perHour: 2 });
  const a = t.issue('x'), b2 = t.issue('x'), c = t.issue('x'), d = t.issue('y');
  ok(a.turn && b2.turn && c.code === 'rate' && d.turn, 'turnCredentials: perHour answers per identity, then rate; another identity is not held back');
  ok(t.issue('x', 1e9 + HOUR).turn, 'the next clock hour: answered again');
}

// ---- the relay on loopback
const dir = mkdtempSync(join(tmpdir(), 'sigelo-relay-turn-'));
let now = Date.parse('2026-11-26T14:20:00Z') / 1000;
const lines = [];
const cfg = { host: 'relay.test', db: join(dir, 'relay.db'), tcpPort: 0, httpPort: 0, loginRate: 1000, verifyBudget: 1e6, clock: () => now, diskUsed: () => 0.1, log: (l) => lines.push(l),
  push: false, turnSecret: SECRET, turnPerHour: 3 };
let relay = await startRelay(cfg);
const base = () => `http://127.0.0.1:${relay.ports.http}`;
const mq = (creds) => new Promise((resolve) => {
  const c = connect({ host: '127.0.0.1', port: relay.ports.tcp, protocolVersion: 4, clean: false, reconnectPeriod: 0, connectTimeout: 5000, ...creds });
  c.box = []; c.wire = [];
  c.on('message', (t, p) => c.box.push({ t, p }));
  c.on('packetreceive', (p) => c.wire.push(p.cmd === 'publish' ? `notice:${JSON.parse(p.payload).code}` : p.cmd));
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
try {
  const ch = await (await fetch(`${base()}/challenge?did=${encodeURIComponent(bob.did)}`)).json();
  ok(ch.turn === TURN_V, 'GET /challenge says turn: "sigelo-turn/0": a client asks only where it is answered');
  const A = await login(alice);
  const sub = await subscribe(A, TURN_TOPIC);
  ok(sub === 128 || !A.connected, `a SUBSCRIBE to $sigelo/turn is refused (${sub})`);
  const B = await login(bob);
  ok(await publish(B, TURN_TOPIC, Buffer.alloc(0)) === null, 'bob asks: an empty QoS 1 publish to $sigelo/turn, acknowledged');
  const got = notices(B).filter((x) => x.code === 'turn');
  const t = got[0]?.turn;
  ok(got.length === 1 && Number.isSafeInteger(got[0].id) && t && t.v === TURN_V && t.urls.join() === turnUrls('relay.test').join(), 'the answer: one notice {code: "turn", id, turn: {v, urls, …}}');
  ok(t && t.credential === restPassword(SECRET, t.username) && t.username === credentialFor(SECRET, relay.auth.sessionOf(relay.broker.clients[clientId(bob)]).account, now).username && t.exp === credentialFor(SECRET, 'x', now).exp,
    'the credential is coturn\'s: password = base64(HMAC-SHA1(secret, "<exp>:<tag>")), the tag bob\'s account\'s');
  const wi = B.wire.indexOf('notice:turn'), wa = B.wire.indexOf('puback');
  ok(wi >= 0 && wa > wi, `the notice comes before the PUBACK (${B.wire.join(' ')}): one request in flight takes it as its answer`);
  await sleep(100);
  ok(A.box.filter((m) => m.t === TURN_TOPIC).length === 0, 'nothing is delivered on $sigelo/turn');
  for (let i = 0; i < 3; i++) await publish(B, TURN_TOPIC, Buffer.alloc(0));
  const ns = notices(B);
  ok(ns.filter((x) => x.code === 'turn').length === 3 && ns.filter((x) => x.code === 'rate').length === 1 && B.connected, 'past 3 an hour (turnPerHour): notice rate; the session stays');
  now += HOUR;
  await publish(B, TURN_TOPIC, Buffer.alloc(0));
  const last = notices(B).filter((x) => x.code === 'turn').at(-1).turn;
  ok(notices(B).filter((x) => x.code === 'turn').length === 4 && last.exp === t.exp + HOUR, 'the next hour: answered again, a new username');
  const leak = [t.username, t.credential, SECRET, last.credential].filter((s) => lines.some((l) => l.includes(s)));
  ok(leak.length === 0, 'the log holds no username, credential or secret');
  await end(A); await end(B);

  // No secret: GET /challenge says nothing; the topic is a closed session, as any topic the relay does not take.
  await relay.close();
  relay = await startRelay({ ...cfg, db: join(dir, 'off.db'), turnSecret: undefined });
  const off = await (await fetch(`${base()}/challenge?did=${encodeURIComponent(carol.did)}`)).json();
  ok(off.turn === undefined && relay.turn === null, 'no secret: GET /challenge has no turn field');
  const C = await login(carol);
  publish(C, TURN_TOPIC, Buffer.alloc(0));
  ok(await until(() => !C.connected), 'no secret: a publish to $sigelo/turn closes the session (a topic not taken)');
} finally {
  await relay.close();
}
console.log(failed ? `${failed} FAILED, ${n - failed} passed` : `ALL PASS (${n})`);
process.exit(failed ? 1 : 0);
