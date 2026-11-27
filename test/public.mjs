#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// relay/test/public.mjs — public codes (sigelo-public/0, park.mjs) on a
// relay of its own: Pro only, the answer topic claimed first, fetched without being spent and on a
// brake of its own, the mailbox's guard (once a day, the cap, Pause, Revoke), 3 per account, a year
// at most, kept across a restart, the sweep; one-time short codes as before. Prints "ALL PASS (n)".
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, hkdfSync, randomBytes } from 'node:crypto';
import { connect } from 'mqtt';
import { canonicalize, multibase } from 'sigelo';
import { startRelay } from '../server.mjs';
import { accountOf } from '../db.mjs';
import { PUBLIC_CAP, PUBLIC_FETCHES, PUBLIC_TTL_MAX, publicTopic } from '../park.mjs';
import { clientId, identity, password } from './fixtures.mjs';

let n = 0, failed = 0;
const ok = (cond, what) => { n++; if (cond) console.log(`ok ${what}`); else { failed++; console.log(`FAIL ${what}`); } };
setTimeout(() => { console.log(`FAIL the run did not finish in 120 s (${n} checks so far)`); process.exit(1); }, 120000).unref();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (cond, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (cond()) return true; await sleep(10); } return cond(); };

const DAY = 86400;
const dir = mkdtempSync(join(tmpdir(), 'sigelo-public-'));
let now = Date.parse('2026-11-13T10:00:00Z') / 1000;
const alice = identity('alice'), bob = identity('bob'), carol = identity('carol'), hana = identity('hana'), ivan = identity('ivan');
const pro = new Set([accountOf(alice.original)]);
const cfg = { host: 'relay.test', db: join(dir, 'relay.db'), tcpPort: 0, httpPort: 0, loginRate: 1000, verifyBudget: 1e6, clock: () => now, diskUsed: () => 0.1, log: () => {},
  park: { pro: (account) => pro.has(account) } };
let relay = await startRelay(cfg);
const base = () => `http://127.0.0.1:${relay.ports.http}`;
const H = (b) => createHash('sha256').update(b).digest();
const realIp = (ip) => (ip ? { 'x-real-ip': ip } : {});

// A long code, apps/contact/invite.mjs's layout spelled out: version | DID digest | secret | exp | relay length | relay | checksum.
const longCode = (id, { version = 2, exp = now + 180 * DAY, secret = randomBytes(32) } = {}) => {
  const host = Buffer.from('relay.test'), e = Buffer.alloc(4);
  e.writeUInt32BE(exp);
  const body = Buffer.concat([Buffer.from([version]), H(canonicalize(id.genesis)), secret, e, Buffer.from([host.length]), host]);
  return { text: (version === 2 ? 'sgl2' : 'sgl1') + multibase(Buffer.concat([body, H(body).subarray(0, 4)])).slice(1), secret };
};
const pubHash = (code) => H(`sigelo-public/0${code}`).toString('hex');
let net = 0;
const nextIp = () => `10.${Math.floor(++net / 256)}.${net % 256}.7`;
const login = async (id, ip = nextIp()) => {
  const { challenge } = await (await fetch(`${base()}/challenge?did=${encodeURIComponent(id.did)}`, { headers: realIp(ip) })).json();
  return { username: id.did, client_id: clientId(id), password: password(id, challenge) };
};
const call = async (method, path, id, fields = {}, ip = nextIp()) => {
  const res = await fetch(`${base()}${path}`, { method, headers: realIp(ip), body: JSON.stringify({ ...(await login(id, ip)), ...fields }) });
  return { status: res.status, json: await res.json() };
};
const get = async (h, ip = '203.0.113.9') => { const res = await fetch(`${base()}/park/${h}`, { headers: realIp(ip) }); return { status: res.status, json: await res.json() }; };
const mqtt = async (id) => {
  const { challenge } = await (await fetch(`${base()}/challenge?did=${encodeURIComponent(id.did)}`)).json();
  return new Promise((resolve, reject) => {
    const c = connect({ host: '127.0.0.1', port: relay.ports.tcp, protocolVersion: 4, clean: false, clientId: clientId(id), username: id.did, password: password(id, challenge), reconnectPeriod: 0, connectTimeout: 5000 });
    c.box = [];
    c.on('message', (t, p) => c.box.push({ t, p }));
    c.once('connect', () => resolve(c));
    c.once('error', reject);
  });
};
const subscribe = (c, t) => new Promise((resolve) => c.subscribe(t, { qos: 1 }, (e, g) => resolve(e ? 128 : g[0].qos)));
const publish = (c, t, p) => new Promise((resolve) => c.publish(t, p, { qos: 1 }, () => resolve()));
const notices = (c) => c.box.filter((m) => m.t === '$sigelo/notice').map((m) => JSON.parse(m.p).code);
const end = (c) => new Promise((resolve) => c.end(false, {}, resolve));
// A joiner's answer: published, then the codes of the notices it got for it.
const answer = async (id, topic) => {
  const c = await mqtt(id);
  await publish(c, topic, randomBytes(200));
  await sleep(50);
  const got = notices(c);
  await end(c);
  return got;
};

// ---- parking: the topic first, Pro only ----
const one = longCode(alice), topic = publicTopic(one.secret), code = 'PUB7Q4KM2XD'.slice(3), h = pubHash('7Q4KM2XD');
ok(topic === 'm/' + Buffer.from(hkdfSync('sha256', one.secret, Buffer.alloc(0), 'sigelo-public/0 answer topic', 16)).toString('hex') && code.length === 8,
  'the answer topic: m/ + hex HKDF-SHA256(secret, no salt, "sigelo-public/0 answer topic", 16)');
let r = await call('POST', '/park', alice, { code_hash: h, invite: one.text, exp: now + 180 * DAY });
ok(r.json.ok === false && r.json.check === 'public_topic', `a public code before its answer topic is claimed: public_topic (${r.json.detail})`);
const b = longCode(bob), bc = await mqtt(bob);
await subscribe(bc, publicTopic(b.secret));
r = await call('POST', '/park', bob, { code_hash: pubHash('BBBBBBBB'), invite: b.text, exp: now + 30 * DAY });
ok(r.json.ok === false && r.json.check === 'public_pro' && /Pro/.test(r.json.detail), `without Pro: public_pro (${r.json.detail})`);
await end(bc);
const ac = await mqtt(alice);
ok(await subscribe(ac, topic) === 1, 'alice claims the answer topic, an ordinary mailbox');
r = await call('POST', '/park', alice, { code_hash: h, invite: one.text, exp: now + 180 * DAY });
const endOfDay = Math.ceil((now + 180 * DAY) / DAY) * DAY;
ok(r.json.ok === true && r.json.public === true && r.json.cap === PUBLIC_CAP && PUBLIC_CAP === 50 && r.json.exp === endOfDay && r.json.topic === topic,
  `POST /park: a public code, kept to the end of its UTC day, cap 50 by default (${JSON.stringify(r.json)})`);
const rows = () => relay.db.raw.prepare('SELECT * FROM public_codes').all();
ok(rows().length === 1 && rows()[0].invite === one.text && rows()[0].owner === accountOf(alice.original), 'kept in the database, table public_codes');

// ---- what may be parked ----
const refusal = async (fields, what, want = 'park') => {
  const x = await call('POST', '/park', alice, { code_hash: pubHash('ZZZZZZZZ'), invite: longCode(alice).text, exp: now + 30 * DAY, ...fields });
  ok(x.json.ok === false && x.json.check === want, `POST /park refuses ${what} (${x.json.check}: ${x.json.detail})`);
};
await refusal({ cap: 0 }, 'a cap of 0');
await refusal({ cap: 501 }, 'a cap over 500');
await refusal({ exp: now + PUBLIC_TTL_MAX + 400, invite: longCode(alice, { exp: now + PUBLIC_TTL_MAX + 400 }).text }, 'a life past a year');
await refusal({ invite: longCode(alice, { version: 1, exp: now + 600 }).text, exp: now + 600, cap: 5 }, 'a cap with a one-time code');
r = await call('POST', '/park', alice, { code_hash: h, invite: one.text, exp: now + 180 * DAY });
ok(r.json.check === 'park_taken', 'the same hash again: park_taken');

// ---- fetched, never spent; a brake of its own ----
const f1 = await get(h), f2 = await get(h);
ok(f1.status === 200 && f1.json.invite === one.text && f1.json.public === true && f2.status === 200 && f2.json.invite === one.text, 'GET /park/<hash>: the public code, again and again');
let last;
for (let i = 0; i < PUBLIC_FETCHES.n - 2; i++) last = await get(h);
const over = await get(h), miss = await get(pubHash('QQQQQQQQ'));
ok(last.status === 200 && over.status === 429 && over.json.check === 'rate' && /public-code/.test(over.json.detail) && miss.status === 404 && miss.json.check === 'park_unknown',
  `the public brake: ${PUBLIC_FETCHES.n} per network per 10 minutes, then 429; the network's short-code lookups untouched (a miss is still park_unknown)`);
ok((await get(h, '198.51.100.20')).status === 200, 'another network fetches it');

// ---- the mailbox's guard ----
ok((await answer(carol, topic)).length === 0 && await until(() => ac.box.some((m) => m.t === topic)), 'a joiner\'s answer reaches the inviter');
ok((await answer(carol, topic)).includes('public_once'), 'the same joiner again today: public_once');
r = await call('POST', `/park/${h}`, alice, { cap: 2 });
ok(r.status === 200 && r.json.ok === true && r.json.cap === 2 && r.json.paused === false, `POST /park/<hash>: the parker sets the cap (${JSON.stringify(r.json)})`);
r = await call('POST', `/park/${h}`, bob, { cap: 9 });
ok(r.status === 404 && r.json.check === 'park_unknown', 'another identity sets nothing: park_unknown');
ok((await answer(hana, topic)).length === 0, 'a second joiner: taken (2 of 2)');
ok((await answer(ivan, topic)).includes('public_cap'), 'a third: public_cap');
r = await call('POST', `/park/${h}`, alice, { paused: true });
const paused = await get(h, '198.51.100.21');
ok(r.json.paused === true && paused.status === 409 && paused.json.check === 'public_paused', `Pause: GET answers 409 public_paused (${paused.json.detail})`);
now += DAY;
ok((await answer(ivan, topic)).includes('public_paused'), 'paused: an answer is refused public_paused, even on a new day');
r = await call('POST', `/park/${h}`, alice, { paused: false, cap: 1 });
ok(r.json.paused === false && (await get(h, '198.51.100.22')).status === 200, 'Resume: fetched again');
ok((await answer(ivan, topic)).length === 0, 'a new UTC day: the count starts again');

// ---- 3 per account ----
const more = [longCode(alice), longCode(alice), longCode(alice)];
for (const x of more) await subscribe(ac, publicTopic(x.secret));
const p2 = await call('POST', '/park', alice, { code_hash: pubHash('22222222'), invite: more[0].text, exp: now + 30 * DAY, cap: 500 });
const p3 = await call('POST', '/park', alice, { code_hash: pubHash('33333333'), invite: more[1].text, exp: now + 2 * DAY });
const p4 = await call('POST', '/park', alice, { code_hash: pubHash('44444444'), invite: more[2].text, exp: now + 30 * DAY });
ok(p2.json.ok && p2.json.cap === 500 && p3.json.ok && p4.json.check === 'public_full', `at most 3 live per account: the fourth is public_full (${p4.json.detail})`);

// ---- a restart: the codes, the count, the settings kept ----
await end(ac);
await relay.close();
relay = await startRelay(cfg);
const after = await get(h, '198.51.100.30');
ok(after.status === 200 && after.json.invite === one.text && relay.park.publics() === 3, 'after a restart: the public codes are still there');
ok((await answer(carol, topic)).includes('public_cap'), 'after a restart: today\'s count kept (cap 1, taken)');

// ---- Revoke for all ----
r = await call('DELETE', `/park/${h}`, bob);
ok(r.status === 404 && r.json.check === 'park_unknown', 'another identity revokes nothing');
r = await call('DELETE', `/park/${h}`, alice);
const gone = await get(h, '198.51.100.31');
ok(r.status === 200 && r.json.ok === true && gone.status === 404 && gone.json.check === 'park_unknown', 'DELETE /park/<hash>: revoked, GET is park_unknown');
now += DAY;
ok((await answer(hana, topic)).includes('public_revoked'), 'an answer to a revoked code: public_revoked');
const ac2 = await mqtt(alice);
await subscribe(ac2, publicTopic(more[2].text === '' ? Buffer.alloc(32) : more[2].secret));
r = await call('POST', '/park', alice, { code_hash: h, invite: more[2].text, exp: now + 30 * DAY });
ok(r.json.check === 'park_taken', 'a revoked hash stays taken until its exp (a tombstone row)');
await relay.close();
relay = await startRelay(cfg);
ok((await get(h, '198.51.100.32')).status === 404 && rows().some((x) => x.code_hash === h && x.invite === null), 'the tombstone survives a restart');
r = await call('POST', '/park', alice, { code_hash: pubHash('44444444'), invite: more[2].text, exp: now + 30 * DAY });
ok(r.json.ok === true, 'a revoked code no longer counts against the 3: another parks');

// ---- the sweep ----
now += 3 * DAY;
relay.sweep(now);
ok(!rows().some((x) => x.code_hash === pubHash('33333333')) && rows().some((x) => x.code_hash === pubHash('22222222')), 'the sweep drops a code after its exp, and keeps the others');

// ---- one-time codes as before ----
const once = longCode(alice, { version: 1, exp: now + 600 }), oh = H('sigelo-park/0K7F3Q9ZP').toString('hex');
r = await call('POST', '/park', alice, { code_hash: oh, invite: once.text, exp: now + 600 });
const o1 = await get(oh), o2 = await get(oh);
ok(r.json.ok === true && r.json.public === undefined && o1.status === 200 && o1.json.public === undefined && o2.status === 404, 'a one-time code: parked, fetched once, as before');

await end(ac2);
await relay.close();
console.log(failed ? `${failed} FAILED of ${n}` : `ALL PASS (${n})`);
process.exit(failed ? 1 : 0);
