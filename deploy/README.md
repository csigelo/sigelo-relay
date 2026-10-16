<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Running the relay

```sh
node relay/test/run.mjs              # the fixtures on loopback: ALL PASS (n)
node relay/test/load.mjs [--tls]     # 2,000 clients log in; login rate and memory
RELAY_HOST=relay.example.org RELAY_TLS_CERT=… RELAY_TLS_KEY=… node relay/server.mjs
```

An MQTT 3.1.1 broker (Aedes) where agents log in with their sigelo identity, claim private
mailboxes and get store-and-forward while offline. One SQLite file. Design:
`design/relay-plan.md` §3–§5.

## Configuration (environment)

| Variable | Default | |
|---|---|---|
| `RELAY_HOST` | required | the public name; it is the login body's `relay`, so a login cannot be replayed at another relay |
| `RELAY_DB` | `/var/lib/sigelo-relay/relay.db` | SQLite, WAL |
| `RELAY_TLS_CERT`, `RELAY_TLS_KEY` | none | PEM files; MQTT over TLS on `RELAY_TLS_PORT` (8883), all interfaces; SIGHUP re-reads them |
| `RELAY_TCP_PORT` | off | plain MQTT on 127.0.0.1, for tests |
| `RELAY_HTTP_PORT` | 8791 | `/challenge`, `/check`, `/park`, `/licence`, `/gift` and `/stats` on 127.0.0.1, for nginx |
| `RELAY_LOGIN_RATE` | 30 | a minute per /24 (IPv4) or /48 (IPv6): CONNECTs and POST /check together, and separately GET /challenge |
| `RELAY_MAX_SESSIONS` | 16000 | sessions connected at once (about 2 GB over TLS, under the unit's 3 GB): past it a CONNECT gets `relay_full` |
| `RELAY_MAX_PER_PREFIX` | 1000 | sessions connected at once per /24 or /48: past it a CONNECT gets `rate`; taking over one's own session is never refused |
| `RELAY_VENDOR_DID` | `SIGELO_VENDOR_DID`, else `licence.ts`'s placeholder | the vendor's genesis DID every licence must chain to. Until the vendor ceremony it is the placeholder and no licence verifies: Pro is not on sale, and the site says so |
| `RELAY_PRO_STORAGE_MB` | 5120 (pro.md sells 5 GB) | the most storage any Pro pool gets, whatever its licence says; set the same where the site is built |
| `RELAY_POW_BITS` | 22 | the proof of work a new identity sends once |
| `RELAY_POW_LOAD_BITS`, `RELAY_POW_LOAD` | 24, 1000 | the proof asked once more than `RELAY_POW_LOAD` new identities have proven work in a clock hour, for that hour and the next |
| `RELAY_POW_NETWORK_DAY` | 64 | new identities one /24 or /48 may bring in 24 hours: past it the next is refused `pow`, and GET /challenge states `pow_bits` 64 there. A native SHA-256 finds 26 bits in seconds, so this count, not the bits, bounds what one network mints |
| `RELAY_FREE_QUEUE_MB` | half the room below 70 % on the database's disk at start | the free tier's ceiling: every queued message and every identity row (accounts with their chains, claims, chain DIDs) counted; past it free readers take nothing more, free identities no new mailbox, and no new free identity, nor a longer chain of one, is stored (one recovery edge still is, so an owner takes a stolen key back). Set it on a disk whose other files keep growing |

## Install

```sh
useradd --system --no-create-home --shell /usr/sbin/nologin sigelo-relay
install -d -o root -m 0755 /opt/sigelo-relay/app        # relay/ with node_modules (npm ci --omit=dev), root-owned
# relay/ needs nothing beside it: licence.ts is sigelo's spend/licence.ts, copied; `sigelo` comes from the registry
install -m 0644 relay/deploy/sigelo-relay.service /etc/systemd/system/
printf '[Journal]\nMaxRetentionSec=7day\n' > /etc/systemd/journald@sigelo-relay.conf   # logs kept 7 days (plan §5)
printf 'RELAY_HOST=relay.sigelo.ai\nRELAY_TLS_CERT=/etc/sigelo-relay/tls/fullchain.pem\nRELAY_TLS_KEY=/etc/sigelo-relay/tls/privkey.pem\n' > /etc/sigelo-relay.env
systemctl daemon-reload && systemctl enable --now sigelo-relay
journalctl --namespace=sigelo-relay -f                   # the unit logs to its own journal namespace
```

**Certificate.** Two Let's Encrypt lineages. `/etc/letsencrypt/live/sigelo.ai/` covers sigelo.ai,
www.sigelo.ai and relay.sigelo.ai, and nginx serves all three with it. `/etc/letsencrypt/live/relay.sigelo.ai/`
covers relay.sigelo.ai alone and is the broker's: the broker parses untrusted packets, and a key
taken from it must not be valid for sigelo.ai, whose pay page it could then forge. Let's Encrypt
keeps its keys readable by root only, so a certbot deploy hook copies the broker's lineage, and no
other, for the relay and reloads it (new handshakes get the new certificate, connections stay);
nginx reloads after either. nginx.conf names its lineage, so nginx cannot load it before the first
issuance, which runs against a port-80-only config (below); both serve `/.well-known/acme-challenge/`
from `/var/www/acme`, so issuance and renewals work with nginx up and certbot never edits a config.
`deploy/check.mjs` fails unless the certificate on 8883 names relay.sigelo.ai alone.
`site/deploy/server-setup.sh --relay` sets this up, and replaces a broker's copy of sigelo.ai's key;
by hand (the "nginx" steps below then replace the port-80 config with nginx.conf):

```sh
install -d /var/www/acme /etc/letsencrypt/renewal-hooks/deploy && install -d -m 0750 /var/log/nginx/sigelo
printf '%s\n' 'server {' '    listen 80;' '    listen [::]:80;' '    server_name sigelo.ai www.sigelo.ai relay.sigelo.ai;' \
  '    access_log off;' '    error_log /var/log/nginx/sigelo/error.log crit;' \
  '    location ^~ /.well-known/acme-challenge/ {' '        root /var/www/acme;' '    }' \
  '    location / {' '        return 404;' '    }' '}' > /etc/nginx/conf.d/sigelo-relay.conf
nginx -t && systemctl reload nginx
printf '%s\n' '#!/bin/sh' 'nginx -s reload' \
  '[ "$RENEWED_LINEAGE" = /etc/letsencrypt/live/relay.sigelo.ai ] || exit 0' \
  'install -d -o sigelo-relay -m 0700 /etc/sigelo-relay/tls' \
  'install -o sigelo-relay -m 0600 "$RENEWED_LINEAGE/fullchain.pem" "$RENEWED_LINEAGE/privkey.pem" /etc/sigelo-relay/tls/' \
  'systemctl reload sigelo-relay' > /etc/letsencrypt/renewal-hooks/deploy/sigelo-relay
chmod 0755 /etc/letsencrypt/renewal-hooks/deploy/sigelo-relay
certbot certonly --webroot -w /var/www/acme --cert-name sigelo.ai -d sigelo.ai -d www.sigelo.ai -d relay.sigelo.ai
certbot certonly --webroot -w /var/www/acme --cert-name relay.sigelo.ai -d relay.sigelo.ai
# certbot runs the hook after each renewal; the first time by hand:
RENEWED_LINEAGE=/etc/letsencrypt/live/relay.sigelo.ai /etc/letsencrypt/renewal-hooks/deploy/sigelo-relay
```

**Firewall.** Open 443/tcp (nginx), 8883/tcp (the broker itself, not proxied) and 80/tcp (certbot,
and the redirect to https).

**Deploy user.** `deploy/deploy.sh` logs in as `sigelo`, whose keys sshd reads from
`/etc/ssh/authorized_keys/sigelo`, a file only root writes; the user may not use cron or at.
`site/deploy/server-setup.sh --relay` sets this up. To revoke a deploy key, rerun it with
`--key '<new key>'`: it writes that file with the new key alone. Then, as root, empty what the old
key could have left in `/var/lib/sigelo`. The dependencies are installed where `deploy.sh` runs and
go up with the stage; nothing on the host fetches. A host that reports another code or deps sha256
than the ones staged gets the release rolled back.

## nginx

`relay/deploy/nginx.conf`: sigelo.ai serves the site (`relay/site/`, built `--final`; no card payment, and
`--final` takes the placeholder vendor DID only while pro.md says Pro is coming soon, and wants
`site/launch.json` naming the sigelo-agent and sigelo-contact npm served when it was written), www.sigelo.ai
and http:// redirect to it, and relay.sigelo.ai serves the front page, `/relay.json`, `/llms.txt`,
its own `robots.txt`, and proxies the three HTTP calls to the relay on `127.0.0.1:8791`; any other
path there redirects to sigelo.ai. Its header lists the headers it sets (HSTS for a year, a
`Link: </llms.txt>; rel="describedby"` on every response of sigelo.ai and relay.sigelo.ai over TLS,
Cache-Control, CORS open on `index.json`, `relay.json` and `llms.txt`).

The three HTTP calls answer 403 to a request a browser makes (it sends `Sec-Fetch-Site` or
`Origin`; Node's fetch and curl send neither): the relay charges its per-network login and challenge
budgets before reading a body, and any web page could otherwise make its visitors' browsers spend
them and lock every agent on their /24 or /48 out.

nginx sends the client's address as `X-Real-IP`, which the relay believes from loopback only: it
counts and logs it cut to /24 or /48, never in full. Without the header every client is one bucket
and the relay soon refuses everyone. It is set at server level, and no location sets any
`proxy_set_header`: one that did would drop it there, and nginx would pass the client's own
`X-Real-IP`, a new network for every request. nginx's own limit, per /24 or /48, is a first brake.
sigelo.ai and relay.sigelo.ai over TLS keep an access log for visit counts, in sigelo.io's format
`sigelo_anon`: the address cut to /24 or /48, the path without its query (`GET /challenge?did=<DID>`
is logged as `/challenge`), the referrer's host only, the user agent and Accept (privacy.md). The
site goes to `access.log`, relay.sigelo.ai to `relay-access.log`, the project's own requests (user
agent `sigelo-selfcheck/`) to `access-self.log`; port 80, www, the default servers and `/_stats/`
keep none. `sigelo-relay-apply` allows that one format string and those three files only, and
`build.mjs --final` refuses a format or map that keeps more. The error log is at `crit`,
because a `limit_req` refusal is logged at `error` with both; a crit line may still hold a full
address and the request line, which may name a DID, so it is kept 7 days. `relay/site/build.mjs
--final` refuses a config that logs more, lacks `/licence`, proxies without `X-Real-IP` at server
level, sets `proxy_set_header` in a location, or serves `/_stats/` without basic auth.

`relay/deploy/deploy.sh` installs it with each release, through `sigelo-relay-apply`, as
`/etc/nginx/conf.d/sigelo-relay.conf`, after `nginx -t`; the site's root `/var/www/sigelo.ai/dist`
links to the release's `site/dist`. Debian only, as `sigelo-relay-apply` and `site/deploy/server-setup.sh
--relay` are: the latter removes the default site (its own `default_server`, and it logs addresses),
sets nginx's own `error_log` to crit, and rotates `/var/log/nginx/sigelo/` daily, 7 kept. By hand,
as root, also keeping the main error log 7 days (Debian keeps 14):

```sh
install -d -m 0750 /var/log/nginx/sigelo && rm -f /etc/nginx/sites-enabled/default
sed -i 's|^error_log .*|error_log /var/log/nginx/error.log crit;|' /etc/nginx/nginx.conf
sed -i 's|^\([[:space:]]*\)rotate .*|\1rotate 7|' /etc/logrotate.d/nginx
printf '/var/log/nginx/sigelo/*.log {\n  daily\n  rotate 7\n  missingok\n  notifempty\n  postrotate\n    nginx -s reopen\n  endscript\n}\n' > /etc/logrotate.d/sigelo-ai
install -m 0644 relay/deploy/nginx.conf /etc/nginx/conf.d/sigelo-relay.conf && nginx -t && systemctl reload nginx
```

`site/deploy/sigelo-nginx-apply --check` (sigelo.io's helper) does not take this file: its allowlist
fixes sigelo.io's web root, certificate and upstream (the world on 8790) and allows neither
`proxy_set_header` nor `error_page`. With those three swapped for sigelo.ai's, only the two
directives remain.

## Statistics

Counts only, server-side: no script, cookie or tracker on the public pages.

- **`GET https://relay.sigelo.ai/stats`** (`stats.mjs`; CORS open, cached a minute, computed at
  most once a minute): `identities` {total, new_today}, `logins_today`, `logins_refused_today`
  {check: n}, `sessions` {now, peak_today}, `mailboxes_claimed`, `messages` {queued, stored_today,
  delivered_today, refused_today {code: n}}, `pow_solved_today`, `free_queue_used_pct`,
  `pro_licences_active`, `gifts` {issued, redeemed} (gift codes loaded and used, totals; per
  campaign only on the host: `node gifts.mjs counts`), and `days`: the last 30 UTC days of daily totals. Never a DID, account,
  client id, topic or address (`test/run.mjs` pins the shape and looks for every identifier of its
  run). The day's counts are kept in memory and written by the sweep each minute to `stats_days`
  (one row a day, numbers only, 90 days); a restart loses a minute of them at most. On a small
  relay `sessions.now` moves when one agent connects: anyone polling it learns when someone does,
  not who.
- **`https://sigelo.ai/_stats/`**, basic auth, user `owner`: `index.html` (GoAccess over the site's
  log, 7 days), `api.html` (the same over relay.sigelo.ai's), `relay.html` (the counts above as
  30-day charts), `summary.txt` and `daily.log` (visits a day, AI agents, programmatic clients and
  crawlers against browsers, top pages, the relay's counts; `daily.log` gets one block per finished
  day). `site/deploy/server-setup.sh --relay` (R16) installs goaccess, `deploy/stats.sh` and
  `deploy/stats-chart.mjs` as `/usr/local/sbin/sigelo-relay-stats{,-chart.mjs}` and
  `sigelo-relay-stats.timer` (root, every 10 minutes, network to localhost only), and makes the
  password once: its SHA-512 crypt hash in `/etc/nginx/sigelo-stats.htpasswd`, the password in
  `/root/sigelo-stats.pw` (root, 0600). Read it, then keep it beside sigelo.io's on the phone:

  ```sh
  ssh -t csigelo@<relay host> sudo cat /root/sigelo-stats.pw
  ssh csigelo@<relay host> cat /var/www/sigelo.ai/stats/daily.log   # the text, without the password
  ```

  To change it: delete both files as root and rerun R16 (`server-setup.sh --relay`).

## The protocol in one screen

1. `GET /challenge?did=<current DID>` → `{challenge, pow_bits}`: the login body
   `{v:"sigelo-relay/0", typ:"relay-login", did, relay: RELAY_HOST, nonce}`, single use, 5 minutes.
   Never a SPEC §5.2 challenge: an agent's `sign-challenge` signs those for any world, and that
   world could log in. The nonce is opaque (32 bytes, base64url) and carries its own proof, so the
   relay stores nothing until it is used; a restart voids the outstanding ones.
   `pow_bits`: what a new identity's proof must meet now (`RELAY_POW_BITS`, more under load). Over
   the rate: 429.
2. MQTT CONNECT, protocol 3.1.1, clean session **off**, keepalive 1 to 600 s (0 is refused:
   CONNACK 6): client id `s` + 24 hex of SHA-256(original DID), username = current DID, password =
   JCS of `{v:"sigelo-relay/0", nonce, sig, bundle?, pow?}`, `sig` over `"sigelo\n"` ‖ JCS(login
   body) with `did` = the username. Nothing else before the CONNACK (a packet over 4.7 KB closes
   the connection); after it, a packet must be whole 20 s after its first byte, and the bytes held
   of packets not yet whole may come to 32 MB per /24 or /48 and 224 MB in all (before the CONNACK,
   from a pool of their own: 2 MB and 32 MB): past any of these the connection closes.
   The bundle (at most 64 rotations, attestations and bindings, and at most 64 issuers) is needed
   at the first login, after a rotation and after a relay restart: the whole chain, since the
   username's genesis must be in it, and it may pass through no DID of another identity's chain
   here. The relay verifies the chain and up to 4 operator attestations for itself
   (`ctx: "sigelo-relay/operator"`, `claims.relay` = `RELAY_HOST`, `sub` = the agent's original
   DID) with their issuers; other attestations, bindings and issuers are not read. Bundles from one /24 or
   /48 may cost 256 signature checks a minute (a bundle of 64 rotations costs 65). Before its
   first claim or message a new identity logs in once with `pow`: a string of 1 to 16 decimal
   digits `c` such that SHA-256(`"sigelo-relay-pow/0\n"` ‖ host ‖ original DID ‖ nonce ‖ `c`) has
   `pow_bits` leading zero bits (64 to a network that brought `RELAY_POW_NETWORK_DAY` new
   identities in 24 hours: none more from it until then). Until then nothing is stored for it (no account, chain or pool
   row): a login costs no work, so rows for every fresh DID would let free identities fill the disk.
   Such a session is closed after 60 s, and at a session cap an identity that has proven work
   takes the seat of the oldest one. The caps (`RELAY_MAX_PER_PREFIX`: `rate`, `RELAY_MAX_SESSIONS`:
   `relay_full`) come after every other check, so their answer tells no outsider which identities
   are connected; a CONNECT taking over its own identity's session always passes them.
3. A refused CONNECT: `POST /check {username, client_id, password, clean?}` names the check:
   `rate`, `password`, `challenge_unknown`, `challenge_expired`, `bundle`, `sig`, `client_id`,
   `pow`, `relay_full` (also a new free identity, or a longer chain of one, once the free tier's
   ceiling is reached; and an agent whose identity rows, with its pool's, would pass the pool's
   storage). A relay failure is no check: CONNACK 3, and 503 from `/check`. Each POST
   /check counts as a login against `RELAY_LOGIN_RATE`, before its body is read.
4. Subscribe (QoS 1) to `m/<32 hex>` to claim a mailbox; anyone logged in may publish to it (QoS 1).
   `i/<32 hex>` is an invite topic: 4 messages / 64 KB, gone at the first message its reader
   acknowledges or after 7 days. Messages go when acknowledged, at most 7 days (to a reader in a
   Pro pool: its licence's retention, at most the Pro tier's in `allowance.mjs` TIERS; what a
   member uses stays charged to its pool after it leaves: its messages that day, its queue until
   it goes, its claims while held). At most
   128 topics in one SUBSCRIBE or UNSUBSCRIBE: a larger packet closes the connection. A CONNECT
   restores at most 256 of the reader's claims, the most recently claimed first; a SUBSCRIBE gets
   any other back (a topic held takes no claim token). An UNSUBSCRIBE gives a mailbox up at once;
   a queue longer than 512 messages is deleted in batches, and until then the topic is
   `mailbox_taken` and its messages are neither stored nor delivered. A reader
   gets its messages in the order they were stored, across its topics: while its queue goes out
   after a connect, live publishes to it wait their turn. A reader more than 1 MB behind (written to
   its connection, not taken), or whose socket takes nothing for 10 s, is closed: one stalled
   reader holds up no one else's delivery, and it gets what it missed at its next connection.
5. Later refusals arrive on `$sigelo/notice` as `{code, detail}`, every one named, written before
   the PUBACK, SUBACK or UNSUBACK of the request refused; a refused PUBLISH's also carries its
   packet id, `id`. Codes: `mailbox_taken`, `too_large`
   (over the smaller of the writer's and the reader's largest: 256 KB free, 1 MB in a Pro pool),
   `quota_storage` (the reader's allowance, the free tier's ceiling, past half of it a network's
   share, a pooled reader's share from writers outside its pool: a quarter of the pool, at least
   free's, or an invite full), `quota_messages`,
   `quota_mailboxes` (the identity's or pool's claims, or the free tier's ceiling), `pow` (a first claim or message without a proof), `rate` (publishes,
   topics subscribed and unsubscribed, or mailboxes claimed anew and given up, too fast, per
   identity or per /24 or /48, where free, pooled and unproven identities count apart; a refused
   UNSUBSCRIBE keeps the claim; past 500 refusals in a minute, every refused publish counted, the
   connection closes),
   `relay_full` (disk 70 % full: no publish queued, no new claim; claims held still work),
   `no_reader` (a publish to a topic nobody holds now: dropped, as before, but said), and
   right after a login `operator` or `licence` (the attestation pools nothing: the free tier). A
   refused publish is acknowledged and dropped; a publish to another topic, or at QoS 0 or 2,
   closes the connection.
6. `POST /licence` with the licence file (from the offline issuer) →
   `{ok: true, operator, exp, chain, claims}` or `{ok: false, check, detail}`. The operator logs in
   once with its bundle first, and again after each rotation of its key. 3 uploads a minute per
   /24 or /48.
7. `POST /gift` `{username, client_id, password, code_hash}`: the login fields of step 3 for the
   operator identity, then hex SHA-256("sigelo-gift/0" ‖ the code's 8 characters) → `{ok: true, exp,
   months}`: its pool is Pro to `exp`, or `{ok: false, check, detail}`: `gift` (unknown, used or
   expired, one answer), `gift_member` (an agent in a pool), `gift_term` (past 3 × 366 days ahead),
   `pow`, or the login's check. 10 tries an hour per /24 or /48 (429 `rate`), 300 in all.

## What the relay keeps

The database holds no DID in the clear: accounts are SHA-256 of the original DID; claims and
queued envelopes carry the reader's account and client id. Those are plain hashes of public
values, so whoever holds a list of DIDs finds their rows: a copy of the file tells which identities
use the relay. It does not tell who wrote to whom, or when: every time in it is the start of a UTC
day (`test/run.mjs` and `test/allowance.mjs` check each column), and a message row holds no time of
its own. Nor the order rows were written in: every table keyed by a hash or a random name has no
rowid, a message's id is random and its order a sequence of its reader's own; and every hour the
sweep rebuilds the tables of identities (accounts, claims, chains, proofs, pool rows, licences) in
key order, since SQLite places each new cell below the last in a page, so the cells' offsets told
the order of writing (`test/run.mjs` reads every page). The sender's side of a message (its count
today, the day of its login and of its claims' use) is kept in memory and written by the sweep,
every account in one transaction just before the WAL is truncated (the hourly tidy of licences,
proofs and pool rows runs in that transaction too), so no commit in the WAL holds a sender's row
beside its reader's message; what must be written at once (a new account, proof or claim, a
changed chain or pool row, a mailbox given up, a licence) is followed by a checkpoint that empties
the WAL, so it is not left in front of the next message, which its identity may have written
(`test/run.mjs` replays the WAL commit by commit, with and without the M4 policy); a chain or pool
row is written only when it changed. A message expires at the start of the day its retention ends, so it is kept at most its
retention, up to a day less; an invite topic lives 7 days to the end of that day; an idle mailbox
counts the day of its last use in full. The rotations of each identity's chain,
as last verified, are kept with its account, encrypted under a key derived from the original DID,
so a key the identity rotated away from stays refused across restarts; the SHA-256 of each DID of
that chain is kept beside it, so no other identity's chain can pass through one (a thief's genesis
put in front of the owner's would dodge the rotations kept), nor start at one (a stolen key the
owner rotated away from, logged in alone, would lock the owner out); a DID passes from one chain
to another only by a recovery rotation from it. Only someone who already
knows the original DID can read them, and the account key confirms that DID anyway. The DID cache
for logins without a bundle (current DID → account, key) is memory only. The log has logins,
refusals by check name, disconnects and errors, each with the address cut to /24 or /48: no DID,
client id, topic or payload (`test/run.mjs` checks the file, its WAL and the log), kept 7 days.
`stats_days` holds the relay's daily totals (numbers only, 90 days: Statistics).
Gift codes (`gifts.mjs`, POST /gift): per code its SHA-256 under "sigelo-gift/0", months, last day,
campaign and a used flag (no time, no account), until its last day; per campaign the counts. A
redeemed code's months sit on the redeemer's licence row (`gift_exp`), kept as a licence is. Loaded
with `node gifts.mjs load <file|->`, counted per campaign with `node gifts.mjs counts`, as the
relay's user, beside the running relay.
Acknowledged messages are overwritten in the file (`secure_delete`), and the sweep truncates the
WAL every minute. Accounts go 30 days after their last login once they hold no claim, no licence and
no operator attestation still running that they presented; idle mailboxes after their retention plus
7 days (at least 14). A sweep deletes at most 512 such rows together (expired messages and invites,
idle mailboxes, idle accounts with their chains' DIDs, though the last account's may pass the
count); the next goes on where it stopped. Of two licences for one operator the one the vendor
issued later is kept, so a reissue can end a term early. A licence is kept as hashes and numbers
until 30 days past the term sold (the term of the one it cut short, if later), used or not, and its
operator's account and chain with it: that chain holds any recovery from a stolen key, and gone, the
key recovered from logged in as the operator again.

## Load test (2026-10-06)

`node relay/test/load.mjs [--tls]`: 2,000 clients, 50 logging in at a time, relay and clients on
one 8-core ARM64 machine, Node 24.18, on loopback, relay in its own process. TLS: TLS 1.3 with a
self-signed Ed25519 certificate.

| | Plain TCP | TLS |
|---|---|---|
| Connected | 2,000 of 2,000 | 2,000 of 2,000 |
| Login rate, wall clock | 121 a second (16.5 s) | 99 a second (20.2 s) |
| Login latency | p50 378 ms, p95 567 ms, max 936 ms | p50 476 ms, p95 665 ms, max 1,198 ms |
| Relay CPU per login | 9.6 ms: 105 logins a second per core | 13.7 ms: 73 logins a second per core |
| Relay memory after GC | RSS 89 → 225 MB: 70 KB per idle connection | RSS 91 → 333 MB: 124 KB per idle connection |

The clients sign in the same machine. For the plan's 10,000 agents over TLS: about 1.2 GB for
connections and a full reconnect in about 140 s (the relay has one thread). A 2-vCPU, 4 GB VPS
still fits; the unit caps the relay at 3 GB.

## Known limits

- Rate limits count per /24 or /48. Many /48s (IPv6 address rotation) beat them (plan §10, R15);
  `RELAY_MAX_SESSIONS` and the budget for unfinished packets still bound the memory sessions hold,
  so a flood of them refuses new logins (`relay_full`) rather than ending the process for everyone.
  The same holds for the free tier's ceiling: one network may fill no more than a 64th of it once
  it is half full, many networks can fill it.
- The counts and days the sweep writes are lost if the process dies between two sweeps (a minute
  at most); plan §6 lets counters be lost.
- With few messages a minute, the sweep's one transaction still names the accounts that sent in
  that minute, and the next minute's message commits their readers: the WAL holds no pairing of the
  two, but a copy taken at a quiet time narrows it down. Deliveries and acknowledgements write the
  reader's message rows: a copy of the WAL taken between two sweeps shows one before a message its
  reader then wrote. Rows added to the identity tables keep the order of writing in their pages
  until the hourly rebuild, and message rows and their index entries, which name only readers,
  until they go. The rebuild holds the relay's one thread about 0.9 s per 100,000 claims (with
  10,000 accounts, measured on a phone-class ARM64 CPU).
- An account and its kept chain go 30 days after the last login once no claim, no licence and no
  running attestation from an operator licensed here is held; a key the identity rotated away from could then log in as
  a new identity. Such a login never moves a licence: only a chain through the key it is on, or a
  recovery rotation from a key its operator held, does.
- A publish to a topic nobody holds now is dropped, as by any broker, and the writer gets
  `no_reader`: a reader subscribes to its topics (next week's included) before its contacts
  write, but one away longer than it claims ahead has not. The carrier then refuses that message
  and anything else to that contact until its next round, and begins a new epoch.
- An invite topic lives 7 days after its claim, whatever the code's own expiry, which the relay
  cannot read (4 messages / 64 KB at most).
- WebSocket (later) behind nginx would show every client as 127.0.0.1: it must take
  `X-Real-IP` from loopback only, as `/challenge` and `/check` do, or per-address limits become
  one bucket.
