// SPDX-License-Identifier: AGPL-3.0-only
// relay/mailbox.mjs — mailboxes, invite topics and store-and-forward (design/relay-plan.md §3
// "Topics", "Retention", "Errors"). Envelopes are opaque bytes here: the relay never decrypts.
//
//   m/<32 hex>  a mailbox: the first identity to subscribe claims it and alone reads it; anyone
//               logged in may write to it. QoS 1; a message is deleted when the reader acknowledges
//               it or at the retention limit (7 days, to the start of that UTC day: db.mjs keeps
//               times by the day). Idle mailboxes go after retention + 7 days.
//               No new claim while the disk is 70 % full; the claims held keep working.
//   i/<32 hex>  an invite topic (contact/invite.mjs: answer and reply): claimed the same way,
//               holds 4 messages / 64 KB, dies at the first answer its reader acknowledges or 7
//               days after the claim, to the end of that UTC day (the longest invite expiry: the
//               relay cannot read the code's).
//   $sigelo/notice  refusals after login, as {code, detail}, written to that client alone; a publish
//               to a topic nobody holds now gets "no_reader". Every refusal is named. A refused
//               PUBLISH's notice also carries its packet id (`id`). The notice is written before the
//               PUBACK, SUBACK or UNSUBACK of the request it refuses: a client keeps one request in
//               flight and takes a notice that comes before the acknowledgement as that request's
//               refusal (contact/carrier.mjs). Aedes writes a QoS 0 publish in a setImmediate and an
//               acknowledgement as soon as the hook calls back, so a hook that refuses calls back once
//               its notice is written (notify).
//
// A refused publish is acknowledged and dropped (MQTT-3.3.5-2 allows either that or closing the
// connection): a QoS 1 client whose connection is closed retransmits the same PUBLISH after every
// reconnect, forever. Only a publish no correct client sends (another topic, QoS 0 or 2) closes it.
//
// Order: a reader gets its messages in the order they were stored (seq), across its topics. At a
// connect Aedes restores the subscriptions before it streams the queue, and forwards a live publish
// at once: one published while the queue went out overtook it, by hundreds of messages, and an
// envelope more than 64 behind the one opened fails out_of_order (contact/envelope.mjs WINDOW). So
// while a connection's queue goes out, live publishes to that reader are held (they stay stored),
// and the queue is read again, for what is not yet sent on this connection, until a read finds
// nothing; from then on live publishes are forwarded, except one the queue has already sent.
//
// The Aedes persistence below is the relay's own, over db.mjs. The stock adapters (memory, level,
// redis, mongodb) keep the offline queue in a store of their own, so "count, then store" and bytes
// per account would span two stores; here the queue is the SQLite table that the counts read, and
// a message is stored by authorizePublish in the same transaction as the checks that admit it.
import { Readable } from 'node:stream';
import { DAY } from './db.mjs';

export const MAILBOX = /^m\/[0-9a-f]{32}$/, INVITE = /^i\/[0-9a-f]{32}$/, NOTICE = '$sigelo/notice';
export const MAX_MESSAGE = 256 * 1024, INVITE_MESSAGES = 4, INVITE_BYTES = 64 * 1024, INVITE_TTL = 7 * DAY;
// Topics in one SUBSCRIBE or UNSUBSCRIBE: server.mjs closes a connection whose packet is larger.
export const MAX_TOPICS = 128;
export const RETENTION = 7 * DAY, IDLE_GRACE = 7 * DAY, ACCOUNT_KEEP = 30 * DAY;
// The most claims a CONNECT restores (subscriptionsByClient), the most recently claimed first.
// Each costs the one thread an authorization and a matcher entry, ~37 µs (measured: 16,384 claims
// stalled it 605 ms before the CONNACK), and a restore draws on no brake but the login rate (30 a
// minute per network): an agent may hold its whole pool's 16,384 mailboxes, and it replayed them
// at every CONNECT. 256 cost about what the login itself does. The rest stay claimed: a client
// subscribes to the topics it wants (contact/carrier.mjs does at every connection), on the
// subscribe brake, and a topic it holds takes no claim token.
export const RESTORE_MAX = 256;
// The rows one read of a reader's queue reads at most (queued). Read whole, a queue of 64,000 was
// one query of 0.33 s, and the rows of it acknowledged, expired or given up since were skipped one
// by one in a single loop: 0.47 s after an UNSUBSCRIBE of that queue (measured on tmpfs).
export const QUEUE_PAGE = 1024;
// No client may subscribe to this topic (authorizeSubscribe admits only the three above), so a
// refused publish sent here reaches nobody: Aedes acknowledges it and routes it to no one.
const SINK = '$sigelo/sink';
const refusal = (why) => Object.assign(new Error(why), { check: 'publish' });
const empty = () => Readable.from([]);
const live = (c, now) => c !== undefined && !c.dead && (c.expires === null || c.expires > now);

// db: relay/db.mjs. clock() → unix seconds. diskFull() → true at 70 %. sessionOf(client) →
// { account, clientId, prefix } from auth.mjs (prefix: the address cut to /24 or /48, memory only).
// online(clientId) → connected now. policy: M4's hooks, none by default: rate (every publish, and
// every topic subscribed or unsubscribed, before any work; both kinds of topic draw on kind
// "subscribe", and a claim made anew or given up on kind "claim" too: each one's commit is followed
// by a WAL checkpoint, milliseconds on a real disk), strike (a publish refused by any check but the
// rate brake, which counts its own), maxMessage (bytes; default 256 KB, never over server.mjs's 1 MB frame), sender (the
// writer's own standing, and a new claim's reader's, before any transaction), publish, claim, pool (the operator pool an
// account draws on now, or null: a message, its sender's count and a claim stay charged to it), retention (seconds a message is
// kept; idle mailboxes go retention + 7 days after their last use, never sooner than 14 days),
// tidy (its own retention, run inside the sweep's transaction: db.mjs sweep) and accountKept
// (an idle account the sweep keeps).
export function mailboxes({ db, clock, diskFull, sessionOf, online, policy = {} }) {
  // The row each queued message is stored in, by its payload Buffer. Aedes wraps a publish in new
  // packet objects on its way to the reader but always passes the payload Buffer along by
  // reference, and the payload is all the relay knows a message by; a weak key frees with it.
  const rowOf = new WeakMap();
  // The subscriptions subscriptionsByClient hands Aedes to restore a session: Aedes authorizes each
  // again, and those are granted on a read, not a write per claim.
  const restored = new WeakSet();

  // Per connection (an Aedes client): its queue going out (queued). yielded, passed: rows the queue
  // stream gave Aedes, and those of them it is about to write (forward); done: the queue is out,
  // live publishes go straight through; more: queued() asks for the next rows.
  const order = new WeakMap();
  const orderOf = (client) => {
    let q = order.get(client);
    if (!q) { q = { yielded: 0, passed: 0, done: false, more: () => {} }; order.set(client, q); }
    return q;
  };
  // The payload Buffers the queue stream made: a live publish carries the writer's own.
  const streamed = new WeakSet();
  // Reader client id → the order state of its queue stream while it reads (queued). A message
  // stored for that reader behind what the stream has read (q.after) moves the next read back to
  // it: a new row's seq is one past the reader's highest left (db.mjs store), so once the newest
  // rows are acknowledged it can fall behind.
  const reading = new Map();

  // What release and the sweep left to delete (db.mjs reap): one batch per turn of the event
  // loop, so other clients are served between two. A batch that fails stops it; the next sweep
  // starts it again.
  let reaping = null, closed = false;
  const reapSoon = () => {
    if (reaping || closed) return;
    reaping = setImmediate(() => {
      reaping = null;
      let more = false;
      try { more = db.reap(clock()).more; } catch { return; }
      if (more) reapSoon();
    });
  };

  // done() runs once the notice is written to the client's connection (or the connection is gone):
  // the refused request is acknowledged only then (the header). id: the refused PUBLISH's packet id.
  const notify = (client, code, detail, done = () => {}, id = undefined) => {
    const n = id === undefined ? { code, detail } : { code, detail, id };
    client.publish({ topic: NOTICE, payload: Buffer.from(JSON.stringify(n)), qos: 0, retain: false }, () => done());
  };

  // → null when stored, else { code, detail }. Synchronous, on the one thread: the claim read first
  // cannot change before the transaction that stores.
  function store(session, packet) {
    const topic = packet.topic, size = packet.payload.length, now = clock();
    const c = db.claim(topic);
    // Nobody reads this topic: dropped at the cost of one read, as any broker drops a publish
    // without subscribers, and the writer is told. A reader claims its topics before its contacts
    // write (contacts.md §5, plan §3 "Topics"), but one away longer than it claimed ahead has not:
    // a silent drop cost the writer the rest of an epoch whose first envelope this was (every later
    // one fails epoch_unknown at the reader) while it believed each one sent. Only a writer who
    // knows the topic learns that nobody holds it now.
    if (!live(c, now)) return { code: 'no_reader', detail: 'nobody holds this topic now: its reader has not claimed it (away longer than it claimed ahead), or gave it up' };
    const max = policy.maxMessage?.({ sender: session.account, reader: c.account, now }) ?? MAX_MESSAGE;
    if (size > max) return { code: 'too_large', detail: `message over ${max} bytes` };
    if (diskFull()) return { code: 'relay_full', detail: 'this relay queues nothing until disk use falls below 70 %' };
    const p = policy.sender?.({ sender: session.account, now });   // M4: pow, before any transaction
    if (p) return p;
    // The transaction writes the reader's side only: the message and its reader's totals (the
    // claim's day of use waits in memory for the sweep). The sender's count is kept in memory
    // (db.mjs's header): written here, beside the message, it named the sender of each message in
    // the WAL. Each is charged to the pool it draws on now (policy.pool, M4), and stays charged
    // there: the message's bytes until it goes, the sender's count until the day ends.
    let senderPool = null;
    const r = db.tx(() => {
      if (c.expires !== null) {
        const load = db.topicLoad(topic);
        if (load.n >= INVITE_MESSAGES || load.bytes + size > INVITE_BYTES) return { code: 'quota_storage', detail: `invite topic full (${INVITE_MESSAGES} messages / ${INVITE_BYTES / 1024} KB)` };
      }
      const r = policy.publish?.({ sender: session.account, reader: c.account, bytes: size, now, db, prefix: session.prefix });   // M4: quota_storage, quota_messages
      if (r) return r;
      senderPool = policy.pool?.(session.account, now) ?? null;
      const { id, seq } = db.store({ topic, clientId: c.client_id, account: c.account, payload: packet.payload, expires: now + (policy.retention?.(c.account) ?? RETENTION), pool: policy.pool?.(c.account, now) ?? null });
      const q = reading.get(c.client_id);
      if (q && seq <= q.after) q.after = seq - 1;
      db.touchClaim(topic, now);
      rowOf.set(packet.payload, id);
      return null;
    });
    if (r === null) db.countSent(session.account, now, senderPool);
    return r;
  }

  function authorizePublish(client, packet, cb) {
    const session = client && sessionOf(client);
    if (!session) return cb(refusal('no session'));
    if (!MAILBOX.test(packet.topic) && !INVITE.test(packet.topic)) return cb(refusal('topic'));
    if (packet.qos !== 1) return cb(refusal('qos'));   // store-and-forward is QoS 1 (0 is not stored, 2 not offered)
    packet.retain = false;                              // nothing is retained here
    let r, rated;
    // Aedes calls this from the parser's event: a throw here would end the process. A store that
    // fails (disk full, a bug) closes this connection instead; the client retransmits later.
    try {
      rated = policy.rate?.({ account: session.account, clientId: session.clientId, kind: 'publish', now: clock(), prefix: session.prefix }) ?? null;
      r = rated || store(session, packet);
      // Every refused publish is a strike (allowance.mjs RATE): a no_reader or a quota costs the
      // writer nothing else, and drew on its network's bucket without end.
      if (r && !rated) policy.strike?.({ account: session.account, clientId: session.clientId, now: clock() });
    } catch { return cb(Object.assign(new Error('store failed'), { check: 'store' })); }
    if (!r) return cb(null);
    packet.topic = SINK;
    packet.payload = Buffer.alloc(0);
    notify(client, r.code, r.detail, () => cb(null), packet.messageId);   // the PUBACK after the notice
  }

  // First subscriber claims; its own later subscriptions use the claim. → null when granted, else
  // { code, detail }. Synchronous, as store().
  function claim(session, topic, invite) {
    const now = clock();
    const c = db.claim(topic);
    if (c) {
      // Given up (db.mjs release), its queue still being deleted in batches (reap); then it goes.
      if (c.dead === 2) return { code: 'mailbox_taken', detail: 'this mailbox was given up a moment ago and its messages are still being deleted: subscribe again in a minute' };
      if (c.account !== session.account) return { code: 'mailbox_taken', detail: 'another identity reads this topic' };
      if (!live(c, now)) return { code: 'mailbox_taken', detail: 'this invite topic is used up' };
      db.touchClaim(topic, now);
      return null;
    }
    // A claim is a row that lives for weeks: none is added on a disk 70 % full (the ones held work).
    if (diskFull()) return { code: 'relay_full', detail: 'this relay takes no new mailbox until disk use falls below 70 %' };
    // Proof of work first, one row read, as for a publish's writer: an identity that has proven
    // none opens no transaction, and spends none of the claim brake it needs once it has (a
    // carrier the relay forgot is refused "pow" at its first SUBSCRIBE, then logs in with a proof).
    const p = policy.sender?.({ sender: session.account, now });
    if (p) return p;
    // A transaction and a checkpoint (below): the claim brake, beside the subscribe token taken.
    const rated = policy.rate?.({ account: session.account, clientId: session.clientId, kind: 'claim', now, prefix: session.prefix });
    if (rated) return rated;
    // Settled: its commit names the reader's account, which may write a message next (db.mjs).
    return db.settle(() => db.tx(() => {
      const p = policy.claim?.({ account: session.account, invite, now, db });   // M4: quota_mailboxes, pow
      if (p) return p;
      db.insertClaim(topic, session.account, session.clientId, now, invite ? now + INVITE_TTL : null, policy.pool?.(session.account, now) ?? null);
      return null;
    }));
  }

  function authorizeSubscribe(client, sub, cb) {
    const session = client && sessionOf(client);
    if (!session) return cb(refusal('no session'));
    if (restored.has(sub)) {
      // A session restore: subscriptionsByClient read and touched the claims a moment ago. Read it
      // again (it may have been released or swept since), write nothing. Live publishes reach the
      // subscription from now on, before the queue goes out: they are held until it has (forward).
      orderOf(client);
      const c = db.claim(sub.topic);
      return cb(null, c && c.account === session.account && live(c, clock()) ? sub : null);
    }
    if (sub.topic === NOTICE) return cb(null, sub);
    const invite = INVITE.test(sub.topic);
    if (!invite && !MAILBOX.test(sub.topic)) return cb(null, null);   // granted 128: no wildcards, no other topics
    if (sub.qos < 1) return cb(null, null);                            // a QoS 0 subscription would never acknowledge
    let r;
    try {
      r = policy.rate?.({ account: session.account, clientId: session.clientId, kind: 'subscribe', now: clock(), prefix: session.prefix }) || claim(session, sub.topic, invite);
    } catch { return cb(Object.assign(new Error('claim failed'), { check: 'store' })); }   // as in authorizePublish
    if (r) return notify(client, r.code, r.detail, () => cb(null, null));   // the SUBACK after the notice
    cb(null, sub);
  }

  // Every delivery to a reader, before Aedes writes it (server.mjs authorizeForward): the queue's in
  // its order, a live publish only once the queue is out (the header). → the packet, or null: not
  // written now (it stays stored, and goes from the queue).
  function forward(client, packet) {
    if (!MAILBOX.test(packet.topic) && !INVITE.test(packet.topic)) return packet;   // notices
    // Every reader's queue stream begins at its connect, before anything else can reach it: a
    // reader without one is held, never let through out of order.
    const q = order.get(client);
    if (!q) return null;
    if (streamed.has(packet.payload)) {
      // Written next: once all rows given are, each holds its packet id, and the next read of the
      // queue (rows without one) does not return them again.
      if (++q.passed === q.yielded) queueMicrotask(q.more);
      return packet;
    }
    if (!q.done) return null;
    // Stored before the queue's last read and forwarded after it: the queue sent it already (or the
    // reader has acknowledged it), and a second copy would come as a replay.
    const id = rowOf.get(packet.payload);
    return id === undefined || db.unsent(id) ? packet : null;
  }

  // The reader acknowledged a delivery: the message is deleted; an invite topic dies with its first.
  function acknowledged(clientId, messageId) {
    if (!Number.isInteger(messageId)) return undefined;   // Aedes passes undefined for a delivery it skipped
    const topic = db.take(clientId, messageId);
    if (topic === undefined) return undefined;
    if (INVITE.test(topic)) db.killInvite(topic);
    return { cmd: 'publish', topic, qos: 1, messageId };
  }

  // The reader's queue, in its order, read on until a read finds nothing (the header): a page of
  // rows at a time (QUEUE_PAGE), after the seq read last (q.after), so a full queue is not loaded
  // at once; a row acknowledged, expired or given up meanwhile is skipped. A message stored for
  // the reader behind q.after moves it back (reading). A page whose rows all go
  // nowhere (a long queue given up and not yet deleted, rows in flight) hands the next read to a
  // later turn of the event loop. A read waits until every row given before it is about to be
  // written (forward calls more): those then hold a packet id and are not read again. The read
  // that finds nothing sets done in the same step, so no message stored after it waits for a
  // queue that has ended. A row whose packet id a later delivery on this connection reuses
  // (db.mjs setMessageId) goes at the next connection.
  function queued(client) {
    const q = orderOf(client);
    // The packet ids of an earlier connection are void: what was in flight on it goes again. Voided
    // here, at the first read, not at the restore before it: Aedes has closed the connection this
    // one took over by now (registerClient), so no delivery of that one marks a row after this,
    // and a row it marked would be skipped as sent.
    db.resetMessageIds(client.id);
    let ids = [], i = 0, waiting = false, later = false;
    const s = new Readable({ objectMode: true, read() { more(); } });
    q.more = () => { if (waiting) { waiting = false; more(); } };
    q.after = 0;
    reading.set(client.id, q);
    const stop = () => { if (reading.get(client.id) === q) reading.delete(client.id); };
    s.once('close', stop);
    function more() {
      if (q.done) return;
      for (;;) {
        if (i === ids.length) {
          if (q.passed < q.yielded) { waiting = true; return; }
          const page = db.unsentPage(client.id, clock(), q.after, QUEUE_PAGE);
          if (page.rows === 0) { q.done = true; stop(); s.push(null); return; }
          ids = page.ids; q.after = page.last; i = 0;
          if (ids.length === 0) {
            if (!later) {
              later = true;
              // Outside the stream's read(): a failure (the database closed under it) ends this
              // connection's queue, not the process.
              setImmediate(() => { later = false; if (closed) return; try { more(); } catch (e) { s.destroy(e); } });
            }
            return;
          }
        }
        const id = ids[i++], m = db.message(id);
        if (!m || m.expires <= clock()) continue;
        const payload = Buffer.from(m.payload.buffer, m.payload.byteOffset, m.payload.byteLength);
        rowOf.set(payload, id);
        streamed.add(payload);
        q.yielded++;
        if (!s.push({ cmd: 'publish', topic: m.topic, payload, qos: 1, retain: false, dup: false })) return;
      }
    }
    return s;
  }

  // Every method Aedes 1.x calls (aedes-persistence 11 interface), each saying what it is here.
  const persistence = {
    async setup() {},
    async storeRetained() {},                               // authorizePublish clears retain
    createRetainedStream: empty,
    createRetainedStreamCombi: empty,
    // A claim is made in authorizeSubscribe, atomically with the mailbox_taken check. Aedes calls
    // this with every topic of the SUBSCRIBE packet, refused ones too, so it must add nothing.
    async addSubscriptions() {},
    // UNSUBSCRIBE gives a claim up, and its queued messages with it: work, as a claim is, so each
    // topic draws on the subscribe rate first, then on the claim brake. At most db.mjs's
    // DELETE_BATCH messages go at once; a longer queue goes in batches (reap), its mailbox given up
    // meanwhile. A refused topic stays claimed and the client is told
    // once per packet: UNSUBACK has no failure code in MQTT 3.1.1, and closing the connection would
    // cost a correct client a login. Aedes still drops the subscription from this connection, so
    // its messages queue unsent; the claim comes back with the session at the next connect, or goes
    // at a later UNSUBSCRIBE.
    async removeSubscriptions(client, topics) {
      const session = client && sessionOf(client);
      if (!session) throw refusal('no session');
      const now = clock(), release = [];
      let refused = null, kept = 0;
      for (const t of topics) {
        if (!MAILBOX.test(t) && !INVITE.test(t)) continue;
        const who = { account: session.account, clientId: session.clientId, now, prefix: session.prefix };
        const r = policy.rate?.({ ...who, kind: 'subscribe' }) || policy.rate?.({ ...who, kind: 'claim' });
        if (r) { refused ??= r; kept++; } else release.push(t);
      }
      if (release.length > 0 && db.release(client.id, release) > 0) reapSoon();
      // The UNSUBACK after the notice (the header).
      if (refused) await new Promise((resolve) => notify(client, refused.code, `UNSUBSCRIBE refused for ${kept} of its topics, still claimed (${refused.detail})`, resolve));
    },
    // Called once per CONNECT (clean session off), before any delivery: the reader's live claims
    // are its session, all in use again, and at most RESTORE_MAX of them are restored. (The packet
    // ids of an earlier connection are voided later, by queued.)
    async subscriptionsByClient(client) {
      const now = clock();
      db.touchClaims(client.id, now);
      return db.claimsOf(client.id, now, RESTORE_MAX).map((topic) => { const sub = { topic, qos: 1 }; restored.add(sub); return sub; });
    },
    async countOffline() { const c = db.countClaims(); return { subsCount: c.claims, clientsCount: c.clients }; },
    async subscriptionsByTopic() { return []; },             // stored at authorization, not enqueued by Aedes
    async cleanSubscriptions() {},                          // clean sessions are refused at login
    async outgoingEnqueue() { throw new Error('the relay stores messages at authorization only'); },
    async outgoingEnqueueCombi(subs) { if (subs.length > 0) throw new Error('the relay stores messages at authorization only'); },
    // Never throws: Aedes disconnects a reader whose update fails, and a message that expired a
    // moment ago is still worth delivering.
    async outgoingUpdate(client, packet) {
      const id = rowOf.get(packet.payload);
      if (id !== undefined && Number.isInteger(packet.messageId)) db.setMessageId(id, client.id, packet.messageId);
    },
    // Aedes calls this for a PUBACK, and also for a delivery it did not write (authorizeForward
    // refused it: a live publish held while the queue goes out (forward), or a reader too far
    // behind (server.mjs)). Only the reader's PUBACK deletes a message: the other stays queued.
    async outgoingClearMessageId(client, packet) { return packet?.cmd === 'puback' ? acknowledged(client.id, packet.messageId) : undefined; },
    outgoingStream: (client) => queued(client),
    // Inbound QoS 2 state: authorizePublish refuses QoS 2 before Aedes reaches these.
    async incomingStorePacket() { throw new Error('QoS 2 is not offered'); },
    async incomingGetPacket() { throw new Error('no such packet'); },
    async incomingDelPacket() { throw new Error('no such packet'); },
    async cleanIncoming() {},
    async putWill() {},                                     // auth.mjs drops wills at login
    async getWill() { return undefined; },
    async delWill() { return undefined; },
    streamWill: empty,
    getClientList: empty,
    async destroy() {},
  };

  // One batch of expired messages and invite topics; reap takes what is left, and what release
  // left (after a restart too).
  const sweep = (now = clock()) => {
    const r = db.sweep(now, {
      minIdle: RETENTION + IDLE_GRACE, idleAfter: (account) => (policy.retention?.(account) ?? RETENTION) + IDLE_GRACE, accountAfter: ACCOUNT_KEEP, online,
      tidy: (t) => policy.tidy?.(t), kept: (account, t) => policy.accountKept?.(account, t) ?? false,
    });
    reapSoon();
    return r;
  };
  // Before the database closes: no batch runs after it.
  const close = () => { closed = true; clearImmediate(reaping); reaping = null; };

  return { persistence, authorizePublish, authorizeSubscribe, forward, sweep, notify, close };
}
