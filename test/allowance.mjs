#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// relay/test/allowance.mjs — M4 on loopback, with small tiers and an injected clock: each allowance
// at its edge (too_large; quota_storage, freed by delivery and by expiry, empty messages charged
// too, the free tier's ceiling for the relay; quota_messages and the UTC day; quota_mailboxes), the
// rate brake (UNSUBSCRIBE too), proof of work accepted and refused, its load raise and its steps
// per network (8 and 64 new identities a day), checked against the bits the nonce states, with the
// challenges fetched and not yet redeemed counted (a network fetching ahead gets no base), a pool of
// two agents under one operator drawing one allowance, operator attestations forged, expired,
// mis-shaped and from a rotated-away key (free tier + "operator"), licences expired, from the wrong
// vendor, over the term, from a rotated-away vendor key or absent (free tier + "licence"), an
// operator's rotation the relay has not seen yet, stolen vendor and operator keys against recovery,
// licences kept until 30 days after their expiry, used or not, with their operator's account and
// chain, an agent's account kept while its operator attestation runs, a licence moved only along
// its operator's chain or by a recovery, a login without a bundle storing no new identity, POST
// /licence, and the free tier's ceiling measured from the disk's room. Also: one network's share of the free ceiling, the brake per network, a
// "pow" refusal before any transaction, every refusal named, and sessions of identities that
// have proven no work, closed in time and giving their seat to one that has. The default tiers of
// §11 (Pro: 90 days, 1 MB, groups, support), and the licence's support claim. Refusals that cost
// nothing else (no_reader) neither starve a network's Pro agents (their own bucket) nor escape the
// strikes; a chain sent again longer checked against the free ceiling, a pool's rows against its
// storage, a recovery edge let through; one pooled reader's share against writers outside its
// pool, and the largest message the smaller of the two tiers'; the claim brake on claims and
// releases, each a checkpoint; a long queue given up and a day's expired messages deleted in
// batches; a CONNECT restoring at most RESTORE_MAX claims.
// design/relay-plan.md §1, §3, §5, §7 M4, §11. Prints "ALL PASS (n)".
//   node relay/test/allowance.mjs
import { mkdtempSync, readFileSync, rmSync, statfsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { connect as netConnect } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { connect, MqttClient } from 'mqtt';
import { attest, canonicalize, keygen, rotate } from 'sigelo';
import { FULL, startRelay } from '../server.mjs';
import { ACCOUNT_ROW, CLAIM_ROW, DELETE_BATCH, accountOf, openDb } from '../db.mjs';
import { RESTORE_MAX } from '../mailbox.mjs';
import { OPERATOR_CTX } from '../auth.mjs';
import { KB, MB, MESSAGE_FLOOR, MESSAGE_ROW, TIERS as DEFAULT_TIERS, chargeOf, freeQueueOf, relayPolicy, relayPolicyFromEnv, windowWeeks } from '../allowance.mjs';
import { checkRelayLicence, LICENCE_CTX, LICENCE_KEEP, RELAY_ROTATIONS_MAX, operators } from '../operator.mjs';
import { CLOSED_BITS, DAY as POW_DAY, NETWORK_DAY, NETWORK_STEPS, leadingZeroBits, powCheck, powDigest, solve } from '../pow.mjs';
import { CREATED, bundleOf, clientId, identity, password, rotated, seed } from './fixtures.mjs';

let n = 0, failed = 0;
const ok = (cond, what) => { n++; if (cond) console.log(`ok ${what}`); else { failed++; console.log(`FAIL ${what}`); } };
setTimeout(() => { console.log(`FAIL the run did not finish in 240 s (${n} checks so far)`); process.exit(1); }, 240000).unref();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (cond, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (cond()) return true; await sleep(10); } return cond(); };

const HOST = 'relay.test', DAY = 86400, YEAR = 365 * DAY;
const dir = mkdtempSync(join(tmpdir(), 'sigelo-relay-m4-'));
let now = Date.parse('2026-10-07T00:00:00Z') / 1000;
// Small tiers, so every edge is a few messages away. A queued message is charged its size, at
// least 256, plus 384 (chargeOf): a 1,000-byte message costs 1,384, an empty one 640. The licences
// below sell more than pro allows in storage (the ceiling applies) and less in messages and
// retention (the licence applies).
const TIERS = {
  free: { storage: 5000, msgsDay: 5, retentionDays: 7, maxMessage: 1000, mailboxes: 3 },
  pro: { storage: 8768, msgsDay: 6, retentionDays: 30, maxMessage: 4000, mailboxes: 5 },
};
const vendor = identity('vendor');
let pol;   // the policy object of the main relay, for tierOf
// The free tier's ceiling is set, so the run does not depend on how full this machine's disk is;
// the default, measured from the disk, is checked on a relay of its own below.
const config = { vendor: vendor.original, tiers: TIERS, pow: { bits: 8, loadBits: 12, loadPerHour: 1000 }, licenceRate: 1000, freeQueue: 64 * 1024 * 1024 };
const cfg = { host: HOST, db: join(dir, 'relay.db'), tcpPort: 0, httpPort: 0, loginRate: 100000, verifyBudget: 1e9, clock: () => now, diskUsed: () => 0.1, log: () => {},
  policy: (ctx) => (pol = relayPolicy(ctx, config)) };
const relay = await startRelay(cfg);

// ---- clients ----
const base = (r = relay) => `http://127.0.0.1:${r.ports.http}`;
// ip: the client address nginx would send as X-Real-IP (documentation ranges, RFC 5737): the
// network GET /challenge counts it in. Without it, 127.0.0.0/24.
const getChallenge = async (d, r = relay, ip = undefined) => (await fetch(`${base(r)}/challenge?did=${encodeURIComponent(d)}`, { headers: ip ? { 'x-real-ip': ip } : {} })).json();
const postJson = async (path, body, r = relay) => {
  const res = await fetch(`${base(r)}${path}`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
};
// local: the client's own loopback address (127.0.1.1 is another /24 than 127.0.0.1).
const mqttConnect = ({ username, clientId: cid, password: pw }, r = relay, local = undefined) => new Promise((resolve) => {
  const o = { protocolVersion: 4, clean: false, clientId: cid, username, password: pw, reconnectPeriod: 0, connectTimeout: 5000 };
  const c = local ? new MqttClient(() => netConnect({ host: '127.0.0.1', port: r.ports.tcp, localAddress: local }), o) : connect({ host: '127.0.0.1', port: r.ports.tcp, ...o });
  c.box = [];
  c.on('message', (t, p) => c.box.push({ t, p }));
  c.once('connect', () => resolve({ client: c }));
  c.once('error', (error) => { c.end(true); resolve({ error }); });
  c.once('close', () => resolve({ error: new Error('closed') }));
});
// Log in as id. opts: bundle (an object, or false for none), pow (true: solve it; a string: send
// it; false: none; absent: as contact/carrier.mjs does, a proof at the identity's first login to
// that relay, none after), local (the client's loopback address), ip (the X-Real-IP of its GET
// /challenge: the network its proof counts against).
const proved = new Set();   // relay port + original DID of each login with a proof that connected
async function login(id, opts = {}, r = relay) {
  const { challenge, pow_bits } = await getChallenge(id.did, r, opts.ip);
  const first = !proved.has(`${r.ports.tcp} ${id.original}`);
  const pow = opts.pow === true || (opts.pow === undefined && first) ? solve(HOST, id.original, challenge.nonce, pow_bits) : opts.pow || undefined;
  const pw = password(id, challenge, { bundle: opts.bundle ?? true, extra: pow === undefined ? {} : { pow } });
  const creds = { username: id.did, clientId: clientId(id), password: pw };
  const out = { ...(await mqttConnect(creds, r, opts.local)), creds, challenge, pow_bits };
  if (out.client && pow !== undefined) proved.add(`${r.ports.tcp} ${id.original}`);
  return out;
}
const checkOf = async (creds, r = relay) => (await postJson('/check', { username: creds.username, client_id: creds.clientId, password: creds.password }, r)).json;
const subscribe = (c, t) => new Promise((resolve) => c.subscribe(t, { qos: 1 }, (e, g) => resolve(e ? (/^Subscribe error/.test(e.message) ? 128 : -1) : g[0].qos)));
const unsubscribe = (c, t) => new Promise((resolve) => c.unsubscribe(t, () => resolve()));
// The packets c receives while f runs, in the order they came on the wire: a notice as
// "notice:<code>", any other packet as its type. A refusal's notice must come before the
// acknowledgement of the request it refuses (mailbox.mjs): a client reads it that way.
async function wireOf(c, f) {
  const wire = [], on = (p) => wire.push(p.cmd === 'publish' && p.topic === '$sigelo/notice' ? `notice:${JSON.parse(p.payload).code}` : p.cmd);
  c.on('packetreceive', on);
  try { await f(); } finally { c.off('packetreceive', on); }
  return wire.join();
}
const publish = (c, t, p) => new Promise((resolve) => c.publish(t, p, { qos: 1 }, (e) => resolve(e ?? null)));
const notices = (c) => c.box.filter((m) => m.t === '$sigelo/notice').map((m) => JSON.parse(m.p));
const noticed = (c, code) => until(() => notices(c).some((x) => x.code === code));
const got = (c, t) => c.box.filter((m) => m.t === t);
const end = (c) => new Promise((resolve) => c.end(false, {}, resolve));
const topic = () => `m/${randomBytes(16).toString('hex')}`;
const queued = (t, r = relay) => r.db.raw.prepare('SELECT count(*) AS n, coalesce(sum(bytes), 0) AS bytes FROM messages WHERE topic = ?').get(t);
// What the reader is charged for its queue (allowance.mjs queue_totals), and whether those totals
// equal the queue summed afresh: they are kept by triggers, so every way a message goes must count.
const charged = (id, r = relay) => r.db.raw.prepare('SELECT bytes FROM queue_totals WHERE account = ?').get(accountOf(id.original))?.bytes ?? 0;
function totalsMatch(r) {
  const c = `max(bytes, ${MESSAGE_FLOOR}) + ${MESSAGE_ROW}`, q = (sql) => JSON.stringify(r.db.raw.prepare(sql).all());
  return q(`SELECT account, count(*) AS n, sum(${c}) AS bytes FROM messages GROUP BY account ORDER BY account`) === q("SELECT account, n, bytes FROM queue_totals WHERE account <> '*' ORDER BY account")
    && q(`SELECT count(*) AS n, coalesce(sum(${c}), 0) AS bytes FROM messages`) === q("SELECT n, bytes FROM queue_totals WHERE account = '*'")
    && q(`SELECT pool, count(*) AS n, sum(${c}) AS bytes FROM messages WHERE pool IS NOT NULL GROUP BY pool ORDER BY pool`) === q('SELECT pool, n, bytes FROM pool_queue ORDER BY pool');
}
// A publish the relay refused: the sender's notice names `code`, and nothing new is queued or delivered.
async function refusedPublish(c, t, size, code, what, reader) {
  const before = queued(t).n, seen = reader ? got(reader, t).length : 0;
  c.box.length = 0;
  await publish(c, t, randomBytes(size));
  const named = await noticed(c, code);
  await sleep(50);
  ok(named && queued(t).n === before && (!reader || got(reader, t).length === seen), `${what}: refused ${code} (${notices(c).map((x) => x.code).join() || 'no notice'})`);
}
const tierOf = (id) => pol.tierOf(accountOf(id.original), now);
// A login whose proof of work misses the difficulty (the first such c for this login's nonce).
async function loginBadPow(id, r = relay) {
  const { challenge, pow_bits } = await getChallenge(id.did, r);
  let c = 0;
  while (leadingZeroBits(powDigest(HOST, id.original, challenge.nonce, String(c))) >= pow_bits) c++;
  const creds = { username: id.did, clientId: clientId(id), password: password(id, challenge, { extra: { pow: String(c) } }) };
  return { ...(await mqttConnect(creds, r)), creds };
}
const isoOf = (t) => new Date(t * 1000).toISOString().replace('.000Z', 'Z');

// ---- licences and operator attestations, as commercial/issue-licence.mjs and an operator write them ----
const relayClaims = { tier: 'pro', storage_mb: 1, msgs_day: 5, retention_days: 20, groups: 0 };
function licence(sub, o = {}) {
  const v = o.vendor ?? vendor, iat = o.iat ?? now - 60;
  const attestation = attest({ secret: o.secret ?? v.secret, iss: o.iss ?? v.did, sub: sub.original, iat, exp: o.exp ?? iat + YEAR, ctx: o.ctx ?? LICENCE_CTX, admission: 'payment', claims: o.claims ?? relayClaims });
  return { attestation, issuer: o.issuer ?? v.origin, rotations: o.rotations ?? v.rotations };
}
const upload = async (lic, r = relay) => (await postJson('/licence', lic, r)).json;
function vouch(op, agent, o = {}) {
  const iat = o.iat ?? now - 60;
  return attest({ secret: o.secret ?? op.secret, iss: op.did, sub: o.sub ?? agent.original, iat, exp: o.exp ?? iat + 30 * DAY, ctx: OPERATOR_CTX, admission: o.admission ?? 'invite',
    admission_by: op.did, claims: o.claims ?? { relay: HOST } });
}
const withVouch = (agent, op, att) => bundleOf(agent, { attestations: [att], issuers: [op.genesis] });

// ================================================================ pow.mjs, by itself
{
  ok(leadingZeroBits(Buffer.from([0, 0, 0x3f, 0xff])) === 18 && leadingZeroBits(Buffer.from([0x80, 0])) === 0 && leadingZeroBits(Buffer.alloc(32)) === 256, 'leading zero bits: 18, 0, and 256 for a zero digest');
  const did = identity('pow').original, nonceA = 'A'.repeat(43), nonceB = 'B'.repeat(43);
  const p = powCheck({ bits: 12, loadBits: 16 });
  const c = solve(HOST, did, nonceA, 12);
  ok(leadingZeroBits(powDigest(HOST, did, nonceA, c)) >= 12 && p.check({ pow: c, host: HOST, original: did, nonce: nonceA, bits: 12 }) === null, `a proof of 12 bits over (host, original DID, nonce, c = ${c}) is accepted: one hash`);
  // An independent vector (computed with sha256sum over the plan's bytes), so a change of the
  // layout fails here even though solve() and the check would still agree with each other.
  ok(c === '5505' && powDigest(HOST, did, nonceA, c).toString('hex') === '0002fd76159103431219d720d7ecd8e87289abbc6a856ffa8fb32f654d6a3f5e',
    'plan §3\'s layout pinned: "sigelo-relay-pow/0\\n" ‖ relay.test ‖ the "pow" fixture DID ‖ "A" × 43 ‖ c: c = 5505 at 12 bits, digest 0002fd76…');
  ok(/does not meet 12 bits/.test(p.check({ pow: c, host: HOST, original: did, nonce: nonceB, bits: 12 })) && p.check({ pow: c, host: 'other.relay', original: did, nonce: nonceA, bits: 12 }) !== null
    && p.check({ pow: c, host: HOST, original: identity('pow 2').original, nonce: nonceA, bits: 12 }) !== null, 'the same c over another nonce, another relay or another DID: refused, "does not meet 12 bits"');
  ok(['12a', '1'.repeat(17), '', 5].every((x) => /want c as a string/.test(p.check({ pow: x, host: HOST, original: did, nonce: nonceA, bits: 12 }))), 'c that is not 1 to 16 decimal digits (a letter, 17 digits, empty, a number): refused');
  // The check takes the bits the nonce states, never below the base: a stated 0 is a bug, not a pass.
  let weak = 0, none = 0;   // a c of 12 to 15 bits; one of fewer than 12
  for (let i = 0; ; i++) { const z = leadingZeroBits(powDigest(HOST, did, nonceA, String(i))); if (z >= 12 && z < 16) { weak = String(i); break; } }
  for (let i = 0; ; i++) { if (leadingZeroBits(powDigest(HOST, did, nonceA, String(i))) < 12) { none = String(i); break; } }
  const stated = (b, pc = p, x = weak) => pc.check({ pow: x, host: HOST, original: did, nonce: nonceA, bits: b });
  ok(stated(12) === null && /does not meet 16 bits/.test(stated(16)) && /does not meet 12 bits/.test(stated(0, p, none)),
    'a proof is checked against the bits its nonce states (12 taken, 16 refused for a 12-to-15-bit c), and never below the base (stated 0: 12 still needed)');
  // The load raise: more than 2 new identities in an hour → 16 bits, for that hour and the next.
  const l = powCheck({ bits: 12, loadBits: 16, loadPerHour: 2 });
  const hour = Math.floor(now / 3600) * 3600;
  for (let i = 0; i < 3; i++) l.arrived(hour + 10);
  ok(l.required(hour + 20) === 16 && stated(12, l) === null && /does not meet 16 bits/.test(stated(16, l)),
    'under load (3 new identities, 2 an hour configured): 16 bits for a challenge issued now; one issued at 12 before the raise is still taken at 12 (its nonce says so)');
  ok(l.required(hour + 3600 + 5) === 16 && l.required(hour + 7200 + 5) === 12, 'the raise holds through the next hour and ends the hour after');
  // Per network (pow.mjs NETWORK_STEPS): the base below 8 new identities from it in 24 hours, + 2
  // from 8, + 4 from 64; a network is counted alone, and only for 24 hours.
  ok(JSON.stringify(NETWORK_STEPS) === '[{"from":8,"add":2},{"from":64,"add":4}]', 'the default curve: + 2 bits from 8 new identities a day from one network, + 4 from 64 (22, 24, 26)');
  const w = powCheck({ bits: 22, loadBits: 24, loadPerHour: 1000 }), t = hour + 3 * 3600, A = 'net a', B = 'net b';
  const curve = [];
  for (let i = 0; i < 64; i++) {
    if ([0, 7, 8, 63].includes(i)) curve.push(`${i}:${w.required(t, A)}`);
    w.arrived(t + i, A);
  }
  curve.push(`64:${w.required(t + 64, A)}`);
  ok(curve.join() === '0:22,7:22,8:24,63:24,64:26' && w.required(t + 64, B) === 22 && w.required(t + 64) === 22,
    `a network's difficulty at the edges (arrivals:bits): ${curve.join(' ')}; another network, and none, still 22`);
  // Arrival i came at t + i: at t + DAY + k, those after t + k are inside the day, 63 - k of them.
  ok(w.required(t + POW_DAY - 1, A) === 26 && w.required(t + POW_DAY, A) === 24 && w.required(t + POW_DAY + 55, A) === 24 && w.required(t + POW_DAY + 56, A) === 22,
    '24 hours on, the arrivals leave one by one: 26 while all 64 are inside the day, 24 from the first one out, 22 once 7 are left');
  const both = powCheck({ bits: 12, loadBits: 16, loadPerHour: 2 });
  for (let i = 0; i < 8; i++) both.arrived(hour + 10, A);
  ok(both.required(hour + 20, A) === 16 && both.required(hour + 20, B) === 16 && both.required(hour + 3 * 3600, A) === 14,
    'the load raise and a network\'s step together: the higher of the two (16), and the network\'s 14 once the load is gone');
  // Challenges waiting (issued, neither spent nor expired) count with the arrivals: each one's
  // difficulty is frozen in its nonce, so counting good proofs alone let one network fetch as many
  // challenges as it liked at the base before redeeming any (review finding: the prefetch race).
  const pf = powCheck({ bits: 22, loadBits: 24, loadPerHour: 1000 }), tp = hour + 5 * 3600;
  const tally = (xs) => [...new Set(xs)].map((x) => `${x}x${xs.filter((y) => y === x).length}`).join(' ');
  const ahead = Array.from({ length: 70 }, () => pf.issue(tp, A, tp + 300));
  ok(tally(ahead) === '22x8 24x56 26x6' && pf.required(tp, B) === 22,
    `70 challenges fetched by one network before any login state ${tally(ahead)}, the curve for 70 new identities; another network still 22`);
  for (let i = 0; i < 70; i++) pf.spent(tp + 1, A, tp + 300);
  ok(pf.required(tp + 1, A) === 22, 'spent by logins without a good proof (a known identity, a bad proof), they wait no more: 22 again');
  for (let i = 0; i < 8; i++) { pf.issue(tp + 2, A, tp + 302); pf.spent(tp + 3, A, tp + 302); pf.arrived(tp + 3, A); }
  ok(pf.required(tp + 3, A) === 24, 'spent with a good proof, a challenge moves from waiting to arrived: 8 of them, 24 for the next');
  for (let i = 0; i < 60; i++) pf.issue(tp + 4, B, tp + 304);
  ok(pf.required(tp + 303, B) === 24 && pf.required(tp + 304, B) === 22, 'challenges never redeemed wait until they expire (300 s), then count no more');
  const pl = powCheck({ bits: 12, loadBits: 16, loadPerHour: 2 });
  const relayWide = [0, 1, 2, 3].map((i) => pl.issue(tp, `net ${i}`, tp + 300));
  [0, 1, 2, 3].forEach((i) => pl.spent(tp + 1, `net ${i}`, tp + 300));
  ok(relayWide.join() === '12,12,12,16' && pl.required(tp + 1) === 12,
    `the load raise counts waiting challenges too (2 an hour configured, one each from 4 networks): ${relayWide.join()}; 12 once they are spent`);
  // A count, not a difficulty, bounds what one network mints (audit: a native solver does 2^26 in
  // ~3 s): past perDay good proofs in 24 hours the network is capped, and its challenges state
  // CLOSED_BITS. Challenges held unredeemed close nothing; another network is not touched.
  ok(NETWORK_DAY === 64 && CLOSED_BITS === 64, 'the default cap: 64 new identities a day from one network; a closed network is told 64 bits');
  const cap = powCheck({ bits: 12, loadBits: 16, perDay: 3 }), tc = hour + 7 * 3600;
  for (let i = 0; i < 5; i++) cap.issue(tc, A, tc + 300);
  const opened = !cap.capped(tc, A);
  for (let i = 0; i < 3; i++) cap.arrived(tc + i, A);
  ok(opened && cap.capped(tc + 3, A) && cap.issue(tc + 3, A, tc + 303) === CLOSED_BITS && !cap.capped(tc + 3, B) && cap.issue(tc + 3, B, tc + 303) === 12,
    'perDay 3: 5 challenges held close nothing; after 3 good proofs the network is capped and its next challenge states 64; another network 12');
  ok(cap.capped(tc + POW_DAY - 1, A) && !cap.capped(tc + POW_DAY, A), 'the cap holds for 24 hours from the oldest of those proofs, then the network opens');
  const thrown = (o) => { try { powCheck(o); return ''; } catch (e) { return e.message; } };
  ok(/perDay/.test(thrown({ bits: 8, perDay: 0 })), 'powCheck refuses a cap below 1');
  ok(/at most 60/.test(thrown({ bits: 61, loadBits: 61 })) && /rising/.test(thrown({ bits: 8, steps: [{ from: 8, add: 2 }, { from: 8, add: 4 }] })) && /rising/.test(thrown({ bits: 8, steps: [{ from: 8, add: 2 }, { from: 64, add: 2 }] })),
    'powCheck refuses a base whose highest step passes 64 bits, and steps that do not rise');
  const bad = powCheck({ bits: 22 });
  const t0 = process.hrtime.bigint();
  let passed = 0;
  for (let i = 0; i < 10000; i++) if (bad.check({ pow: String(i), host: HOST, original: did, nonce: nonceB, bits: 22 }) === null) passed++;
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  ok(passed === 0 && ms < 2000 && bad.required(now) === 22, `10,000 bad proofs at 22 bits: all refused in ${ms.toFixed(0)} ms, one hash each, no arrival counted`);
}

// ================================================================ proof of work on the relay
const erin = identity('erin');
{
  const ch = await getChallenge(erin.did);
  ok(ch.pow_bits === 8, `GET /challenge gives pow_bits, the configured difficulty (${ch.pow_bits})`);
  const l0 = await login(erin, { pow: false });
  ok(l0.client?.connected === true, 'a new identity logs in without a proof: the work is due at its first claim');
  ok(await subscribe(l0.client, topic()) === 128 && await noticed(l0.client, 'pow'), 'its first claim: refused, $sigelo/notice "pow"');
  await end(l0.client);
  const shape = await login(erin, { pow: '0x1f' });
  ok(!shape.client && (await checkOf(shape.creds)).check === 'pow', 'a pow that is not decimal digits: CONNECT refused, POST /check names pow');
  // A proof for one login's nonce, sent with another login: refused.
  const first = await getChallenge(erin.did), second = await getChallenge(erin.did);
  let stale;
  for (let i = 0; ; i++) {
    const c = String(i);
    if (leadingZeroBits(powDigest(HOST, erin.original, first.challenge.nonce, c)) >= 8 && leadingZeroBits(powDigest(HOST, erin.original, second.challenge.nonce, c)) < 8) { stale = c; break; }
  }
  const staleCreds = { username: erin.did, clientId: clientId(erin), password: password(erin, second.challenge, { extra: { pow: stale } }) };
  const replayed = await mqttConnect(staleCreds);
  ok(!replayed.client && (await checkOf(staleCreds)).check === 'pow', 'a proof made over another login\'s nonce: refused, POST /check names pow');
  const l1 = await login(erin, { pow: true });
  ok(l1.client?.connected === true && await subscribe(l1.client, topic()) === 1, 'with a proof over this login\'s nonce: logged in, and the first claim is granted');
  await end(l1.client);
  const l2 = await login(erin, { bundle: false });
  ok(l2.client?.connected === true && await subscribe(l2.client, topic()) === 1, 'later logins prove nothing: work is proven once per identity');
  await end(l2.client);
  const l3 = await login(erin, { pow: '0' });
  const l4 = await login(erin, { pow: 'x' });
  ok(l3.client?.connected === true && !l4.client && (await checkOf(l4.creds)).check === 'pow', 'a proven identity\'s pow is not hashed again ("0" passes) but is still shape-checked ("x": pow)');
  l3.client?.end(true);
  // Bad proofs leave nothing behind: no proof kept, no account, no arrival (plan §5 "Proof-of-work
  // DoS"). Five logins of a new identity, then 10,000 checks through the relay's own policy.
  const nell = identity('nell'), nellAccount = accountOf(nell.original), nonceB = 'B'.repeat(43);
  const proofs = () => relay.db.raw.prepare('SELECT count(*) AS n FROM pow_proofs').get().n, before = proofs();
  let named = 0;
  for (let i = 0; i < 5; i++) { const b = await loginBadPow(nell); if (!b.client && (await checkOf(b.creds)).check === 'pow') named++; }
  const bad = [];
  for (let i = 0; bad.length < 10000; i++) if (leadingZeroBits(powDigest(HOST, nell.original, nonceB, String(i))) < 8) bad.push(String(i));
  const t0 = process.hrtime.bigint();
  const refused = bad.filter((c) => pol.pow({ pow: c, host: HOST, account: nellAccount, original: nell.original, nonce: nonceB, isNew: false, now, bits: 8, network: 'test' }) !== null).length;
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  ok(named === 5 && refused === 10000 && ms < 5000 && proofs() === before && relay.db.account(nellAccount) === undefined && (await getChallenge(erin.did)).pow_bits === 8,
    `5 logins and 10,000 policy checks with bad proofs: refused "pow" (${ms.toFixed(0)} ms), no proof kept, no account made, pow_bits still 8`);
  // The load raise on a relay of its own, configured for 3 new identities an hour: only good proofs
  // count, so logins without a proof, or with bad ones, cannot raise the work for everyone else.
  const loaded = await startRelay({ ...cfg, db: join(dir, 'load.db'), policy: (ctx) => relayPolicy(ctx, { ...config, pow: { bits: 8, loadBits: 12, loadPerHour: 3 } }) });
  for (let i = 0; i < 6; i++) (await login(identity(`idle ${i}`), { pow: false }, loaded)).client?.end(true);
  for (let i = 0; i < 4; i++) (await loginBadPow(identity('liar'), loaded)).client?.end(true);
  const unloaded = (await getChallenge(erin.did, loaded)).pow_bits;
  for (let i = 0; i < 4; i++) (await login(identity(`crowd ${i}`), { pow: true }, loaded)).client?.end(true);
  const raised = (await getChallenge(erin.did, loaded)).pow_bits;
  now += 2 * 3600;
  const calm = (await getChallenge(erin.did, loaded)).pow_bits;
  ok(unloaded === 8 && raised === 12 && calm === 8,
    `6 new identities without a proof and one failing 4 times raise nothing (pow_bits ${unloaded}); 4 good proofs in an hour: ${raised}; two hours later ${calm}`);
  await loaded.close();
  // Per network, on a relay of its own (base 8): new identities whose challenges came from one /24
  // (nginx's X-Real-IP; every CONNECT here comes from 127.0.0.1) raise that network's pow_bits at 8
  // good proofs a day. Other networks stay at 8, the CONNECTs' own 127.0.0.0/24 included: else
  // challenges asked from one network and logins made from another kept the first at the base.
  const N = await startRelay({ ...cfg, db: join(dir, 'netpow.db'), policy: (ctx) => relayPolicy(ctx, config) });
  const NET = '198.51.100.7', NEAR = '198.51.100.200', OTHER = '203.0.113.7', saved = now;
  const late = identity('net late'), later = identity('net later');
  const early = await getChallenge(late.did, N, NET);   // issued at 8 bits, used after the raise
  const joined = [];
  for (let i = 0; i < 8; i++) { const l = await login(identity(`net ${i}`), { pow: true, ip: NET }, N); joined.push(l.client?.connected === true); l.client?.end(true); }
  const bitsOf = async (ip) => (await getChallenge(erin.did, N, ip)).pow_bits;
  const seen = [await bitsOf(NET), await bitsOf(NEAR), await bitsOf(OTHER), await bitsOf(undefined)];
  ok(early.pow_bits === 8 && joined.every(Boolean) && seen.join() === '10,10,8,8',
    `8 new identities whose challenges came from ${NET}: pow_bits there and in the rest of its /24 ${seen[0]}, ${seen[1]} (8 + 2); another /24 ${seen[2]}; the CONNECTs' 127.0.0.0/24 ${seen[3]}`);
  // A proof is checked against the bits its nonce states: the raise refuses no client mid-search.
  const weakFor = (id, nonce) => { for (let i = 0; ; i++) { const z = leadingZeroBits(powDigest(HOST, id.original, nonce, String(i))); if (z >= 8 && z < 10) return String(i); } };
  const connectWith = async (id, ch) => { const creds = { username: id.did, clientId: clientId(id), password: password(id, ch, { extra: { pow: weakFor(id, ch.nonce) } }) }; return { ...(await mqttConnect(creds, N)), creds }; };
  const e = await connectWith(late, early.challenge), fresh10 = await getChallenge(later.did, N, NET), f = await connectWith(later, fresh10.challenge);
  ok(e.client?.connected === true && fresh10.pow_bits === 10 && !f.client && (await checkOf(f.creds, N)).check === 'pow',
    'an 8-or-9-bit proof on the challenge issued at 8 before the raise logs in after it (its nonce states 8); on one issued after (10): refused "pow"');
  e.client?.end(true);
  now += DAY;
  const dayOn = await bitsOf(NET);
  ok(dayOn === 8, `a day after those proofs, ${NET} is back at the base (${dayOn})`);
  now = saved;
  await N.close();
  // The prefetch race (review finding), on a relay of its own: one /24 fetches challenges for 9
  // fresh DIDs before any login. They wait, and count as new identities to come, so the 9th states
  // 8 + 2; all 9 are redeemed at what they state and log in. Before, all 9 stated 8, and so did
  // every challenge a network could fetch within 5 minutes.
  const P = await startRelay({ ...cfg, db: join(dir, 'prefetch.db'), policy: (ctx) => relayPolicy(ctx, config) });
  const PNET = '192.0.2.7', KNET = '2001:db8:1::7', UNET = '2001:db8:2::7';   // three networks: a /24 and two /48s
  const fetched = [];
  for (let i = 0; i < 9; i++) { const id = identity(`ahead ${i}`); fetched.push({ id, ...(await getChallenge(id.did, P, PNET)) }); }
  let redeemed = 0;
  for (const { id, challenge, pow_bits } of fetched) {
    const r = await mqttConnect({ username: id.did, clientId: clientId(id), password: password(id, challenge, { extra: { pow: solve(HOST, id.original, challenge.nonce, pow_bits) } }) }, P);
    if (r.client?.connected) redeemed++;
    r.client?.end(true);
  }
  const statedAhead = fetched.map((x) => x.pow_bits).join();
  ok(statedAhead === '8,8,8,8,8,8,8,8,10' && redeemed === 9 && (await getChallenge(erin.did, P, PNET)).pow_bits === 10,
    `9 challenges fetched by one /24 before any login state ${statedAhead}; all 9 log in at what they state; that /24 then states 10`);
  // A known identity's logins spend their challenges at once (auth.mjs powSpent): 20 logins from
  // one /24 leave nothing waiting there. Challenges nobody redeems wait 300 s, then count no more.
  const known = identity('known k');
  for (let i = 0; i < 21; i++) { const l = await login(known, { ip: KNET }, P); l.client?.end(true); }
  const knownBits = (await getChallenge(erin.did, P, KNET)).pow_bits;
  for (let i = 0; i < 8; i++) await getChallenge(identity(`unredeemed ${i}`).did, P, UNET);
  const held = (await getChallenge(erin.did, P, UNET)).pow_bits;
  now += 300;
  const expired = (await getChallenge(erin.did, P, UNET)).pow_bits;
  ok(knownBits === 8 && held === 10 && expired === 8,
    `21 logins of one identity from one network leave its pow_bits there at ${knownBits}; 8 challenges unredeemed on another raise it to ${held}, and to ${expired} once expired`);
  now = saved;
  await P.close();
  // The cap per network, on a relay of its own (3 a day): the network's 4th new identity is refused
  // "pow" however good its proof, a challenge issued before the cap included, and GET /challenge
  // states 64 there meanwhile. Known identities from it log in; another network is not held.
  const C = await startRelay({ ...cfg, db: join(dir, 'netcap.db'), policy: (ctx) => relayPolicy(ctx, { ...config, pow: { ...config.pow, perDay: 3 } }) });
  const CNET = '198.51.100.9', CAWAY = '203.0.113.9';
  const pre = identity('cap before'), ch4 = await getChallenge(pre.did, C, CNET);
  // A licensed operator (logged in from another network) and a challenge its new agent fetches
  // from CNET before the cap, stated at 8.
  const opC = identity('cap operator'), agC = identity('cap agent'), chA = await getChallenge(agC.did, C, CNET);
  (await login(opC, { pow: true, ip: CAWAY }, C)).client?.end(true);
  const upC = await upload(licence(opC), C);
  const three = [];
  for (let i = 0; i < 3; i++) { const id = identity(`cap ${i}`), l = await login(id, { pow: true, ip: CNET }, C); three.push(l.client?.connected === true); l.client?.end(true); }
  const closed = (await getChallenge(erin.did, C, CNET)).pow_bits;
  const c4 = { username: pre.did, clientId: clientId(pre), password: password(pre, ch4.challenge, { extra: { pow: solve(HOST, pre.original, ch4.challenge.nonce, ch4.pow_bits) } }) };
  const capL = await mqttConnect(c4, C), why4 = await checkOf(c4, C);
  ok(three.every(Boolean) && closed === CLOSED_BITS && ch4.pow_bits === 8 && !capL.client && why4.check === 'pow' && /brought 3 new identities/.test(why4.detail ?? ''),
    `3 new identities from one /24 log in; then its GET /challenge states ${closed}, and a 4th with a good proof on a challenge issued before is refused "pow" (${why4.detail})`);
  // Review finding, recorded rather than changed (relay/README.md says it): the cap closes the
  // network to a licensed operator's new agents too. GET /challenge states 64 before the relay sees
  // any bundle, and contact/carrier.mjs searches no more than 26 bits; here the agent holds a
  // challenge from before the cap, a good proof and its operator attestation, and is refused all
  // the same. An exemption is the orchestrator's decision (this suite pins what is shipped).
  const cA = { username: agC.did, clientId: clientId(agC), password: password(agC, chA.challenge, { bundle: withVouch(agC, opC, vouch(opC, agC)), extra: { pow: solve(HOST, agC.original, chA.challenge.nonce, chA.pow_bits) } }) };
  const agL = await mqttConnect(cA, C), whyA = await checkOf(cA, C);
  ok(upC.ok && chA.pow_bits === 8 && !agL.client && whyA.check === 'pow' && /brought 3 new identities/.test(whyA.detail ?? '') && (await getChallenge(agC.did, C, CNET)).pow_bits === CLOSED_BITS,
    'a licensed operator\'s new agent on the capped network, with a good proof and its attestation: refused "pow" too, and told 64 bits for a fresh challenge');
  agL.client?.end(true);
  const again = await login(identity('cap 0'), { ip: CNET }, C), away = await login(identity('cap away'), { pow: true, ip: CAWAY }, C);
  ok(again.client?.connected === true && away.client?.connected === true, 'an identity that has proven work logs in from the capped network; a new one from another network gets in');
  again.client?.end(true); away.client?.end(true);
  now += POW_DAY;
  const reopened = await login(identity('cap next day'), { pow: true, ip: CNET }, C);
  ok(reopened.client?.connected === true, 'a day later the network brings a new identity again');
  reopened.client?.end(true);
  now = saved;
  await C.close();
}

// ================================================================ nothing durable for an identity that has proven no work
{
  // A login costs no work, so what it stores for a fresh DID is what free identities alone can pile
  // onto the disk: no account row, no chain (up to 64 rotations), no index, no pool row before a proof.
  const wan = rotated(identity('wan'), 'wan 1'), acct = accountOf(wan.original);
  const opw = identity('operator w');
  (await login(opw)).client?.end(true);
  await upload(licence(opw));
  const stored = () => [relay.db.account(acct) !== undefined, relay.db.chainOf(acct, wan.original).length,
    relay.db.raw.prepare('SELECT count(*) AS n FROM chain_dids WHERE account = ?').get(acct).n, relay.db.raw.prepare('SELECT count(*) AS n FROM pool_members WHERE account = ?').get(acct).n];
  const lw = await login(wan, { pow: false, bundle: withVouch(wan, opw, vouch(opw, wan)) });
  ok(lw.client?.connected === true && stored().join() === 'false,0,0,0', `a fresh identity with a rotation and an operator attestation logs in without a proof: no account, chain, index or pool row is stored (${stored().join()})`);
  const reader = (await login(identity('wan reader'))).client, WT = topic();
  await subscribe(reader, WT);
  await refusedPublish(lw.client, WT, 10, 'pow', 'and it sends nothing before a proof (its messages today are counted on the account row it does not have)', reader);
  await end(lw.client);
  const lp = await login(wan, { pow: true, bundle: withVouch(wan, opw, vouch(opw, wan)) });
  ok(lp.client?.connected === true && stored().join() === 'true,1,2,1', `with a proof: its account, its chain of one rotation, both DIDs indexed and its pool row (${stored().join()})`);
  lp.client.box.length = 0;
  await publish(lp.client, WT, randomBytes(10));
  ok(await until(() => got(reader, WT).length === 1) && notices(lp.client).length === 0, 'and its message is delivered');
  for (const c of [lp.client, reader]) await end(c);
}
{
  // The audit's case: the key cached from a login that stored nothing, then a login without a
  // bundle but with the proof. That stored the account with no chain and no index rows: whoever
  // held a key the identity had rotated away from logged in with its genesis alone as an original
  // of its own, took it, and the owner's next login with its chain was refused "bundle".
  const v0 = identity('nobundle'), v1 = rotated(v0, 'nobundle 1'), v2 = rotated(v1, 'nobundle 2'), acct = accountOf(v0.original);
  const indexed = () => relay.db.raw.prepare('SELECT count(*) AS n FROM chain_dids WHERE account = ?').get(acct).n;
  const l0 = await login(v2, { pow: false });
  ok(l0.client?.connected === true && relay.db.account(acct) === undefined, 'an identity at its second key logs in with its chain and no proof: nothing stored');
  l0.client?.end(true);
  const l1 = await login(v2, { bundle: false, pow: true });
  ok(!l1.client && (await checkOf(l1.creds)).check === 'bundle' && relay.db.account(acct) === undefined, 'then without its bundle, with the proof: refused "bundle", still nothing stored');
  const l2 = await login(v2, { pow: true });
  ok(l2.client?.connected === true && relay.db.chainOf(acct, v0.original).length === 2 && indexed() === 3, `with its bundle and the proof: stored with its chain, all three DIDs indexed (${indexed()})`);
  l2.client?.end(true);
  const v1Alone = { ...v1, original: v1.did, origin: v1.genesis, rotations: [] };
  const lt = await login(v1Alone, { pow: true });
  ok(!lt.client && (await checkOf(lt.creds)).check === 'bundle', 'a holder of the key it rotated away from, with that genesis alone: refused "bundle"');
  const l3 = await login(v2, { bundle: false });
  ok(l3.client?.connected === true, 'and the owner logs in without its bundle once stored');
  l3.client?.end(true);
}

// ================================================================ the free tier, each allowance at its edge
const frank = identity('frank'), gina = identity('gina'), ivy = identity('ivy');
let F;
{
  now = Date.parse('2026-10-08T00:00:00Z') / 1000;
  const fr = (await login(frank, { pow: true })).client, gi = (await login(gina, { pow: true })).client;
  F = topic();
  await subscribe(fr, F);
  await publish(gi, F, randomBytes(1000));
  ok(await until(() => got(fr, F).length === 1), 'too_large edge: a 1,000-byte message to a free reader (largest 1,000) is delivered');
  await refusedPublish(gi, F, 1001, 'too_large', 'too_large edge: 1,001 bytes', fr);
  for (let i = 0; i < 4; i++) await publish(gi, F, randomBytes(10));
  ok(await until(() => got(fr, F).length === 5), 'quota_messages edge: the sender\'s 5th message today (free: 5 a day) is delivered');
  await refusedPublish(gi, F, 10, 'quota_messages', 'quota_messages edge: the 6th', fr);
  now += DAY;
  await publish(gi, F, randomBytes(10));
  ok(await until(() => got(fr, F).length === 6), 'the next UTC day the count starts again: delivered');
  // quota_storage: the reader offline, 5,000 bytes charged (its cap), then one byte more.
  await end(fr);
  const iv = (await login(ivy, { pow: true })).client;
  await publish(gi, F, randomBytes(1000));
  await publish(gi, F, randomBytes(1000));
  await publish(iv, F, randomBytes(900));
  ok(queued(F).bytes === 2900 && charged(frank) === 1384 + 1384 + 1284, `queued for the offline reader: 2,900 bytes, charged 4,052 of 5,000: each message its size plus 384 (${charged(frank)})`);
  await publish(iv, F, randomBytes(564));
  ok(charged(frank) === 5000 && queued(F).n === 4, 'quota_storage edge: a message whose charge fills the reader\'s 5,000 exactly is stored');
  await refusedPublish(iv, F, 1, 'quota_storage', 'quota_storage edge: one byte more');
  await refusedPublish(iv, F, 0, 'quota_storage', 'and an empty message: charged 640 (at least 256, plus 384), not nothing');
  const back = (await login(frank, { bundle: false })).client;
  ok(await until(() => queued(F).n === 0) && got(back, F).length === 4 && charged(frank) === 0, 'the reader collects its 4 messages: acknowledged, deleted, nothing charged');
  iv.box.length = 0;
  await publish(iv, F, randomBytes(500));
  ok(await until(() => got(back, F).length === 5) && notices(iv).length === 0, 'delivery freed the storage: the next message is accepted');
  // Expiry frees it too.
  await end(back);
  now += DAY;
  for (let i = 0; i < 3; i++) await publish(iv, F, randomBytes(1000));
  await publish(iv, F, randomBytes(464));
  await refusedPublish(iv, F, 1, 'quota_storage', 'the reader\'s queue full again (3 × 1,000 + 464 bytes: 5,000 charged), one byte more');
  now += 8 * DAY;
  const swept = relay.sweep();
  iv.box.length = 0;
  await publish(iv, F, randomBytes(1));
  ok(swept.expired === 4 && await until(() => queued(F).n === 1) && charged(frank) === 640 && notices(iv).length === 0,
    `after 7 days (free retention) the sweep expires the 4 (${swept.expired}): storage freed, a new message is stored`);
  // quota_mailboxes: frank holds F; two more make 3 (free: 3), a fourth is refused.
  const fm = (await login(frank, { bundle: false })).client;
  const T2 = topic(), T3 = topic(), T4 = topic();
  ok(await subscribe(fm, T2) === 1 && await subscribe(fm, T3) === 1, 'quota_mailboxes edge: the 2nd and 3rd claims (free: 3) are granted');
  ok(await subscribe(fm, T4) === 128 && await noticed(fm, 'quota_mailboxes'), 'quota_mailboxes edge: the 4th is refused, $sigelo/notice "quota_mailboxes"');
  await unsubscribe(fm, T3);
  ok(await subscribe(fm, T4) === 1, 'after giving one up (UNSUBSCRIBE), the 4th is granted');
  for (const c of [fm, gi, iv]) await end(c);
}

// ================================================================ a Pro pool: one operator, two agents, one allowance
const opr = identity('operator'), ann = identity('ann'), ben = identity('ben'), kai = identity('kai'), lou = identity('lou');
const POOL = accountOf(opr.original);
let annC, benC, K;
{
  now = Date.parse('2026-10-20T00:00:00Z') / 1000;
  // The relay takes the operator's current key from the chain it keeps with the operator's
  // account: no account, no licence (else a thief's key could pool until the licence ends).
  const early = await upload(licence(opr));
  ok(early.ok === false && early.check === 'licence' && early.detail.includes('logs in once with its bundle before uploading'), `POST /licence before the operator has ever logged in: refused "licence" (${early.detail})`);
  (await login(opr)).client?.end(true);
  const up = await upload(licence(opr));
  ok(up.ok === true && up.operator === opr.original && up.chain === 1 && up.claims.msgs_day === 5, `POST /licence: once it has logged in, a vendor licence to the operator's original DID is kept (${JSON.stringify(up)})`);
  const la = await login(ann, { pow: true, bundle: withVouch(ann, opr, vouch(opr, ann)) });
  const lb = await login(ben, { pow: true, bundle: withVouch(ben, opr, vouch(opr, ben)) });
  annC = la.client; benC = lb.client;
  const ta = tierOf(ann), tb = tierOf(ben);
  ok(annC?.connected && benC?.connected && ta.pool === POOL && tb.pool === POOL, 'two agents log in with their operator\'s attestation in their bundles: both draw on the operator\'s pool');
  ok(ta.limits.storage === 8768 && ta.limits.msgsDay === 5 && ta.limits.retention === 20 * DAY && ta.limits.maxMessage === 4000 && ta.limits.mailboxes === 5 && ta.limits.support === 'email',
    'the pool\'s allowance: the licence\'s 5 messages and 20 days, its 1 MB capped at pro\'s 8,768 bytes, pro\'s largest message and claims; a licence without support reads as "email"');
  // Messages: 3 from ann and 2 from ben use the pool's 5; the next from either is refused.
  const kc = (await login(kai, { pow: true })).client;
  K = topic();
  await subscribe(kc, K);
  for (let i = 0; i < 3; i++) await publish(annC, K, randomBytes(10));
  for (let i = 0; i < 2; i++) await publish(benC, K, randomBytes(10));
  ok(await until(() => got(kc, K).length === 5), 'pooled messages: ann sends 3, ben 2: all 5 delivered');
  await refusedPublish(benC, K, 10, 'quota_messages', 'pooled quota_messages edge: ben\'s 3rd', kc);
  await refusedPublish(annC, K, 10, 'quota_messages', 'and ann\'s 4th: one allowance for the pool', kc);
  // Claims: ann 3, ben 2 = the pool's 5.
  const claims = [];
  for (let i = 0; i < 3; i++) claims.push(await subscribe(annC, topic()));
  for (let i = 0; i < 2; i++) claims.push(await subscribe(benC, topic()));
  ok(claims.every((q) => q === 1), 'pooled claims: ann 3, ben 2, all granted (pool: 5)');
  ok(await subscribe(benC, topic()) === 128 && await noticed(benC, 'quota_mailboxes'), 'pooled quota_mailboxes edge: ben\'s 3rd is refused');
  ok(await subscribe(annC, topic()) === 128 && await noticed(annC, 'quota_mailboxes'), 'and ann\'s 4th');
  // Storage: both readers offline; 4,000 bytes to each (4,384 charged) fill the pool's 8,768.
  const A1 = topic(), B1 = topic();
  const freeA = relay.db.raw.prepare('SELECT topic FROM claims WHERE account = ? LIMIT 1').get(accountOf(ann.original)).topic;
  const freeB = relay.db.raw.prepare('SELECT topic FROM claims WHERE account = ? LIMIT 1').get(accountOf(ben.original)).topic;
  await unsubscribe(annC, freeA);
  await unsubscribe(benC, freeB);
  ok(await subscribe(annC, A1) === 1 && await subscribe(benC, B1) === 1, 'each gives one claim up and claims a fresh mailbox');
  await end(annC); await end(benC);
  now += DAY;
  const ly = (await login(lou, { pow: true })).client;
  const gi = (await login(gina, { bundle: false })).client;
  // The operator itself draws on its pool, and writes to its agents on it.
  const lo = await login(opr, { pow: true }), oc = lo.client;
  ok(oc?.connected && tierOf(opr).pool === POOL, 'the operator logs in itself: its own account is the pool\'s');
  // Audit finding: the largest message followed the reader alone, so a free contact sent a pooled
  // agent 1 MB messages, kept on the pool for up to 90 days. Now the smaller of the two.
  await refusedPublish(ly, A1, 1001, 'too_large', 'a free sender to a Pro reader: 1,001 bytes, over the smaller of its 1,000 and the reader\'s 4,000');
  await publish(oc, A1, randomBytes(4000));
  ok(queued(A1).bytes === 4000, 'too_large for a Pro reader: from a Pro sender, 4,000 bytes (pro\'s largest, over free\'s 1,000) are stored');
  await refusedPublish(oc, A1, 4001, 'too_large', 'and 4,001 bytes');
  await publish(oc, B1, randomBytes(4000));
  ok(queued(B1).bytes === 4000 && charged(ann) + charged(ben) === 8768, 'pooled storage: 4,000 bytes queued for ann and 4,000 for ben, 4,384 charged each, fill the pool\'s 8,768');
  await refusedPublish(ly, B1, 1, 'quota_storage', 'pooled quota_storage edge: one byte more for ben');
  await refusedPublish(gi, A1, 1, 'quota_storage', 'and one for ann');
  const exp = relay.db.raw.prepare('SELECT expires FROM messages WHERE topic = ?').get(A1);
  ok(exp.expires === Math.floor((now + 20 * DAY) / DAY) * DAY, 'a Pro reader\'s message is kept the licence\'s 20 days (to the start of that UTC day), not free\'s 7');
  for (const c of [kc, ly, gi, oc]) await end(c);
}

// ================================================================ operator attestations that pool nothing: free tier + "operator"
{
  now += DAY;
  const stranger = identity('stranger');
  const cases = [
    ['forged (signed by another key under the operator\'s DID)', identity('cal'), (a) => vouch(opr, a, { secret: stranger.secret })],
    ['expired', identity('dan'), (a) => vouch(opr, a, { iat: now - 10 * DAY, exp: now - 1 })],
    ['admission "open"', identity('eva'), (a) => vouch(opr, a, { admission: 'open' })],
    ['living 91 days (exp - iat)', identity('fay'), (a) => vouch(opr, a, { exp: now - 60 + 91 * DAY })],
  ];
  for (const [what, agent, make] of cases) {
    const l = await login(agent, { bundle: withVouch(agent, opr, make(agent)) });
    ok(l.client?.connected && await noticed(l.client, 'operator') && tierOf(agent).pool === null, `an operator attestation ${what}: logged in on the free tier, $sigelo/notice "operator" (${notices(l.client)[0]?.detail})`);
    l.client?.end(true);
  }
  // A free tier in deed, not only in tierOf: a 1,001-byte message to the forged one's mailbox.
  const cal = cases[0][1];
  const cc = (await login(cal, { pow: true, bundle: withVouch(cal, opr, cases[0][2](cal)) })).client, C1 = topic();
  await subscribe(cc, C1);
  const sender = (await login(kai, { bundle: false })).client;
  await refusedPublish(sender, C1, 1001, 'too_large', 'to an agent whose attestation was forged, free limits apply: 1,001 bytes');
  // The operator rotates its key and logs in: the relay now knows the old key is rotated away from.
  const opr2 = rotated(opr, 'operator 2');
  const lo = await login(opr2);
  ok(lo.client?.connected && tierOf(opr).pool === POOL, 'the operator rotates its key and logs in with the rotation: still its pool (the licence names its original DID)');
  const stale = await login(ann, { bundle: withVouch(ann, opr, vouch(opr, ann)) });
  ok(stale.client?.connected && await noticed(stale.client, 'operator') && tierOf(ann).pool === null,
    `ann's attestation by the key the operator rotated away from: free tier, "operator" (${notices(stale.client)[0]?.detail})`);
  ok(tierOf(ben).pool === null, 'ben, who logged in under the old key, no longer pools either: the key is checked at every use');
  stale.client?.end(true);
  const fresh = await login(ann, { bundle: withVouch(ann, opr2, vouch(opr2, ann)) });
  await sleep(100);
  ok(fresh.client?.connected && tierOf(ann).pool === POOL && notices(fresh.client).length === 0, 'a new attestation by the operator\'s current key: pooled again, no notice');
  const cached = await login(ann, { bundle: false });
  ok(cached.client?.connected && tierOf(ann).pool === POOL, 'a later login without a bundle keeps the pool until the attestation\'s exp');
  for (const c of [cc, sender, lo.client, fresh.client, cached.client]) c?.end(true);
}

// ================================================================ a chain put in front of an agent's genesis is refused, and pools nothing
{
  now += DAY;
  const opc = identity('operator c'), agc = identity('agent c'), OPC = accountOf(opc.original);
  (await login(opc)).client?.end(true);
  const upc = await upload(licence(opc));
  const la = await login(agc, { pow: true, bundle: withVouch(agc, opc, vouch(opc, agc)) });
  ok(upc.ok && la.client?.connected && tierOf(agc).pool === OPC, 'agent c pools under operator c, by an attestation to its original DID');
  la.client?.end(true);
  // Agent c's key is stolen. Its owner recovers (SPEC §7.1) and logs in: the relay keeps the recovery.
  const back = rotated(agc, 'agent c recovered', 'recovery', now - 600);
  const lr = await login(back, { pow: true, bundle: withVouch(back, opc, vouch(opc, agc)) });
  ok(lr.client?.connected && tierOf(agc).pool === OPC, 'its owner logs in with a recovery rotation; the attestation to the original DID still pools');
  lr.client?.end(true);
  const plain = await login(agc, { bundle: withVouch(agc, opc, vouch(opc, agc)) });
  ok(!plain.client && (await checkOf(plain.creds)).check === 'bundle', 'the thief with the stolen key and agent c\'s own genesis: bundle (the recovery kept here wins)');
  // The thief's own genesis, carrying agent c's recovery commitment (public), and a voluntary
  // rotation from it into agent c's genesis: SPEC §7.3 accepts that chain, and before, the relay
  // looked up the rotations it keeps by the first DID only, so the recovery was never merged.
  const tk = keygen({ seed: seed('agent c thief start'), recovery: agc.origin.recovery, created: CREATED, nonce: seed('agent c thief start nonce').slice(0, 16) });
  const into = rotate({ genesis: tk.genesis, next_genesis: agc.origin, iat: now - 300, reason: 'voluntary', secret: tk.secret });
  const prefixed = { ...agc, original: tk.did };   // agent c's stolen key and DID; the account of the thief's start
  const viaPrefix = (att) => ({ v: 'sigelo/0', typ: 'bundle', genesis: tk.genesis, rotations: [into], bindings: [], attestations: [att], issuers: [opc.genesis] });
  const lp = await login(prefixed, { pow: true, bundle: viaPrefix(vouch(opc, agc)) });
  const cp = lp.client ? { check: 'accepted' } : await checkOf(lp.creds);
  ok(!lp.client && cp.check === 'bundle' && !cp.detail.includes('did:sigelo:'),
    `after the recovery, the stolen key behind a chain start of the thief's own: refused bundle, naming no DID (${cp.check}: ${cp.detail})`);
  ok(pol.tierOf(accountOf(tk.did), now).pool === null, 'and that chain\'s account pools nothing');
  lp.client?.end(true);
  // An attestation names the agent by its original DID, the one the relay keys the account by: one
  // to another DID of the chain (the recovered key) pools nothing.
  const lc = await login(back, { bundle: withVouch(back, opc, vouch(opc, back, { sub: back.did })) });
  ok(lc.client?.connected && await noticed(lc.client, 'operator') && tierOf(agc).pool === null,
    `an operator attestation whose sub is the agent's current, not original, DID: free tier, "operator" (${notices(lc.client)[0]?.detail})`);
  lc.client?.end(true);
}

// ================================================================ licences: refused at upload, or lapsed: free tier + "licence"
{
  const other = identity('other vendor'), opx = identity('operator x');
  const refusals = [
    ['from another vendor', licence(opx, { vendor: other }), 'not the vendor'],
    ['with a term over 3 × 366 days', licence(opx, { exp: now - 60 + 3 * 366 * DAY + 1 }), 'longer than 1098 days'],
    ['already expired', licence(opx, { iat: now - 10 * DAY, exp: now - 1 }), 'expired at'],
    ['for the keeper (ctx sigelo-spend), worded as the keeper words it', licence(opx, { ctx: 'sigelo-spend', claims: { tier: 'pro', seats: 1 } }), 'is for "sigelo-spend", not sigelo-relay'],
    ['with claims other than {tier, storage_mb, msgs_day, retention_days, groups, support?}', licence(opx, { claims: { ...relayClaims, seats: 1 } }), 'claims are not'],
    ['with support "gold" (none, email or priority)', licence(opx, { claims: { ...relayClaims, support: 'gold' } }), 'claims are not'],
    // Each rotation would cost a signature check on the relay's one thread, twice: refused unread.
    [`carrying ${RELAY_ROTATIONS_MAX + 1} vendor rotations`, licence(opx, { rotations: Array(RELAY_ROTATIONS_MAX + 1).fill(rotated(vendor, 'vendor 2').rotations[0]) }), `more than the ${RELAY_ROTATIONS_MAX} this relay reads`],
  ];
  for (const [what, lic, why] of refusals) {
    const r = await upload(lic);
    ok(r.ok === false && r.check === 'licence' && r.detail.includes(why), `POST /licence ${what}: refused "licence" (${r.detail})`);
  }
  const tampered = licence(opx);
  tampered.attestation.body.claims.storage_mb = 999;
  const t = await upload(tampered);
  ok(t.check === 'licence' && t.detail.startsWith('the licence\'s signature does not verify'), 'POST /licence with claims edited after issue: "licence", the signature');
  // An agent of an operator with no licence here.
  const gus = identity('gus');
  const lg = await login(gus, { bundle: withVouch(gus, opx, vouch(opx, gus)) });
  ok(lg.client?.connected && await noticed(lg.client, 'licence') && tierOf(gus).pool === null, `an attestation from an operator without a licence here: free tier, "licence" (${notices(lg.client)[0]?.detail})`);
  lg.client?.end(true);
  // The operator logs in, as every operator must before its licence is taken. A licence naming its
  // CURRENT DID (after a rotation) binds no account: refused, saying sub is the original DID.
  (await login(opx)).client?.end(true);
  const rsub = await upload(licence({ original: rotated(opx, 'operator x 2').did }));
  ok(rsub.ok === false && rsub.detail.includes('names the operator by its ORIGINAL DID'), `POST /licence for an operator's rotated DID: refused "licence" (${rsub.detail})`);
  // A licence that lapses: pooled while it holds, free tier after.
  const short = await upload(licence(opx, { exp: now + 2 * DAY }));
  const hal = identity('hal');
  const lh = await login(hal, { bundle: withVouch(hal, opx, vouch(opx, hal)) });
  ok(short.ok && lh.client?.connected && tierOf(hal).pool === accountOf(opx.original), 'an operator with a 2-day licence: its agent pools');
  lh.client?.end(true);
  now += 3 * DAY;
  ok(tierOf(hal).pool === null, 'three days later the licence has expired: the agent is free at once (checked at every use)');
  const lh2 = await login(hal, { bundle: withVouch(hal, opx, vouch(opx, hal, { iat: now - 60 })) });
  ok(lh2.client?.connected && await noticed(lh2.client, 'licence') && /expired at/.test(notices(lh2.client)[0]?.detail), `and its next login is told "licence" (${notices(lh2.client)[0]?.detail})`);
  lh2.client?.end(true);
  // A renewal replaces it; of two issued at the same second, the shorter does not replace the longer.
  const renew = await upload(licence(opx, { exp: now + 60 * DAY }));
  const older = await upload(licence(opx, { exp: now + 30 * DAY }));
  ok(renew.ok && older.ok === false && older.detail.includes('the one issued last is kept'), 'a renewal is taken; one issued at the same second running shorter is refused ("the one issued last is kept")');
  // The one issued later is kept, so an older copy cannot swap the claims back.
  const renewExp = now + 60 * DAY;
  const earlier = await upload(licence(opx, { exp: renewExp + DAY, iat: now - 120, claims: { ...relayClaims, storage_mb: 2 } }));
  ok(earlier.ok === false && earlier.detail.includes('the one issued last is kept') && ![earlier, older].some((r) => r.detail.includes(isoOf(renewExp)) || r.detail.includes('2026-')),
    'a licence issued earlier, even one running longer: refused too; no refusal quotes the kept licence\'s dates');
  const later = await upload(licence(opx, { exp: renewExp, iat: now - 30 }));
  ok(later.ok === true, 'one ending with it and issued later replaces it');
  ok(tierOf(hal).pool === accountOf(opx.original), 'with the renewal the agent pools again at once: its attestation still holds, so it need not log in');
  // The vendor rotates: a licence by its new key, carrying the rotation, extends the chain this
  // relay has seen; licences by the old key stop counting.
  const vendor2 = rotated(vendor, 'vendor 2');
  const opy = identity('operator y');
  (await login(opy)).client?.end(true);
  const v2 = await upload(licence(opy, { vendor: vendor2 }));
  ok(v2.ok && v2.chain === 2, `a licence by the vendor's rotated key, carrying the rotation: kept, vendor chain 2 (${v2.detail ?? 'ok'})`);
  ok(tierOf(ann).pool === null && tierOf(hal).pool === null, 'the licences signed by the vendor\'s old key no longer count: their agents are free');
  const again = await upload(licence(opr, { exp: now + 90 * DAY }));
  ok(again.ok === false && again.detail.includes('shorter than the 2 this relay has seen'), `a new licence by the old vendor key: refused (${again.detail})`);
  const la = await login(ann, { bundle: withVouch(ann, rotated(opr, 'operator 2'), vouch(rotated(opr, 'operator 2'), ann)) });
  ok(la.client?.connected && await noticed(la.client, 'licence') && /rotated away from/.test(notices(la.client)[0]?.detail), `ann's next login is told "licence" (${notices(la.client)[0]?.detail})`);
  la.client?.end(true);
  const reissued = await upload(licence(opr, { vendor: vendor2, exp: now + 90 * DAY }));
  ok(reissued.ok && tierOf(ann).pool === POOL, 'the vendor reissues the operator\'s licence under its new key: ann pools again, without a new login');
  // The licence check alone, as commercial/test.sh runs it: the same rules without the store.
  const alone = checkRelayLicence(licence(opy, { vendor: vendor2 }), now, { vendor: vendor.original });
  ok(alone.ok === true && alone.chain.chain.length === 2 && checkRelayLicence(licence(opy), now, { vendor: other.original }).why.includes('not the vendor'), 'checkRelayLicence: the vendor rules of spend/licence.ts with ctx sigelo-relay');
}

// ================================================================ a reissue ends a term early
{
  // Audit finding: a licence that still held was replaced only by one running longer, so a licence
  // the vendor reissued to end a term (a card payment charged back, a breach: relay/site/terms.md
  // §8, §10) was refused and the first ran on to its exp. Now the licence the vendor issued last is
  // kept, whatever its term, and an older one is refused while the row is kept: until LICENCE_KEEP
  // after the term it cut short, so the year licence cannot come back once the short one lapsed.
  let t = now;
  const d = openDb(':memory:'), op = identity('operator cut'), a = accountOf(op.original);
  const ops = operators({ db: d, host: HOST, vendor: vendor.original, clock: () => t });
  d.touchAccount(a, t);
  const year = licence(op, { iat: t - 60, exp: t + YEAR });
  ok(ops.upload(year, t).ok && ops.licenceOf(a, null, t) !== null, 'a year licence is taken');
  t += 10 * DAY;
  const cut = ops.upload(licence(op, { iat: t - 60, exp: t + 60 }), t);
  ok(cut.ok === true && ops.licenceOf(a, null, t) !== null && ops.licenceOf(a, null, t + 60) === null,
    `10 days on, the vendor reissues it to end at once: taken, and the operator is licensed until then, not to day 365 (${cut.detail ?? 'taken'})`);
  const back = ops.upload(year, t + 120);
  ok(back.ok === false && back.detail.includes('the one issued last is kept') && ops.licenceOf(a, null, t + 120) === null,
    'the year licence uploaded again once the short one lapsed: refused, still unlicensed');
  ops.tidy(t + 60 + LICENCE_KEEP);
  ok(d.raw.prepare('SELECT count(*) AS n FROM licences').get().n === 1 && ops.upload(year, t + 60 + LICENCE_KEEP).ok === false,
    `${LICENCE_KEEP / DAY} days after the short one's expiry its row stays, the year licence's term still running: refused again`);
  const end = year.attestation.body.exp + LICENCE_KEEP;
  ops.tidy(end - 1);
  const stays = d.raw.prepare('SELECT count(*) AS n FROM licences').get().n;
  ops.tidy(end);
  ok(stays === 1 && d.raw.prepare('SELECT count(*) AS n FROM licences').get().n === 0, `the row goes ${LICENCE_KEEP / DAY} days after the term it cut short would have ended`);
  d.close();
}

// ================================================================ POST /licence, the HTTP surface
{
  const broken = await postJson('/licence', '{"attestation":');
  ok(broken.status === 400, `POST /licence with broken JSON: 400 (${broken.status})`);
  const dup = await postJson('/licence', '{"issuer":1,"issuer":2}');
  ok(dup.status === 400, 'POST /licence with a duplicate key: 400 (strict parser)');
  const shape = await upload({ attestation: 1 });
  ok(shape.check === 'licence' && shape.detail === 'the licence file is not {attestation, issuer, rotations}', 'POST /licence with another shape: "licence", named as the keeper names it');
  const slow = await startRelay({ ...cfg, db: join(dir, 'rate.db'), policy: (ctx) => relayPolicy(ctx, { ...config, licenceRate: 2 }) });
  const r = [await upload({}, slow), await upload({}, slow), await upload({}, slow)];
  ok(r[0].check === 'licence' && r[1].check === 'licence' && r[2].check === 'rate', `POST /licence: 2 a minute per network on a relay configured so, the 3rd refused "rate" (${r.map((x) => x.check).join()})`);
  await slow.close();
}

// ================================================================ the environment
{
  const died = [];
  const die = (why) => { died.push(why); throw new Error(why); };
  const tryEnv = (env) => { try { relayPolicyFromEnv(env, die); return 'ok'; } catch { return died.at(-1); } };
  ok(tryEnv({}) === 'ok' && tryEnv({ RELAY_POW_BITS: '20', RELAY_PRO_STORAGE_MB: '2048', RELAY_VENDOR_DID: vendor.original }) === 'ok', 'relayPolicyFromEnv: the defaults, and set values, are taken');
  ok(/^RELAY_POW_BITS/.test(tryEnv({ RELAY_POW_BITS: 'x' })) && /^RELAY_PRO_STORAGE_MB/.test(tryEnv({ RELAY_PRO_STORAGE_MB: '0' })) && /^RELAY_VENDOR_DID/.test(tryEnv({ RELAY_VENDOR_DID: 'vendor' }))
    && /loadBits/.test(tryEnv({ RELAY_POW_BITS: '26', RELAY_POW_LOAD_BITS: '22' })) && /^RELAY_FREE_QUEUE_MB/.test(tryEnv({ RELAY_FREE_QUEUE_MB: '0' }))
    && /tiers\.pro\.storage: want at least tiers\.free\.storage/.test(tryEnv({ RELAY_PRO_STORAGE_MB: '10' })) && /at most 60/.test(tryEnv({ RELAY_POW_BITS: '61', RELAY_POW_LOAD_BITS: '61' })),
    'relayPolicyFromEnv: a bad value is refused naming its variable (or the tier it breaks: pro below free; a base whose network steps pass 64 bits)');
}

const fresh = (name, extra = {}) => {
  const box = {};
  const start = async () => { box.r = await startRelay({ ...cfg, db: join(dir, `${name}.db`), policy: (ctx) => (box.pol = relayPolicy(ctx, { ...config, ...extra })) }); return box.r; };
  box.start = start;
  box.tier = (id) => box.pol.tierOf(accountOf(id.original), now);
  return box;
};

// ================================================================ the rate brake (plan §1 "Abuse brakes"), on a relay of its own
{
  now = Date.parse('2026-11-01T00:00:10Z') / 1000;
  // Roomy quotas, so only the brake refuses.
  const tiers = { free: { ...TIERS.free, msgsDay: 100, mailboxes: 10 }, pro: { ...TIERS.pro, msgsDay: 100, mailboxes: 10 } };
  const B = fresh('brake', { tiers, rate: { publish: { perSecond: 2, burst: 4 }, subscribe: { perSecond: 1, burst: 3 }, strikes: 6 } });
  const R = await B.start();
  const rd = identity('rate reader'), sd = identity('rate sender'), X = topic();
  const rc = (await login(rd, { pow: true }, R)).client, sc = (await login(sd, {}, R)).client;
  const claimsOf = () => R.db.raw.prepare('SELECT count(*) AS n FROM claims WHERE account = ?').get(accountOf(rd.original)).n;
  ok(await subscribe(rc, X) === 1 && await subscribe(rc, topic()) === 1 && await subscribe(rc, topic()) === 1 && claimsOf() === 3, 'rate: 3 topics subscribed at once (configured: 3, then 1 a second) are claimed');
  let wire = await wireOf(rc, async () => { ok(await subscribe(rc, topic()) === 128, 'the 4th in that second: granted 128'); });
  ok(await noticed(rc, 'rate') && claimsOf() === 3 && wire === 'notice:rate,suback', `the 4th in that second: refused "rate" before any claim is made, the notice on the wire before the SUBACK (${wire})`);
  for (let i = 0; i < 4; i++) await publish(sc, X, randomBytes(300));
  ok(await until(() => got(rc, X).length === 4), 'a burst of 4 publishes (configured: 4, then 2 a second) is delivered');
  sc.box.length = 0;
  // Every refusal named, each with its PUBLISH's packet id: a publish dropped without a notice was
  // acknowledged all the same, and its writer reported it sent (contact/carrier.mjs).
  const ids = [];
  wire = await wireOf(sc, async () => {
    for (let i = 0; i < 2; i++) await new Promise((resolve) => sc.publish(X, randomBytes(300), { qos: 1 }, (e, p) => { ids.push(p?.messageId); resolve(); }));
  });
  ok(wire === 'notice:rate,puback,notice:rate,puback', `each publish refused: its notice on the wire before its PUBACK (${wire})`);
  await sleep(100);
  const rated = notices(sc).filter((x) => x.code === 'rate');
  ok(rated.length === 2 && rated.map((x) => x.id).join() === ids.join() && got(rc, X).length === 4 && queued(X, R).n === 0,
    `the 5th and 6th in that second: dropped, nothing stored, a notice "rate" for each, naming its packet id (${rated.map((x) => x.id).join()} for ${ids.join()}: ${rated[0]?.detail})`);
  now += 1;
  await publish(sc, X, randomBytes(300));
  await publish(sc, X, randomBytes(300));
  ok(await until(() => got(rc, X).length === 6), 'a second later, 2 more: delivered');
  const closed = new Promise((resolve) => sc.once('close', () => resolve(true)));
  for (let i = 0; i < 10; i++) sc.publish(X, randomBytes(300), { qos: 1 });
  ok(await Promise.race([closed, sleep(3000).then(() => false)]) && queued(X, R).n === 0, 'a flood past 6 refusals in a minute (the strikes): the relay closes the connection, nothing stored');
  // UNSUBSCRIBE releases claims and their queues: its topics draw on the subscribe rate too. One
  // token has come back in this second (1 a second): the first topic goes, the second stays.
  const held = R.db.raw.prepare('SELECT topic FROM claims WHERE account = ? ORDER BY topic').all(accountOf(rd.original)).map((r) => r.topic);
  rc.box.length = 0;
  wire = await wireOf(rc, () => unsubscribe(rc, held.slice(0, 2)));
  ok(wire === 'notice:rate,unsuback', `UNSUBSCRIBE refused for a topic: the notice on the wire before the UNSUBACK (${wire})`);
  ok(await noticed(rc, 'rate') && claimsOf() === 2 && R.db.raw.prepare('SELECT 1 FROM claims WHERE topic = ?').get(held[1]) !== undefined
    && /^UNSUBSCRIBE refused for 1 of its topics, still claimed \(too many topics subscribed or given up from this identity/.test(notices(rc)[0]?.detail ?? ''),
    `UNSUBSCRIBE of 2 topics with 1 token left: the first released, the second still claimed, refused "rate" (${notices(rc)[0]?.detail})`);
  now += 3;
  await unsubscribe(rc, held[1]);
  ok(await until(() => claimsOf() === 1), 'once the bucket refills, an UNSUBSCRIBE of the refused topic releases it on the same connection');
  rc.end(true); sc.end(true);
  await R.close();
}

// ================================================================ a member that leaves its pool takes no usage with it
{
  // Audit finding: the caps counted the pool's current members only, so a member whose attestation
  // expired, or that logged in without it, took its messages, queue and claims out of the pool, and
  // one licence gave its allowance once per member that left. Usage stays charged where it was
  // incurred: the sender's messages in the pool's day, a queued message and a claim until they go.
  now = (Math.floor(now / DAY) + 1) * DAY + 10;
  const E = fresh('escape'), R = await E.start();
  const op = identity('escape operator'), POOLE = accountOf(op.original);
  (await login(op, {}, R)).client?.end(true);
  const up = await upload(licence(op), R);   // 5 messages a day; storage capped at 8,768; pro's 5 claims
  const hour = (a) => withVouch(a, op, vouch(op, a, { exp: now + 3600 }));
  const held = (a) => withVouch(a, op, vouch(op, a));
  const a1 = identity('escape a1'), a2 = identity('escape a2'), a3 = identity('escape a3'), rd = identity('escape reader');
  const c1 = (await login(a1, { bundle: hour(a1) }, R)).client, c2 = (await login(a2, { bundle: held(a2) }, R)).client, c3 = (await login(a3, { bundle: held(a3) }, R)).client;
  const kc = (await login(rd, {}, R)).client, K = topic();
  await subscribe(kc, K);
  for (let i = 0; i < 5; i++) await publish(c1, K, randomBytes(10));
  ok(up.ok && await until(() => got(kc, K).length === 5) && [a1, a2, a3].every((x) => E.tier(x).pool === POOLE), 'a1 (an attestation for one hour), a2 and a3 pool; a1 sends the pool\'s 5 messages of the day');
  await refusedPublish(c2, K, 10, 'quota_messages', 'a2\'s next: the pool\'s 5 are spent', kc);
  now += 2 * 3600;
  ok(E.tier(a1).pool === null, 'two hours later, the same UTC day: a1\'s attestation has expired, it is free');
  await refusedPublish(c2, K, 10, 'quota_messages', 'a2 still refused: a1\'s 5 stay in the pool\'s day', kc);
  await end(c2);
  const c2b = (await login(a2, { bundle: bundleOf(a2) }, R)).client;
  await refusedPublish(c3, K, 10, 'quota_messages', 'a2 leaves by a login without its attestation; a3 still refused', kc);
  await publish(c2b, K, randomBytes(10));
  ok(E.tier(a2).pool === null && await until(() => got(kc, K).length === 6), 'a2, free now, sends on its own free allowance: stored');
  // Storage, on the next UTC day: r1 (an attestation for one hour) and r2 claim and go offline;
  // two 4,000-byte messages for r1 from a3, of the same pool (outside it, a writer may fill only a
  // share of one reader's: POOL_SHARES), fill the pool's 8,768.
  now = (Math.floor(now / DAY) + 1) * DAY + 10;
  const r1 = identity('escape r1'), r2 = identity('escape r2');
  const cr1 = (await login(r1, { bundle: hour(r1) }, R)).client, cr2 = (await login(r2, { bundle: held(r2) }, R)).client, T1 = topic(), T2 = topic();
  await subscribe(cr1, T1); await subscribe(cr2, T2);
  await end(cr1); await end(cr2);
  const sc = (await login(identity('escape sender'), {}, R)).client;
  await publish(c3, T1, randomBytes(4000)); await publish(c3, T1, randomBytes(4000));
  const poolQ = () => R.db.raw.prepare('SELECT bytes FROM pool_queue WHERE pool = ?').get(POOLE)?.bytes ?? 0;
  ok(queued(T1, R).n === 2 && poolQ() === 8768, `two 4,000-byte messages for r1, offline, fill the pool's 8,768 (${poolQ()})`);
  await refusedPublish(sc, T2, 1, 'quota_storage', 'one byte for r2: the pool is full');
  now += 2 * 3600;
  ok(E.tier(r1).pool === null && queued(T1, R).n === 2, 'two hours later r1 is free, and its 8,000 bytes are still queued, kept to the pool\'s retention');
  await refusedPublish(sc, T2, 1, 'quota_storage', 'one byte for r2 still refused: r1\'s queue stays charged to the pool until it goes');
  // Claims: T1 and T2 were claimed under the pool; r2 claims 3 more, the pool's 5 with r1's.
  const cr2b = (await login(r2, { bundle: held(r2) }, R)).client, more = [];
  for (let i = 0; i < 3; i++) more.push(await subscribe(cr2b, topic()));
  ok(more.every((g) => g === 1) && await subscribe(cr2b, topic()) === 128 && await noticed(cr2b, 'quota_mailboxes'),
    'r2 claims 3 more, the pool\'s 5 with r1\'s mailbox though r1 has left: its next is refused quota_mailboxes');
  // r1 collects its queue and gives its mailbox up: both leave the pool's count.
  const cr1b = (await login(r1, {}, R)).client;
  ok(await until(() => got(cr1b, T1).length === 2 && poolQ() === 0) && totalsMatch(R), 'r1 logs in and collects its 2: the pool\'s queue is empty, and the totals equal the queue summed afresh');
  await unsubscribe(cr1b, T1);
  sc.box.length = 0;
  await publish(sc, T2, randomBytes(1));
  await sleep(50);
  ok(await until(() => got(cr2b, T2).length === 1) && notices(sc).length === 0 && await subscribe(cr2b, topic()) === 1, 'then a byte for r2 is stored (r2 online gets it), and r2 claims one more in r1\'s place');
  for (const c of [c1, c2b, c3, kc, sc, cr2b, cr1b]) await end(c);
  await R.close();
}

// ================================================================ storage: empty messages, the free tier's ceiling, the totals, a pool's floor
{
  now += DAY;
  const tiers = { free: { storage: 5 * 640, msgsDay: 100, retentionDays: 7, maxMessage: 1000, mailboxes: 3 }, pro: { storage: 64000, msgsDay: 1000, retentionDays: 30, maxMessage: 4000, mailboxes: 5 } };
  // One network's share is the whole ceiling here (freeShares 1): every client is on 127.0.0.0/24.
  // The ceiling counts the identity rows too (db.mjs row_totals): every identity of this block logs
  // in and claims first, on a relay with room, and the relay starts again with its ceiling at those
  // rows plus 7 × 640.
  let S = fresh('store', { tiers, freeQueue: 64 * MB, freeShares: 1 });
  let R = await S.start();
  const rs = identity('store reader'), r2 = identity('store reader 2'), snd = identity('store sender'), ops = identity('store operator'), ags = identity('store agent');
  const claimOne = async (id, bundle) => { const c = (await login(id, { pow: true, bundle }, R)).client, t = topic(); await subscribe(c, t); await end(c); return t; };
  const X = await claimOne(rs), Y = await claimOne(r2);
  (await login(snd, { pow: true }, R)).client?.end(true);
  (await login(ops, { pow: true }, R)).client?.end(true);
  // A licence selling less than the free tier (1 day's retention, 5 messages a day): the pool
  // still gets free's numbers.
  const up = await upload(licence(ops, { claims: { ...relayClaims, retention_days: 1 } }), R);
  const Z = await claimOne(ags, withVouch(ags, ops, vouch(ops, ags)));
  const rows = R.db.rowBytes();
  await R.close();
  S = fresh('store', { tiers, freeQueue: rows + 7 * 640, freeShares: 1 });
  R = await S.start();
  ok(R.db.rowBytes() === rows && rows > 0, `the identity rows are counted again at a start, the same (${rows} bytes: accounts, chains, claims, chain DIDs)`);
  const sc = (await login(snd, {}, R)).client;
  for (let i = 0; i < 5; i++) await publish(sc, X, Buffer.alloc(0));
  ok(queued(X, R).n === 5 && charged(rs, R) === 3200, `5 empty messages to an offline free reader (storage 3,200): stored, charged 640 each (${charged(rs, R)})`);
  await refusedPublish(sc, X, 0, 'quota_storage', 'the 6th empty message: its allowance is spent, not free of charge');
  // The free tier's ceiling for the whole relay (here 4,480): free readers stop there, paid ones do not.
  await publish(sc, Y, Buffer.alloc(0));
  await publish(sc, Y, Buffer.alloc(0));
  sc.box.length = 0;
  await publish(sc, Y, Buffer.alloc(0));
  ok(await noticed(sc, 'quota_storage') && /free tier is full/.test(notices(sc)[0]?.detail) && queued(Y, R).n === 2 && charged(r2, R) === 1280,
    `a second free reader, its own allowance far from spent, stops at the relay's free ceiling: "quota_storage" (${notices(sc)[0]?.detail})`);
  const t = S.tier(ags);
  ok(up.ok && t.pool === accountOf(ops.original) && t.limits.msgsDay === 100 && t.limits.retention === 7 * DAY && t.limits.storage === 64000,
    'a pool whose licence sells under the free tier (5 messages, 1 day) gets free\'s 100 and 7 days; its storage, pro\'s 64,000');
  sc.box.length = 0;
  await publish(sc, Z, Buffer.alloc(0));
  await sleep(50);
  ok(queued(Z, R).n === 1 && notices(sc).length === 0, 'a pooled reader is not held to the free ceiling: stored');
  const back = (await login(rs, {}, R)).client;
  ok(await until(() => got(back, X).length === 5 && queued(X, R).n === 0) && charged(rs, R) === 0 && totalsMatch(R), 'the reader collects its 5: its charge goes to 0, and the totals equal the queue summed afresh');
  await end(back); await end(sc);
  // The totals are rebuilt from the queue at every start, whatever the file held.
  R.db.raw.exec('UPDATE queue_totals SET n = 0, bytes = 0');
  await R.close();
  R = await S.start();
  ok(totalsMatch(R) && charged(r2, R) === 1280, 'totals wiped in the file are rebuilt from the queue at the next start');
  await R.close();
}

// ================================================================ one network's share of the free ceiling
{
  // The ceiling is one pool for every free reader, and an identity costs one proof of work: two
  // identities on one network filled it with messages to their own mailbox, which nobody collects,
  // and stopped every free delivery for 7 days. Past half the ceiling, a network that stored its
  // share is refused; another network still gets through. Ceiling 10 × 640, a share of a quarter.
  // The identity rows count towards the ceiling (db.mjs row_totals): every identity logs in first,
  // and the relay starts again with the ceiling at twice those rows plus 10 × 640, so half of it is
  // the rows plus 5 × 640.
  now += DAY;
  const tiers = { free: { storage: 64000, msgsDay: 100, retentionDays: 7, maxMessage: 1000, mailboxes: 5 }, pro: { storage: 64000, msgsDay: 1000, retentionDays: 30, maxMessage: 4000, mailboxes: 5 } };
  let S = fresh('shares', { tiers, freeQueue: 64 * MB, freeShares: 4 });
  let R = await S.start();
  const sink = identity('share sink'), m1 = identity('share mallory'), m2 = identity('share mallory 2'), st = identity('share stranger'), rd = identity('share reader');
  const claim = async (id, local) => { const c = (await login(id, { pow: true, local }, R)).client, t = topic(); await subscribe(c, t); await end(c); return t; };
  const SINK = await claim(sink, '127.0.0.1'), RD = await claim(rd, '127.0.1.1');
  for (const [id, local] of [[m1], [m2], [st, '127.0.1.1']]) (await login(id, { pow: true, local }, R)).client?.end(true);
  const rows = R.db.rowBytes();
  await R.close();
  S = fresh('shares', { tiers, freeQueue: 2 * rows + 10 * 640, freeShares: 4 });
  R = await S.start();
  const a1 = (await login(m1, {}, R)).client, a2 = (await login(m2, {}, R)).client;
  for (let i = 0; i < 5; i++) await publish(i % 2 ? a2 : a1, SINK, Buffer.alloc(0));
  ok(queued(SINK, R).n === 5 && notices(a1).length === 0 && notices(a2).length === 0, 'two identities on 127.0.0.0/24 store 5 empty messages for their own mailbox: 3,200 bytes, with the rows half the ceiling');
  await refusedPublish(a1, SINK, 0, 'quota_storage', 'a 6th from that network would pass half: refused, its share (a quarter of the ceiling) passed');
  ok(/your network stored 3200 bytes/.test(notices(a1)[0]?.detail ?? ''), `named as the network's share (${notices(a1)[0]?.detail})`);
  const sc = (await login(st, { local: '127.0.1.1' }, R)).client;
  await publish(sc, RD, Buffer.alloc(0));
  await sleep(50);
  ok(queued(RD, R).n === 1 && notices(sc).length === 0, 'a stranger on 127.0.1.0/24 writing to a free reader is stored all the same');
  for (const c of [a1, a2, sc]) await end(c);
  await R.close();
}

// ================================================================ identity rows count towards the free ceiling; a Pro pool still stores
{
  // Audit finding: free identities' claims, accounts and chains stopped only at relay_full, which
  // then refused every publish and claim on the relay, Pro's too. They count towards the free
  // tier's ceiling (db.mjs row_totals). Every identity logs in first, on a relay with room; it
  // starts again with room for two more claims and not a new account on top.
  now += DAY;
  const tiers = { free: { storage: 64000, msgsDay: 100, retentionDays: 7, maxMessage: 1000, mailboxes: 10 }, pro: { storage: 64000, msgsDay: 1000, retentionDays: 30, maxMessage: 4000, mailboxes: 10 } };
  let S = fresh('rows', { tiers, freeQueue: 64 * MB });
  let R = await S.start();
  const fa = identity('rows free'), fs = identity('rows sender'), op = identity('rows operator'), ag = identity('rows agent'), na = identity('rows new agent');
  for (const id of [fa, fs, op]) (await login(id, { pow: true }, R)).client?.end(true);
  const up = await upload(licence(op), R);
  const ac = (await login(ag, { pow: true, bundle: withVouch(ag, op, vouch(op, ag)) }, R)).client, Z = topic();
  await subscribe(ac, Z); await end(ac);
  const rows = R.db.rowBytes();
  await R.close();
  S = fresh('rows', { tiers, freeQueue: rows + 2 * CLAIM_ROW + ACCOUNT_ROW - 1 });
  R = await S.start();
  const fc = (await login(fa, {}, R)).client, FT = topic();
  ok(up.ok && await subscribe(fc, FT) === 1 && await subscribe(fc, topic()) === 1, `a free identity claims two mailboxes: with them the rows still fit (${rows} + ${2 * CLAIM_ROW} of ${rows + 2 * CLAIM_ROW + ACCOUNT_ROW - 1})`);
  ok(await subscribe(fc, topic()) === 128 && await noticed(fc, 'quota_mailboxes') && /free tier is full/.test(notices(fc).at(-1)?.detail ?? ''),
    `its third: refused quota_mailboxes, the free tier full of identity rows (${notices(fc).at(-1)?.detail})`);
  const nw = await login(identity('rows newcomer'), { pow: true }, R), nwWhy = nw.client ? {} : await checkOf(nw.creds, R);
  ok(!nw.client && nwWhy.check === 'relay_full' && /stores no new free identity/.test(nwWhy.detail ?? ''), `a new free identity: refused relay_full, nothing stored (${nwWhy.detail})`);
  const known = (await login(fs, {}, R)).client;
  const ac2 = (await login(ag, { bundle: withVouch(ag, op, vouch(op, ag)) }, R)).client;
  const nac = (await login(na, { pow: true, bundle: withVouch(na, op, vouch(op, na)) }, R)).client;
  ok(known?.connected === true && await subscribe(ac2, topic()) === 1 && nac?.connected === true && S.tier(na).pool === accountOf(op.original),
    'a known free identity still logs in; the pool\'s agent still claims, and a new agent of the pool is stored and pools');
  known.box.length = 0;
  await publish(known, Z, randomBytes(10));
  await sleep(50);
  ok(await until(() => got(ac2, Z).length === 1) && notices(known).length === 0, 'a free sender\'s message for the pooled reader is stored: free rows stop no Pro pool');
  await refusedPublish(known, FT, 10, 'quota_storage', 'one for a free reader: refused, the free tier is full');
  for (const c of [fc, known, ac2, nac]) await end(c);
  await R.close();
}

// ================================================================ an operator attestation keeps an account only if its operator holds a licence here
{
  // Audit finding: any free identity kept its account and chain up to 90 days, renewably, with an
  // attestation of the right shape it signed for itself; now it is kept 30 days after its last
  // login like any free one, unless the attestation's operator holds a licence here.
  now += DAY;
  const V = fresh('vouch'), R = await V.start();
  const ou = identity('unlicensed operator'), vu = identity('self vouched'), VU = accountOf(vu.original);
  const l = await login(vu, { pow: true, bundle: withVouch(vu, ou, vouch(ou, vu, { exp: now - 60 + 90 * DAY })) }, R);
  ok(l.client?.connected === true && await noticed(l.client, 'licence') && R.db.raw.prepare('SELECT count(*) AS n FROM vouched WHERE account = ?').get(VU).n === 0,
    'an agent with a 90-day attestation from an operator with no licence here: free tier, "licence", no residency granted');
  l.client?.end(true);
  now += 31 * DAY;
  R.sweep();
  ok(R.db.account(VU) === undefined, '31 days after its last login, no claim held: its account goes as any free one\'s');
  await R.close();
}

// ================================================================ the brake per network, and "pow" before any transaction
{
  // Per identity alone, one network's sessions times 20 a second could keep the one thread busy.
  now += DAY;
  const tiers = { free: { ...TIERS.free, msgsDay: 100, mailboxes: 10 }, pro: { ...TIERS.pro, msgsDay: 100, mailboxes: 10 } };
  const B = fresh('netbrake', { tiers, rate: { publish: { perSecond: 4, burst: 4 }, subscribe: { perSecond: 4, burst: 8 }, network: { publish: { perSecond: 6, burst: 6 }, subscribe: { perSecond: 8, burst: 16 } }, strikes: 100 } });
  const R = await B.start();
  const rd = identity('net reader'), w1 = identity('net writer 1'), w2 = identity('net writer 2'), w3 = identity('net writer 3'), X = topic();
  const rc = (await login(rd, { pow: true, local: '127.0.1.1' }, R)).client;
  await subscribe(rc, X);
  const c1 = (await login(w1, { pow: true }, R)).client, c2 = (await login(w2, { pow: true }, R)).client;
  for (let i = 0; i < 3; i++) await publish(c1, X, randomBytes(10));
  for (let i = 0; i < 3; i++) await publish(c2, X, randomBytes(10));
  ok(await until(() => got(rc, X).length === 6) && notices(c1).length === 0 && notices(c2).length === 0, 'two identities on one /24, 3 each: within each one\'s 4 and the network\'s 6');
  await refusedPublish(c2, X, 10, 'rate', 'a 7th from that network in the same second, the identity\'s own 4th', rc);
  ok(/this network/.test(notices(c2)[0]?.detail ?? ''), `named as the network\'s brake (${notices(c2)[0]?.detail})`);
  const c3 = (await login(w3, { pow: true, local: '127.0.1.1' }, R)).client;
  await publish(c3, X, randomBytes(10));
  ok(await until(() => got(rc, X).length === 7), 'an identity on another /24 is not held by it');
  // An identity that has proven no work: its publishes are refused before any transaction, each by
  // name (the rate brake, drawn on first, bounds the notices).
  now += 2;   // the network's bucket full again
  const u = identity('net unproven'), uc = (await login(u, { pow: false }, R)).client;
  const realTx = R.db.tx;
  let txs = 0;
  R.db.tx = (fn) => { txs++; return realTx(fn); };
  uc.box.length = 0;
  for (let i = 0; i < 3; i++) await publish(uc, X, randomBytes(10));
  await sleep(100);
  R.db.tx = realTx;
  ok(txs === 0 && notices(uc).filter((x) => x.code === 'pow').length === 3 && got(rc, X).length === 7, `3 publishes from an identity with no proof: no transaction opened (${txs}), a notice "pow" for each, nothing delivered`);
  // Review finding: identities with no proof drew on the bucket of the network's proven ones, so a
  // few such sessions, free to mint, refused every proven identity of their /24 (a Pro operator's
  // agents among them) each publish, claim and UNSUBSCRIBE. Now they have a bucket of their own:
  // three of them empty it (4 publishes and an UNSUBSCRIBE of 8 topics each: 12 against the
  // network's 6, 24 against its 16), and in that same second a proven identity on that /24
  // publishes, claims and gives the claim up.
  now += 2;   // every bucket full again
  const us = [];
  for (let i = 0; i < 3; i++) us.push((await login(identity(`net squatter ${i}`), { pow: false }, R)).client);
  for (const c of us) { c.box.length = 0; for (let i = 0; i < 4; i++) await publish(c, X, randomBytes(10)); }
  for (const c of us) await unsubscribe(c, Array.from({ length: 8 }, topic));
  await sleep(100);
  const theirs = us.flatMap(notices).filter((x) => x.code === 'rate' && /this network .*without a proof of work together/.test(x.detail));
  const unsubRefused = us.flatMap(notices).filter((x) => /^UNSUBSCRIBE refused for 8 of its topics/.test(x.detail ?? '')).length;
  c1.box.length = 0;
  const P = topic(), held = () => R.db.raw.prepare('SELECT count(*) AS n FROM claims WHERE topic = ?').get(P).n;
  await publish(c1, X, randomBytes(10));
  const granted = await subscribe(c1, P), claimed = held();
  await unsubscribe(c1, P);
  ok(theirs.length === 7 && unsubRefused === 1 && await until(() => got(rc, X).length === 8) && granted === 1 && claimed === 1 && await until(() => held() === 0) && notices(c1).length === 0,
    `three sessions with no proof on 127.0.0.0/24 empty their own network bucket (${theirs.length} "rate" notices: 6 publishes, 1 UNSUBSCRIBE of 8); in the same second a proven identity there publishes, claims and gives the claim up, untouched`);
  for (const c of [rc, c1, c2, c3, uc, ...us]) c.end(true);
  await R.close();
}

// ================================================================ sessions of identities that have proven no work
{
  // Nothing is stored for them and they can claim and send nothing: they are closed after
  // unprovenSeconds, and an identity that has proven work takes the seat of the oldest of them when
  // a cap is full. Before, unproven sessions held a /24's cap for as long as they liked, and a
  // proven identity's reconnect was refused ("rate"; "relay_full" at the relay's cap).
  now += DAY;
  const U = await startRelay({ ...cfg, db: join(dir, 'unproven.db'), maxPerPrefix: 3, unprovenSeconds: 1, policy: (ctx) => relayPolicy(ctx, config) });
  const pv = identity('seat holder'), PT = topic();
  const p0 = (await login(pv, { pow: true }, U)).client;
  ok(await subscribe(p0, PT) === 1, 'an identity proves work and claims a mailbox');
  await end(p0);
  const squat = [];
  for (let i = 0; i < 3; i++) squat.push((await login(identity(`squatter ${i}`), { pow: false }, U)).client);
  ok(squat.every((c) => c?.connected) && U.auth.sessions() === 3, 'three sessions of identities with no proof fill 127.0.0.0/24 (cap 3)');
  const late = await login(identity('squatter late'), { pow: false }, U);
  ok(!late.client && (await checkOf(late.creds, U)).check === 'rate', 'a fourth with no proof: refused "rate"');
  const back = await login(pv, { bundle: false }, U);
  ok(back.client?.connected === true && await until(() => !squat[0].connected) && squat[1].connected && squat[2].connected,
    'the identity that proved work logs in all the same: the oldest unproven session gives up its seat');
  ok(await until(() => !squat[1].connected && !squat[2].connected, 4000) && back.client.connected, 'and the others are closed after their second; the proven session stays');
  ok(await until(() => U.auth.sessions() === 1), 'one session left');
  for (const c of [...squat, back.client]) c?.end(true);
  await U.close();
  const A = await startRelay({ ...cfg, db: join(dir, 'unproven-all.db'), maxSessions: 2, unprovenSeconds: 60, policy: (ctx) => relayPolicy(ctx, config) });
  const pa = identity('seat holder 2');
  (await login(pa, { pow: true }, A)).client?.end(true);
  const s1 = (await login(identity('squatter a'), { pow: false }, A)).client, s2 = (await login(identity('squatter b'), { pow: false, local: '127.0.1.1' }, A)).client;
  const in2 = await login(pa, { bundle: false }, A);
  ok(in2.client?.connected === true && await until(() => !s1.connected) && s2.connected, 'at the relay\'s cap the proven identity takes the seat of the oldest unproven session anywhere');
  for (const c of [s1, s2, in2.client]) c?.end(true);
  await A.close();
}

// ================================================================ stolen keys against recovery (plan §5), and licences kept until 30 days after their expiry
{
  now += DAY;
  const vb = identity('vendor b'), opT = identity('operator t'), agT = identity('agent t'), sold = identity('operator of a thief');
  const S = fresh('stolen', { vendor: vb.original });
  let R = await S.start();
  const OP = accountOf(opT.original);
  (await login(opT, {}, R)).client?.end(true);
  const up = await upload(licence(opT, { vendor: vb }), R);
  (await login(agT, { bundle: withVouch(agT, opT, vouch(opT, agT)) }, R)).client?.end(true);
  ok(up.ok && S.tier(agT).pool === OP, 'stolen keys: an operator licensed by vendor b; its agent pools');
  // A thief holding vendor b's key rotates it and sells a licence; this relay sees its chain first.
  const vThief = rotated(vb, 'vendor b thief'), vRec = rotated(vb, 'vendor b recovered', 'recovery');
  (await login(sold, {}, R)).client?.end(true);
  const t1 = await upload(licence(sold, { vendor: vThief }), R);
  ok(t1.ok && t1.chain === 2 && S.tier(sold).pool === accountOf(sold.original) && S.tier(agT).pool === null,
    'a thief rotates the vendor key and uploads first: its licence counts, the vendor\'s own stop (signed by a key rotated away from)');
  // The vendor recovers and reissues: a recovery rotation supersedes the thief's (SPEC §7.1).
  const r1 = await upload(licence(opT, { vendor: vRec }), R);
  ok(r1.ok && r1.chain === 2 && S.tier(agT).pool === OP && S.tier(sold).pool === null, 'the vendor recovers and reissues: accepted, the operator pools again, the thief\'s licence stops counting');
  const t2 = await upload(licence(sold, { vendor: vThief, exp: now + 2 * YEAR }), R);
  ok(t2.ok === false && t2.detail.includes('forks from the one this relay has seen'), `a thief's licence uploaded after the recovery: refused (${t2.detail})`);
  await R.close();
  R = await S.start();
  const t3 = await upload(licence(sold, { vendor: vThief, exp: now + 2 * YEAR + DAY }), R);
  ok(t3.ok === false && t3.detail.includes('forks from') && S.tier(agT).pool === OP && S.tier(sold).pool === null, 'after a restart the relay keeps the recovered chain: the thief is still refused, the operator still pools');
  // A thief holding the operator's key rotates it and logs in: the relay follows, its sybil pools.
  const oThief = rotated(opT, 'operator t thief'), oRec = rotated(opT, 'operator t recovered', 'recovery'), syb = identity('sybil');
  (await login(oThief, {}, R)).client?.end(true);
  (await login(syb, { bundle: withVouch(syb, oThief, vouch(oThief, syb)) }, R)).client?.end(true);
  ok(S.tier(syb).pool === OP && S.tier(agT).pool === null, 'stolen operator key: the thief rotates it and logs in; its sybil pools, the agent vouched for by the old key does not');
  // The operator recovers and logs in: recovery beats the thief's rotation (auth.mjs, SPEC §7.1).
  const lr = await login(oRec, {}, R);
  ok(lr.client?.connected && S.tier(syb).pool === null, 'the operator recovers and logs in: the sybil is free at once');
  lr.client?.end(true);
  const ls = await login(syb, { bundle: withVouch(syb, oThief, vouch(oThief, syb)) }, R);
  ok(ls.client?.connected && await noticed(ls.client, 'operator') && /rotated away from/.test(notices(ls.client)[0]?.detail), `and its next login is told "operator" (${notices(ls.client)[0]?.detail})`);
  ls.client?.end(true);
  const lt = await login(oThief, {}, R);
  ok(!lt.client && (await checkOf(lt.creds, R)).check === 'bundle', 'the thief logs in with its rotation again: refused, POST /check names bundle');
  const ag2 = identity('agent t 2');
  (await login(ag2, { bundle: withVouch(ag2, oRec, vouch(oRec, ag2)) }, R)).client?.end(true);
  ok(S.tier(ag2).pool === OP, 'an attestation by the recovered key pools');
  // A licence goes LICENCE_KEEP after its expiry, used or not, and its operator's account and chain
  // stay with it (operator.mjs; the audit of the licence's retention): kept only until 30 days after
  // its last use, it went with the operator's chain, the recovery from the thief in it.
  const licences = () => R.db.raw.prepare('SELECT operator FROM licences').all().map((x) => x.operator);
  now += 40 * DAY;
  R.sweep();   // the sweep runs the hourly tidy, inside its transaction
  ok(licences().includes(OP) && licences().includes(accountOf(sold.original)) && R.db.account(OP) !== undefined,
    '40 days on, neither licence used since: both kept (each runs a year), and the operator\'s account with its chain');
  const lexp = Math.max(...R.db.raw.prepare('SELECT exp FROM licences').all().map((x) => x.exp));
  now = lexp + LICENCE_KEEP - DAY;
  R.sweep();
  ok(licences().includes(OP), `${LICENCE_KEEP / DAY - 1} days after its expiry the licence is still kept`);
  now = lexp + LICENCE_KEEP;
  R.sweep();
  ok(licences().length === 0 && R.db.raw.prepare('SELECT count(*) AS n FROM operator_retired').get().n === 0, `${LICENCE_KEEP / DAY} days after their expiry both licences are gone, with the retired keys kept for them`);
  await R.close();
}

// ================================================================ an operator's key it rotated away from, stolen: kept out while the licence is kept
{
  // The audit's two cases. An operator rotates to its key 1, logs in, uploads its licence; key 1
  // is stolen. (1) The thief logged in with key 1's genesis alone as an original of its own: that
  // took key 1's row from the operator's account, and the operator, recovered from key 1, was
  // refused ever after, its licence left on the stolen key. (2) The operator logs in once and
  // again only after a rotation (relay/site/pro.md), holds no mailbox, and nobody uses the licence
  // for 30 days (or its agents do: once, the use was what kept it): the sweep took the licence, then
  // the account with the chain and its recovery, and the thief's login with the old chain and an
  // upload of the public licence moved it to the stolen key. Then the same for an agent, and the
  // operator's chain lost all the same (an erasure).
  now += DAY;
  const S = fresh('kept operator'), R = await S.start();
  const op0 = identity('operator k'), op1 = rotated(op0, 'operator k 1'), op2 = rotated(op1, 'operator k 2', 'recovery', now - 60);
  const OPK = accountOf(op0.original), current = () => R.db.raw.prepare('SELECT current FROM licences WHERE operator = ?').get(OPK)?.current;
  (await login(op1, {}, R)).client?.end(true);
  const up = await upload(licence(op0), R);
  const op1Alone = { ...op1, original: op1.did, origin: op1.genesis, rotations: [] };
  const l1 = await login(op1Alone, { pow: true }, R);
  ok(up.ok && !l1.client && (await checkOf(l1.creds, R)).check === 'bundle', 'the thief logs in with key 1\'s genesis alone: refused bundle, the key is in the operator\'s chain here');
  const lr = await login(op2, {}, R);
  ok(lr.client?.connected === true && current() === accountOf(op2.did), 'the operator recovers from key 1 and logs in: its licence follows the recovered key');
  lr.client?.end(true);
  const agK = identity('agent k'), agT = identity('agent of a thief k');
  // With a proof each time: an idle agent's account goes once its attestation has expired.
  const vouched = async (ag, op) => (await login(ag, { pow: true, bundle: withVouch(ag, op, vouch(op, ag, { iat: now - 60 })) }, R)).client?.end(true);
  await vouched(agK, op2); await vouched(agT, op1);
  ok(S.tier(agK).pool === OPK && S.tier(agT).pool === null, 'the agent vouched for by the recovered key pools, the one vouched for by key 1 does not');
  now += 32 * DAY;
  R.sweep();
  ok(R.db.account(OPK) !== undefined && current() === accountOf(op2.did), '32 days with neither the operator nor an agent using the licence: the sweep keeps it, and the operator\'s account and chain');
  const l2 = await login(op1, { pow: true }, R);
  ok(!l2.client && (await checkOf(l2.creds, R)).check === 'bundle', 'the thief with the chain the operator recovered from: refused, the recovery kept here wins');
  const t2 = await upload(licence(op0), R);
  await vouched(agK, op2); await vouched(agT, op1);
  ok(t2.ok && current() === accountOf(op2.did) && S.tier(agT).pool === null && S.tier(agK).pool === OPK, 'an upload of the same licence by anyone: it stays on the recovered key');
  // The agent variant: an agent that recovered from its key 1, vouched for by the operator for 90
  // days, holds no claim. 30 days after its last login the sweep took its account and chain, and
  // the thief logged in with the old chain and the attestation, and pooled.
  const a0 = identity('agent v'), a1 = rotated(a0, 'agent v 1'), a2 = rotated(a1, 'agent v 2', 'recovery', now - 60), AV = accountOf(a0.original);
  const att90 = vouch(op2, a0, { iat: now - 60, exp: now - 60 + 90 * DAY });
  const la2 = await login(a2, { pow: true, bundle: withVouch(a2, op2, att90) }, R);
  ok(la2.client?.connected === true && S.tier(a0).pool === OPK, 'an agent recovered from its key 1 logs in with a 90-day attestation of the operator\'s: it pools');
  la2.client?.end(true);
  now += 31 * DAY;
  R.sweep();
  const la1 = await login(a1, { pow: true, bundle: withVouch(a1, op2, att90) }, R);
  ok(R.db.account(AV) !== undefined && !la1.client && (await checkOf(la1.creds, R)).check === 'bundle',
    '31 days idle, no claim: the sweep keeps its account and chain while the attestation runs, and the thief with key 1 and that attestation is refused "bundle"');
  now = att90.body.exp;
  R.sweep();
  ok(R.db.account(AV) === undefined && R.db.account(OPK) !== undefined, 'once the attestation has expired, the agent\'s account goes as any idle one (the licensed operator\'s stays)');
  // The account and chain lost all the same (an erasure): a login ending at a key the operator
  // rotated away from moves nothing, nor one a voluntary rotation past it, nor an upload after it.
  R.db.raw.prepare('DELETE FROM chain_dids WHERE account = ?').run(OPK);
  R.db.raw.prepare('DELETE FROM accounts WHERE account = ?').run(OPK);
  const l3 = await login(op1, { pow: true }, R);
  ok(l3.client?.connected === true, 'with the operator\'s chain gone, the old chain logs in as a new identity');
  l3.client?.end(true);
  await vouched(agT, op1);
  ok(current() === accountOf(op2.did) && S.tier(agT).pool === null, 'but the licence does not follow a key its operator rotated away from');
  const opT = rotated(op1, 'operator k thief'), agS = identity('sybil k');
  const l4 = await login(opT, {}, R), in4 = l4.client?.connected === true;
  l4.client?.end(true);
  await vouched(agS, opT);
  ok(in4 && current() === accountOf(op2.did) && S.tier(agS).pool === null,
    'the thief rotates key 1 to a key of its own and logs in: the licence stays on the recovered key, and the thief\'s sybil does not pool');
  const t4 = await upload(licence(op0), R);
  await vouched(agS, opT);
  ok(t4.ok && current() === accountOf(op2.did) && S.tier(agS).pool === null, 'nor after an upload of the licence, the thief\'s chain kept as the account\'s');
  const l5 = await login(op2, {}, R), in5 = l5.client?.connected === true;
  l5.client?.end(true);
  const l6 = await login(opT, {}, R);
  ok(in5 && current() === accountOf(op2.did) && !l6.client && (await checkOf(l6.creds, R)).check === 'bundle',
    'the operator logs in with its recovered key: its recovery beats the thief\'s rotation, and the thief is refused "bundle" from then on');
  await R.close();
}

// ================================================================ an operator's rotation the relay has not seen yet
{
  now += DAY;
  const opZ = identity('operator z'), agZ = identity('agent z');
  const S = fresh('rotation');
  const R = await S.start();
  (await login(opZ, {}, R)).client?.end(true);
  const up = await upload(licence(opZ), R);
  // The operator rotates on its own (no theft) and vouches with its new key before logging in.
  const opZ2 = rotated(opZ, 'operator z 2');
  const l1 = await login(agZ, { bundle: withVouch(agZ, opZ2, vouch(opZ2, agZ)) }, R);
  ok(up.ok && l1.client?.connected && await noticed(l1.client, 'licence') && S.tier(agZ).pool === null
    && /has rotated its key and not logged in here since \(it logs in with its new key\)/.test(notices(l1.client)[0]?.detail),
    `an operator vouches with its new key before logging in with it: free tier, and "licence" names the rotation as well as a missing licence (${notices(l1.client)[0]?.detail})`);
  l1.client?.end(true);
  (await login(opZ2, {}, R)).client?.end(true);
  const l2 = await login(agZ, { bundle: withVouch(agZ, opZ2, vouch(opZ2, agZ)) }, R);
  await sleep(100);
  ok(l2.client?.connected && S.tier(agZ).pool === accountOf(opZ.original) && notices(l2.client).length === 0,
    'once the operator logs in with its new key, the same attestation pools: no new licence, no notice');
  l2.client?.end(true);
  await R.close();
}

// ================================================================ the default tiers (§11), the licence's support, a licence table of an earlier version
{
  now += DAY;
  const { free, pro } = DEFAULT_TIERS;
  ok(free.retentionDays === 14 && free.maxMessage === 512 * KB && free.mailboxes === 128 && free.msgsDay === 3000 && free.storage === 100 * MB && free.groups === 0 && free.support === 'none'
    && pro.retentionDays === 90 && pro.maxMessage === MB && pro.groups === 0 && pro.support === 'email' && windowWeeks(free.retentionDays) === 3 && windowWeeks(pro.retentionDays) === 14,
    `the default tiers (§11): free 3,000 a day, 14 days, 512 KB, 100 MB, 128 mailboxes, no support; Pro 90 days, 1 MB, e-mail support; a reader's window ${windowWeeks(14)} weeks free, ${windowWeeks(90)} Pro`);
  // A licence table without support (and with the day of use an older one kept): its rows read as
  // "email", and the sweep's rebuild in key order copies the table as made now.
  const old = new DatabaseSync(join(dir, 'default tiers.db'));   // fresh('default tiers') opens it
  old.exec(`CREATE TABLE licences (operator TEXT PRIMARY KEY, current TEXT NOT NULL, vendor_key TEXT NOT NULL, iat INTEGER NOT NULL, exp INTEGER NOT NULL, storage_mb INTEGER NOT NULL,
    msgs_day INTEGER NOT NULL, retention_days INTEGER NOT NULL, groups INTEGER NOT NULL, last_used INTEGER NOT NULL) STRICT, WITHOUT ROWID;
    INSERT INTO licences VALUES ('${'a'.repeat(64)}', '${'a'.repeat(64)}', 'did:sigelo:zold', ${now - DAY}, ${now + YEAR}, 1, 1, 1, 0, ${now});`);
  old.close();
  const D = fresh('default tiers', { tiers: undefined });
  const R = await D.start();
  const migrated = R.db.raw.prepare('SELECT support FROM licences').all().map((x) => x.support).join();
  let swept = true;
  try { R.sweep(); } catch { swept = false; }
  ok(migrated === 'email' && swept && R.db.raw.prepare('SELECT support FROM licences').get().support === 'email', `a licence table of an earlier version: its licence reads support "${migrated}", and survives the sweep's rebuild`);
  const opd = identity('operator d'), agd = identity('agent d'), frd = identity('free d');
  (await login(opd, {}, R)).client?.end(true);
  const up = await upload(licence(opd, { claims: { tier: 'pro', storage_mb: 2048, msgs_day: 50000, retention_days: 365, groups: 5, support: 'priority' } }), R);
  (await login(agd, { pow: true, bundle: withVouch(agd, opd, vouch(opd, agd)) }, R)).client?.end(true);
  const t = D.tier(agd).limits, f = D.tier(frd).limits;
  ok(up.ok && t.retentionDays === 90 && t.retention === 90 * DAY && t.maxMessage === MB && t.mailboxes === 16384 && t.storage === 1024 * MB && t.groups === 0 && t.support === 'priority',
    'a licence selling 365 days, 2 GB, 5 groups and priority support, under the default tiers: 90 days, 1 MB messages, 16,384 mailboxes, Pro\'s 1 GB, groups 0 until they exist, support "priority"');
  ok(f.retentionDays === 14 && f.maxMessage === 512 * KB && f.mailboxes === 128 && f.support === 'none' && D.pol.retention(accountOf(agd.original)) === 90 * DAY,
    'a free identity: 14 days, 512 KB, 128 mailboxes, no support; the pooled agent\'s messages are kept 90 days');
  await R.close();
}

// ================================================================ the free tier's ceiling by default: half the room below relay_full
{
  // A disk of 1,000,000 blocks of 4 KiB; bavail: the blocks not in use (server.mjs: use = 1 - bavail / blocks).
  const SIZE = 1e6 * 4096, disk = (bavail) => ({ blocks: 1e6, bavail, bsize: 4096 });
  ok(freeQueueOf(disk(1e6), 0) === Math.floor(FULL * SIZE / 2), `an empty disk: half of server.mjs's relay_full share (${FULL}) of it, so the two constants agree`);
  // The review's case: the disk is 40 % used before the relay starts. A ceiling of 35 % of the disk
  // let free messages alone take it to 75 %, past relay_full.
  const c40 = freeQueueOf(disk(600000), 0);
  ok(c40 === Math.floor((FULL * 1e6 - 400000) * 4096 / 2) && 0.4 + c40 / SIZE < FULL,
    `a disk 40 % used by other files: the ceiling is half the 30 % left below relay_full (${c40} bytes), so free messages alone stop at ${((0.4 + c40 / SIZE) * 100).toFixed(0)} %`);
  ok(freeQueueOf(disk(600000 - c40 / 4096), c40) === c40, 'restarted with that free tier full (its charge now on the disk): the same ceiling, not a higher one');
  ok(freeQueueOf(disk(250000), 0) === 1 && freeQueueOf(disk(0), 0) === 1, 'other files at 75 % or 100 % of the disk: a ceiling of 1 byte, free readers take nothing');
  // On a relay: no freeQueue configured, so it is measured from the database's own disk at start.
  const D = fresh('measured', { freeQueue: undefined });
  const R = await D.start();
  const st = statfsSync(dir), want = freeQueueOf(st, 0);
  ok(Math.abs(D.pol.freeQueue - want) <= 0.01 * st.blocks * st.bsize,
    `a relay without RELAY_FREE_QUEUE_MB measures its ceiling from its database's disk at start (${D.pol.freeQueue} bytes; measured again now: ${want})`);
  await R.close();
}

// ================================================================ the per-network curve at its default edge, through the policy
{
  // Review finding: NETWORK_DAY is the top step's 64, so what GET /challenge states (policy.powBits:
  // pow.mjs issue(), the cap applied) runs base, base + 2, then closed; base + 4 only while a
  // challenge waiting brings the count to 64 before the 64th good proof. The earlier edge test read
  // required(), which ignores the cap. Default steps and cap here, base 8: 8, 10, 12, 64.
  const E = fresh('pow edge'), R = await E.start(), EN = 'edge net', te = now, exp = te + 300;
  const proveAs = (i, bits) => {
    const original = `did:sigelo:zEdge${i}`, nonce = String(i).padStart(43, 'E');
    E.pol.powSpent({ network: EN, exp, now: te });
    return E.pol.pow({ pow: solve(HOST, original, nonce, bits), host: HOST, account: accountOf(original), original, nonce, isNew: true, now: te, bits, network: EN });
  };
  const seen = [];
  for (let i = 0; i < 64; i++) {
    const bits = E.pol.powBits({ network: EN, exp, now: te });
    if ([0, 7, 8, 63].includes(i)) seen.push(`${i}:${bits}`);
    if (i === 63) { seen.push(`63 + 1 waiting:${E.pol.powBits({ network: EN, exp, now: te })}`); E.pol.powSpent({ network: EN, exp, now: te }); }
    if (proveAs(i, bits) !== null) seen.push(`refused ${i}`);
  }
  seen.push(`64:${E.pol.powBits({ network: EN, exp, now: te })}`);
  const past = proveAs(64, 10);
  ok(seen.join() === '0:8,7:8,8:10,63:10,63 + 1 waiting:12,64:64' && /brought 64 new identities/.test(past ?? ''),
    `the default curve as stated (good proofs:bits): ${seen.join(' ')}; the 65th new identity refused "pow" whatever its proof`);
  await R.close();
}

// ================================================================ a good proof whose login stores nothing is kept for its retry
{
  // Review finding: a good proof whose login then failed (relay_full for a new free identity, a
  // session cap) was voided at that identity's next login, so every retry owed a new proof and
  // counted one more arrival against its network: honest retries behind one NAT were told the
  // network had brought its most for the day instead of relay_full. A proof from today is kept; one
  // from an earlier day for an identity with no account (a swept one) is still void.
  now += DAY;
  const tiers = { free: { ...TIERS.free, mailboxes: 10 }, pro: { ...TIERS.pro, mailboxes: 10 } }, pow = { ...config.pow, perDay: 2 };
  let S = fresh('retry', { tiers, freeQueue: 64 * MB, pow });
  let R = await S.start();
  const holder = identity('retry holder'), HT = topic();
  const hc = (await login(holder, { pow: true }, R)).client;
  await subscribe(hc, HT); await end(hc);
  const rows = R.db.rowBytes();
  await R.close();
  S = fresh('retry', { tiers, freeQueue: rows + ACCOUNT_ROW - 1, pow });   // no room for one more account
  R = await S.start();
  const RNET = '198.51.100.77', nx = identity('retry newcomer'), NX = accountOf(nx.original), tries = [];
  for (let i = 0; i < 3; i++) {
    // A closed network states 64 bits, which no search here could meet: recorded, not searched.
    const { challenge, pow_bits } = await getChallenge(nx.did, R, RNET);
    if (pow_bits === CLOSED_BITS) { tries.push('closed'); continue; }
    const creds = { username: nx.did, clientId: clientId(nx), password: password(nx, challenge, { extra: { pow: solve(HOST, nx.original, challenge.nonce, pow_bits) } }) };
    const l = await mqttConnect(creds, R);
    tries.push(l.client ? 'connected' : (await checkOf(creds, R)).check);
    l.client?.end(true);
  }
  const there = (await getChallenge(erin.did, R, RNET)).pow_bits;
  ok(tries.join() === 'relay_full,relay_full,relay_full' && there === 8 && R.db.account(NX) === undefined,
    `a new free identity tries 3 times with a good proof while the free tier is full: ${tries.join()}; one arrival counted (its network, 2 a day, still states ${there})`);
  const hb = (await login(holder, {}, R)).client;
  await unsubscribe(hb, HT); await end(hb);   // room for an account now
  const kept = await login(nx, { pow: false, ip: RNET }, R);
  ok(kept.client?.connected === true && R.db.account(NX) !== undefined, 'once there is room it logs in without a new proof and is stored: its proof from today was kept');
  kept.client?.end(true);
  const old = identity('retry swept'), OLD = accountOf(old.original);
  R.db.raw.prepare('INSERT INTO pow_proofs (account, at) VALUES (?, ?)').run(OLD, Math.floor(now / DAY) * DAY - DAY);
  const lo = await login(old, { pow: false }, R);
  ok(lo.client?.connected === true && R.db.account(OLD) === undefined && R.db.raw.prepare('SELECT 1 FROM pow_proofs WHERE account = ?').get(OLD) === undefined,
    'a proof from yesterday for an identity with no account (one swept): void, its login stores nothing and the row goes');
  lo.client?.end(true);
  await R.close();
}

// ================================================================ refusals that cost nothing else: Pro's own network bucket, every refused publish a strike
{
  // Audit finding: a refusal other than "rate" (no_reader, a quota) took a token from the network's
  // bucket and was no strike, so a dozen proven free identities on a shared /24 publishing to a
  // topic nobody holds kept that bucket empty, and every other identity there, Pro agents among
  // them, was refused "rate". Identities drawing on an operator pool now have a network bucket of
  // their own, and every refused publish counts toward the strikes. A minute's second 10.
  now = (Math.floor(now / DAY) + 1) * DAY + 10;
  const tiers = { free: { ...TIERS.free, msgsDay: 1000, mailboxes: 10 }, pro: { ...TIERS.pro, msgsDay: 1000, mailboxes: 10 } };
  const B = fresh('starve', { tiers, rate: { publish: { perSecond: 4, burst: 4 }, network: { publish: { perSecond: 6, burst: 6 } }, strikes: 6 } });
  const R = await B.start();
  const op = identity('starve operator'), ag = identity('starve agent'), rd = identity('starve reader');
  (await login(op, { pow: true }, R)).client?.end(true);
  const up = await upload(licence(op), R);
  const rc = (await login(rd, { pow: true, local: '127.0.1.1' }, R)).client, X = topic(), nobody = topic();
  await subscribe(rc, X);
  const ac = (await login(ag, { pow: true, bundle: withVouch(ag, op, vouch(op, ag)) }, R)).client;
  const fr = (await login(identity('starve free'), { pow: true }, R)).client;
  const sy = [];
  for (let i = 0; i < 2; i++) sy.push((await login(identity(`starve sybil ${i}`), { pow: true }, R)).client);
  for (const c of sy) { c.box.length = 0; for (let i = 0; i < 3; i++) await publish(c, nobody, randomBytes(10)); }
  await sleep(50);
  ok(up.ok && B.tier(ag).pool === accountOf(op.original) && sy.flatMap(notices).filter((x) => x.code === 'no_reader').length === 6,
    'two free identities on 127.0.0.0/24 publish 3 each to a topic nobody holds: 6 no_reader, the free network bucket\'s 6');
  await refusedPublish(fr, X, 10, 'rate', 'in that second, another free identity there: refused "rate", the bucket its network\'s free identities share', rc);
  ok(/on the free tier together/.test(notices(fr)[0]?.detail ?? ''), `named as the free identities\' network bucket (${notices(fr)[0]?.detail})`);
  ac.box.length = 0;
  await publish(ac, X, randomBytes(10));
  ok(await until(() => got(rc, X).length === 1) && notices(ac).length === 0, 'and a Pro agent there: delivered, on the network bucket of identities drawing on a pool');
  now += 1;
  const closed = new Promise((resolve) => sy[0].once('close', () => resolve(true)));
  for (let i = 0; i < 4; i++) sy[0].publish(nobody, randomBytes(10), { qos: 1 });
  ok(await Promise.race([closed, sleep(3000).then(() => false)]) && !notices(sy[0]).some((x) => x.code === 'rate'),
    'a second later one of them goes on: its 7th refused publish in the minute, each no_reader and none "rate", closes the connection (strikes: 6)');
  for (const c of [rc, ac, fr, ...sy]) c.end(true);
  await R.close();
}

// ================================================================ a chain sent again longer: the free ceiling; a pool's rows: its storage
{
  // Audit finding: the free ceiling was checked only when a new identity was first stored, and
  // against ACCOUNT_ROW (128 bytes). A stored identity logging in again with a longer chain (64
  // rotations, minted offline for nothing) rewrote its sealed chain and chain DIDs unchecked, so
  // free rows grew past the ceiling to relay_full, which refuses every publish, Pro's too; a pooled
  // new identity was checked against nothing. Now every login that grows an identity's rows
  // (db.mjs chainRowBytes) is checked: free ones against the ceiling, pooled ones with their pool's
  // other identity rows against its storage (8,768 here). A chain edge is ~950 bytes.
  now += DAY;
  let S = fresh('chains', { freeQueue: 64 * MB });
  let R = await S.start();
  const g = identity('chain grower'), op = identity('chain operator'), OP = accountOf(op.original);
  for (const id of [g, op]) (await login(id, { pow: true }, R)).client?.end(true);
  const up = await upload(licence(op), R);
  const chainOf = (from, label, k) => { let id = from; for (let i = 1; i <= k; i++) id = rotated(id, `${label} ${i}`); return id; };
  const rowsOf = (id, r = R) => r.db.rowsOf(accountOf(id.original));
  const why = async (l, r) => (l.client ? (l.client.end(true), 'connected') : (await checkOf(l.creds, r)).detail ?? 'no detail');
  const a7 = chainOf(identity('chain agent'), 'chain agent', 7), a9 = chainOf(identity('chain agent'), 'chain agent', 9), b9 = chainOf(identity('chain big'), 'chain big', 9);
  const lb = await login(b9, { pow: true, bundle: withVouch(b9, op, vouch(op, identity('chain big'))) }, R), wb = await why(lb, R);
  ok(up.ok && /operator's pool holds .* more than its storage \(8768\): it stores no new agent/.test(wb) && R.db.account(accountOf(b9.original)) === undefined,
    `a new agent of the pool with 9 rotations: its rows and the operator's pass the pool's storage, refused relay_full, nothing stored (${wb})`);
  const la = await login(a7, { pow: true, bundle: withVouch(a7, op, vouch(op, identity('chain agent'))) }, R), wa = await why(la, R);
  ok(wa === 'connected' && rowsOf(a7) > 7000 && S.tier(a7).pool === OP, `one with 7 rotations fits beside the operator's rows: stored, pooled (${rowsOf(a7)} bytes)`);
  const la9 = await login(a9, { bundle: withVouch(a9, op, vouch(op, identity('chain agent'))) }, R), wa9 = await why(la9, R);
  ok(/no longer chain of one/.test(wa9) && rowsOf(a7) < 7500, `it logs in again with 9: refused relay_full, its chain kept as it was (${wa9})`);
  const room = R.db.rowBytes() + 1000;
  await R.close();
  S = fresh('chains', { freeQueue: room });
  R = await S.start();
  const g1 = rotated(g, 'chain grower 1'), g2 = rotated(g1, 'chain grower 2'), r0 = rowsOf(g);
  const l2 = await login(g2, {}, R), w2 = await why(l2, R);
  ok(/free tier is full .* no longer chain of one/.test(w2) && rowsOf(g) === r0, `the ceiling 1,000 bytes above the rows: the free grower with 2 more rotations, refused relay_full, nothing written (${w2})`);
  const l1 = await login(g1, {}, R), w1 = await why(l1, R);
  ok(w1 === 'connected' && rowsOf(g1) === r0 + 978, `with 1, within the room: stored (${rowsOf(g1) - r0} bytes more)`);
  const l2b = await login(g2, {}, R), w2b = await why(l2b, R);
  ok(/no longer chain of one/.test(w2b), `then the 2nd, past the ceiling: refused (${w2b})`);
  // Its key is stolen; the owner recovers from it. One recovery edge on a chain whose last edge is
  // not one passes the ceiling (SPEC §7.1); a second one, minted by whoever holds the recovery key
  // of its own identity, does not.
  const back = rotated(g1, 'chain grower back', 'recovery'), again = rotated(back, 'chain grower again', 'recovery');
  const lr = await login(back, {}, R), wr = await why(lr, R);
  ok(wr === 'connected' && R.db.rowBytes() > room, `the owner's recovery from the stolen key: stored past the ceiling (${R.db.rowBytes()} of ${room})`);
  const lr2 = await login(again, {}, R), wr2 = await why(lr2, R);
  ok(/no longer chain of one/.test(wr2), `a second recovery edge on top: refused (${wr2})`);
  const nw = await login(identity('chain newcomer'), { pow: true }, R), wn = await why(nw, R);
  ok(/stores no new free identity/.test(wn), `a new free identity: refused relay_full (${wn})`);
  await R.close();
}

// ================================================================ one pooled reader's share against writers outside its pool
{
  // Audit finding: a pooled reader's storage was checked only against its whole pool, and its
  // largest message and retention follow the reader, so one free contact of one offline agent
  // filled the operator's pool with 1 MB messages kept 90 days, and every other agent's mail was
  // refused quota_storage. Now the largest message is the smaller of the sender's and the reader's,
  // and from writers outside the pool one reader holds at most max(free storage, pool storage /
  // POOL_SHARES): here max(3,000, 20,000 / 4) = 5,000. A 1,000-byte message is charged 1,384.
  now += DAY;
  const tiers = { free: { storage: 3000, msgsDay: 100, retentionDays: 7, maxMessage: 1000, mailboxes: 10 }, pro: { storage: 20000, msgsDay: 100, retentionDays: 30, maxMessage: 4000, mailboxes: 10 } };
  const P = fresh('share', { tiers }), R = await P.start();
  const op = identity('share operator'), a1 = identity('share agent 1'), a2 = identity('share agent 2'), st = identity('share stranger');
  const oc = (await login(op, { pow: true }, R)).client;
  const up = await upload(licence(op), R);
  const c1 = (await login(a1, { pow: true, bundle: withVouch(a1, op, vouch(op, a1)) }, R)).client, c2 = (await login(a2, { pow: true, bundle: withVouch(a2, op, vouch(op, a2)) }, R)).client;
  const T1 = topic(), T2 = topic();
  await subscribe(c1, T1); await subscribe(c2, T2);
  await end(c1); await end(c2);
  const sc = (await login(st, { pow: true }, R)).client;
  ok(up.ok && P.tier(a1).limits.storage === 20000 && P.tier(st).pool === null, 'two agents of a pool of 20,000 bytes go offline; a free stranger writes to agent 1');
  await refusedPublish(sc, T1, 1001, 'too_large', 'its 1,001 bytes: over the smaller of its 1,000 and the reader\'s 4,000');
  for (let i = 0; i < 3; i++) await publish(sc, T1, randomBytes(1000));
  ok(queued(T1, R).n === 3, 'three of 1,000 bytes are stored (4,152 charged)');
  await refusedPublish(sc, T1, 1000, 'quota_storage', 'a fourth: past agent 1\'s share of its pool from outside it (5,000)');
  ok(/the most one agent of its pool holds from writers outside it/.test(notices(sc).at(-1)?.detail ?? ''), `named as that share (${notices(sc).at(-1)?.detail})`);
  sc.box.length = 0;
  await publish(sc, T2, randomBytes(1000));
  await sleep(50);
  ok(queued(T2, R).n === 1 && notices(sc).length === 0, 'agent 2\'s mail is still stored: the pool has room');
  oc.box.length = 0;
  await publish(oc, T1, randomBytes(4000));
  await sleep(50);
  ok(queued(T1, R).n === 4 && notices(oc).length === 0, 'the operator, of the same pool, writes 4,000 bytes to agent 1 past that share: stored, on the whole pool');
  for (const c of [oc, sc]) await end(c);
  await R.close();
}

// ================================================================ the claim brake: claims and releases, each a checkpoint
{
  // Audit finding: every claim and every release is a transaction and a WAL checkpoint (db.mjs
  // settle), milliseconds on a real disk, while the subscribe brake was sized from a publish's
  // cost: one network's SUBSCRIBE/UNSUBSCRIBE churn within it held the thread. A claim made anew
  // and a release now also draw on a claim bucket, per identity and per network; a topic held
  // already does not. Configured: 3, then 1 a second per identity; 4, then 1 per network.
  now = (Math.floor(now / DAY) + 1) * DAY + 10;
  const tiers = { free: { ...TIERS.free, mailboxes: 50 }, pro: { ...TIERS.pro, mailboxes: 50 } };
  const C = fresh('claimbrake', { tiers, rate: { subscribe: { perSecond: 100, burst: 100 }, claim: { perSecond: 1, burst: 3 }, network: { claim: { perSecond: 1, burst: 4 } }, strikes: 1000 } });
  const R = await C.start();
  const rd = identity('claim reader'), c2id = identity('claim second'), c3id = identity('claim churner');
  const rc = (await login(rd, { pow: true }, R)).client;
  const held = () => R.db.raw.prepare('SELECT count(*) AS n FROM claims WHERE account = ?').get(accountOf(rd.original)).n;
  const H = [topic(), topic(), topic()];
  ok((await Promise.all(H.map((t) => subscribe(rc, t)))).every((g) => g === 1) && held() === 3, 'three new topics in a second: claimed (the identity\'s claim burst: 3)');
  rc.box.length = 0;
  ok(await subscribe(rc, topic()) === 128 && await noticed(rc, 'rate') && held() === 3 && /mailboxes claimed or given up from this identity/.test(notices(rc)[0]?.detail ?? ''),
    `a fourth new one in that second: refused "rate" by the claim brake (${notices(rc)[0]?.detail})`);
  ok(await subscribe(rc, H[0]) === 1, 'a topic it holds, subscribed again in that second: granted, no claim drawn');
  rc.box.length = 0;
  await unsubscribe(rc, H[0]);
  ok(await noticed(rc, 'rate') && held() === 3, 'an UNSUBSCRIBE in that second: refused, still claimed (a release is a claim\'s work)');
  now += 1;
  await unsubscribe(rc, H[0]);
  ok(await until(() => held() === 2), 'a second later: released');
  // The network's bucket for 127.0.0.0/24: 4 at once, 4 taken above and 1 back since.
  const c2 = (await login(c2id, { pow: true }, R)).client;
  c2.box.length = 0;
  const g2 = await Promise.all([topic(), topic(), topic()].map((t) => subscribe(c2, t)));
  ok(g2.filter((g) => g === 1).length === 1 && await noticed(c2, 'rate') && /this network/.test(notices(c2)[0]?.detail ?? ''),
    `another identity on that /24, its own bucket full: 1 of 3 claimed, the others refused by the network's claim bucket (${notices(c2)[0]?.detail})`);
  // Proof of work comes first: an identity refused "pow" spends none of the brake. Before, its
  // refused claims took it, and once it had logged in with a proof (a carrier the relay forgot)
  // its claims were refused "rate".
  now += 10;
  const unproven = identity('claim unproven');
  const u1 = (await login(unproven, { pow: false }, R)).client;
  u1.box.length = 0;
  const gu = await Promise.all([topic(), topic(), topic(), topic(), topic()].map((t) => subscribe(u1, t)));
  ok(gu.every((g) => g === 128) && await noticed(u1, 'pow') && !notices(u1).some((x) => x.code === 'rate'), `unproven, 5 new topics in a second: each refused "pow", none "rate" (${notices(u1).map((x) => x.code)})`);
  u1.end(true);
  const u2 = (await login(unproven, { pow: true }, R)).client;
  const gp = await Promise.all([topic(), topic(), topic()].map((t) => subscribe(u2, t)));
  ok(gp.every((g) => g === 1), `with a proof, in that second, it claims its 3 at once: the refusals spent none of the brake (${gp})`);
  u2.end(true);
  // Churn: SUBSCRIBE and UNSUBSCRIBE of fresh topics, 20 of each in one second, well within the
  // subscribe brake (100): only what the claim brake lets through reaches a checkpoint.
  now += 10;
  const c3 = (await login(c3id, { pow: true, local: '127.0.1.1' }, R)).client, exec = R.db.raw.exec;
  let checkpoints = 0;
  R.db.raw.exec = function (sql) { if (/wal_checkpoint/.test(sql)) checkpoints++; return exec.call(this, sql); };
  for (let i = 0; i < 20; i++) { const t = topic(); await subscribe(c3, t); await unsubscribe(c3, t); }
  R.db.raw.exec = exec;
  ok(checkpoints <= 3, `20 claims and 20 releases churned in a second from a fresh /24: ${checkpoints} checkpoints (the identity's claim burst: 3)`);
  for (const c of [rc, c2, c3]) c.end(true);
  await R.close();
}

// ================================================================ deletions in batches; a restore of RESTORE_MAX claims
{
  // Audit findings: an UNSUBSCRIBE deleted its mailbox's whole queue in one transaction (64,000
  // messages held the one thread 5 s, for one claim token), and the sweep deleted a UTC day's
  // expired messages in one (they all expire at one instant). Now no transaction deletes more than
  // DELETE_BATCH messages: the rest go in batches, a turn of the event loop each (db.mjs reap). A
  // spy on COMMIT measures what each transaction took from the queue.
  now = (Math.floor(now / DAY) + 1) * DAY + 30;
  const tiers = { free: { ...TIERS.free, mailboxes: 10 }, pro: { ...TIERS.pro, mailboxes: 10 } };
  const B = fresh('batches', { tiers, rate: { subscribe: { perSecond: 100, burst: 1000 }, claim: { perSecond: 100, burst: 1000 }, network: { claim: { perSecond: 100, burst: 1000 } }, strikes: 10000 } });
  const R = await B.start();
  const rd = identity('batch reader'), wr = identity('batch writer');
  const rc = (await login(rd, { pow: true }, R)).client, wc = (await login(wr, { pow: true }, R)).client;
  const T = topic(), small = topic(), N = 40 * DELETE_BATCH;
  ok(await subscribe(rc, T) === 1 && await subscribe(rc, small) === 1, 'the reader claims two mailboxes');
  const count = (sql, ...a) => R.db.raw.prepare(sql).get(...a).n, onT = () => count('SELECT count(*) AS n FROM messages WHERE topic = ?', T);
  const fill = (t, k, expires) => { for (let i = 0; i < k; i += 1000) R.db.tx(() => { for (let j = i; j < Math.min(k, i + 1000); j++) R.db.store({ topic: t, clientId: clientId(rd), account: accountOf(rd.original), payload: Buffer.alloc(0), expires, pool: null }); }); };
  fill(T, N, now + 7 * DAY);
  fill(small, 3, now + 7 * DAY);
  await end(rc);
  // Each transaction's drop in the queue, over everything below.
  const exec = R.db.raw.exec;
  let last = count('SELECT count(*) AS n FROM messages'), most = 0;
  R.db.raw.exec = function (sql) { const r = exec.call(this, sql); if (sql === 'COMMIT') { const k = count('SELECT count(*) AS n FROM messages'); most = Math.max(most, last - k); last = k; } return r; };
  // The batches held back for a moment, to look at the mailbox given up meanwhile.
  const reap = R.db.reap;
  R.db.reap = () => ({ more: false });
  const back = (await login(rd, { bundle: false }, R)).client;
  await unsubscribe(back, [small, T]);
  // The queue streams to the reader as it connects, and the client acknowledges: a few may be read.
  const c = R.db.claim(T);
  ok(R.db.claim(small) === undefined && count('SELECT count(*) AS n FROM messages WHERE topic = ?', small) === 0 && c?.dead === 2 && onT() > N - DELETE_BATCH,
    `one UNSUBSCRIBE: the mailbox holding 3 is deleted at once with them; the one holding ${N} is given up (dead ${c?.dead}), its queue left for the batches (${onT()})`);
  ok(R.db.counters(accountOf(rd.original), now).mailboxes === 0, 'a mailbox given up no longer counts among its reader\'s');
  wc.box.length = 0;
  const before = onT();
  await publish(wc, T, randomBytes(300));
  ok(await noticed(wc, 'no_reader') && onT() <= before, 'a message to it meanwhile: refused no_reader, nothing stored');
  back.box.length = 0;
  ok(await subscribe(back, T) === 128 && await noticed(back, 'mailbox_taken') && /given up a moment ago/.test(notices(back)[0]?.detail ?? ''),
    `a SUBSCRIBE to it meanwhile: refused mailbox_taken (${notices(back)[0]?.detail})`);
  await end(back);
  const again = (await login(rd, { bundle: false }, R)).client;
  await sleep(300);
  ok(got(again, T).length === 0 && !Object.keys(R.broker.clients[clientId(rd)]?.subscriptions ?? {}).includes(T), 'its reader connecting again: the mailbox is not restored, and nothing of its queue is delivered');
  await end(again);
  R.db.reap = reap;
  const h = monitorEventLoopDelay({ resolution: 1 });
  h.enable();
  R.sweep(now);   // the sweep starts the batches (after a restart too)
  const drained = await until(() => onT() === 0 && R.db.claim(T) === undefined, 60000);
  h.disable();
  ok(drained && most <= DELETE_BATCH && totalsMatch(R), `the batches then delete its ${N} messages and the claim: at most ${most} a transaction (DELETE_BATCH ${DELETE_BATCH}), the queue's totals kept`);
  ok(h.max / 1e6 < 1000, `the longest stall of the thread meanwhile: ${(h.max / 1e6).toFixed(0)} ms (one transaction deleted all ${N} before)`);
  // A day's expired messages: the sweep deletes one batch, the batches the rest.
  const rc2 = (await login(rd, { bundle: false }, R)).client, E = topic(), M = 5 * DELETE_BATCH + 7;
  ok(await subscribe(rc2, E) === 1, 'the reader claims another mailbox');
  await end(rc2);
  fill(E, M, now + DAY);
  now += 2 * DAY;
  last = count('SELECT count(*) AS n FROM messages'); most = 0;
  const swept = R.sweep(now);
  ok(swept.expired === DELETE_BATCH && swept.more === true && count('SELECT count(*) AS n FROM messages WHERE topic = ?', E) === M - DELETE_BATCH,
    `${M} messages expired at one instant: the sweep deletes ${swept.expired}, one batch, and says more are left`);
  ok(await until(() => count('SELECT count(*) AS n FROM messages WHERE topic = ?', E) === 0, 60000) && most <= DELETE_BATCH && totalsMatch(R),
    `the batches delete the rest: at most ${most} a transaction, the queue's totals kept`);
  R.db.raw.exec = exec;

  // A CONNECT restores at most RESTORE_MAX claims, the most recently claimed first: one pooled
  // agent may hold its pool's 16,384 mailboxes, and each CONNECT replayed them all (605 ms of the
  // one thread, measured), drawn on no brake but the login rate. The rest stay claimed: a
  // SUBSCRIBE gets each back, without a claim token.
  const many = identity('restore holder');
  const mc = (await login(many, { pow: true }, R)).client;
  await end(mc);
  const older = Array.from({ length: 40 }, topic), newer = Array.from({ length: RESTORE_MAX }, topic);
  R.db.tx(() => {
    for (const t of older) R.db.insertClaim(t, accountOf(many.original), clientId(many), now - 3 * DAY, null, null);
    for (const t of newer) R.db.insertClaim(t, accountOf(many.original), clientId(many), now, null, null);
  });
  const mc2 = (await login(many, { bundle: false }, R)).client;
  const subs = Object.keys(R.broker.clients[clientId(many)]?.subscriptions ?? {}).filter((t) => t.startsWith('m/'));
  ok(subs.length === RESTORE_MAX && newer.every((t) => subs.includes(t)), `${older.length + newer.length} claims held: the CONNECT restores ${subs.length}, the most recently claimed (RESTORE_MAX ${RESTORE_MAX})`);
  const claimsBefore = count('SELECT count(*) AS n FROM claims WHERE account = ?', accountOf(many.original));
  ok(await subscribe(mc2, older[0]) === 1 && count('SELECT count(*) AS n FROM claims WHERE account = ?', accountOf(many.original)) === claimsBefore
    && Object.keys(R.broker.clients[clientId(many)].subscriptions).includes(older[0]), 'an older claim not restored: a SUBSCRIBE gets it back, still the one claim');
  for (const x of [mc2, wc]) x.end(true);
  await R.close();
}

// ================================================================ idle mailboxes and accounts: a batch a sweep
{
  // Audit finding: the sweep deleted every idle claim, and every idle account, in one transaction.
  // claims.last_used is kept by the UTC day, so every claim last used on one day goes idle in the
  // same minute: 64,000 held the one thread 4.6 s (Sybil identities reconnecting on one day, or a
  // lapsed Pro pool's 16,384). Now one sweep deletes at most DELETE_BATCH rows of every kind
  // together, the idle ones read a page at a time in key order, and the next sweep goes on where it
  // stopped. A page of claims kept longer (a connected reader's, here first in key order) must not
  // hold up those after it at every sweep.
  const S = fresh('idle batches'), R = await S.start();
  const holder = identity('online holder'), idler = identity('idle holder');
  const hc = (await login(holder, { pow: true }, R)).client;
  const at = (p, i) => `m/${p}${i.toString(16).padStart(31, '0')}`, KEPT = DELETE_BATCH + 10, IDLE = 2 * DELETE_BATCH + 5, ACCOUNTS = DELETE_BATCH + 188;
  R.db.tx(() => {
    for (let i = 0; i < KEPT; i++) R.db.insertClaim(at('0', i), accountOf(holder.original), clientId(holder), now, null, null);
    for (let i = 0; i < IDLE; i++) R.db.insertClaim(at('f', i), accountOf(idler.original), clientId(idler), now, null, null);
    for (let i = 0; i < ACCOUNTS; i++) R.db.touchAccount(randomBytes(32).toString('hex'), now);
  });
  const n = (sql) => R.db.raw.prepare(sql).get().n, rows = () => n('SELECT count(*) AS n FROM claims') + n('SELECT count(*) AS n FROM accounts') + n('SELECT count(*) AS n FROM chain_dids');
  // Sweeps until one says nothing is left (at most 8): what each deleted, and the totals.
  const sweepAll = () => {
    const out = [];
    for (let i = 0; i < 8; i++) {
      const before = rows(), r = R.sweep(now);
      out.push({ ...r, gone: before - rows() });
      if (!r.more) break;
    }
    return out;
  };
  now += 15 * DAY;   // free retention + 7 days, and the day of the stamp
  const s1 = sweepAll(), idleGone = s1.reduce((a, x) => a + x.idle, 0);
  ok(s1.every((x) => x.gone <= DELETE_BATCH) && idleGone === IDLE && n("SELECT count(*) AS n FROM claims WHERE topic >= 'm/f'") === 0 && n("SELECT count(*) AS n FROM claims WHERE topic < 'm/1'") === KEPT,
    `${IDLE} idle mailboxes behind ${KEPT} of a connected reader's: ${s1.length} sweeps delete them, at most ${Math.max(...s1.map((x) => x.gone))} rows each (DELETE_BATCH ${DELETE_BATCH}); the connected reader's stay (${s1.map((x) => x.idle).join(', ')})`);
  now += 16 * DAY;   // 30 days after the accounts' last login
  const s2 = sweepAll(), accountsGone = s2.reduce((a, x) => a + x.accounts, 0);
  ok(s2.every((x) => x.gone <= DELETE_BATCH) && accountsGone === ACCOUNTS && R.db.account(accountOf(holder.original)) !== undefined,
    `${ACCOUNTS} idle accounts: at most ${Math.max(...s2.map((x) => x.gone))} rows a sweep (${s2.map((x) => x.accounts).join(', ')}); the account holding claims stays`);
  hc?.end(true);
  await R.close();
}

// ================================================================ what the docs state, against the code
{
  const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
  // Every variable relayPolicyFromEnv reads is in server.mjs's header, where an operator configuring
  // the relay looks (review finding: RELAY_POW_NETWORK_DAY was missing).
  const vars = [...new Set([...read('allowance.mjs').matchAll(/whole\('(RELAY_[A-Z_]+)'|env\.(RELAY_[A-Z_]+)/g)].map((m) => m[1] ?? m[2]))];
  const header = read('server.mjs').split(/\nimport /)[0];
  ok(vars.length >= 7 && vars.every((v) => new RegExp(`\\b${v}\\b`).test(header)), `server.mjs's header names every variable relayPolicyFromEnv reads (${vars.join(', ')})`);
  // The README's limits are the default tiers' (review finding: Pro's retention is the licence's,
  // up to 90 days, not a flat 90), and it links the published limits document itself.
  const readme = read('README.md'), { free, pro } = DEFAULT_TIERS;
  ok(readme.includes(`| Kept | ${free.retentionDays} days, or until read | the licence's, up to ${pro.retentionDays} days |`) && readme.includes(`| Mailboxes | ${free.mailboxes} | ${pro.mailboxes.toLocaleString('en')} |`)
    && readme.includes('(https://relay.sigelo.ai/relay.json)'),
    'README: Kept and Mailboxes match the default tiers (Pro kept: the licence\'s, up to 90 days); /relay.json links the published document');
}

// The main relay's totals after everything above: deliveries, expiry, mailboxes given up.
ok(totalsMatch(relay), 'the queue totals of the main relay equal its queue summed afresh');
// M4's rows keep times by the UTC day too (plan §5 "Privacy"): a proof's or a licence's use to the
// second would tie it to the log's line of that login, and to the other rows written then.
{
  const stamps = relay.db.raw.prepare('SELECT at AS t FROM pow_proofs').all().map((r) => r.t);
  ok(stamps.length > 0 && stamps.every((t) => t % DAY === 0), `pow_proofs.at is the start of a UTC day (${stamps.length} values); a licence keeps no day of use`);
}

// GET /stats (stats.mjs) reads M4's numbers from its tables: proofs of work today, licences
// running, the free tier's ceiling used.
{
  const s = await (await fetch(`${base()}/stats?x=${now}`)).json(), raw = relay.db.raw, day = Math.floor(now / DAY) * DAY;
  const pow = raw.prepare('SELECT count(*) AS n FROM pow_proofs WHERE at = ?').get(day).n, lic = raw.prepare('SELECT count(*) AS n FROM licences WHERE exp > ?').get(now).n;
  const pct = Math.round((pol.freeUsed() / pol.freeQueue) * 1000) / 10;
  ok(s.pow_solved_today === pow && s.pro_licences_active === lic && s.free_queue_used_pct === pct && typeof pct === 'number',
    `GET /stats: pow solved today ${s.pow_solved_today}, Pro licences active ${s.pro_licences_active}, free queue used ${s.free_queue_used_pct} %, as the tables hold them`);
}

await relay.close();
rmSync(dir, { recursive: true, force: true });
console.log(failed === 0 ? `ALL PASS (${n})` : `${failed} FAILED of ${n}`);
process.exit(failed === 0 ? 0 : 1);
