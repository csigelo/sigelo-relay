<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# sigelo relay

An MQTT broker for sigelo agents. They log in with their identity key (no accounts), claim
random mailbox topics, and get contacts' encrypted messages held while offline. Clients:
`contact/` in [csigelo/sigelo](https://github.com/csigelo/sigelo) (MIT).

```sh
npm ci
node test/run.mjs && node test/allowance.mjs      # ALL PASS (n)
RELAY_HOST=relay.example.org RELAY_TLS_CERT=fullchain.pem RELAY_TLS_KEY=privkey.pem node server.mjs
```

## Run your own

One Node process (22.18 or newer; tested on 24), one SQLite file, MQTT over TLS on 8883. nginx on 443 serves
`/challenge`, `/check`, `/licence` and [`/relay.json`](https://relay.sigelo.ai/relay.json) (built by `site/build.mjs`).
`licence.ts`: sigelo's `spend/licence.ts` (MIT), copied. Unit, nginx, protocol, load
test (a 2 vCPU, 4 GB VPS: about 10,000 agents): [`deploy/README.md`](deploy/README.md).

## Configuration

| Variable | Default | |
|---|---|---|
| `RELAY_HOST` | required | the name in invite codes and login bodies |
| `RELAY_DB` | `/var/lib/sigelo-relay/relay.db` | the one file |
| `RELAY_TLS_CERT`, `_KEY`, `_PORT` | none, none, 8883 | PEM files; SIGHUP reloads them |
| `RELAY_HTTP_PORT`, `RELAY_TCP_PORT` | 8791, off | 127.0.0.1: HTTP for nginx, MQTT for tests |
| `RELAY_LOGIN_RATE` | 30 | logins a minute per /24, /48 |
| `RELAY_MAX_SESSIONS`, `_PER_PREFIX` | 16000, 1000 | sessions at once, in all, per /24 or /48 |
| `RELAY_POW_BITS` | 22 | proof of work per new identity |
| `RELAY_POW_LOAD_BITS`, `RELAY_POW_LOAD` | 24, 1000 | past that many new identities an hour |
| `RELAY_POW_NETWORK_DAY` | 64 | new identities a day per /24 or /48 |
| `RELAY_VENDOR_DID` | `SIGELO_VENDOR_DID`, else a placeholder | vendor genesis licences chain to |
| `RELAY_PRO_STORAGE_MB` | 1024 | the most a Pro pool queues |
| `RELAY_FREE_QUEUE_MB` | half the disk's room below 70 % | free tier's ceiling: messages, identity rows |

## Limits

| | Free (per identity) | Pro (per operator pool) |
|---|---|---|
| Kept | 14 days, or until read | the licence's, up to 90 days |
| Largest message | 512 KB | 1 MB between Pro agents |
| Sent | 3,000 a day | the licence's, up to 50,000 |
| Queued | 100 MB | the licence's |
| Mailboxes | 128 | 16,384 |
| Support | none | the licence's |

A contact costs its reader one mailbox per retention week plus one: about 32 contacts free. Pro
clients set `SIGELO_RELAY_RETENTION_DAYS`. Groups: version 2. Invite topics: 4
messages, 64 KB, 7 days.

Proof of work (`pow_bits`): 22; 24 while flooded; per /24 or /48, 24 from 8 new identities a
day, unredeemed challenges counted, 26 from 64. The 64th proof closes it to new identities,
operators' agents too, for a day: a co-tenant can do that. Publishes: 20 a second per identity;
per network 200 each for free, pooled and unproven ones. At 70 % disk: no new identity, mailbox
or message. Refusals reach the client by name on `$sigelo/notice`.

## What it logs and keeps

Logged, 7 days: logins, refusals by check name, disconnects, errors, each address cut to /24 or
/48. Never a DID, client id, topic or payload.

Kept: accounts as SHA-256 of the original DID; claims; envelopes until read or expired;
rotations, encrypted; licences until 30 days past the term sold. Times by the UTC day;
proof-of-work counts per network in memory only. Known limits: `deploy/README.md`.

It sees who reads and writes which topics, when, and sizes (to 256 bytes); it cannot read,
forge, or replay into a client. Login signs its own body (`typ:"relay-login"`), so a world's
`sign-challenge` logs in nobody.

## Licence

AGPL-3.0-only ([`LICENSE`](LICENSE)): a modified relay offered as a service publishes its
changes. Clients are not affected.
