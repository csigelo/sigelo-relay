#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// relay/test/home.mjs — home-relay groups (home.mjs, sigelo-home/0): the entry head as the relay reads
// it (and, inside sigelo's tree, against apps/contact/home-wire.mjs), then the relay on loopback with
// M4's policy: create, the tier's groups and members, append under the member and admin credential,
// refusals by name, fetch-since in pages and live rows, keep slots, the door and its caps, GRP codes,
// a renewal (letters parts, the switch, the old epoch's end), channel mode, the group's rate and the
// owner's storage, handover, the supergroup slot (the operator verb) and name card, moved, end,
// drop, the sweep, what the file holds; wakes (who a row, a door row wakes; a kicked member not);
// then 1,000 members: one renewal, 1,000 opens fetching the
// log, one live row to all, the 1,001st refused. Prints "ALL PASS (n)" and the timings.
//   node relay/test/home.mjs
import { createECDH, createHash, generateKeyPairSync, randomBytes, sign as edSign } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect } from 'mqtt';
import { attest, canonicalize, sign, verify } from 'sigelo';
import { startRelay } from '../server.mjs';
import { accountOf } from '../db.mjs';
import { relayPolicy } from '../allowance.mjs';
import { CHANNEL_ENTRY, DOOR_HEAD, FLAG, HOME_TOPIC, HOME_V, MIN_DOOR, MIN_ENTRY, NAME_GRACE, SLOT_CTX, controlInput, doorRefusal, entryInput, openInput, readEntry, topicOf } from '../home.mjs';
import { LICENCE_CTX } from '../operator.mjs';
import { bundleOf, clientId, identity, password, rotated } from './fixtures.mjs';

let n = 0, failed = 0;
const ok = (cond, what) => { n++; if (cond) console.log(`ok ${what}`); else { failed++; console.log(`FAIL ${what}`); } };
setTimeout(() => { console.log(`FAIL the run did not finish in 900 s (${n} checks so far)`); process.exit(1); }, 900000).unref();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (cond, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { if (cond()) return true; await sleep(5); } return cond(); };
const HERE = dirname(fileURLToPath(import.meta.url));
const HOST = 'relay.test', DAY = 86400, YEAR = 365 * DAY;
const hex = (b) => Buffer.from(b).toString('hex');

// ---- the client's side, spelled out here (the relay is published alone; home-wire.mjs is MIT) ----
// An Ed25519 write key: {pub (32 bytes), b64 (base64url), sign(msg)}.
function writeKey() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pub = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
  return { pub, b64: pub.toString('base64url'), sign: (m) => edSign(null, m, privateKey) };
}
// An entry of `size` bytes (rounded up to a padded body) under key k: head ‖ credential ‖ random.
function entry(topic, epoch, k, { flags = 0, slot = 0, size = MIN_ENTRY } = {}) {
  const len = MIN_ENTRY + Math.ceil(Math.max(0, size - MIN_ENTRY) / 256) * 256;
  const b = Buffer.concat([Buffer.from([2, 3, flags, slot]), Buffer.alloc(4), Buffer.alloc(64), randomBytes(len - 72)]);
  b.writeUInt32BE(epoch, 4);
  k.sign(entryInput(b, topic)).copy(b, 8);
  return b;
}
const doorBytes = (size = MIN_DOOR) => Buffer.concat([Buffer.from([2, 4]), randomBytes(MIN_DOOR - 2 + Math.ceil(Math.max(0, size - MIN_DOOR) / 256) * 256)]);
const newGid = () => randomBytes(16).toString('hex');
const signed = (req, k) => ({ ...req, sig: k.sign(controlInput(req)).toString('base64url') });
const proofOf = (topic, epoch, account, k, t) => k.sign(openInput(topic, epoch, account, Math.floor(t / DAY))).toString('base64url');

// ---- the relays ----
const dir = mkdtempSync(join(tmpdir(), 'sigelo-relay-home-'));
let now = Date.parse('2026-11-27T10:00:00Z') / 1000;
const vendor = identity('vendor'), operatorId = identity('relay operator');
const lines = [];
const T = Object.freeze({ m: 8, t: 1, p: 1 });
const BIG = { perSecond: 1e6, burst: 1e6 };
const policyConfig = (extra = {}) => ({ vendor: vendor.original, pow: { bits: 0, loadBits: 0, loadPerHour: 1e9, perDay: 1e6, steps: [{ from: 1e6, add: 1 }], cost: T }, licenceRate: 1000, freeQueue: 1024 * 1024 * 1024,
  rate: { publish: BIG, subscribe: BIG, claim: BIG, network: { publish: BIG, subscribe: BIG, claim: BIG }, strikes: 1e6 }, ...extra });
const base = { host: HOST, tcpPort: 0, httpPort: 0, loginRate: 1e6, verifyBudget: 1e9, maxSessions: 5000, maxPerPrefix: 5000, clock: () => now, diskUsed: () => 0.1, push: false, operator: operatorId.original };
let pol;
const relay = await startRelay({ ...base, db: join(dir, 'relay.db'), log: (l) => lines.push(l), policy: (ctx) => (pol = relayPolicy(ctx, policyConfig())),
  homeLimits: { entryRate: { free: BIG, paid: BIG }, page: 4 } });
// R2: the default entry rate, and a free tier of 1.5 MB, for the group's rate and the owner's storage.
const R2 = await startRelay({ ...base, db: join(dir, 'r2.db'), log: () => {}, policy: (ctx) => relayPolicy(ctx, policyConfig({ tiers: { free: { storage: 1536 * 1024 } } })) });

const http = (r) => `http://127.0.0.1:${r.ports.http}`;
async function login(id, r = relay) {
  const ch = await (await fetch(`${http(r)}/challenge?did=${encodeURIComponent(id.did)}`)).json();
  const c = await new Promise((resolve) => {
    const x = connect({ host: '127.0.0.1', port: r.ports.tcp, protocolVersion: 4, clean: false, clientId: clientId(id), username: id.did, password: password(id, ch.challenge), reconnectPeriod: 0, connectTimeout: 10000, keepalive: 120 });
    x.box = []; x.rows = new Map(); x.notes = [];
    x.on('message', (t, p) => {
      if (t === '$sigelo/notice') { const v = JSON.parse(p); if (v.code !== 'tier') x.notes.push(v); return; }
      if (t.startsWith('g/')) { let m = x.rows.get(t); if (!m) { m = []; x.rows.set(t, m); } m.push({ lane: p[0], seq: Number(p.readBigUInt64BE(1)), bytes: p.subarray(9) }); return; }
      x.box.push({ t, p });
    });
    x.once('connect', () => resolve(x));
    x.once('error', (e) => { x.end(true); resolve({ error: e }); });
  });
  c.challenge = ch; c.id = id; c.account = accountOf(id.original);
  return c;
}
// A publish, then the notice it drew (written before its PUBACK, carrying its packet id), or null.
async function send(c, t, p) {
  const id = await new Promise((resolve) => c.publish(t, p, { qos: 1 }, (e, pk) => resolve(pk?.messageId)));
  return c.notes.findLast((x) => x.id === id) ?? null;
}
const ctl = (c, req) => send(c, HOME_TOPIC, Buffer.from(JSON.stringify({ v: HOME_V, ...req })));
const rowsOf = (c, t) => c.rows.get(t) ?? [];
const seqs = (c, t) => rowsOf(c, t).map((r) => r.seq).join();
const end = (c) => new Promise((resolve) => (c.end ? c.end(false, {}, resolve) : resolve()));
const count = (r, sql, ...p) => Number(r.db.raw.prepare(sql).get(...p).n);
const postJson = async (r, path, body, method = 'POST') => { const res = await fetch(`${http(r)}${path}`, { method, body: JSON.stringify(body) }); return { status: res.status, json: await res.json() }; };
const loginFields = async (id, r = relay) => {
  const ch = await (await fetch(`${http(r)}/challenge?did=${encodeURIComponent(id.did)}`)).json();
  return { username: id.did, client_id: clientId(id), password: password(id, ch.challenge) };
};
// A group made by owner session c: its gid, topic and epoch-1 keys.
async function makeGroup(c, { members = 8, channel = false } = {}) {
  const gid = newGid(), topic = topicOf(gid), W = writeKey(), AW = writeKey();
  const a = await ctl(c, { typ: 'create', topic, write: W.b64, admin: AW.b64, members, channel });
  return { gid, topic, W, AW, epoch: 1, a };
}
const open = (c, g, { since = 0, as = 'member', epoch = g.epoch, key } = {}) => ctl(c, { typ: 'open', topic: g.topic, epoch, since, as, proof: proofOf(g.topic, epoch, c.account, key ?? (as === 'admin' ? g.AW : g.W), now) });

// ================================================================ the entry head, by itself
{
  const W = writeKey(), topic = topicOf(newGid());
  const good = entry(topic, 1, W), r = readEntry(good);
  ok(r.epoch === 1 && r.flags === 0 && !r.why, `readEntry: a ${good.length}-byte entry (head, header, one padded block) reads epoch 1, flags 0`);
  const bad = [
    ['short', good.subarray(0, MIN_ENTRY - 1)], ['version', Buffer.concat([Buffer.from([1]), good.subarray(1)])], ['kind', Buffer.concat([Buffer.from([2, 4]), good.subarray(2)])],
    ['padding', Buffer.concat([good, Buffer.alloc(1)])], ['flags 8', Buffer.concat([Buffer.from([2, 3, 8, 0]), good.subarray(4)])],
    ['keep without slot', Buffer.concat([Buffer.from([2, 3, FLAG.keep | FLAG.admin, 0]), good.subarray(4)])], ['slot 10', Buffer.concat([Buffer.from([2, 3, FLAG.keep | FLAG.admin, 10]), good.subarray(4)])],
    ['slot without keep', Buffer.concat([Buffer.from([2, 3, 0, 1]), good.subarray(4)])], ['kept, member credential', Buffer.concat([Buffer.from([2, 3, FLAG.keep, 1]), good.subarray(4)])],
    ['letters, member credential', Buffer.concat([Buffer.from([2, 3, FLAG.letters, 0]), good.subarray(4)])], ['letters kept', Buffer.concat([Buffer.from([2, 3, 7, 1]), good.subarray(4)])],
    ['epoch 0', Buffer.concat([good.subarray(0, 4), Buffer.alloc(4), good.subarray(8)])],
  ].filter(([, b]) => !readEntry(b).why).map(([w]) => w);
  ok(bad.length === 0, `readEntry refuses: short, version, kind, not padded, flag bit 3, keep without a slot, slot 10, a slot without keep, a kept or letters entry under the member credential, letters kept, epoch 0${bad.length ? ` (taken: ${bad})` : ''}`);
  const largest = MIN_DOOR + Math.floor((16 * 1024 - MIN_DOOR) / 256) * 256;
  ok(doorRefusal(doorBytes()) === null && doorRefusal(doorBytes(largest)) === null && doorRefusal(doorBytes(largest + 256)) !== null && doorRefusal(Buffer.concat([Buffer.from([2, 3]), doorBytes().subarray(2)])) !== null
    && doorRefusal(Buffer.concat([doorBytes(), Buffer.alloc(1)])) !== null && DOOR_HEAD === 1130, `doorRefusal: ${MIN_DOOR} to 16 KiB, kind 4, padded; over 16 KiB, kind 3, unpadded refused`);
  // Inside sigelo's tree: the wire as apps/contact/home-wire.mjs builds it reads the same here.
  const wire = join(HERE, '..', '..', 'apps', 'contact', 'home-wire.mjs');
  if (existsSync(wire)) {
    const w = await import(wire);
    const gid = newGid(), t = w.topicOf(gid), e = entry(t, 3, W, { flags: FLAG.admin | FLAG.keep, slot: 2 });
    let parsed;
    try { parsed = w.parseEntry(new Uint8Array(e)); } catch { parsed = null; }
    ok(t === topicOf(gid) && w.credentialOk(new Uint8Array(e), t, { write: new Uint8Array(32), admin: new Uint8Array(W.pub) }) && parsed?.epoch === 3 && parsed.slot === 2
      && !w.credentialOk(new Uint8Array(Buffer.concat([e.subarray(0, 200), Buffer.from([e[200] ^ 1]), e.subarray(201)])), t, { write: W.pub, admin: W.pub }),
    'home-wire.mjs agrees: the same topic for a gid, its parseEntry reads this head, its credentialOk accepts this credential and refuses a flipped byte');
  } else ok(true, 'home-wire.mjs agrees: skipped (relay/ published alone)');
}

// ================================================================ create, the tier, append
const owner = identity('home owner'), member = identity('home member'), joiner = identity('home joiner'), stranger = identity('home stranger');
const O = await login(owner), M = await login(member), J = await login(joiner), S = await login(stranger);
ok(O.challenge?.home === HOME_V && !O.error && !M.error, 'GET /challenge says home: "sigelo-home/0"; the owner and a member log in');
const g = await makeGroup(O);
ok(g.a?.code === 'home' && g.a.typ === 'created' && g.a.epoch === 1 && g.a.seq === 0 && g.a.cap === 8 && count(relay, 'SELECT count(*) AS n FROM homes WHERE topic = ?', g.topic) === 1,
  `create: answered {code: "home", typ: "created", epoch 1, seq 0, cap 8} before the PUBACK; the free owner's cap is 8 (${JSON.stringify(g.a)})`);
const again = await ctl(O, { typ: 'create', topic: g.topic, write: g.W.b64, admin: g.AW.b64, members: 2, channel: false });
const nine = await ctl(O, { typ: 'create', topic: topicOf(newGid()), write: g.W.b64, admin: g.AW.b64, members: 9, channel: false });
const shape = await ctl(O, { typ: 'create', topic: topicOf(newGid()), write: 'x', admin: g.AW.b64, members: 2, channel: false });
const extra = await ctl(O, { typ: 'create', topic: topicOf(newGid()), write: g.W.b64, admin: g.AW.b64, members: 2, channel: false, more: 1 });
ok(again?.code === 'home_taken' && nine?.code === 'home_cap' && shape?.code === 'home_request' && extra?.code === 'home_request' && typeof again.id === 'number',
  `create refused by name, with the packet id: the topic taken (home_taken), 9 members on the free tier (home_cap), a bad key or an extra field (home_request) (${[again, nine, shape, extra].map((x) => x?.code)})`);
const g2 = await makeGroup(O), g3 = await makeGroup(O), g4 = await makeGroup(O);
ok(g2.a?.typ === 'created' && g3.a?.typ === 'created' && g4.a?.code === 'home_limit', `a free owner makes 3 home groups here, the 4th is refused home_limit (${g4.a?.code})`);

let a = await open(O, g, { as: 'admin' });
ok(a?.typ === 'opened' && a.epoch === 1 && a.first === 1 && a.last === 0, `open as admin (proof by AW over topic, epoch, account, day): opened, epoch 1, rows 1 to 0 (${JSON.stringify(a)})`);
const r1 = await send(O, g.topic, entry(g.topic, 1, g.W)), r2 = await send(O, g.topic, entry(g.topic, 1, g.AW, { flags: FLAG.admin }));
ok(r1 === null && r2 === null && count(relay, 'SELECT count(*) AS n FROM home_rows WHERE topic = ?', g.topic) === 2, 'append: an entry under the member credential and one under the admin credential are stored, no notice');
const refusals = [
  ['home_credential', await send(O, g.topic, entry(g.topic, 1, writeKey()))],
  ['home_credential', await send(O, g.topic, entry(g.topic, 1, g.W, { flags: FLAG.admin }))],
  ['home_epoch', await send(O, g.topic, entry(g.topic, 2, g.W))],
  ['group_entry', await send(O, g.topic, entry(g.topic, 1, g.W).subarray(0, 300))],
  ['group_entry', await send(O, g.topic, entry(g.topic, 1, g.AW, { flags: FLAG.admin | FLAG.keep, slot: 12 }))],
  ['too_large', await send(O, g.topic, entry(g.topic, 1, g.W, { size: 600 * 1024 }))],
  ['home_unknown', await send(O, topicOf(newGid()), entry(g.topic, 1, g.W))],
  ['home_epoch', await send(O, g.topic, entry(g.topic, 1, g.AW, { flags: FLAG.admin | FLAG.letters }))],
];
const wrong = refusals.filter(([want, got]) => got?.code !== want).map(([want, got]) => `${want}≠${got?.code}`);
ok(wrong.length === 0 && count(relay, 'SELECT count(*) AS n FROM home_rows WHERE topic = ?', g.topic) === 2,
  `append refused by name, nothing stored: a stranger's key and the member key under the admin flag (home_credential), epoch 2 (home_epoch), a cut or slot-12 entry (group_entry), 600 KB on the free tier (too_large), no group (home_unknown), letters with no renewal (home_epoch)${wrong.length ? ` (${wrong})` : ''}`);
const stats0 = await (await fetch(`${http(relay)}/stats`)).json(), statsPublic = await (await fetch(`${http(relay)}/stats`, { headers: { 'x-real-ip': '192.0.2.7' } })).json();
ok(stats0.groups?.total === 3 && stats0.groups.rows === 2 && Object.keys(stats0.groups).sort().join() === 'rows,total' && !('groups' in statsPublic),
  `GET /stats, the operator's view (loopback, no X-Real-IP), counts home groups and log rows, nothing else of them (${JSON.stringify(stats0.groups)}); the public view (through nginx) has no groups key`);

// ================================================================ fetch-since, pages, live, keep slots
await until(() => rowsOf(O, g.topic).length === 2);
ok(seqs(O, g.topic) === '1,2' && rowsOf(O, g.topic).every((r) => r.lane === 0), `the opener gets the rows as lane ‖ seq ‖ bytes, live (${seqs(O, g.topic)})`);
for (let i = 0; i < 9; i++) await send(O, g.topic, entry(g.topic, 1, g.W, { size: 600 }));
a = await open(M, g, { since: 3 });
await until(() => rowsOf(M, g.topic).length === 8);
ok(a?.typ === 'opened' && seqs(M, g.topic) === '4,5,6,7,8,9,10,11', `fetch since 3, in pages of 4 (the test's page): rows 4 to 11 in order, once each (${seqs(M, g.topic)})`);
await send(O, g.topic, entry(g.topic, 1, g.W));
await until(() => rowsOf(M, g.topic).length === 9);
ok(seqs(M, g.topic).endsWith('11,12') && rowsOf(O, g.topic).length === 12, 'a live row goes to every session that opened the group');
const mBytes = rowsOf(M, g.topic).at(-1).bytes, stored = relay.db.raw.prepare('SELECT payload FROM home_rows WHERE topic = ? AND seq = 12').get(g.topic).payload;
ok(Buffer.from(stored).equals(mBytes), 'delivered bytes are the stored entry unchanged');
const sub = await new Promise((resolve) => M.subscribe(g.topic, { qos: 0 }, (e, gr) => resolve(gr?.[0]?.qos))), subS = await new Promise((resolve) => S.subscribe(g.topic, { qos: 0 }, (e, gr) => resolve(e ? 128 : gr?.[0]?.qos)));
ok(sub === 0 && subS === 128, `SUBSCRIBE g/: granted at QoS 0 to a session that opened it, refused (128) to one that did not (${sub}, ${subS})`);
const k1 = await send(O, g.topic, entry(g.topic, 1, g.AW, { flags: FLAG.admin | FLAG.keep, slot: 1 })), k2 = await send(O, g.topic, entry(g.topic, 1, g.AW, { flags: FLAG.admin | FLAG.keep, slot: 1 }));
const kept = relay.db.raw.prepare('SELECT seq, expires FROM home_rows WHERE topic = ? AND slot = 1').all(g.topic);
ok(k1 === null && k2 === null && kept.length === 1 && kept[0].seq === 14 && kept[0].expires === null, `keep slot 1: the newer state part replaces the older; kept rows never expire (${JSON.stringify(kept)})`);
const proofOther = await ctl(S, { typ: 'open', topic: g.topic, epoch: 1, since: 0, as: 'member', proof: proofOf(g.topic, 1, M.account, g.W, now) });
const asAdmin = await open(M, g, { as: 'admin', key: g.W });
ok(proofOther?.code === 'home_credential' && asAdmin?.code === 'home_credential', `open refused: a proof made for another account, or by W as admin (home_credential) (${proofOther?.code}, ${asAdmin?.code})`);

// ================================================================ the door
const door = 'd/' + randomBytes(16).toString('hex');
const dBad = await ctl(M, signed({ v: HOME_V, typ: 'door', topic: g.topic, door, exp: now + 7 * DAY, cap: 1 }, g.W));
const dOk = await ctl(M, signed({ v: HOME_V, typ: 'door', topic: g.topic, door, exp: now + 7 * DAY, cap: 1 }, g.AW));
ok(dBad?.code === 'home_credential' && dOk?.typ === 'door' && dOk.exp % 3600 === 0, `door: registered with a sig by AW (any session), refused under W; its end rounded up to the hour (${dBad?.code}, ${dOk?.typ})`);
const beforeM = rowsOf(M, g.topic).length, d1 = await send(J, door, doorBytes());
await until(() => rowsOf(O, g.topic).some((r) => r.lane === 1));
await sleep(50);
const doorRow = rowsOf(O, g.topic).find((r) => r.lane === 1);
ok(d1 === null && doorRow && rowsOf(M, g.topic).length === beforeM && count(relay, 'SELECT count(*) AS n FROM home_rows WHERE topic = ? AND lane = 1', g.topic) === 1,
  'a door request from anyone logged in: stored as a lane 1 row of the log, delivered to the admin session only');
const d2 = await send(J, door, doorBytes()), d3 = await send(S, door, doorBytes()), d4 = await send(S, 'd/' + randomBytes(16).toString('hex'), doorBytes()), d5 = await send(S, door, doorBytes().subarray(0, 600));
ok(d2?.code === 'home_once' && d3?.code === 'home_door' && d4?.code === 'home_door', `door refusals: the same identity twice a day (home_once), the link's cap of 1 a day reached (home_door), no such door (home_door) (${[d2, d3, d4].map((x) => x?.code)}; short: ${d5?.code})`);
now += DAY;
const d6 = await send(S, door, doorBytes());
ok(d6 === null, 'the next UTC day the cap counts anew');
a = await open(M, g, { since: 0 });
await sleep(50);
const memberLanes = new Set(rowsOf(M, g.topic).map((r) => r.lane));
a = await open(O, g, { as: 'admin', since: 14 });
await until(() => rowsOf(O, g.topic).filter((r) => r.lane === 1).length >= 3);
ok(!memberLanes.has(1) && rowsOf(O, g.topic).filter((r) => r.lane === 1).length >= 3, 'fetch-since as member skips door rows; as admin includes them');

// ================================================================ GRP codes (park.mjs, a third kind)
const inviteBody = (o = {}) => ({ v: 'sigelo-group/2', typ: 'invite', gid: g.gid, name: 'Test group', owner: owner.original, home: HOST, door, door_key: 'A'.repeat(1622), link: randomBytes(8).toString('hex'), by: owner.did, iat: now, exp: now + 5 * DAY, approve: 'admin', ...o });
const inviteOf = (body, by = owner) => { const inv = { body, sig: sign(by.secret, body), genesis: by.genesis }; return Buffer.from(canonicalize(inv)).toString('base64url'); };
const code = 'GRP7Q4KM2XD', hash = createHash('sha256').update(`sigelo-group/2 code${'7Q4KM2XD'}`).digest('hex');
const inv = inviteOf(inviteBody());
const parkAs = async (id, body) => postJson(relay, '/park', { ...(await loginFields(id)), ...body });
const pk = await parkAs(owner, { code_hash: hash, invite: inv, exp: now + 5 * DAY });
const f1 = await (await fetch(`${http(relay)}/park/${hash}`)).json(), f2 = await (await fetch(`${http(relay)}/park/${hash}`)).json();
ok(pk.json.ok && pk.json.group === true && f1.ok && f1.invite === inv && f1.group === true && f2.invite === inv, `a GRP code parked by an admin of the group (it opened as admin), fetched again and again until exp: group: true (${JSON.stringify(pk.json)}; code ${code})`);
const wire = join(HERE, '..', '..', 'apps', 'contact', 'home-wire.mjs');
if (existsSync(wire)) {
  const w = await import(wire);
  let parsed = null;
  try { parsed = w.parseInviteLong(inv, now); } catch (e) { parsed = e.message; }
  ok(w.groupCodeHash('GRP-7Q4K-M2XD') === hash && parsed?.body?.door === door, `home-wire.mjs agrees: groupCodeHash("GRP-7Q4K-M2XD") is the hash parked under; parseInviteLong takes the invite (${typeof parsed === 'string' ? parsed : 'ok'})`);
}
const pM = await parkAs(member, { code_hash: createHash('sha256').update('x').digest('hex'), invite: inv, exp: now + DAY });
const pTaken = await parkAs(owner, { code_hash: hash, invite: inv, exp: now + DAY });
const pLate = await parkAs(owner, { code_hash: createHash('sha256').update('y').digest('hex'), invite: inv, exp: now + 9 * DAY });
const pHome = await parkAs(owner, { code_hash: createHash('sha256').update('z').digest('hex'), invite: inviteOf(inviteBody({ home: 'other.relay' })), exp: now + DAY });
const pForged = await parkAs(owner, { code_hash: createHash('sha256').update('w').digest('hex'), invite: inviteOf(inviteBody(), member).replace(/.$/, 'A'), exp: now + DAY });
ok(!pM.json.ok && pTaken.json.check === 'park_taken' && !pLate.json.ok && !pHome.json.ok && !pForged.json.ok,
  `GRP parking refused: by a member (not an admin), the hash taken (park_taken), exp past the invite's, another home, an altered invite (${[pM, pTaken, pLate, pHome, pForged].map((x) => x.json.check)})`);
const cancelM = await postJson(relay, `/park/${hash}`, await loginFields(member), 'DELETE'), cancelO = await postJson(relay, `/park/${hash}`, await loginFields(owner), 'DELETE');
const f3 = await fetch(`${http(relay)}/park/${hash}`);
ok(cancelM.status === 404 && cancelO.json.ok && f3.status === 404, 'a GRP code cancelled by an admin (a member\'s DELETE is the same 404 as a miss); then 404');

// ================================================================ renewal: letters, the switch, the old epoch's end
await open(M, g, { since: 0 });
await sleep(50);
const W2 = writeKey(), AW2 = writeKey();
const lap = await send(O, g.topic, entry(g.topic, 1, g.AW, { flags: FLAG.admin | FLAG.letters }));
const reg = await ctl(M, signed({ v: HOME_V, typ: 'epoch', topic: g.topic, epoch: 2, write: W2.b64, admin: AW2.b64, parts: 2, members: 3, channel: false }, g.AW));
const regBad = await ctl(M, signed({ v: HOME_V, typ: 'epoch', topic: g.topic, epoch: 3, write: W2.b64, admin: AW2.b64, parts: 2, members: 3, channel: false }, g.AW));
const regTwo = await ctl(M, signed({ v: HOME_V, typ: 'epoch', topic: g.topic, epoch: 2, write: W2.b64, admin: AW2.b64, parts: 2, members: 3, channel: false }, g.AW));
const regW = await ctl(M, signed({ v: HOME_V, typ: 'epoch', topic: g.topic, epoch: 2, write: W2.b64, admin: AW2.b64, parts: 2, members: 3, channel: false }, g.W));
ok(lap?.code === 'home_epoch' && reg?.typ === 'pending' && regBad?.code === 'home_epoch' && regTwo?.code === 'home_epoch' && regW?.code === 'home_credential',
  `renewal: registered by an admin's sig (pending); refused: letters before it, epoch 3, a second while one is pending (home_epoch), a sig by W (home_credential) (${[lap, reg, regBad, regTwo, regW].map((x) => x?.code === 'home' ? x.typ : x?.code)})`);
const own = await ctl(O, { typ: 'epoch', topic: g.topic, epoch: 2, write: W2.b64, admin: AW2.b64, parts: 2, members: 3, channel: false });
ok(own?.typ === 'pending', 'the owner\'s own session registers without a sig, and replaces a pending one');
const lastBefore = count(relay, 'SELECT seq AS n FROM homes WHERE topic = ?', g.topic);
const l1 = await send(O, g.topic, entry(g.topic, 1, g.AW, { flags: FLAG.admin | FLAG.letters, size: 2000 }));
const midSwitch = count(relay, 'SELECT epoch AS n FROM homes WHERE topic = ?', g.topic);
const l2 = await send(O, g.topic, entry(g.topic, 1, g.AW, { flags: FLAG.admin | FLAG.letters, size: 2000 }));
const ep = relay.db.raw.prepare('SELECT epoch, first, last FROM home_epochs WHERE topic = ? ORDER BY epoch').all(g.topic);
ok(l1 === null && l2 === null && midSwitch === 1 && count(relay, 'SELECT epoch AS n FROM homes WHERE topic = ?', g.topic) === 2 && ep[0].last === lastBefore + 2 && ep[1].first === lastBefore + 3 && ep[1].last === null,
  `after the last of 2 letters parts the relay switches to epoch 2: epoch 1 reads to ${ep[0].last} (the last part), epoch 2 from ${ep[1].first}`);
await until(() => M.notes.some((x) => x.typ === 'epoch'));
ok(M.notes.some((x) => x.code === 'home' && x.typ === 'epoch' && x.epoch === 2 && x.topic === g.topic) && rowsOf(M, g.topic).at(-1).seq === ep[0].last,
  'a session open under epoch 1 gets every row to the last letters part, then {code: "home", typ: "epoch", epoch: 2}, and its open ends');
const stale = await send(O, g.topic, entry(g.topic, 1, g.W)), oldKey = await send(O, g.topic, entry(g.topic, 2, g.W));
ok(stale?.code === 'home_epoch' && oldKey?.code === 'home_credential', `after the switch: an entry under epoch 1 is home_epoch, the old write key under epoch 2 home_credential (a kicked member writes nothing) (${stale?.code}, ${oldKey?.code})`);
const g2e = { ...g, W: W2, AW: AW2, epoch: 2 };
// The switch takes the admin mark off the wake list; an open as admin under the new admin key gives it back.
const pOld = await parkAs(owner, { code_hash: createHash('sha256').update('after switch').digest('hex'), invite: inv, exp: now + DAY });
await open(O, g2e, { as: 'admin' });
const pNew = await parkAs(owner, { code_hash: createHash('sha256').update('after switch').digest('hex'), invite: inv, exp: now + DAY });
ok(!pOld.json.ok && pNew.json.ok, `after a renewal a GRP code is parked only by an account that opened as admin under the new epoch (${pOld.json.check}, ${pNew.json.ok})`);
const o2 = await open(M, g2e);
const live2 = await send(O, g.topic, entry(g.topic, 2, W2));
await until(() => rowsOf(M, g.topic).at(-1)?.seq === ep[1].first);
ok(o2?.typ === 'opened' && o2.first === ep[1].first && live2 === null && rowsOf(M, g.topic).at(-1).seq === ep[1].first, 'a member with a letter opens epoch 2 and reads on, the new write key accepted');
const fresh = await open(J, g2e, { since: 0 });
await until(() => rowsOf(J, g.topic).at(-1)?.seq === ep[1].first);
ok(fresh?.typ === 'opened' && rowsOf(J, g.topic)[0]?.seq === 1 && rowsOf(J, g.topic).some((r) => r.seq === 14) && rowsOf(J, g.topic).every((r) => r.lane === 0) && rowsOf(J, g.topic).at(-1).seq === ep[1].first,
  'a joiner holding epoch 2 only opens since 0: it fetches the earlier rows too (the kept state part at 14, the roster its welcome has keys for), no door row');
await ctl(J, { typ: 'close', topic: g.topic, forget: true });
const kicked = await open(S, g, { since: 0 });
await until(() => S.notes.some((x) => x.typ === 'epoch'));
ok(kicked?.typ === 'opened' && kicked.last === ep[0].last && rowsOf(S, g.topic).at(-1)?.seq === ep[0].last && S.notes.some((x) => x.typ === 'epoch'),
  'a holder of epoch 1 only (a kicked member) reads to the renewal\'s letters and no further');
const soon = await ctl(O, { typ: 'epoch', topic: g.topic, epoch: 3, write: W2.b64, admin: AW2.b64, parts: 1, members: 3, channel: false });
ok(soon?.code === 'home_epoch', `a second switch within 10 s of the last: home_epoch (${soon?.detail})`);
now += 11;
const capR = await ctl(O, { typ: 'epoch', topic: g.topic, epoch: 3, write: W2.b64, admin: AW2.b64, parts: 1, members: 9, channel: false });
ok(capR?.code === 'home_cap', 'a renewal for 9 members on the free tier: home_cap');

// ================================================================ the wake list's cap: 8 accounts on the free tier
{
  const ids = Array.from({ length: 8 }, (_, i) => identity(`wake ${i}`));
  const cs = [];
  for (const id of ids) cs.push(await login(id));
  const answers = [];
  for (const c of cs) answers.push(await open(c, g2e));
  const nine2 = answers.findIndex((x) => x?.code === 'home_cap');
  const reopen = await open(M, g2e);
  ok(nine2 >= 0 && answers.slice(0, nine2).every((x) => x?.typ === 'opened') && reopen?.typ === 'opened',
    `the wake list holds the free cap of 8 accounts: those on it and ${nine2} more opened, the next is home_cap; an account on it opens again (${answers.map((x) => x?.code === 'home' ? 'o' : x?.code).join(' ')})`);
  // A kicked member's open of its old epoch never put it on the list: the admin forgets one that opened epoch 2.
  const fg = await ctl(O, signed({ v: HOME_V, typ: 'forget', topic: g.topic, account: cs[0].account }, AW2));
  const after = await open(cs[nine2], g2e);
  ok(fg?.typ === 'forgot' && after?.typ === 'opened', 'an admin forgets a kicked account (sig by AW): its place opens');
  for (const c of cs) await end(c);
}

// ================================================================ channel mode
{
  const ch = await makeGroup(O, { channel: true });
  await ctl(O, { typ: 'drop', topic: g3.topic });
  const ch2 = ch.a?.typ === 'created' ? ch : await makeGroup(O, { channel: true });
  const big = await send(O, ch2.topic, entry(ch2.topic, 1, ch2.W, { size: CHANNEL_ENTRY + 256 })), small = await send(O, ch2.topic, entry(ch2.topic, 1, ch2.W, { size: 1024 }));
  const admin = await send(O, ch2.topic, entry(ch2.topic, 1, ch2.AW, { flags: FLAG.admin, size: 64 * 1024 }));
  ok(big?.code === 'home_channel' && small === null && admin === null, `channel mode: an entry over 4 KiB under the member credential is home_channel; 1 KB fits; the admin credential posts anything (${big?.code})`);
  g3.topic = ch2.topic; Object.assign(g3, ch2);
}

// ================================================================ the group's rate and the owner's storage (R2: defaults, 1.5 MB free)
{
  const o = await login(owner, R2);
  const q = await makeGroup(o);
  const r = [];
  for (let i = 0; i < 22; i++) r.push(await send(o, q.topic, entry(q.topic, 1, q.W)));
  const first = r.findIndex((x) => x !== null);
  ok(first === 20 && r[20]?.code === 'rate', `a free owner's group takes 2 entries a second, a burst of 20: the 21st at once is rate (${r.map((x) => (x ? x.code : '.')).join('')})`);
  // The member credential's bucket empty, an admin's entry and a joiner's door request still go (a bucket each).
  const door = 'd/' + randomBytes(16).toString('hex');
  await ctl(o, signed({ v: HOME_V, typ: 'door', topic: q.topic, door, exp: now + DAY, cap: 5 }, q.AW));
  const adminE = await send(o, q.topic, entry(q.topic, 1, q.AW, { flags: 1 })), joinR = await send(o, door, doorBytes()), memberE = await send(o, q.topic, entry(q.topic, 1, q.W));
  ok(adminE === null && joinR === null && memberE?.code === 'rate', `a member who empties the group's bucket holds back neither an admin's entry nor a door request (${[adminE, joinR, memberE].map((x) => (x ? x.code : '.')).join('')})`);
  const st = [];
  for (let i = 0; i < 6; i++) { now += 10; st.push(await send(o, q.topic, entry(q.topic, 1, q.W, { size: 400 * 1024 }))); }
  const full = st.find((x) => x !== null);
  ok(full?.code === 'quota_storage' && full.side === 'owner' && /owner over quota/.test(full.detail), `the rows are charged to the owner: past its 1.5 MB, quota_storage, side owner (${st.map((x) => (x ? x.code : '.')).join(' ')})`);
  await end(o);
}

// ================================================================ Pro: a home of up to 1,000, licensed
const proOwner = identity('pro owner');
let P = await login(proOwner);
const lic = (() => { const iat = now - 60; return { attestation: attest({ secret: vendor.secret, iss: vendor.did, sub: proOwner.original, iat, exp: iat + YEAR, ctx: LICENCE_CTX, admission: 'payment', claims: { tier: 'pro', storage_mb: 1000, msgs_day: 100000, retention_days: 90, groups: 5 } }), issuer: vendor.origin, rotations: [] }; })();
const up = await postJson(relay, '/licence', lic);
await end(P);
P = await login(proOwner);
const big = await makeGroup(P, { members: 1000 });
ok(up.json.ok && big.a?.typ === 'created' && big.a.cap === 1000, `a Pro owner (licence) makes a home of 1,000 (${big.a?.code}, cap ${big.a?.cap})`);
const over = await makeGroup(P, { members: 1001 });
ok(over.a?.code === 'home_cap', 'and 1,001 is home_cap');
// A group past the free numbers whose payer is free now (a Pro that ended) still renews for the members of its last
// switch, never more: a kick must cut the kicked member off. Emulated: the switch at 50, then the payer and the cap as a lapse leaves them.
{
  const W2 = writeKey(), AW2 = writeKey(), W3 = writeKey(), AW3 = writeKey();
  const reg = await ctl(P, { typ: 'epoch', topic: big.topic, epoch: 2, write: W2.b64, admin: AW2.b64, parts: 1, members: 50, channel: false });
  const part = await send(P, big.topic, entry(big.topic, 1, big.AW, { flags: 5 }));
  relay.db.raw.prepare('UPDATE homes SET owner = ?, pool = NULL, cap = 50 WHERE topic = ?').run(accountOf(identity('lapsed payer').original), big.topic);
  now += 11;
  const more = await ctl(P, signed({ v: HOME_V, typ: 'epoch', topic: big.topic, epoch: 3, write: W3.b64, admin: AW3.b64, parts: 1, members: 51, channel: false }, AW2));
  const same = await ctl(P, signed({ v: HOME_V, typ: 'epoch', topic: big.topic, epoch: 3, write: W3.b64, admin: AW3.b64, parts: 1, members: 50, channel: false }, AW2));
  ok(reg?.typ === 'pending' && part === null && more?.code === 'home_cap' && same?.typ === 'pending',
    `a lapsed Pro's group of 50 renews for 50 on the free numbers, not 51 (${[reg, part, more, same].map((x) => (x === null ? '.' : x?.code === 'home' ? x.typ : x?.code)).join(' ')})`);
}

// ================================================================ handover
{
  const op = { body: { v: 'sigelo-group/2', typ: 'handover', gid: g2.gid, mid: randomBytes(8).toString('hex'), iat: now, from: owner.did, epoch: 1, at: 0, to: member.original } };
  op.sig = sign(owner.secret, op.body);
  const chain = { genesis: owner.origin, rotations: owner.rotations };
  const wrongS = await ctl(S, { typ: 'handover', topic: g2.topic, op, chain });
  const forged = await ctl(M, { typ: 'handover', topic: g2.topic, op: { ...op, sig: sign(member.secret, op.body) }, chain });
  const okH = await ctl(M, { typ: 'handover', topic: g2.topic, op, chain });
  ok(wrongS?.code === 'home_owner' && forged?.code === 'home_credential' && okH?.typ === 'handover' && relay.db.raw.prepare('SELECT owner FROM homes WHERE topic = ?').get(g2.topic).owner === M.account,
    `handover: the new owner's session takes the group with the owner's signed handover (it pays from now); another session (home_owner), a sig not the owner's (home_credential) refused (${[wrongS, forged, okH].map((x) => x?.code === 'home' ? x.typ : x?.code)})`);
  // Handed back, the old op is a replay: the former owner holds it, still signed by the owner, and its at is older.
  const back = { body: { ...op.body, mid: randomBytes(8).toString('hex'), from: member.did, at: 5, to: owner.original } };
  back.sig = sign(member.secret, back.body);
  const okBack = await ctl(O, { typ: 'handover', topic: g2.topic, op: back, chain: { genesis: member.origin, rotations: member.rotations } });
  const replay = await ctl(M, { typ: 'handover', topic: g2.topic, op, chain });
  ok(okBack?.typ === 'handover' && replay?.code === 'home_request' && /replay/.test(replay.detail) && relay.db.raw.prepare('SELECT owner FROM homes WHERE topic = ?').get(g2.topic).owner === O.account,
    `handed back, the first handover replayed by its old taker is refused: the owner stays (${[okBack, replay].map((x) => x?.code === 'home' ? x.typ : x?.code)})`);
  const again2 = { body: { ...op.body, mid: randomBytes(8).toString('hex'), at: 10 } };
  again2.sig = sign(owner.secret, again2.body);
  const okAgain = await ctl(M, { typ: 'handover', topic: g2.topic, op: again2, chain });
  ok(okAgain?.typ === 'handover' && relay.db.raw.prepare('SELECT owner FROM homes WHERE topic = ?').get(g2.topic).owner === M.account, `a new handover (a later at) is taken (${okAgain?.code})`);
  // A rotated owner: the chain resolves to its current key.
  const rot = rotated(owner, 'home owner 2');
  const op2 = { body: { ...op.body, gid: g3.gid, from: rot.did, mid: randomBytes(8).toString('hex') } };
  op2.sig = sign(rot.secret, op2.body);
  const oldKey2 = await ctl(M, { typ: 'handover', topic: g3.topic, op: { body: { ...op2.body, from: owner.did }, sig: sign(owner.secret, { ...op2.body, from: owner.did }) }, chain: { genesis: rot.origin, rotations: rot.rotations } });
  ok(oldKey2?.code === 'home_request', 'a handover signed by a key the owner rotated away from is refused');
}

// ================================================================ the supergroup slot (the operator verb) and the name card
{
  // The operator verb reads the host's own clock: the slot is dated by it.
  const iat = Math.floor(Date.now() / 1000) - 60;
  const slotBody = { secret: operatorId.secret, iss: operatorId.did, sub: owner.original, iat, exp: iat + 200 * DAY, ctx: SLOT_CTX, admission: 'invite', admission_by: operatorId.did,
    claims: { relay: HOST, name: 'community', members: 20, storage_mb: 10, retention_days: 120 } };
  const slotFile = join(dir, 'slot.json');
  writeFileSync(slotFile, canonicalize({ attestation: attest(slotBody), issuer: operatorId.origin, rotations: [] }));
  const run = (env, file = slotFile) => spawnSync(process.execPath, [join(HERE, '..', 'home.mjs'), 'slot', file], { env: { ...process.env, RELAY_DB: join(dir, 'relay.db'), RELAY_HOST: HOST, ...env }, encoding: 'utf8' });
  const loaded = run({ RELAY_OPERATOR_DID: operatorId.original });
  const noOp = run({ RELAY_OPERATOR_DID: owner.original });
  const badFile = join(dir, 'slot-bad.json');
  writeFileSync(badFile, canonicalize({ attestation: attest({ ...slotBody, claims: { ...slotBody.claims, relay: 'other.relay' } }), issuer: operatorId.origin, rotations: [] }));
  const badRelay = run({ RELAY_OPERATOR_DID: operatorId.original }, badFile);
  ok(loaded.status === 0 && /slot community until/.test(loaded.stdout) && noOp.status !== 0 && badRelay.status !== 0,
    `node home.mjs slot <file>: the operator loads a slot it signed (${loaded.stdout.trim() || loaded.stderr.trim()}); one checked against another operator DID, or for another relay, is refused`);
  const inv3 = inviteOf(inviteBody({ gid: g3.gid }));
  const card = (o = {}) => { const body = { v: 'sigelo-group/2', typ: 'card', name: 'community', home: HOST, gid: g3.gid, owner: owner.original, public: true, about: 'The test community', avatar: null, invite: inv3, iat: now, ...o }; return { body, sig: sign(owner.secret, body) }; };
  const chain = { genesis: owner.origin, rotations: [] };
  const byM = await ctl(M, { typ: 'name', topic: g3.topic, card: card(), chain, listed: true });
  const noSlot = await ctl(O, { typ: 'name', topic: g3.topic, card: card({ name: 'nobody' }), chain, listed: true });
  const otherGid = await ctl(O, { typ: 'name', topic: g3.topic, card: card({ gid: newGid() }), chain, listed: true });
  const named = await ctl(O, { typ: 'name', topic: g3.topic, card: card(), chain, listed: true });
  ok(byM?.code === 'home_owner' && noSlot?.code === 'home_slot' && otherGid?.code === 'home_request' && named?.typ === 'named' && named.members === 20,
    `name: the owner binds its slot's name to its group with a signed card; refused: another session (home_owner), a name with no slot (home_slot), a card for another gid (home_request) (${[byM, noSlot, otherGid, named].map((x) => x?.code === 'home' ? x.typ : x?.code)})`);
  const got = await (await fetch(`${http(relay)}/group/community`)).json(), list = await (await fetch(`${http(relay)}/groups`)).json(), none = await fetch(`${http(relay)}/group/nobody`);
  let accepted = false;
  try {
    const v = verify({ v: 'sigelo/0', typ: 'bundle', genesis: got.chain.genesis, rotations: got.chain.rotations, bindings: [], attestations: [got.slot], issuers: [got.issuer] }, Math.max(now, iat + 60));   // the slot is dated by the wall clock, the relay's by the test's
    accepted = (v.attestations[operatorId.did] ?? []).some((x) => x.ctx === SLOT_CTX && x.claims.name === 'community') && v.did === owner.did;
  } catch {}
  ok(got.ok && got.card.body.name === 'community' && accepted && list.groups?.length === 1 && list.groups[0].name === 'community' && list.groups[0].about === 'The test community' && none.status === 404,
    'GET /group/community: the card, the slot, the owner\'s chain and the operator\'s genesis, which SPEC §9 accepts offline; GET /groups lists it (name, about); an unknown name 404');
  // The slot's members: the cap is 20, past the free 8.
  const many = [];
  for (let i = 0; i < 12; i++) many.push(await login(identity(`super ${i}`)));
  const opens = [];
  for (const c of many) opens.push(await open(c, g3));
  ok(opens.every((x) => x?.typ === 'opened'), `a named group holds its slot's 20 members, past the free tier's 8 (${opens.filter((x) => x?.typ === 'opened').length} opened)`);
  for (const c of many) await end(c);
  const taken = await ctl(M, { typ: 'name', topic: g2.topic, card: { body: { ...card().body, gid: g2.gid, owner: member.original }, sig: '' }, chain: { genesis: member.origin, rotations: [] }, listed: false });
  ok(taken?.code === 'home_name', 'the name for another owner\'s group: home_name');
  const otherInvite = await ctl(O, { typ: 'name', topic: g3.topic, card: card({ invite: inv }), chain, listed: true });
  ok(otherInvite?.code === 'home_request', `a public card whose invite is another group's: home_request (${otherInvite?.detail})`);

  // The operator's verb end to end: `slot issue` signs wherever the operator keeps its key, `slot <file>` loads.
  const opFile = join(dir, 'operator.local.json');
  writeFileSync(opFile, JSON.stringify({ secret: Buffer.from(operatorId.secret).toString('hex'), genesis: operatorId.origin, rotations: [] }));
  const issue = (...a) => spawnSync(process.execPath, [join(HERE, '..', 'home.mjs'), 'slot', 'issue', opFile, ...a], { env: { ...process.env, RELAY_HOST: HOST }, encoding: 'utf8' });
  const hidden = issue(owner.original, 'hidden', '--members', '30', '--storage-mb', '5', '--retention-days', '30', '--days', '1');
  const hiddenFile = join(dir, 'slot-hidden.json');
  writeFileSync(hiddenFile, hidden.stdout);
  const hiddenLoaded = run({ RELAY_OPERATOR_DID: operatorId.original }, hiddenFile);
  const badName = issue(owner.original, 'No_Caps', '--members', '30', '--storage-mb', '5', '--retention-days', '30');
  const steal = issue(member.original, 'community', '--members', '30', '--storage-mb', '5', '--retention-days', '30'), stealFile = join(dir, 'slot-steal.json');
  writeFileSync(stealFile, steal.stdout);
  const stolen = run({ RELAY_OPERATOR_DID: operatorId.original }, stealFile);
  ok(hidden.status === 0 && /slot hidden@/.test(hidden.stderr) && hiddenLoaded.status === 0 && badName.status !== 0 && steal.status === 0 && stolen.status !== 0 && /held here by another owner/.test(stolen.stderr),
    `node home.mjs slot issue: the operator signs a slot from its identity file, the relay loads it; a bad name is refused at issue; a slot for a name another owner holds is refused at load (name taken: ${stolen.stderr.trim()})`);

  // A private supergroup: no invite, no avatar; never listed, even when asked; the card says the name, about and owner.
  const pg = await makeGroup(O);
  const pcard = (o = {}) => { const body = { v: 'sigelo-group/2', typ: 'card', name: 'hidden', home: HOST, gid: pg.gid, owner: owner.original, public: false, about: 'Ask an admin', avatar: null, invite: null, iat: now, ...o }; return { body, sig: sign(owner.secret, body) }; };
  const withAvatar = await ctl(O, { typ: 'name', topic: pg.topic, card: pcard({ avatar: { sha256: '0'.repeat(64), type: 'image/png', w: 8, h: 8 } }), chain, listed: false });
  const privNamed = await ctl(O, { typ: 'name', topic: pg.topic, card: pcard(), chain, listed: true });
  const pgot = await (await fetch(`${http(relay)}/group/hidden`)).json(), plist = await (await fetch(`${http(relay)}/groups`)).json();
  ok(withAvatar?.code === 'home_request' && privNamed?.typ === 'named' && pgot.ok && pgot.card.body.invite === null && pgot.card.body.avatar === null && pgot.card.body.public === false
    && plist.groups.map((x) => x.name).join() === 'community',
    `a private supergroup: named with no invite (an avatar refused); GET /group/hidden serves the card without one; GET /groups does not list it, though asked (${plist.groups.map((x) => x.name)})`);
  const page2 = await (await fetch(`${http(relay)}/groups?after=community`)).json();
  ok(page2.ok && page2.groups.length === 0, 'GET /groups?after=<name>: the next page by name');
}

// ================================================================ what the file holds
{
  relay.sweep(now);
  const dump = (t) => relay.db.raw.prepare(`SELECT * FROM ${t}`).all();
  const text = JSON.stringify(['homes', 'home_epochs', 'home_rows', 'home_doors', 'home_codes', 'home_names'].map((t) => dump(t).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v instanceof Uint8Array ? Buffer.from(v).toString('hex') : v])))));
  const accounts = [joiner, stranger, ...Array.from({ length: 8 }, (_, i) => identity(`wake ${i}`)), ...Array.from({ length: 12 }, (_, i) => identity(`super ${i}`))].map((id) => accountOf(id.original));
  const times = [...dump('homes').flatMap((r) => [r.created, r.last_used]), ...dump('home_rows').map((r) => r.expires).filter((x) => x !== null)];
  const withRowid = relay.db.raw.prepare("SELECT name FROM pragma_table_list WHERE schema = 'main' AND type = 'table' AND name LIKE 'home%' AND wr = 0").all();
  ok(!text.includes('did:sigelo:') && accounts.every((x) => !text.includes(x)) && times.length > 0 && times.every((t) => t % DAY === 0) && withRowid.length === 0,
    `the home tables hold no DID and no member's account in the clear (the wake lists are sealed; only the owner's account, which pays); every time is a UTC day; no rowid (${times.length} times)`);
}

// ================================================================ moved, end, drop, the sweep
{
  const mg = g2e;
  const last = await send(O, mg.topic, entry(mg.topic, 2, AW2, { flags: FLAG.admin }));
  const seq = count(relay, 'SELECT seq AS n FROM homes WHERE topic = ?', mg.topic);
  const notOwner = await ctl(M, { typ: 'moved', topic: mg.topic, seq });
  const notLast = await ctl(O, { typ: 'moved', topic: mg.topic, seq: seq - 1 });
  const mv = await ctl(O, { typ: 'moved', topic: mg.topic, seq });
  const after = await send(O, mg.topic, entry(mg.topic, 2, W2));
  const doorAfter = count(relay, 'SELECT count(*) AS n FROM home_doors WHERE topic = ?', mg.topic);
  ok(last === null && notOwner?.code === 'home_owner' && notLast?.code === 'home_request' && mv?.typ === 'moved' && after?.code === 'home_closed' && doorAfter === 0,
    `moved: the owner marks its moved entry as the log's last; then entries are home_closed and its doors go; refused: another session, a seq not the last (${[notOwner, notLast, mv, after].map((x) => x?.code === 'home' ? x.typ : x?.code)})`);
  const c = await login(identity('late reader'));
  void c;
  const reread = await open(M, mg, { since: seq - 2 });
  await until(() => M.notes.some((x) => x.typ === 'closed' && x.topic === mg.topic));
  ok(reread?.typ === 'opened' && rowsOf(M, mg.topic).at(-1).seq === seq && M.notes.some((x) => x.typ === 'closed' && x.why === 'moved'),
    'a member still reads the closed log to its moved entry, then {typ: "closed", why: "moved"}');
  await end(c);
  // The moved group no longer counts against the owner's three; ended likewise; drop deletes at once.
  const eg = await makeGroup(O);
  await send(O, eg.topic, entry(eg.topic, 1, eg.AW, { flags: FLAG.admin }));
  const en = await ctl(O, { typ: 'end', topic: eg.topic, seq: 1 });
  const dg = await makeGroup(O);
  ok(eg.a?.typ === 'created' && en?.typ === 'end' && dg.a?.typ === 'created', 'a moved or ended group no longer counts against the owner\'s home groups');
  await open(M, { ...dg, epoch: 1 });
  await send(O, dg.topic, entry(dg.topic, 1, dg.W));
  const dropM = await ctl(M, { typ: 'drop', topic: dg.topic });
  const dropped = await ctl(O, { typ: 'drop', topic: dg.topic });
  await until(() => M.notes.some((x) => x.typ === 'dropped' && x.topic === dg.topic));
  ok(dropM?.code === 'home_owner' && dropped?.typ === 'dropped' && count(relay, 'SELECT count(*) AS n FROM home_rows WHERE topic = ?', dg.topic) === 0 && count(relay, 'SELECT count(*) AS n FROM homes WHERE topic = ?', dg.topic) === 0
    && M.notes.some((x) => x.typ === 'dropped'), 'drop: the owner deletes the group, its rows, epochs and doors at once; its sessions are told; another session is home_owner');
  // Past the retention (14 days free) the closed groups' rows expire and the groups go.
  now += 15 * DAY;
  relay.sweep(now);
  relay.sweep(now);
  // A slot ended (hidden's lived one day): its name is refused (home_slot) and not served; community's runs on.
  const expired = await ctl(O, { typ: 'name', topic: g3.topic, card: (() => { const body = { v: 'sigelo-group/2', typ: 'card', name: 'hidden', home: HOST, gid: g3.gid, owner: owner.original, public: false, about: '', avatar: null, invite: null, iat: now }; return { body, sig: sign(owner.secret, body) }; })(), chain: { genesis: owner.origin, rotations: [] }, listed: false });
  const goneCard = await fetch(`${http(relay)}/group/hidden`), still = await fetch(`${http(relay)}/group/community`);
  ok(expired?.code === 'home_slot' && goneCard.status === 404 && still.status === 200, `a slot expired: its name is home_slot, GET /group/hidden 404; a running slot's card is still served (${expired?.code}, ${goneCard.status}, ${still.status})`);
  ok(count(relay, 'SELECT count(*) AS n FROM homes WHERE topic IN (?, ?)', mg.topic, eg.topic) === 0 && lines.some((l) => /^sweep homes rows=\d+ dropped=\d+$/.test(l)),
    `the sweep: the closed groups' rows expire at the owner's retention, then the groups go; logged as counts only (${lines.filter((l) => l.startsWith('sweep homes')).join(' | ')})`);
  // An idle group: nobody opened or wrote it for 30 days.
  const idleBefore = count(relay, 'SELECT count(*) AS n FROM homes WHERE topic IN (?, ?)', g2.topic, g3.topic);
  await end(O); await end(M); await end(S);
  await sleep(100);
  now += 31 * DAY;
  relay.sweep(now); relay.sweep(now);
  const left = count(relay, 'SELECT count(*) AS n FROM homes WHERE topic IN (?, ?)', g2.topic, g3.topic), named = count(relay, 'SELECT count(*) AS n FROM home_names WHERE topic IS NOT NULL');
  now += 95 * DAY;
  relay.sweep(now); relay.sweep(now);
  const gone = count(relay, 'SELECT count(*) AS n FROM homes WHERE topic IN (?, ?)', g2.topic, g3.topic);
  ok(idleBefore === 2 && left === 1 && named === 1 && gone === 0, `idle groups go 30 days after their last use, past the retention: after 31 days the free one (${idleBefore} → ${left}), the named one (its slot keeps 120 days) after 126 (→ ${gone})`);
}

// ================================================================ wakes (push.mjs): the wake list at work
// A relay with push on and a fake distributor (push.mjs's send): who is woken by a row, a door row, a
// forget, a renewal; one wake until the account logs in again.
{
  const posts = [];
  let pms = 1e9;
  const R3 = await startRelay({ ...base, db: join(dir, 'r3.db'), log: () => {}, policy: (ctx) => relayPolicy(ctx, policyConfig()), homeLimits: { entryRate: { free: BIG, paid: BIG } },
    push: { now: () => pms, send: async (url) => { posts.push(new URL(url).pathname.slice(1)); return 201; } } });
  const ua = createECDH('prime256v1');
  ua.generateKeys();
  const register = (c, name) => send(c, '$sigelo/push', Buffer.from(JSON.stringify({ v: 'sigelo-push/0', endpoint: `https://push.example/${name}`, p256dh: ua.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') })));
  const woken = () => [...posts].sort().join();
  // The owner O writes (never opens); a member M, an admin A, a member K (kicked later) and X (stays connected) open.
  const ids = { O: identity('wake owner'), M: identity('wake member'), A: identity('wake admin'), K: identity('wake kicked'), X: identity('wake here') };
  const c = {};
  for (const [k, id] of Object.entries(ids)) c[k] = await login(id, R3);
  const g = await makeGroup(c.O);
  const regs = [];
  for (const k of ['M', 'A', 'K', 'X']) { regs.push(await register(c[k], k)); regs.push(await open(c[k], g, { as: k === 'A' ? 'admin' : 'member' })); }
  ok(g.a?.typ === 'created' && regs.every((x) => x === null || x?.typ === 'opened') && R3.home.wakeList(g.topic).length === 4, 'wakes: M, A, K and X register push here and open the group: four on the wake list');
  // Away and back: each login resets push.mjs's one wake (connected).
  const cycle = async (keys) => { for (const k of keys) { await end(c[k]); c[k] = await login(ids[k], R3); await end(c[k]); } await sleep(50); pms += 10000; };
  await end(c.M); await end(c.A); await end(c.K);
  await sleep(50);
  ok(await send(c.O, g.topic, entry(g.topic, 1, g.W)) === null && await until(() => posts.length === 3) && woken() === 'A,K,M', `a row: M, A and K (not connected) woken; X (connected, its open live) and O (the writer) not (${woken()})`);
  await send(c.O, g.topic, entry(g.topic, 1, g.W));
  await sleep(200);
  ok(posts.length === 3, 'a second row before they log in again: no second wake');
  // A door row: admins only.
  posts.length = 0;
  await cycle(['M', 'A', 'K']);
  const door = `d/${randomBytes(16).toString('hex')}`;
  const dr = await ctl(c.O, signed({ v: HOME_V, typ: 'door', topic: g.topic, door, exp: now + DAY, cap: 5 }, g.AW));
  const st = await login(identity('wake stranger'), R3);
  ok(dr?.typ === 'door' && await send(st, door, doorBytes()) === null && await until(() => posts.length === 1) && woken() === 'A', `a door request: only the admin (on the wake list as admin) woken (${woken()})`);
  await end(st);
  // K is kicked: the renewal, then the admin's forget. K opening its old epoch does not put it back.
  posts.length = 0;
  await cycle(['M', 'A', 'K']);
  const W2 = writeKey(), AW2 = writeKey();
  await ctl(c.O, { typ: 'epoch', topic: g.topic, epoch: 2, write: W2.b64, admin: AW2.b64, parts: 1, members: 4, channel: false });
  await send(c.O, g.topic, entry(g.topic, 1, g.AW, { flags: FLAG.admin | FLAG.letters }));
  const fg = await ctl(c.O, signed({ v: HOME_V, typ: 'forget', topic: g.topic, account: c.K.account }, AW2));
  c.K = await login(ids.K, R3);
  const back = await open(c.K, g, { since: 0 });
  await until(() => c.K.notes.some((x) => x.typ === 'epoch'));
  await end(c.K);
  await sleep(50);
  posts.length = 0; pms += 10000;
  const g2 = { ...g, W: W2, AW: AW2, epoch: 2 };
  await until(() => c.X.notes.some((x) => x.typ === 'epoch'));
  const x2 = await open(c.X, g2);
  ok(x2?.typ === 'opened', 'X, still connected, opens epoch 2 after the switch');
  ok(fg?.typ === 'forgot' && back?.typ === 'opened' && !R3.home.wakeList(g.topic).includes(c.K.account) && R3.home.wakeList(g.topic).length === 3,
    `the kicked K forgotten by an admin; its open of the old epoch reads to the renewal and does not put it back on the wake list (${R3.home.wakeList(g.topic).length} on it)`);
  await cycle(['M', 'A']);
  posts.length = 0;
  ok(await send(c.O, g.topic, entry(g.topic, 2, W2)) === null && await until(() => posts.length === 2) && (await sleep(200), woken() === 'A,M'), `a row under epoch 2: M and A woken, the kicked K not (${woken()})`);
  R3.sweep(now);
  ok(R3.db.raw.prepare('SELECT count(*) AS n FROM push').get().n === 4 && R3.db.raw.prepare('SELECT wake FROM homes').all().every((r) => r.wake !== null && !Buffer.from(r.wake).toString('latin1').includes(c.M.account)), 'four registrations here; the wake list stays sealed at rest');
  for (const k of ['O', 'X']) await end(c[k]);
  await R3.close();
}

// ================================================================ 1,000 members
{
  const N = 1000, LOGINS = 50;
  P = P.connected ? P : await login(proOwner);
  // The owner writes without opening: the 1,000 on the wake list are the members who open.
  const gid = newGid(), topic = topicOf(gid), W = writeKey(), AW = writeKey();
  const made = await ctl(P, { typ: 'create', topic, write: W.b64, admin: AW.b64, members: N, channel: false });
  const ids = Array.from({ length: N }, (_, i) => identity(`member ${i}`));
  const t0 = Date.now();
  const clients = [];
  for (let i = 0; i < N; i += LOGINS) clients.push(...await Promise.all(ids.slice(i, i + LOGINS).map((id) => login(id))));
  const loginMs = Date.now() - t0;
  // The log: one renewal for 1,000 (letters ~130 bytes a member: two parts of 64 KiB), then 50 posts.
  const W2b = writeKey(), AW2b = writeKey();
  const regb = await ctl(P, { typ: 'epoch', topic, epoch: 2, write: W2b.b64, admin: AW2b.b64, parts: 2, members: N, channel: false });
  for (let i = 0; i < 2; i++) await send(P, topic, entry(topic, 1, AW, { flags: FLAG.admin | FLAG.letters, size: 65 * 1024 }));
  for (let i = 0; i < 50; i++) await send(P, topic, entry(topic, 2, W2b, { size: 1000 }));
  const total = count(relay, 'SELECT seq AS n FROM homes WHERE topic = ?', topic), first2 = relay.db.raw.prepare('SELECT first FROM home_epochs WHERE topic = ? AND epoch = 2').get(topic).first;
  // 1,000 opens: each reads epoch 1's rows (the letters), gets the epoch notice, opens epoch 2 and reads on.
  const t1 = Date.now(), per = [];
  const g1 = { topic, W, AW, epoch: 1 }, gb = { topic, W: W2b, AW: AW2b, epoch: 2 };
  const one = async (c) => {
    const s0 = Date.now();
    const x = await open(c, g1);
    if (x?.typ !== 'opened') return x?.code ?? 'none';
    await until(() => c.notes.some((v) => v.typ === 'epoch' && v.topic === topic), 60000);
    const y = await open(c, gb, { since: first2 - 1 });
    if (y?.typ !== 'opened') return y?.code ?? 'none';
    await until(() => rowsOf(c, topic).length === total, 60000);
    per.push(Date.now() - s0);
    return rowsOf(c, topic).length === total && rowsOf(c, topic).every((r, i) => r.seq === i + 1) ? 'ok' : `rows ${rowsOf(c, topic).length}`;
  };
  const results = [];
  for (let i = 0; i < N; i += 100) results.push(...await Promise.all(clients.slice(i, i + 100).map(one)));
  const fetchMs = Date.now() - t1;
  per.sort((x, y) => x - y);
  const pct = (p) => per[Math.min(per.length - 1, Math.floor(per.length * p))];
  const bytesEach = rowsOf(clients[0], topic).reduce((s, r) => s + r.bytes.length + 9, 0);
  const fine = results.filter((x) => x === 'ok').length;
  ok(made?.typ === 'created' && regb?.typ === 'pending' && fine === N,
    `1,000 members: ${N} logins in ${loginMs} ms; ${N} opens (epoch 1's letters, the epoch notice, epoch 2) each fetched all ${total} rows (${(bytesEach / 1024).toFixed(0)} KiB) in order, 100 at a time: ${fetchMs} ms in all, per member p50 ${pct(0.5)} ms, p95 ${pct(0.95)} ms, max ${per.at(-1)} ms${fine === N ? '' : ` (${results.filter((x) => x !== 'ok').slice(0, 5)})`}`);
  const t2 = Date.now();
  await send(P, topic, entry(topic, 2, W2b, { size: 1000 }));
  await until(() => clients.every((c) => rowsOf(c, topic).length === total + 1), 30000);
  const liveMs = Date.now() - t2;
  ok(clients.every((c) => rowsOf(c, topic).length === total + 1), `one live row reaches all 1,000 sessions in ${liveMs} ms`);
  const extraId = await login(identity('member 1000'));
  const refused = await open(extraId, gb);
  ok(refused?.code === 'home_cap' && relay.home.wakeList(topic).length === N, `the 1,001st account is home_cap (the wake list holds 1,000) (${refused?.code})`);
  console.log(`timing: 1,000 members — logins ${loginMs} ms; opens and fetch ${fetchMs} ms (p50 ${pct(0.5)} ms, p95 ${pct(0.95)} ms per member, ${total} rows, ${(bytesEach / 1024).toFixed(0)} KiB each); live row to all ${liveMs} ms`);
  await Promise.all([...clients, extraId, P].map((c) => end(c)));
}

await Promise.all([J].map(end));
await relay.close();
await R2.close();
console.log(failed ? `FAILED ${failed} of ${n}` : `ALL PASS (${n})`);
process.exit(failed ? 1 : 0);
