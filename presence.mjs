// SPDX-License-Identifier: AGPL-3.0-only
// relay/presence.mjs — presence markers (design/transfer.md §8 T0): whether an agent is connected,
// for the readers it chose, and since when it is not.
//
//   p/<32 hex>  a presence topic: one writer, one reader. The writer derives it from the pairing key
//               (contact/carrier.mjs presenceTopic), so only the pair (and this relay, which sees it
//               used) knows it. The first identity to publish to it owns it; another identity's
//               publish is refused presence_taken. Anyone logged in who names it may subscribe
//               (granted QoS 0): the marker held is sent at once, as MQTT sends a retained message,
//               and every later one live. A publish (QoS 1) replaces the marker, it never adds one;
//               an empty one clears it and frees the topic, from any session of its owner. Its payload
//               is opaque here (the writer's sealed `online`, at most MARKER_BYTES). Only a session
//               whose CONNECT set the presence will may publish one (else presence_will): no marker
//               outlives its session unsaid.
//   $sigelo/presence  the only will a CONNECT may carry (any other is dropped, as every will was
//               before). When the session of a client that set it ends, however it ends (a cut, a
//               keepalive timeout, a DISCONNECT: a carrier that stops is offline too), unless a later
//               login of the same identity holds the session by then, the relay replaces every marker
//               that identity owns with its own {"presence":"offline","at":<unix seconds>}, and sends
//               it to the readers subscribed: the relay knows when a session ends, the writer cannot
//               say it after.
//
// Allowances: none of the message quotas. A marker is counted against a fixed size only: at most
// MARKER_BYTES each, PER_ACCOUNT topics per identity (an agent's contacts), MARKERS on the relay;
// past the last two a new topic is refused presence_full (the markers held keep working). Each
// publish and each topic subscribed draws on the rate brake as any other (allowance.mjs RATE), and
// owning a topic needs the standing a claim needs (policy.sender: proof of work). Memory only: a
// restart forgets every marker (readers see none until each writer connects again, which a started
// carrier does at once). An offline marker is kept KEEP seconds, then swept.
export const PRESENCE = /^p\/[0-9a-f]{32}$/, PRESENCE_WILL = '$sigelo/presence';
export const MARKER_BYTES = 512, PER_ACCOUNT = 1024, MARKERS = 100000, KEEP = 30 * 86400;

// clock() → unix seconds. publish(packet): to the subscribed readers now (the broker's). policy:
// mailbox.mjs's (sender only).
export function presence({ clock, publish, policy = {} }) {
  const markers = new Map();   // topic → { account, payload, offline: unix seconds | null }
  const owned = new Map();     // account → Set of its topics
  const watching = new Map();  // account → the client whose CONNECT set the presence will, the latest

  const drop = (topic) => {
    const m = markers.get(topic);
    if (!m) return;
    markers.delete(topic);
    const s = owned.get(m.account);
    s?.delete(topic);
    if (s?.size === 0) owned.delete(m.account);
  };

  // A publish to a p/ topic by client, whose session (auth.mjs) it is → null when held (or cleared),
  // else { code, detail }.
  function store(client, session, packet) {
    const topic = packet.topic, bytes = packet.payload.length, now = clock(), m = markers.get(topic);
    if (m && m.account !== session.account) return { code: 'presence_taken', detail: 'another identity writes this presence topic' };
    // Clearing needs no will: an owner withdraws a reader's view from any session.
    if (bytes === 0) { drop(topic); return null; }
    if (watching.get(session.account) !== client) return { code: 'presence_will', detail: `a presence marker needs the will ${PRESENCE_WILL} on this session's CONNECT` };
    if (bytes > MARKER_BYTES) return { code: 'too_large', detail: `a presence marker is at most ${MARKER_BYTES} bytes` };
    if (!m) {
      const p = policy.sender?.({ sender: session.account, now });
      if (p) return p;
      const mine = owned.get(session.account) ?? new Set();
      if (mine.size >= PER_ACCOUNT) return { code: 'presence_full', detail: `this identity holds ${PER_ACCOUNT} presence topics, the most there are: clear one (an empty publish)` };
      if (markers.size >= MARKERS) return { code: 'presence_full', detail: 'this relay holds no more presence topics now' };
      mine.add(topic); owned.set(session.account, mine);
    }
    markers.set(topic, { account: session.account, payload: Buffer.from(packet.payload), offline: null });
    return null;
  }

  // The markers held on these topics, as Aedes sends retained messages at a SUBSCRIBE.
  const held = (topics) => topics.filter((t) => markers.has(t)).map((t) => ({ cmd: 'publish', topic: t, payload: markers.get(t).payload, qos: 0, retain: true }));

  // A login whose CONNECT carried the presence will: its account's markers go offline when it ends.
  const watch = (client, account) => { watching.set(account, client); };

  // The session of client (account) ended.
  function end(client, account) {
    if (account === undefined || watching.get(account) !== client) return;
    watching.delete(account);
    const at = clock(), payload = Buffer.from(JSON.stringify({ presence: 'offline', at }));
    for (const topic of owned.get(account) ?? []) {
      markers.set(topic, { account, payload, offline: at });
      publish({ cmd: 'publish', topic, payload, qos: 0, retain: false });
    }
  }

  // Offline markers older than KEEP go, with their topics.
  function sweep(now = clock()) {
    let n = 0;
    for (const [t, m] of markers) if (m.offline !== null && m.offline + KEEP < now) { drop(t); n++; }
    return n;
  }

  return { store, held, watch, end, sweep, get size() { return markers.size; }, ownedBy: (account) => owned.get(account)?.size ?? 0 };
}
