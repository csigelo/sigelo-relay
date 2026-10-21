#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// relay/test/closed.mjs — a closed relay (closed.mjs) on loopback, with M4's policy and proof of
// work asked of strangers on an open relay: the operator and the identities it attests log in, claim
// and deliver with no proof of work (GET /challenge asks 0 bits); a stranger is refused `closed`,
// with a proof of work, with an attestation from someone else, for another relay, expired, or from
// a key the operator rotated away from, and stores nothing; POST /park for admitted identities
// only; a session ends with its attestation; the sweep keeps an admitted account while the
// attestation runs; GET /stats names the operators and no one else; RELAY_CLOSED_OPERATOR read and
// refused. ROADMAP §9.1. Prints "ALL PASS (n)".
//   node relay/test/closed.mjs
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect } from 'mqtt';
import { attest, canonicalize, multibase } from 'sigelo';
import { startRelay } from '../server.mjs';
import { accountOf } from '../db.mjs';
import { CHECKS, OPERATOR_CTX } from '../auth.mjs';
import { relayPolicy } from '../allowance.mjs';
import { MAX_CLOSED, closedOperators } from '../closed.mjs';
import { solve } from '../pow.mjs';
import { bundleOf, clientId, identity, password, rotated } from './fixtures.mjs';

let n = 0, failed = 0;
const ok = (cond, what) => { n++; if (cond) console.log(`ok ${what}`); else { failed++; console.log(`FAIL ${what}`); } };
setTimeout(() => { console.log(`FAIL the run did not finish in 120 s (${n} checks so far)`); process.exit(1); }, 120000).unref();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HOST = 'corp.test', DAY = 86400;
const dir = mkdtempSync(join(tmpdir(), 'sigelo-relay-closed-'));
let now = Date.parse('2026-10-21T00:00:00Z') / 1000;
const op = identity('closed operator'), agent = identity('closed agent'), stranger = identity('closed stranger'), other = identity('closed other operator');
const cfg = { host: HOST, db: join(dir, 'relay.db'), tcpPort: 0, httpPort: 0, loginRate: 100000, verifyBudget: 1e9, clock: () => now, diskUsed: () => 0.1, log: () => {},
  closed: [op.original], policy: (ctx) => relayPolicy(ctx, { pow: { bits: 8, loadBits: 12, loadPerHour: 1000 } }) };
const relay = await startRelay(cfg);
const base = `http://127.0.0.1:${relay.ports.http}`;
const count = (sql, ...p) => relay.db.raw.prepare(sql).get(...p).n;

const getChallenge = async (d) => (await fetch(`${base}/challenge?did=${encodeURIComponent(d)}`)).json();
const postJson = async (path, body) => { const r = await fetch(`${base}${path}`, { method: 'POST', body: JSON.stringify(body) }); return { status: r.status, json: await r.json() }; };
const mqttConnect = ({ username, clientId: cid, password: pw }) => new Promise((resolve) => {
  const c = connect({ host: '127.0.0.1', port: relay.ports.tcp, protocolVersion: 4, clean: false, clientId: cid, username, password: pw, reconnectPeriod: 0, connectTimeout: 5000 });
  c.box = [];
  c.on('message', (t, p) => c.box.push({ t, p }));
  c.once('connect', () => resolve({ client: c }));
  c.once('error', () => { c.end(true); resolve({ error: true }); });
  c.once('close', () => resolve({ error: true }));
});
// Log in as id with `bundle` (default: its chain alone); pow: solve the challenge's bits. → { client?, check }.
async function login(id, { bundle = bundleOf(id), pow = false } = {}) {
  const { challenge, pow_bits } = await getChallenge(id.did);
  const extra = pow ? { pow: solve(HOST, id.original, challenge.nonce, Math.max(pow_bits, 8)) } : {};
  const creds = { username: id.did, clientId: clientId(id), password: password(id, challenge, { bundle, extra }) };
  const r = await mqttConnect(creds);
  const c = (await postJson('/check', { username: creds.username, client_id: creds.clientId, password: creds.password })).json;
  return { ...r, check: c.ok ? 'ok' : c.check, detail: c.detail, creds };
}
const vouch = (by, sub, o = {}) => attest({ secret: by.secret, iss: by.did, sub: sub.original, iat: o.iat ?? now - 60, exp: o.exp ?? now + 30 * DAY, ctx: OPERATOR_CTX,
  admission: 'invite', admission_by: by.did, claims: { relay: o.relay ?? HOST } });
const withVouch = (id, by, att) => bundleOf(id, { attestations: [att], issuers: [by.genesis] });
const subscribe = (c, t) => new Promise((resolve) => c.subscribe(t, { qos: 1 }, (e, g) => resolve(e ? 128 : g[0].qos)));
const publish = (c, t, p) => new Promise((resolve) => c.publish(t, p, { qos: 1 }, (e) => resolve(e ?? null)));
const end = (c) => new Promise((resolve) => c.end(false, {}, resolve));
const topic = () => `m/${randomBytes(16).toString('hex')}`;
const stored = (id) => count('SELECT count(*) AS n FROM accounts WHERE account = ?', accountOf(id.original)) + count('SELECT count(*) AS n FROM pow_proofs WHERE account = ?', accountOf(id.original));

try {
  // ---- configuration
  ok(closedOperators(` ${op.original}, ${other.original},${op.original}`).join() === [op.original, other.original].join(), 'RELAY_CLOSED_OPERATOR: comma- or space-separated, duplicates dropped');
  for (const bad of ['', 'did:sigelo:nope', Array.from({ length: MAX_CLOSED + 1 }, (_, i) => identity(`many ${i}`).original).join(',')]) {
    let why = 'accepted';
    try { closedOperators(bad); } catch (e) { why = e.message; }
    ok(why.startsWith(`want 1 to ${MAX_CLOSED} original DIDs`), `RELAY_CLOSED_OPERATOR ${JSON.stringify(bad.slice(0, 24))}: refused (${why})`);
  }
  const env = { ...process.env, RELAY_HOST: HOST, RELAY_TCP_PORT: '0', RELAY_HTTP_PORT: '0', RELAY_DB: join(dir, 'env.db'), RELAY_CLOSED_OPERATOR: 'did:sigelo:nope' };
  const run = spawnSync(process.execPath, [fileURLToPath(new URL('../server.mjs', import.meta.url))], { env, encoding: 'utf8', timeout: 20000 });
  ok(run.status === 2 && run.stderr.includes('RELAY_CLOSED_OPERATOR: want 1 to'), `node server.mjs with a bad RELAY_CLOSED_OPERATOR: exit 2, named (${run.stderr.trim()})`);
  ok(CHECKS.includes('closed') && CHECKS.indexOf('closed') === CHECKS.indexOf('client_id') + 1 && CHECKS.indexOf('closed') < CHECKS.indexOf('pow'), 'auth.mjs CHECKS: closed, after client_id, before pow');

  // ---- no proof of work is asked
  const ch = await getChallenge(stranger.did);
  ok(ch.pow_bits === 0, `GET /challenge on a closed relay: pow_bits 0 (${ch.pow_bits}), M4's policy asking 8 elsewhere`);

  // ---- the operator and an identity it attests
  const o1 = await login(op);
  ok(o1.client && o1.check === 'ok', `the operator logs in as itself, no attestation, no proof of work (${o1.check}: ${o1.detail ?? ''})`);
  const a1 = await login(agent, { bundle: withVouch(agent, op, vouch(op, agent)) });
  ok(a1.client && a1.check === 'ok', `an identity carrying the operator's attestation logs in, no proof of work (${a1.check}: ${a1.detail ?? ''})`);
  const t = topic();
  ok(await subscribe(a1.client, t) === 1, 'the attested identity claims a mailbox');
  ok(await publish(o1.client, t, Buffer.from('hello')) === null, 'the operator writes to it');
  await sleep(300);
  ok(a1.client.box.some((m) => m.t === t && m.p.toString() === 'hello'), 'and it is delivered');
  ok(count('SELECT count(*) AS n FROM closed_members WHERE account = ?', accountOf(agent.original)) === 1, 'closed_members: the admitted identity, with its attestation\'s exp');
  await end(a1.client);
  // A login without a bundle while the admission holds.
  const { challenge: c2 } = await getChallenge(agent.did);
  const bare = await mqttConnect({ username: agent.did, clientId: clientId(agent), password: password(agent, c2, { bundle: false }) });
  ok(bare.client !== undefined, 'a login without a bundle, as admitted at the last, while that holds');
  bare.client && await end(bare.client);

  // ---- strangers
  const refusedClosed = async (r, what) => {
    ok(!r.client && r.check === 'closed' && r.detail.includes('this relay admits only its operators') && r.detail.includes(op.original), `${what}: refused closed, the operators named (${r.detail})`);
    r.client && await end(r.client);
  };
  await refusedClosed(await login(stranger), 'a stranger');
  await refusedClosed(await login(stranger, { pow: true }), 'a stranger with a proof of work');
  await refusedClosed(await login(stranger, { bundle: withVouch(stranger, other, vouch(other, stranger)) }), 'a stranger attested by someone else');
  await refusedClosed(await login(stranger, { bundle: withVouch(stranger, op, vouch(op, stranger, { relay: 'relay.sigelo.ai' })) }), 'a stranger attested by the operator for another relay');
  const late = await login(stranger, { bundle: withVouch(stranger, op, vouch(op, stranger, { iat: now - 3 * DAY, exp: now - DAY })) });
  await refusedClosed(late, 'an expired attestation');
  ok(late.detail.includes('does not verify'), 'an expired attestation: said not to verify');
  // An attestation naming another identity (the agent's), carried by the stranger.
  await refusedClosed(await login(stranger, { bundle: withVouch(stranger, op, vouch(op, agent)) }), 'a stranger carrying an attestation for another identity');
  ok(stored(stranger) === 0, 'nothing stored for a stranger: no account, no proof of work');
  // A stranger's CONNECT with junk credentials gets no further than before: the closed check comes after the signature.
  const { challenge: c3 } = await getChallenge(stranger.did);
  const junk = (await postJson('/check', { username: stranger.did, client_id: clientId(stranger), password: password(agent, c3) })).json;
  ok(junk.check === 'bundle' || junk.check === 'sig', `a stranger's login signed by another key: ${junk.check}, never closed (no answer about admission before the signature)`);

  // ---- the operator rotates: its old key's attestations admit nobody once it logs in again
  const op2 = rotated(op, 'closed operator 2');
  const fresh = identity('closed agent 2');
  const old = vouch(op, fresh);
  ok((await login(fresh, { bundle: withVouch(fresh, op, old) })).check === 'ok', 'before the operator\'s rotation reaches the relay: its old key admits');
  const o2 = await login(op2);
  ok(o2.client && o2.check === 'ok', 'the operator logs in after its rotation');
  await end(o2.client);
  const fresh2 = identity('closed agent 3');
  const stale = await login(fresh2, { bundle: withVouch(fresh2, op, vouch(op, fresh2)) });
  await refusedClosed(stale, 'an attestation by a key the operator rotated away from');
  ok(stale.detail.includes('current key'), 'said: not the operator\'s current key');
  const now2 = await login(fresh2, { bundle: withVouch(fresh2, op2, vouch(op2, fresh2)) });
  ok(now2.check === 'ok', `an attestation by the operator's new key admits (${now2.detail ?? ''})`);
  now2.client && await end(now2.client);

  // ---- short codes: parked by admitted identities only
  const H = (b) => createHash('sha256').update(b).digest();
  const longCode = (id) => {
    const host = Buffer.from(HOST), e = Buffer.alloc(4);
    e.writeUInt32BE(now + DAY);
    const body = Buffer.concat([Buffer.from([1]), H(canonicalize(id.genesis)), randomBytes(32), e, Buffer.from([host.length]), host]);
    return 'sgl1' + multibase(Buffer.concat([body, H(body).subarray(0, 4)])).slice(1);
  };
  const park = async (id, bundle) => {
    const { challenge } = await getChallenge(id.did);
    return postJson('/park', { username: id.did, client_id: clientId(id), password: password(id, challenge, { bundle }), code_hash: H(`sigelo-park/0K7F3Q9Z${id.label.length % 10}`).toString('hex'), invite: longCode(id), exp: now + 600 });
  };
  const ps = await park(stranger, bundleOf(stranger));
  ok(ps.status === 200 && ps.json.ok === false && ps.json.check === 'closed', `POST /park by a stranger: closed (${ps.json.check})`);
  const pa = await park(agent, withVouch(agent, op2, vouch(op2, agent)));
  ok(pa.status === 200 && pa.json.ok === true, `POST /park by an admitted identity: parked (${JSON.stringify(pa.json)})`);

  // ---- a session ends with its attestation
  const brief = identity('closed brief');
  const b1 = await login(brief, { bundle: withVouch(brief, op2, vouch(op2, brief, { exp: now + 2 })) });
  ok(b1.client && b1.check === 'ok', 'an attestation that ends in 2 s admits');
  const shut = await new Promise((resolve) => { const t0 = Date.now(); b1.client.once('close', () => resolve(Date.now() - t0)); setTimeout(() => resolve(-1), 6000); });
  ok(shut >= 0 && shut < 5000, `its session is closed when the attestation ends (${shut} ms)`);
  b1.client.end(true);

  // ---- the sweep keeps an admitted account while its attestation runs, the operator's for good
  const ACCOUNT_IDLE = 60 * DAY;
  ok(relay.closed.kept(accountOf(op.original), now + 10 * 365 * DAY), 'kept: the operator\'s account, for good');
  ok(relay.closed.kept(accountOf(agent.original), now + 29 * DAY) && !relay.closed.kept(accountOf(agent.original), now + 31 * DAY), 'kept: an admitted account while its attestation runs (30 days), not after');
  ok(!relay.closed.kept(accountOf(stranger.original), now), 'kept: nobody else');
  now += ACCOUNT_IDLE;
  relay.sweep(now);
  ok(count('SELECT count(*) AS n FROM closed_members WHERE account = ?', accountOf(agent.original)) === 0, 'the sweep drops a closed_members row once its attestation ended');
  ok(count('SELECT count(*) AS n FROM accounts WHERE account = ?', accountOf(op.original)) === 1, 'and keeps the operator\'s account, idle 60 days');
  now -= ACCOUNT_IDLE;

  // ---- GET /stats: closed, and for whom
  const sres = await fetch(`${base}/stats`), stext = await sres.text(), s = JSON.parse(stext);
  ok(s.closed?.operators?.join() === op.original && Object.keys(s.closed).join() === 'operators', `GET /stats: closed, the operator's original DID only (${JSON.stringify(s.closed)})`);
  const others = [agent, stranger, fresh, fresh2, brief, other].flatMap((id) => [id.did, id.original, accountOf(id.original), clientId(id)]).concat([op2.did, accountOf(op.original), clientId(op)]);
  ok(!others.some((x) => stext.includes(x)) && (stext.match(/did:sigelo:/g) ?? []).length === 1, 'GET /stats names no other DID, account or client id (the operator\'s current key neither)');
  ok(s.logins_refused_today.closed >= 7, `GET /stats counts the refusals by name: closed ${s.logins_refused_today.closed}`);
  await end(o1.client);
} finally {
  await relay.close();
  rmSync(dir, { recursive: true, force: true });
}
console.log(failed === 0 ? `ALL PASS (${n})` : `${failed} FAILED of ${n}`);
process.exit(failed === 0 ? 0 : 1);
