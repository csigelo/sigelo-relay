// SPDX-License-Identifier: AGPL-3.0-only
// relay/turn.mjs — TURN credentials for logged-in identities, sigelo-turn/0 (relay/deploy/README.md
// "STUN and TURN (coturn)"): coturn on the relay host relays a call's or a transfer's packets when no
// direct pair of candidates answers. The media stays end to end (DTLS-SRTP, DTLS): coturn moves
// ciphertext.
//
// Ask: a session publishes (QoS 1) an empty payload to $sigelo/turn. The answer is a notice on
// $sigelo/notice, written before the PUBACK, to that client alone, never stored or delivered:
//   {"code": "turn", "id": <the PUBLISH's packet id>,
//    "turn": {"v": "sigelo-turn/0", "urls": ["turn:<host>:3478?transport=udp", "turn:<host>:3478?transport=tcp"],
//             "username": "<exp>:<tag>", "credential": <base64>, "exp": <unix seconds>}}
// or a refusal {code: "rate" | "pow", detail}. GET /challenge says `turn: "sigelo-turn/0"` when this
// relay has a secret, so a client never asks one that would close its session for the topic.
//
// The credential is coturn's TURN REST scheme (`use-auth-secret`, `static-auth-secret`): username
// "<expiry, unix seconds>:<tag>", password base64(HMAC-SHA1(secret, username)); coturn computes the
// same from its copy of the secret and refuses a username whose time has passed. exp is the end of
// the hour after the current one, so a credential lives 1 to 2 hours, and one identity gets one
// username per clock hour: coturn's user-quota (allocations at once per username) then counts per
// identity. tag: 16 base64url characters of HMAC-SHA256(secret, "sigelo-turn/0\n" ‖ account ‖ "\n" ‖ exp):
// on the wire a STUN username is plain text, so it names no DID and links no two hours of one
// identity; only the relay can tell whose it is.
//
// Limits: PER_HOUR answers per identity per clock hour (in memory: a restart forgets them); the
// relay's publish brake (allowance.mjs rate) and proof of work (sender) come first.
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const TURN_TOPIC = '$sigelo/turn', TURN_V = 'sigelo-turn/0', TURN_PORT = 3478, HOUR = 3600, PER_HOUR = 60;
const SECRET = /^[A-Za-z0-9+/=_-]{32,256}$/;

/** coturn's REST password for username: base64(HMAC-SHA1(secret, username)). */
export const restPassword = (secret, username) => createHmac('sha1', secret).update(username, 'utf8').digest('base64');

/** The credential for account at now: { username, credential, exp }. */
export function credentialFor(secret, account, now) {
  const exp = (Math.floor(now / HOUR) + 2) * HOUR;
  const tag = createHmac('sha256', secret).update(`${TURN_V}\n${account}\n${exp}`, 'utf8').digest('base64url').slice(0, 16);
  const username = `${exp}:${tag}`;
  return { username, credential: restPassword(secret, username), exp };
}

/** The secret file (one line: 32 to 256 characters of [A-Za-z0-9+/=_-], as `openssl rand -hex 32` writes) → the secret. */
export function readSecret(file) {
  const s = readFileSync(file, 'utf8').replace(/\r?\n$/, '');
  if (!SECRET.test(s)) throw new Error(`${file}: not a TURN secret (one line, 32 to 256 characters of A-Z a-z 0-9 + / = _ -)`);
  return s;
}

/** The TURN URIs of a relay named host (its port, if any, is the broker's, not coturn's). */
export const turnUrls = (host) => {
  const h = String(host).replace(/:\d+$/, '');
  return [`turn:${h}:${TURN_PORT}?transport=udp`, `turn:${h}:${TURN_PORT}?transport=tcp`];
};

/**
 * secret: the shared secret (readSecret); host: the relay's name (the URIs); clock() → unix seconds.
 * → { issue(account) → { turn } | { code, detail }, tidy() }.
 */
export function turnCredentials({ secret, host, clock, perHour = PER_HOUR }) {
  const urls = turnUrls(host);
  const asked = new Map();   // account → { hour, n }
  return {
    issue(account, now = clock()) {
      const hour = Math.floor(now / HOUR), a = asked.get(account);
      const n = a && a.hour === hour ? a.n + 1 : 1;
      if (n > perHour) return { code: 'rate', detail: `at most ${perHour} TURN credentials an hour: the last one is good until the end of the next hour` };
      asked.set(account, { hour, n });
      const c = credentialFor(secret, account, now);
      return { turn: { v: TURN_V, urls, username: c.username, credential: c.credential, exp: c.exp } };
    },
    // The sweep: counts of past hours go.
    tidy(now = clock()) { const hour = Math.floor(now / HOUR); for (const [k, v] of asked) if (v.hour !== hour) asked.delete(k); },
  };
}
