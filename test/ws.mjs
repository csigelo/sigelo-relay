#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// relay/test/ws.mjs — MQTT over WebSocket on the loopback HTTP port (server.mjs): login, claim,
// send and receive with no MQTT listener at all; what is refused at the upgrade; the client's
// address taken from X-Real-IP behind a stand-in nginx, so two networks land in two rate buckets,
// and believed from loopback only (auth.mjs clientAddress); a WebSocket frame over its cap closed
// at its header, before any byte reaches the MQTT parser, and one left unfinished closed at the
// packet deadline. Prints "ALL PASS (n)".
//   node relay/test/ws.mjs
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { connect as tcpConnect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { connect } from 'mqtt';
import WebSocket from 'ws';
import { MAX_WS_EARLY, MAX_WS_FRAME, MAX_FRAME, startRelay } from '../server.mjs';
import { clientAddress } from '../auth.mjs';
import { clientId, identity, password } from './fixtures.mjs';

let n = 0, failed = 0;
const ok = (cond, what) => { n++; if (cond) console.log(`ok ${what}`); else { failed++; console.log(`FAIL ${what}`); } };
setTimeout(() => { console.log(`FAIL the run did not finish in 120 s (${n} checks so far)`); process.exit(1); }, 120000).unref();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (cond, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (cond()) return true; await sleep(10); } return cond(); };

const dir = mkdtempSync(join(tmpdir(), 'sigelo-relay-ws-'));
const now = Date.parse('2026-10-07T00:00:00Z') / 1000;
const lines = [];
// No tcpPort, no TLS: the HTTP port is the relay's only listener.
const cfg = { host: 'relay.test', db: join(dir, 'relay.db'), httpPort: 0, loginRate: 1000, verifyBudget: 1e6, clock: () => now, diskUsed: () => 0.1, log: (l) => lines.push(l) };
const alice = identity('alice'), bob = identity('bob'), carol = identity('carol');
const topic = () => `m/${randomBytes(16).toString('hex')}`;
const challengeOf = async (id, port) => (await (await fetch(`http://127.0.0.1:${port}/challenge?did=${encodeURIComponent(id.did)}`)).json()).challenge;
// Log in over WebSocket at url → { client } on CONNACK 0, else { error }.
async function wsLogin(id, port, url = `ws://127.0.0.1:${port}/mqtt`) {
  const pw = password(id, await challengeOf(id, port));
  return new Promise((resolve) => {
    const c = connect(url, { protocolVersion: 4, clean: false, clientId: clientId(id), username: id.did, password: pw, reconnectPeriod: 0, connectTimeout: 5000 });
    c.box = [];
    c.on('message', (t, p) => c.box.push({ t, p }));
    c.once('connect', () => resolve({ client: c }));
    c.once('error', (error) => { c.end(true); resolve({ error }); });
    c.once('close', () => resolve({ error: new Error('closed') }));
  });
}
const subscribe = (c, t) => new Promise((resolve) => c.subscribe(t, { qos: 1 }, (e, g) => resolve(e ? -1 : g[0].qos)));
const publish = (c, t, p) => new Promise((resolve) => c.publish(t, p, { qos: 1 }, (e) => resolve(e ?? null)));
const end = (c) => new Promise((resolve) => c.end(false, {}, resolve));
// A raw upgrade request on the HTTP port → { status, protocol, sock } (sock open after a 101).
function upgrade(port, { path = '/mqtt', protocol = 'mqtt', headers = {} } = {}) {
  return new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port, path, headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13',
      'sec-websocket-key': randomBytes(16).toString('base64'), ...(protocol && { 'sec-websocket-protocol': protocol }), ...headers } });
    req.on('upgrade', (res, sock) => resolve({ status: res.statusCode, protocol: res.headers['sec-websocket-protocol'], sock }));
    req.on('response', (res) => { res.resume(); resolve({ status: res.statusCode }); });
    req.on('error', (e) => resolve({ status: 0, error: e }));
    req.end();
  });
}
// A client frame's header (RFC 6455 §5.2: FIN, binary, masked) announcing len bytes of payload.
const frameHead = (len) => {
  const mask = Buffer.from([1, 2, 3, 4]);
  if (len < 126) return Buffer.concat([Buffer.from([0x82, 0x80 | len]), mask]);
  if (len < 65536) { const b = Buffer.from([0x82, 0x80 | 126, 0, 0]); b.writeUInt16BE(len, 2); return Buffer.concat([b, mask]); }
  const b = Buffer.alloc(10); b[0] = 0x82; b[1] = 0x80 | 127; b.writeBigUInt64BE(BigInt(len), 2); return Buffer.concat([b, mask]);
};
const closedSoon = (sock, ms) => new Promise((resolve) => { if (sock.destroyed) return resolve(true); sock.once('close', () => resolve(true)); setTimeout(() => resolve(false), ms); });

// ================================================================ login, claim, send, receive
const relay = await startRelay(cfg);
const port = relay.ports.http;
{
  ok(relay.ports.tcp === undefined && relay.ports.tls === undefined, 'a relay with no MQTT listener: only the loopback HTTP port');
  const a = await wsLogin(alice, port), b = await wsLogin(bob, port);
  ok(a.client?.connected === true && b.client?.connected === true, 'alice and bob log in over WebSocket at /mqtt (subprotocol mqtt)');
  ok(lines.filter((l) => l === 'login 127.0.0.0/24').length === 2, 'each login logged with the peer\'s address cut to /24 (no X-Real-IP: the loopback peer itself)');
  const A = topic();
  ok(await subscribe(a.client, A) === 1, 'alice claims a mailbox over WebSocket');
  const p = randomBytes(100 * 1024);
  ok(await publish(b.client, A, p) === null, 'bob publishes 100 KB to it over WebSocket: acknowledged');
  ok(await until(() => a.client.box.some((m) => m.t === A && Buffer.from(m.p).equals(p))), `alice receives it byte for byte (${a.client.box.map((m) => `${m.t} ${m.p.length}`).join()})`);
  ok(await until(() => relay.db.raw.prepare('SELECT count(*) AS n FROM messages').get().n === 0), 'acknowledged: gone from the queue');
  ok(relay.auth.sessions() === 2, 'two sessions counted');
  await end(a.client); await end(b.client);
  ok(await until(() => relay.auth.sessions() === 0), 'both closed: the session count is back to 0');
}

// ================================================================ the upgrade, refused
{
  const plain = await fetch(`http://127.0.0.1:${port}/mqtt`);
  ok(plain.status === 426, `a plain GET /mqtt: 426 (${plain.status})`);
  await plain.body?.cancel();
  const other = await upgrade(port, { path: '/challenge' });
  ok(other.status === 400, `a WebSocket upgrade at another path: 400 (${other.status})`);
  const noProto = await upgrade(port, { protocol: null });
  ok(noProto.status === 400, `an upgrade at /mqtt without subprotocol mqtt: 400 (${noProto.status})`);
  const good = await upgrade(port);
  ok(good.status === 101 && good.protocol === 'mqtt', `an upgrade at /mqtt asking mqtt: 101, subprotocol mqtt (${good.status} ${good.protocol})`);
  good.sock?.destroy();
}

// ================================================================ frames over their cap
{
  ok(MAX_WS_FRAME === MAX_FRAME + 5 && MAX_WS_EARLY < MAX_WS_FRAME, `the WebSocket frame cap is the largest packet the relay takes (MAX_FRAME + 5 = ${MAX_WS_FRAME}); before the CONNACK the largest CONNECT (${MAX_WS_EARLY})`);
  const errors = () => lines.filter((l) => l.startsWith('error ')).length;
  // Before login: a frame announcing more than a CONNECT may hold, with 10 bytes of it sent.
  const e0 = errors(), u = await upgrade(port);
  u.sock.write(Buffer.concat([frameHead(MAX_WS_EARLY + 1), Buffer.alloc(10)]));
  ok(await closedSoon(u.sock, 2000) && relay.early() === 0, 'before the CONNACK, a frame announcing more than the largest CONNECT: closed at its header, nothing held');
  ok(await until(() => lines.slice(-5).some((l) => / size$/.test(l))) && errors() > e0, 'logged as a size refusal');
  // After login: a frame announcing more than the largest packet.
  const pw = password(carol, await challengeOf(carol, port));
  let sockOf = null;
  const c = await new Promise((resolve) => {
    // Her WebSocket kept (createWebsocket), so a test can write under MQTT.js.
    const x = connect(`ws://127.0.0.1:${port}/mqtt`, { protocolVersion: 4, clean: false, clientId: clientId(carol), username: carol.did, password: pw, reconnectPeriod: 0,
      createWebsocket: (url, protocols) => (sockOf = new WebSocket(url, protocols)) });
    x.once('connect', () => resolve(x)); x.once('error', () => resolve(null));
  });
  ok(c?.connected === true, 'carol logs in over WebSocket');
  // Under the cap: a 1 MB PUBLISH in one frame reaches the relay's own size rule (too_large, past
  // this relay's 256 KB message), and the connection stays.
  const C = topic();
  await subscribe(c, C);
  ok(await publish(c, C, randomBytes(1024 * 1024 - 64)) === null && c.connected, 'a 1 MB PUBLISH in one frame: passes the frame cap, the connection stays');
  const raw = sockOf?._socket ?? null;
  const before = relay.partial();
  // The frame header goes straight onto her socket, under MQTT.js: the relay must cut it there.
  raw?.write(frameHead(MAX_WS_FRAME + 1));
  ok(raw !== null && await until(() => !c.connected, 2000) && relay.partial() === before, 'after login, a frame announcing more than the largest packet: closed at its header, nothing held');
  c.end(true);
  ok(await until(() => relay.auth.sessions() === 0), 'and her session no longer counts');
}

// ================================================================ a frame left unfinished
{
  const slow = await startRelay({ ...cfg, db: join(dir, 'slow.db'), frameMs: 300, log: () => {} });
  const u = await upgrade(slow.ports.http);
  u.sock.write(Buffer.concat([frameHead(200), Buffer.alloc(20)]));
  ok(await until(() => slow.early() === 20, 1000), 'an unfinished frame\'s bytes are held against the budget of packets before the CONNACK');
  ok(await closedSoon(u.sock, 2000) && slow.early() === 0, 'and the connection is closed at the packet deadline, the budget given back');
  // Many unfinished frames from one network: past its budget, closed.
  const tight = await startRelay({ ...cfg, db: join(dir, 'tight.db'), earlyPerPrefix: 1000, log: () => {} });
  const socks = [];
  for (let i = 0; i < 3; i++) { const v = await upgrade(tight.ports.http); v.sock.write(Buffer.concat([frameHead(2000), Buffer.alloc(400)])); socks.push(v.sock); }
  await sleep(200);
  ok(socks.filter((s) => s.destroyed).length >= 1 && tight.early() <= 1000, `three unfinished frames of 400 bytes from one /24 on a budget of 1,000: one closed (${socks.filter((s) => s.destroyed).length}), ${tight.early()} held`);
  for (const s of socks) s.destroy();
  await slow.close(); await tight.close();
}

// ================================================================ X-Real-IP behind a stand-in nginx
// What relay/deploy/nginx.conf does for /mqtt: from loopback, the upgrade passed on with X-Real-IP
// set to the client's address. Each front stands for clients of one network.
function standInNginx(target, realIp) {
  const front = createServer((req, res) => { res.writeHead(404); res.end(); });
  front.on('upgrade', (req, sock, head) => {
    const up = tcpConnect(target, '127.0.0.1', () => {
      const headers = Object.entries({ ...req.headers, 'x-real-ip': realIp }).map(([k, v]) => `${k}: ${v}`).join('\r\n');
      up.write(`GET ${req.url} HTTP/1.1\r\n${headers}\r\n\r\n`);
      if (head.length) up.write(head);
      up.pipe(sock); sock.pipe(up);
    });
    for (const s of [up, sock]) { s.on('error', () => { up.destroy(); sock.destroy(); }); s.on('close', () => { up.destroy(); sock.destroy(); }); }
  });
  return new Promise((resolve) => front.listen(0, '127.0.0.1', () => resolve(front)));
}
{
  const rl = [];
  const r = await startRelay({ ...cfg, db: join(dir, 'rate.db'), loginRate: 2, log: (l) => rl.push(l) });
  const netA = await standInNginx(r.ports.http, '198.51.100.7'), netB = await standInNginx(r.ports.http, '203.0.113.9');
  const via = (front) => `ws://127.0.0.1:${front.address().port}/mqtt`;
  // Challenges asked with X-Real-IP from yet other networks, so only the CONNECTs count here.
  const login = async (id, front, ip) => {
    const ch = (await (await fetch(`http://127.0.0.1:${r.ports.http}/challenge?did=${encodeURIComponent(id.did)}`, { headers: { 'x-real-ip': ip } })).json()).challenge;
    return new Promise((resolve) => {
      const c = connect(via(front), { protocolVersion: 4, clean: false, clientId: clientId(id), username: id.did, password: password(id, ch), reconnectPeriod: 0, connectTimeout: 5000 });
      c.once('connect', () => resolve({ client: c }));
      c.once('error', (error) => { c.end(true); resolve({ error }); });
    });
  };
  const a1 = await login(alice, netA, '2001:db8:1::1'), a2 = await login(bob, netA, '2001:db8:2::1'), a3 = await login(carol, netA, '2001:db8:3::1');
  ok(a1.client && a2.client && a3.error?.code === 3, `RELAY_LOGIN_RATE=2: two CONNECTs over WebSocket from 198.51.100.0/24 pass, the third is refused (${a3.error?.code ?? 'connected'})`);
  const b1 = await login(carol, netB, '2001:db8:4::1');
  ok(b1.client?.connected === true, 'the same third login from 203.0.113.0/24, through the other front: passes, a bucket of its own');
  ok(rl.filter((l) => l === 'login 198.51.100.0/24').length === 2 && rl.includes('refused 198.51.100.0/24 rate') && rl.includes('login 203.0.113.0/24') && !rl.some((l) => l.includes('127.0.0.0/24')),
    'the relay logs and counts the X-Real-IP network for each, never 127.0.0.0/24 (the front\'s own address)');
  ok(r.auth.prefixOf(a1.client && [...Object.values(r.broker.clients)].find((c) => c.id === clientId(alice))) === '198.51.100.0/24', 'the session itself is held under 198.51.100.0/24 (the per-network session cap counts it there)');
  for (const x of [a1, a2, b1]) x.client?.end(true);
  for (const f of [netA, netB]) f.close();
  await r.close();
}
{
  // The rule itself, which /challenge, /check and the upgrade share: X-Real-IP from a loopback peer
  // only. The listener is bound to 127.0.0.1, so a peer elsewhere is shown to it as such.
  const at = (peer, real) => clientAddress({ socket: { remoteAddress: peer }, headers: real === undefined ? {} : { 'x-real-ip': real } });
  ok(at('127.0.0.1', '198.51.100.7') === '198.51.100.7' && at('::1', '2001:db8::1') === '2001:db8::1' && at('::ffff:127.0.0.1', '203.0.113.1') === '203.0.113.1',
    'clientAddress: X-Real-IP believed from 127.0.0.0/8, ::1 and ::ffff:127.x');
  ok(at('192.0.2.5', '198.51.100.7') === '192.0.2.5' && at('2001:db8::5', '127.0.0.1') === '2001:db8::5' && at('10.0.0.1', '198.51.100.7') === '10.0.0.1',
    'clientAddress: X-Real-IP sent by a peer that is not loopback is ignored: the peer\'s own address counts');
  ok(at('127.0.0.1') === '127.0.0.1' && at('127.0.0.1', ['a', 'b']) === '127.0.0.1', 'clientAddress: no X-Real-IP, or a repeated one: the peer\'s address');
}

await relay.close();
rmSync(dir, { recursive: true, force: true });
console.log(failed ? `${failed} FAILED (${n})` : `ALL PASS (${n})`);
process.exit(failed ? 1 : 0);
