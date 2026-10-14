#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// deploy/check.mjs — the live checks of the relay after a deploy (deploy/deploy.sh runs it), from
// the outside, the way an agent meets it.
//
//   node deploy/check.mjs                         https://sigelo.ai and relay.sigelo.ai
//   node deploy/check.mjs --origin URL --relay HOST [--mqtt HOST:PORT]
//
// Checks: the front page (200, HTML) and its headers (HSTS, nosniff, a Content-Security-Policy, a
// Referrer-Policy, no cookie); /pay-monero.html (301 to /pro.html); https://<relay>/stats (200, the
// relay's counts, CORS open, cached a minute, no DID or hash); /_stats/ (401 without its password); /llms.txt (200, text); https://<relay>/relay.json (200, JSON, CORS
// open, cached an hour, the plan's first fields: design/relay-plan.md §11 "Relay info");
// https://<relay>/challenge?did=… (200, a relay-login body naming this relay, a whole pow_bits);
// MQTT over TLS on <relay>:8883 answering a CONNECT without credentials with CONNACK 4 (check
// `password`), and nothing else: 0 means the login was accepted, 3 the login rate or the relay
// itself failing (`internal`); a timeout or a closed socket is a failure too; the certificate on
// 8883 naming <relay> and nothing else (the broker parses untrusted packets: a key taken from it
// must be valid for no other name, sigelo.ai's pages included, so it holds a lineage of its
// own); and the certificate on 443 and on 8883 valid 14 more days (the broker's copy comes from
// certbot's deploy hook: a renewal that never reached it shows here). Prints PASS/FAIL lines, then ALL PASS and exit
// 0, or FAIL and exit 1. No dependencies, node >= 22. Certificates are verified as any client
// does; for a test against a self-signed relay, NODE_EXTRA_CA_CERTS=<its cert>.
import tls from 'node:tls';

const argv = process.argv.slice(2);
const opts = { '--origin': 'https://sigelo.ai', '--relay': 'relay.sigelo.ai', '--mqtt': '' };
for (let i = 0; i < argv.length; i += 2) {
  if (!(argv[i] in opts) || argv[i + 1] === undefined) { console.error(`check.mjs: unknown argument or missing value: ${argv[i]}`); process.exit(2); }
  opts[argv[i]] = argv[i + 1];
}
const ORIGIN = opts['--origin'].replace(/\/+$/, ''), RELAY = opts['--relay'];
const [MQTT_HOST, MQTT_PORT] = opts['--mqtt'] ? opts['--mqtt'].split(':') : [RELAY, '8883'];
// The DID of test-vectors.json's first vector: well-formed, public, from a documented seed. Asking a
// challenge for it costs the relay nothing it keeps (the nonce is stateless).
const PROBE_DID = 'did:sigelo:zF5FYbH5zNLX5pfd7DZUjPirXeAFzLVxrdFyCrnexdpBG';
const UA = 'sigelo-selfcheck/1 (+https://sigelo.ai/privacy)';
const DAYS = 14;

let n = 0, failed = 0;
const pass = (name) => { n++; console.log(`PASS ${name}`); };
const fail = (name, why) => { n++; failed++; console.log(`FAIL ${name}: ${why}`); };
const get = async (url) => {
  try {
    const r = await fetch(url, { redirect: 'manual', headers: { 'user-agent': UA }, signal: AbortSignal.timeout(20000) });
    return { r, body: await r.text() };
  } catch (e) { return { err: e.cause?.code ?? e.cause?.errors?.[0]?.code ?? e.message }; }
};
// name, url, test(response, body) → '' when right, else what is wrong
const check = async (name, url, test) => {
  const { r, body, err } = await get(url);
  if (err) return fail(name, err);
  if (r.status !== 200) return fail(name, `status ${r.status}`);
  let why;
  try { why = test(r, body); } catch (e) { why = e.message; }
  return why ? fail(name, why) : pass(name);
};
const type = (r) => r.headers.get('content-type') ?? '';

await check('front page', `${ORIGIN}/`, (r, b) => (!type(r).startsWith('text/html') ? `content-type ${type(r)}` : !b.includes('<h1') ? 'no <h1>' : ''));
await check('front page headers', `${ORIGIN}/`, (r) => {
  const h = (k) => r.headers.get(k);
  const missing = [];
  if (!/max-age=[1-9]/.test(h('strict-transport-security') ?? '')) missing.push('Strict-Transport-Security');
  if (h('x-content-type-options') !== 'nosniff') missing.push('X-Content-Type-Options: nosniff');
  if (!h('content-security-policy')) missing.push('Content-Security-Policy');
  if (!h('referrer-policy')) missing.push('Referrer-Policy');
  if (h('set-cookie')) missing.push('no Set-Cookie');
  return missing.length ? `missing ${missing.join(', ')}` : '';
});
// The old pay page (until 2026-10-14) answers 301 to /pro.html, so a link to it still lands (nginx.conf).
{
  const { r, err } = await get(`${ORIGIN}/pay-monero.html`), name = '/pay-monero.html 301 to /pro.html';
  if (err) fail(name, err);
  else if (r.status !== 301 || !/\/pro\.html$/.test(r.headers.get('location') ?? '')) fail(name, `status ${r.status}, location ${r.headers.get('location')}`);
  else pass(name);
}
await check('llms.txt', `${ORIGIN}/llms.txt`, (r, b) => (!type(r).startsWith('text/') ? `content-type ${type(r)}` : !b.startsWith('# ') ? 'does not start with "# "' : ''));
await check('relay.json', `https://${RELAY}/relay.json`, (r, b) => {
  if (!type(r).startsWith('application/json')) return `content-type ${type(r)}`;
  if (r.headers.get('access-control-allow-origin') !== '*') return 'Access-Control-Allow-Origin is not *';
  if (!/max-age=3600\b/.test(r.headers.get('cache-control') ?? '')) return 'Cache-Control lacks max-age=3600';
  const j = JSON.parse(b);
  const missing = ['name', 'software', 'version', 'source', 'limits'].filter((k) => j[k] === undefined);
  return missing.length ? `missing ${missing.join(', ')}` : '';
});
await check('/stats (counts only)', `https://${RELAY}/stats`, (r, b) => {
  if (!type(r).startsWith('application/json')) return `content-type ${type(r)}`;
  if (r.headers.get('access-control-allow-origin') !== '*') return 'Access-Control-Allow-Origin is not *';
  if (!/max-age=60\b/.test(r.headers.get('cache-control') ?? '')) return 'Cache-Control lacks max-age=60';
  const j = JSON.parse(b);
  if (j.v !== 'sigelo-relay-stats/0' || !Number.isSafeInteger(j.identities?.total)) return 'not the relay\'s counts (v sigelo-relay-stats/0)';
  return /did:sigelo:|[0-9a-f]{24}/.test(b) ? 'names a DID or a hash' : '';
});
// The visit statistics are behind basic auth: 401 without credentials, and nothing of them shown.
{
  const { r, body, err } = await get(`${ORIGIN}/_stats/`), name = '/_stats/ 401 without a password (basic auth)';
  if (err) fail(name, err);
  else if (r.status !== 401 || !/^Basic /i.test(r.headers.get('www-authenticate') ?? '') || /goaccess|sigelo relay: counts/i.test(body)) fail(name, `status ${r.status}, WWW-Authenticate ${r.headers.get('www-authenticate')}`);
  else pass(name);
}
await check('/challenge', `https://${RELAY}/challenge?did=${PROBE_DID}`, (r, b) => {
  const j = JSON.parse(b), c = j.challenge ?? {};
  if (c.typ !== 'relay-login') return `challenge.typ ${JSON.stringify(c.typ)}, want "relay-login"`;
  if (c.relay !== RELAY) return `challenge.relay ${JSON.stringify(c.relay)}, want "${RELAY}" (RELAY_HOST)`;
  if (c.did !== PROBE_DID) return 'challenge.did is not the DID asked for';
  return Number.isInteger(j.pow_bits) ? '' : 'pow_bits is not a whole number';
});

// An MQTT 3.1.1 CONNECT with no username or password: client id "sigelo-check", clean session,
// keepalive 60 s. The relay must refuse it with CONNACK 4 (check `password`: no username). Any
// other answer fails: the one check that sees from outside whether login still holds.
const CONNECT = Buffer.from([0x10, 24, 0, 4, 0x4d, 0x51, 0x54, 0x54, 4, 0x02, 0, 60, 0, 12, ...Buffer.from('sigelo-check')]);
const tlsProbe = (host, port, mqtt) => new Promise((resolve) => {
  let got = Buffer.alloc(0), days, san;
  const done = (v) => { s.destroy(); resolve({ days, san, ...v }); };
  const s = tls.connect({ host, port: Number(port), servername: host, timeout: 20000 }, () => {
    const c = s.getPeerCertificate();
    days = (Date.parse(c.valid_to) - Date.now()) / 86400e3;
    san = c.subjectaltname ?? '';
    if (!mqtt) return done({});
    s.write(CONNECT);
  });
  s.on('data', (d) => {
    got = Buffer.concat([got, d]);
    if (got.length < 4) return;
    done(got[0] === 0x20 && got[1] === 2 ? { connack: got[3] } : { err: `not a CONNACK: ${got.subarray(0, 4).toString('hex')}` });
  });
  s.on('timeout', () => done({ err: 'timeout' }));
  s.on('error', (e) => done({ err: e.code ?? e.message }));
  s.on('close', () => done({ err: 'closed before a CONNACK' }));
});

const m = await tlsProbe(MQTT_HOST, MQTT_PORT, true), mqttName = `MQTT CONNECT on ${MQTT_HOST}:${MQTT_PORT}`;
if (m.err) fail(mqttName, m.err);
else if (m.connack === 4) pass(`${mqttName} (CONNACK 4: a login without credentials refused, check password)`);
else if (m.connack === 0) fail(mqttName, 'CONNACK 0: the broker accepted a login without credentials');
else if (m.connack === 3) fail(mqttName, 'CONNACK 3: the login rate (check rate) or the relay itself failing (check internal); want 4');
else fail(mqttName, `CONNACK ${m.connack}, want 4 (a login without credentials refused, check password)`);
const brokerName = `certificate ${MQTT_HOST}:${MQTT_PORT} names ${RELAY} alone`;
if (m.san === undefined) fail(brokerName, m.err ?? 'no certificate');
else if (m.san !== `DNS:${RELAY}`) fail(brokerName, `it names ${JSON.stringify(m.san)}: the broker must hold a lineage of its own, for ${RELAY} alone (site/deploy/server-setup.sh --relay, R9)`);
else pass(brokerName);
const o = new URL(ORIGIN), webPort = o.port || 443;
const web = await tlsProbe(o.hostname, webPort, false);
for (const [name, p] of [[`certificate ${o.hostname}:${webPort}`, web], [`certificate ${MQTT_HOST}:${MQTT_PORT}`, m]]) {
  if (p.days === undefined) fail(name, p.err ?? 'no certificate');
  else if (p.days < DAYS) fail(name, `expires in ${p.days.toFixed(1)} days (renewal or its deploy hook failing)`);
  else pass(`${name} (${Math.floor(p.days)} days left)`);
}

console.log(failed ? `FAIL (${failed} of ${n})` : `ALL PASS (${n})`);
process.exit(failed ? 1 : 0);
