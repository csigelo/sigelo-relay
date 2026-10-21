#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// relay/server.mjs — the sigelo relay: an MQTT 3.1.1 broker (Aedes) where agents log in with their
// sigelo identity (auth.mjs) and keep private pairwise mailboxes with store-and-forward
// (mailbox.mjs), in one SQLite file (db.mjs). design/relay-plan.md §3, §4. Deploy: deploy/README.md.
//
//   node server.mjs      serve, configured by the environment:
//     RELAY_HOST        the relay's public name: the login body's `relay` (required)
//     RELAY_DB          SQLite file (default /var/lib/sigelo-relay/relay.db)
//     RELAY_TLS_CERT, RELAY_TLS_KEY   PEM paths: MQTT over TLS on RELAY_TLS_PORT (default 8883),
//                       all interfaces; SIGHUP re-reads both files (certbot's deploy hook)
//     RELAY_TCP_PORT    plain MQTT on 127.0.0.1 only (tests; unset = off)
//     RELAY_HTTP_PORT   GET /challenge, POST /check, POST /park and GET /park/<hash> (short
//                       invite codes: park.mjs), POST /licence, POST /gift (gift codes:
//                       gifts.mjs), GET /stats (counts only: stats.mjs) and MQTT over WebSocket
//                       (an upgrade at /mqtt, subprotocol mqtt) on 127.0.0.1 for nginx (default
//                       8791). Each takes the client's address from X-Real-IP, believed from
//                       loopback only (auth.mjs clientAddress)
//     RELAY_LOGIN_RATE  CONNECTs and POST /check together, per minute per /24 (IPv4) or /48 (IPv6)
//                       (default 30); GET /challenge separately at the same number. HTTP calls
//                       are counted by nginx's X-Real-IP
//     RELAY_MAX_SESSIONS   sessions connected at once (default 16000: ~2 GB over TLS)
//     RELAY_MAX_PER_PREFIX sessions connected at once per /24 or /48 (default 1000)
//     RELAY_VENDOR_DID, RELAY_PRO_STORAGE_MB, RELAY_POW_BITS, RELAY_POW_LOAD_BITS, RELAY_POW_LOAD,
//     RELAY_POW_NETWORK_DAY, RELAY_FREE_QUEUE_MB   allowances, proof of work and licences:
//                       allowance.mjs relayPolicyFromEnv
//     RELAY_CLOSED_OPERATOR  a closed relay: the original DIDs of its operators, comma-separated
//                       (at most 8). It admits them and the identities they attest for it, and
//                       nobody else (closed.mjs); unset = open
//
// Logged: logins, refusals by check name, disconnects, each with the address cut to /24 or /48.
// Never a DID, a client id, a topic or a payload.
import { Aedes } from 'aedes';
import { createServer as tcpServer } from 'node:net';
import { createServer as tlsServer } from 'node:tls';
import { readFileSync, realpathSync, statfsSync } from 'node:fs';
import { dirname } from 'node:path';
import { Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, createWebSocketStream } from 'ws';
import { auth, clientAddress, MAX_BODY, MAX_PER_PREFIX, MAX_SESSIONS, UNPROVEN_SECONDS, WS_PATH, WS_PROTOCOL, prefixOf } from './auth.mjs';
import { openDb } from './db.mjs';
import { mailboxes, MAX_TOPICS } from './mailbox.mjs';
import { relayPolicyFromEnv } from './allowance.mjs';   // M4: allowances, proof of work, licences
import { relayStats } from './stats.mjs';
import { parking } from './park.mjs';
import { closedOperators, closedRelay } from './closed.mjs';

export { WS_PATH, prefixOf };

export const FULL = 0.70;
// The CONNECT is capped at the HTTP body limit (its password carries the bundle); a later packet
// at the largest message any tier allows (plan §3: 1 MB) plus its header, so a free identity's
// 300 KB message gets a too_large notice rather than a closed connection. A SUBSCRIBE or
// UNSUBSCRIBE holds at most MAX_TOPICS topics of the longest kind the relay admits (packet id,
// then per topic a 2-byte length, 34 bytes of m/ or i/ name, a QoS byte): each topic is a
// transaction, so one packet must not carry thousands.
export const MAX_CONNECT = MAX_BODY, MAX_FRAME = 1024 * 1024 + 1024, MAX_SUBSCRIBE = 2 + MAX_TOPICS * (2 + 34 + 1);
// A packet the parser holds unfinished is memory a session holds: up to MAX_FRAME, for nothing,
// and logging in costs no work. 200 sessions each leaving a 1 MB PUBLISH unfinished took the
// relay from 108 to 381 MB and kept it there; at the session caps that passed the unit's
// MemoryMax=3G, and the kill dropped every client. So:
//   - between the CONNECT and its CONNACK a packet is held to MAX_EARLY: a correct client waits for
//     the CONNACK, and a session of 1 MB frames is had only by logging in;
//   - a packet must be whole FRAME_MS after its first byte, or the connection is closed. A client's
//     own wait for its PUBACK is shorter (contact/carrier.mjs ACK_MS, 15 s), so a correct client
//     never gets there; a session that does must log in again to hold anything more, and logins
//     are counted per network (auth.mjs);
//   - the bytes of packets announced and unfinished, as they arrive (what the parser buffers), may
//     come to PARTIAL_PER_PREFIX per /24 or /48 and PARTIAL_MAX in all: past either, the connection
//     whose packet would pass it is closed. Packets before the CONNACK draw on a pool of their own,
//     EARLY_PER_PREFIX and EARLY_MAX, so sockets that never log in cannot take a logged-in
//     session's room, nor sessions a login's. Counted by the length a packet announced, a socket
//     that sent 4 bytes held 256 KB: 1,024 of them from 8 networks, about 4 KB in all, filled the
//     budget and every CONNECT on the relay was closed before its CONNACK;
//   - a CONNECT must carry a keepalive of 1 to KEEPALIVE_MAX seconds (Aedes keepaliveLimit; 0
//     never times out): a session that sends nothing for 1.5 times it is closed.
export const MAX_EARLY = MAX_SUBSCRIBE, FRAME_MS = 20000, PARTIAL_PER_PREFIX = 32 * 1024 * 1024, PARTIAL_MAX = 224 * 1024 * 1024, KEEPALIVE_MAX = 600;
export const EARLY_PER_PREFIX = 2 * 1024 * 1024, EARLY_MAX = 32 * 1024 * 1024;
// Live delivery must not let one reader hold up everyone else's. Aedes completes a delivery only
// once the reader's socket has taken it ('drain'), and its emitter (mqemitter) counts a publish in
// flight until every delivery of it completes: with its default of 100 in flight and a 60 s drain
// timeout, 100 deliveries to a reader that stopped reading held live delivery for every client for
// a minute. So: no limit on publishes in flight (concurrency 0: a stalled delivery holds a slot of
// no one else's); a reader with more than MAX_BACKLOG bytes not yet sent is not reading: nothing
// more is written to it and it is closed (what it missed is in the database, and goes in order at
// its next connection); a reader whose socket takes nothing for DRAIN_MS is closed by Aedes.
// DRAIN_MS stays under a client's wait for its PUBACK (contact/carrier.mjs ACK_MS, 15 s): the
// writer's PUBACK waits for the delivery too.
export const MAX_BACKLOG = 1024 * 1024, DRAIN_MS = 10000;
const SUBSCRIBE = 8, UNSUBSCRIBE = 10;
// MQTT over WebSocket (clients whose network lets only HTTPS out, on 443; nginx passes the upgrade
// on). A WebSocket frame is held whole before its bytes reach Capped, so it is capped first: at the
// largest packet frameCheck lets through, its fixed header (1 type byte, 4 length bytes) included,
// and before the CONNACK at the largest CONNECT. MQTT.js writes one packet per frame. Its unfinished
// bytes draw on the same budgets, with the same deadline, as an unfinished packet's (wsFrameCheck).
// Not ws's default of 100 MiB, and no compression (a small frame must not inflate).
export const MAX_WS_FRAME = MAX_FRAME + 5, MAX_WS_EARLY = MAX_CONNECT + 5;

// The bytes held of packets not yet whole, per prefix and in all (the header above). reserve →
// true when they fit; release gives them back.
function partials(perPrefix, max) {
  const by = new Map();
  let total = 0;
  return {
    reserve(prefix, n) {
      const mine = by.get(prefix) ?? 0;
      if (mine + n > perPrefix || total + n > max) return false;
      by.set(prefix, mine + n); total += n;
      return true;
    },
    release(prefix, n) {
      const left = (by.get(prefix) ?? 0) - n;
      if (left > 0) by.set(prefix, left); else by.delete(prefix);
      total -= n;
    },
    get total() { return total; },
  };
}

// The MQTT parser buffers a whole packet before anyone sees it, and a packet may claim 256 MB:
// before login, too. frameCheck() reads only the fixed headers (type byte, then 1–4 length bytes of
// 7 bits each, high bit = more) of the bytes in order. cap(type, first) → the most that packet may
// hold; begin() when a packet with a body is announced; grow(n) → why the next n bytes of its body
// may not be held (or null); end() when its last byte is read. → null, or why the connection must
// close.
function frameCheck(cap, begin, grow, end) {
  let state = 'type', type = 0, len = 0, mul = 1, left = 0, first = true;
  return (chunk) => {
    for (let i = 0; i < chunk.length;) {
      if (state === 'body') {
        const n = Math.min(left, chunk.length - i), why = grow(n);
        if (why) return why;
        left -= n; i += n;
        if (left === 0) { state = 'type'; end(); }
        continue;
      }
      if (state === 'type') { state = 'length'; type = chunk[i] >> 4; len = 0; mul = 1; i++; continue; }
      const b = chunk[i++];
      len += (b & 127) * mul; mul *= 128;
      if (len > cap(type, first)) return 'packet over its size cap';
      if (b & 128) { if (mul > 128 ** 3) return 'packet length over 4 bytes'; continue; }
      first = false; left = len; state = left > 0 ? 'body' : 'type';
      if (left > 0) begin();
    }
    return null;
  };
}

// The WebSocket frames (RFC 6455 §5.2) in the raw bytes of an upgraded socket, as frameCheck reads
// packets: 2 header bytes, a 16- or 64-bit length when the 7-bit one says 126 or 127, a 4-byte mask
// when the mask bit is set, then the payload. cap() → the most a frame may hold now; begin, grow,
// end as frameCheck's. → null, or why the connection must close.
function wsFrameCheck(cap, begin, grow, end) {
  let head = [], need = 2, left = 0;
  return (chunk) => {
    for (let i = 0; i < chunk.length;) {
      if (left > 0) {
        const n = Math.min(left, chunk.length - i), why = grow(n);
        if (why) return why;
        left -= n; i += n;
        if (left === 0) end();
        continue;
      }
      head.push(chunk[i++]);
      if (head.length === 2) need = 2 + ((head[1] & 127) === 126 ? 2 : (head[1] & 127) === 127 ? 8 : 0) + (head[1] & 128 ? 4 : 0);
      if (head.length < need) continue;
      const l7 = head[1] & 127, len = l7 < 126 ? l7 : head.slice(2, l7 === 126 ? 4 : 10).reduce((a, b) => a * 256 + b, 0);
      head = []; need = 2;
      if (len > cap()) return 'WebSocket frame over its size cap';
      left = len;
      if (left > 0) begin();
    }
    return null;
  };
}

// One unfinished unit at a time of connection c (a packet, or a WebSocket frame) against the
// budgets: begin() when one is announced (its pool: held once logged in, else early; its deadline),
// grow(n) → why the next n bytes of it may not be held (or null), done() when it is whole or the
// connection ends.
function holding(c, { held, early, prefix, frameMs }) {
  let pool = null, open = 0, timer = null;
  const done = () => { clearTimeout(timer); timer = null; if (open > 0) pool.release(prefix, open); open = 0; pool = null; };
  return {
    begin() {
      pool = c.loggedIn ? held : early;
      timer = setTimeout(() => c.destroy(Object.assign(new Error('a packet not whole in time'), { check: 'slow_packet' })), frameMs);
    },
    grow(n) {
      if (!pool.reserve(prefix, n)) return 'packets left unfinished over the budget';
      open += n;
      return null;
    },
    done,
  };
}

// What Aedes reads and writes instead of the socket: the socket's bytes, each checked by
// frameCheck() before the parser sees it. destroy() closes the socket, as on a bare socket.
// held, early: the shared budgets of unfinished packets (partials), after and before the CONNACK;
// prefix: this socket's /24 or /48. loggedIn is set by server.mjs once the CONNECT is admitted.
// raw: for MQTT over WebSocket, sock is the stream of messages (createWebSocketStream) and raw the
// upgraded socket under it, whose frames are checked as they arrive (wsFrameCheck).
class Capped extends Duplex {
  constructor(sock, { held, early, prefix, frameMs, raw }) {
    super();
    this.sock = sock; this.raw = raw; this.loggedIn = false;
    const packet = holding(this, { held, early, prefix, frameMs }), frame = raw ? holding(this, { held, early, prefix, frameMs }) : null;
    this.done = () => { packet.done(); frame?.done(); };
    const check = frameCheck(
      (type, first) => (first ? MAX_CONNECT : type === SUBSCRIBE || type === UNSUBSCRIBE ? MAX_SUBSCRIBE : this.loggedIn ? MAX_FRAME : MAX_EARLY),
      packet.begin, packet.grow, packet.done);
    if (raw) {
      const frames = wsFrameCheck(() => (this.loggedIn ? MAX_WS_FRAME : MAX_WS_EARLY), frame.begin, frame.grow, frame.done);
      raw.on('data', (chunk) => {
        const why = frames(chunk);
        if (why) this.destroy(Object.assign(new Error(why), { check: 'size' }));
      });
    }
    sock.on('data', (chunk) => {
      const why = check(chunk);
      if (why) return this.destroy(Object.assign(new Error(why), { check: 'size' }));
      if (!this.push(chunk)) sock.pause();
    });
    sock.on('end', () => this.push(null));
    sock.on('error', (e) => this.destroy(Object.assign(e, { check: 'socket' })));
    sock.on('close', () => this.destroy());
  }
  _read() { this.sock.resume(); }
  // Bytes written to this connection and not yet taken by the network: this stream's buffer and
  // the socket's own.
  get backlog() { return this.writableLength + this.sock.writableLength + (this.raw?.writableLength ?? 0); }
  _write(chunk, encoding, cb) { this.sock.write(chunk, cb); }
  _final(cb) { this.sock.end(cb); }
  _destroy(err, cb) { this.done(); this.sock.destroy(); this.raw?.destroy(); cb(err); }
}

// statfs → the share in use, as df computes it (review finding, 2026-10-17; allowance.mjs freeQueueOf agrees).
export const diskUse = ({ blocks, bfree, bavail }) => { const used = blocks - bfree; return used / (used + bavail) || 0; };

const diskUsage = (dir, log) => {
  let at = 0, used = 0;
  return () => {
    if (Date.now() - at > 5000) {
      // Unreadable disk statistics count as full: refuse new work rather than fill a disk blind.
      // Use as df reports it: used / (used + available). blocks - bavail would count the blocks
      // ext4 reserves for root (5 % by default) as used, and reach 70 % at 65 % real use.
      try { used = diskUse(statfsSync(dir)); } catch { used = 1; log('disk statistics unreadable: treated as full'); }
      at = Date.now();
    }
    return used;
  };
};

// cfg: { host, db, tlsCert?, tlsKey?, tlsPort?, tcpPort?, httpPort, loginRate, verifyBudget?,
// maxSessions?, maxPerPrefix?, unprovenSeconds?, frameMs?, partialPerPrefix?, partialMax?,
// earlyPerPrefix?, earlyMax?, clock?, diskUsed?, log?, policy?, closed? (operators' original DIDs:
// a closed relay, closed.mjs) }. Ports may be 0 (any). → the
// running relay; close() stops it.
export async function startRelay(cfg) {
  if (typeof cfg.host !== 'string' || cfg.host === '') throw new Error('host: the relay\'s public name (the login body\'s relay)');
  if (!Number.isInteger(cfg.loginRate) || cfg.loginRate < 1) throw new Error('loginRate: logins per minute per /24 or /48, at least 1');
  for (const k of ['maxSessions', 'maxPerPrefix']) if (cfg[k] !== undefined && (!Number.isSafeInteger(cfg[k]) || cfg[k] < 1)) throw new Error(`${k}: sessions connected at once, at least 1`);
  for (const k of ['unprovenSeconds', 'frameMs', 'partialPerPrefix', 'partialMax', 'earlyPerPrefix', 'earlyMax']) if (cfg[k] !== undefined && (!Number.isSafeInteger(cfg[k]) || cfg[k] < 1)) throw new Error(`${k}: a whole number, at least 1`);
  const log = cfg.log ?? ((line) => console.log(line));
  const clock = cfg.clock ?? (() => Math.floor(Date.now() / 1000));
  const db = openDb(cfg.db);
  const diskUsed = cfg.diskUsed ?? diskUsage(dirname(cfg.db), log);
  const diskFull = () => diskUsed() >= FULL;
  const policy = typeof cfg.policy === 'function' ? cfg.policy({ db, host: cfg.host, clock, log }) : cfg.policy ?? {};   // M4: a factory gets the db
  let broker, a;
  const closed = cfg.closed ? closedRelay({ db, host: cfg.host, operators: cfg.closed }) : null;
  // GET /stats: counts only (stats.mjs), and a closed relay's operators; sessions read from auth once it exists.
  const stats = relayStats({ db, clock, sessions: () => a?.sessions() ?? 0, policy, closed: closed?.operators ?? null });
  // Short invite codes, in memory only (park.mjs); cfg.park: its limits, for tests.
  const park = parking({ host: cfg.host, clock, ...cfg.park });
  a = auth({ db, host: cfg.host, clock, diskFull, loginRate: cfg.loginRate, verifyBudget: cfg.verifyBudget, maxSessions: cfg.maxSessions, maxPerPrefix: cfg.maxPerPrefix,
    unprovenSeconds: cfg.unprovenSeconds ?? UNPROVEN_SECONDS, policy, log, stats, park, closed });
  const held = partials(cfg.partialPerPrefix ?? PARTIAL_PER_PREFIX, cfg.partialMax ?? PARTIAL_MAX), frameMs = cfg.frameMs ?? FRAME_MS;
  const early = partials(cfg.earlyPerPrefix ?? EARLY_PER_PREFIX, cfg.earlyMax ?? EARLY_MAX);
  const m = mailboxes({ db, clock, diskFull, sessionOf: a.sessionOf, online: (id) => broker.clients[id] !== undefined, policy, stats, members: closed });
  // Every delivery: first the reader's order (mailbox.mjs forward: a live publish waits while the
  // queue goes out). Then a reader past MAX_BACKLOG: this delivery is not written (forwarding null
  // never deletes it: mailbox.mjs deletes on a PUBACK only), and the reader is closed once Aedes is
  // out of its delivery code.
  const cutting = new WeakSet();
  const authorizeForward = (client, packet) => {
    if (m.forward(client, packet) === null) return null;
    if (!(client.conn?.backlog > MAX_BACKLOG)) return packet;
    if (!cutting.has(client)) {
      cutting.add(client);
      log(`error ${a.prefixOf(client)} slow_reader`);
      setImmediate(() => client.close());
    }
    return null;
  };
  broker = await Aedes.createBroker({
    persistence: m.persistence,
    // Once admitted, the session may send packets up to MAX_FRAME (Capped).
    authenticate: (client, username, password, cb) => a.authenticate(client, username, password, (err, ok) => { if (ok && client.conn) client.conn.loggedIn = true; cb(err, ok); }),
    authorizePublish: m.authorizePublish,
    authorizeSubscribe: m.authorizeSubscribe,
    authorizeForward,
    connectTimeout: 10000,
    concurrency: 0,
    drainTimeout: DRAIN_MS,
    keepaliveLimit: KEEPALIVE_MAX,
  });
  policy.attach?.({ broker, notify: m.notify, sessionOf: a.sessionOf });   // M4: a login's operator/licence notice
  broker.on('clientDisconnect', (client) => log(`disconnect ${a.prefixOf(client)}`));
  const onError = (client, err) => { if (!err.login) log(`error ${a.prefixOf(client)} ${err.check ?? 'protocol'}`); };
  broker.on('clientError', onError);
  broker.on('connectionError', onError);

  // A connection's bytes (sock), its client's address, and for MQTT over WebSocket the upgraded
  // socket under the stream (raw).
  const onStream = (sock, address, raw) => {
    // No Nagle delay on small acknowledgements; TCP keepalive finds a peer that vanished without a
    // FIN even when its MQTT keepalive is 0.
    const net = raw ?? sock;
    net.setNoDelay(true);
    net.setKeepAlive(true, 60000);
    const prefix = prefixOf(address);
    const client = broker.handle(new Capped(sock, { held, early, prefix, frameMs, raw }));
    a.attach(client, prefix);
    net.once('close', () => a.detach(client));   // every socket closes, whatever ended it: the session caps count down
  };
  const onSocket = (sock) => onStream(sock, sock.remoteAddress);
  const listen = (server, port, host) => new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolve(server.address().port); });
  });

  const ports = {};
  const http = a.http;
  // MQTT over WebSocket on the HTTP port: an upgrade at WS_PATH asking for subprotocol mqtt, else
  // 400 and closed. The address is auth.mjs clientAddress's, as for /challenge and /check: nginx
  // connects from loopback, so without X-Real-IP every client would be one network.
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_FRAME, perMessageDeflate: false, handleProtocols: () => WS_PROTOCOL });
  http.on('upgrade', (req, sock, head) => {
    let path = null;
    try { path = new URL(req.url, 'http://relay').pathname; } catch {}
    const asked = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map((p) => p.trim());
    if (path !== WS_PATH || !asked.includes(WS_PROTOCOL) || String(req.headers.upgrade).toLowerCase() !== 'websocket') {
      sock.on('error', () => {});
      return sock.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    }
    const address = clientAddress(req);
    wss.handleUpgrade(req, sock, head, (ws) => {
      ws.on('error', () => {});   // a frame over maxPayload, a protocol error: the close follows
      onStream(createWebSocketStream(ws), address, sock);
    });
  });
  ports.http = await listen(http, cfg.httpPort, '127.0.0.1');
  let tcp, tls, reloadTls = () => {};
  if (cfg.tcpPort !== undefined) { tcp = tcpServer(onSocket); ports.tcp = await listen(tcp, cfg.tcpPort, '127.0.0.1'); }
  if (cfg.tlsCert) {
    const context = () => ({ cert: readFileSync(cfg.tlsCert), key: readFileSync(cfg.tlsKey) });
    tls = tlsServer({ ...context(), minVersion: 'TLSv1.2', handshakeTimeout: 10000 }, onSocket);
    ports.tls = await listen(tls, cfg.tlsPort ?? 8883);
    // A renewed certificate, without dropping a connection: new handshakes get it, open ones keep
    // theirs. A pair that fails to load leaves the old one in place.
    reloadTls = () => {
      try { tls.setSecureContext(context()); log('tls reloaded'); } catch (e) { log(`tls reload failed, old certificate kept: ${e.code ?? e.name}`); }
    };
  }

  const sweep = (now) => {
    park.sweep(now ?? clock());
    const r = m.sweep(now);
    if (r.expired || r.invites || r.idle || r.accounts) log(`sweep expired=${r.expired} invites=${r.invites} idle=${r.idle} accounts=${r.accounts}`);
    return r;
  };
  // A failed sweep is retried at the next tick; it must not end the process mid-delivery.
  const timer = setInterval(() => { try { sweep(); } catch (e) { log(`sweep failed: ${e.code ?? e.name}`); } }, 60000);
  timer.unref();

  const closeServer = (s) => new Promise((resolve) => (s ? s.close(() => resolve()) : resolve()));
  async function close() {
    clearInterval(timer);
    const stopped = Promise.all([closeServer(tcp), closeServer(tls)]);
    await new Promise((resolve) => broker.close(resolve));
    for (const ws of wss.clients) ws.terminate();
    http.closeAllConnections();
    await Promise.all([stopped, closeServer(http)]);
    m.close();
    db.close();
  }
  return { broker, db, auth: a, mailboxes: m, park, stats, closed, sweep, ports, reloadTls, close, partial: () => held.total, early: () => early.total };
}

function fromEnv(env) {
  const die = (why) => { console.error(`sigelo-relay: ${why}`); process.exit(2); };
  const port = (name, def) => {
    const v = env[name] ?? def;
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!/^\d+$/.test(String(v)) || n > 65535) die(`${name}: want a port number, got ${JSON.stringify(v)}`);
    return n;
  };
  if (!env.RELAY_HOST || !/^[a-z0-9.-]+(:\d+)?$/.test(env.RELAY_HOST)) die('RELAY_HOST: the relay\'s public name, e.g. relay.example.org');
  if (!env.RELAY_TLS_CERT !== !env.RELAY_TLS_KEY) die('RELAY_TLS_CERT and RELAY_TLS_KEY: set both or neither');
  const cfg = {
    host: env.RELAY_HOST, db: env.RELAY_DB || '/var/lib/sigelo-relay/relay.db',
    tlsCert: env.RELAY_TLS_CERT, tlsKey: env.RELAY_TLS_KEY, tlsPort: port('RELAY_TLS_PORT', '8883'),
    tcpPort: port('RELAY_TCP_PORT'), httpPort: port('RELAY_HTTP_PORT', '8791'),
    loginRate: Number(env.RELAY_LOGIN_RATE ?? 30),
    maxSessions: Number(env.RELAY_MAX_SESSIONS ?? MAX_SESSIONS), maxPerPrefix: Number(env.RELAY_MAX_PER_PREFIX ?? MAX_PER_PREFIX),
    policy: relayPolicyFromEnv(env, die),   // M4: RELAY_VENDOR_DID, RELAY_PRO_STORAGE_MB, RELAY_POW_* (allowance.mjs)
  };
  if (!Number.isInteger(cfg.loginRate) || cfg.loginRate < 1) die('RELAY_LOGIN_RATE: want a whole number of logins per minute, at least 1');
  for (const [k, name] of [['maxSessions', 'RELAY_MAX_SESSIONS'], ['maxPerPrefix', 'RELAY_MAX_PER_PREFIX']]) {
    if (!Number.isSafeInteger(cfg[k]) || cfg[k] < 1) die(`${name}: want a whole number of sessions, at least 1`);
  }
  if (env.RELAY_CLOSED_OPERATOR !== undefined && env.RELAY_CLOSED_OPERATOR !== '') {
    try { cfg.closed = closedOperators(env.RELAY_CLOSED_OPERATOR); } catch (e) { die(`RELAY_CLOSED_OPERATOR: ${e.message}`); }
  }
  if (!cfg.tlsCert && cfg.tcpPort === undefined) die('no MQTT listener: set RELAY_TLS_CERT and RELAY_TLS_KEY (or RELAY_TCP_PORT, loopback, for tests)');
  return cfg;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const relay = await startRelay(fromEnv(process.env));
  const p = relay.ports;
  console.log(`sigelo relay: mqtt ${p.tls ? `tls :${p.tls}` : 'tls off'}${p.tcp ? `, tcp 127.0.0.1:${p.tcp}` : ''}, http 127.0.0.1:${p.http}`);
  process.on('SIGHUP', () => relay.reloadTls());
  for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => relay.close().then(() => process.exit(0)));
}
