#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// relay/test/load.mjs — N clients (default 2,000) log in to a relay on loopback and stay connected:
// login rate, login latency, the relay's CPU per login and its memory per connection
// (design/relay-plan.md §4 "First VPS size", §7 M3). The relay runs in a child process, so its
// numbers are its own; the clients share this process. --tls: over the TLS listener (a
// self-signed certificate made per run), as production runs. Results: deploy/README.md.
//   node relay/test/load.mjs [N] [concurrency] [--tls]
import { fork } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect } from 'mqtt';
import { clientId, identity, password, selfSigned } from './fixtures.mjs';

if (process.argv[2] === '--serve') {
  // The relay under test: real clock, a disk gauge pinned at 0 (only logins are measured here),
  // no rate limit, budget or session cap (every client comes from one address).
  const { startRelay } = await import('../server.mjs');
  const [, db, mode] = process.argv.slice(2);
  const listener = { tcpPort: 0 };
  if (mode === 'tls') {
    const { cert, key } = selfSigned('relay.test');
    const certFile = join(dirname(db), 'tls.crt'), keyFile = join(dirname(db), 'tls.key');
    writeFileSync(certFile, cert);
    writeFileSync(keyFile, key, { mode: 0o600 });
    Object.assign(listener, { tcpPort: undefined, tlsCert: certFile, tlsKey: keyFile, tlsPort: 0 });
  }
  const relay = await startRelay({ host: 'relay.test', db, ...listener, httpPort: 0, loginRate: 1e9, verifyBudget: 1e9, maxSessions: 1e9, maxPerPrefix: 1e9, diskUsed: () => 0, log: () => {} });
  process.on('message', (m) => {
    if (m === 'stats') { globalThis.gc(); process.send({ mem: process.memoryUsage(), cpu: process.cpuUsage(), clients: relay.broker.connectedClients }); }
    if (m === 'stop') relay.close().then(() => process.exit(0));
  });
  process.send({ ports: relay.ports });
} else {
  const tls = process.argv.includes('--tls');
  const [N = 2000, CONCURRENCY = 50] = process.argv.slice(2).filter((a) => a !== '--tls').map(Number);
  const dir = mkdtempSync(join(tmpdir(), 'sigelo-relay-load-'));
  const child = fork(fileURLToPath(import.meta.url), ['--serve', join(dir, 'relay.db'), tls ? 'tls' : 'tcp'], { execArgv: ['--expose-gc'] });
  const next = () => new Promise((resolve) => child.once('message', resolve));
  const { ports } = await next();
  const stats = async () => { child.send('stats'); return next(); };

  let t = performance.now();
  const ids = Array.from({ length: N }, (_, i) => identity(`load ${i}`));
  console.log(`${N} fixture identities in ${((performance.now() - t) / 1000).toFixed(1)} s (not counted)`);

  const before = await stats();
  const clients = [], latency = [];
  let refused = 0;
  async function login(id) {
    const t0 = performance.now();
    const { challenge } = await (await fetch(`http://127.0.0.1:${ports.http}/challenge?did=${encodeURIComponent(id.did)}`)).json();
    const c = await new Promise((resolve) => {
      const c = connect({ host: '127.0.0.1', ...(tls ? { protocol: 'mqtts', port: ports.tls, rejectUnauthorized: false } : { port: ports.tcp }),
        protocolVersion: 4, clean: false, clientId: clientId(id), username: id.did, password: password(id, challenge), reconnectPeriod: 0, connectTimeout: 60000 });
      c.once('connect', () => resolve(c));
      c.once('error', () => { c.end(true); resolve(null); });
    });
    if (!c) { refused++; return; }
    latency.push(performance.now() - t0);
    clients.push(c);
  }
  t = performance.now();
  let i = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => { while (i < N) await login(ids[i++]); }));
  const seconds = (performance.now() - t) / 1000;
  const after = await stats();

  latency.sort((x, y) => x - y);
  const pct = (p) => latency[Math.min(latency.length - 1, Math.floor(latency.length * p))].toFixed(0);
  const mb = (b) => (b / 1048576).toFixed(1);
  const cpuMs = (after.cpu.user + after.cpu.system - before.cpu.user - before.cpu.system) / 1000;
  console.log(`${tls ? 'TLS' : 'plain TCP'}: connected ${after.clients} of ${N} (${refused} refused), concurrency ${CONCURRENCY}`);
  console.log(`logins: ${(N / seconds).toFixed(0)}/s wall clock over ${seconds.toFixed(1)} s; latency p50 ${pct(0.5)} ms, p95 ${pct(0.95)} ms, max ${pct(1)} ms`);
  console.log(`relay CPU: ${(cpuMs / N).toFixed(2)} ms per login (${(1000 / (cpuMs / N)).toFixed(0)} logins/s per core)`);
  console.log(`relay memory after gc: rss ${mb(before.mem.rss)} → ${mb(after.mem.rss)} MB, heap ${mb(before.mem.heapUsed)} → ${mb(after.mem.heapUsed)} MB: ${((after.mem.rss - before.mem.rss) / N / 1024).toFixed(1)} KB rss per connection`);
  for (const c of clients) c.end(true);
  child.send('stop');
  await new Promise((resolve) => child.once('exit', resolve));
  rmSync(dir, { recursive: true, force: true });
  process.exit(after.clients === N && refused === 0 ? 0 : 1);
}
