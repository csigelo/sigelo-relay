<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# ntfy beside the relay: push.sigelo.ai

A UnifiedPush server for phones without one of their own (design/push.md §5, decided 2026-11-19). The
sigelo app on Android connects to it itself by default (Built in, design/push.md §6, since 2026-11-25): one
stream to its own random `up` topic, no second app. The alternative is the user's push app (a "distributor":
the ntfy app from F-Droid, NextPush, Sunup…), which holds the connection and gives an endpoint URL; a user
with no server of their own points it at `push.sigelo.ai`. The relay POSTs a 135-byte wake to the endpoint
when mail waits for a phone that is not connected (`relay/push.mjs`, sigelo-push/0).

What runs: the ntfy binary as `ntfy.service` on 127.0.0.1:2586, behind nginx on 443 (`nginx-push.conf`).
Topics whose name begins with `up` (the ntfy app makes each one random: the URL is the capability) may be
published and read by anyone; every other topic is refused (`auth-default-access: deny-all`). No
accounts, sign-up, web app, attachments, Firebase or Apple upstream. Messages kept 12 hours. Rate
limits per subscribing phone. No access log (a path is a phone's capability); the error log at crit.

What it sees: a phone's address while its connection is open (Sigelo's own or the ntfy app's), and that a wake for it came from the
relay at a time. Not a sender, a kind, an account or any content (THREAT-MODEL §3.12).

## Install (once, as root on the relay's host)

Before: a DNS A and AAAA record for `push.sigelo.ai` pointing at this host. Not part of `deploy.sh`.

```sh
# 1. The binary: a pinned release from github.com/binwiederhier/ntfy, checked against that release's checksums.txt.
V=2.38.2   # or the newest release; read its notes first
A=$(dpkg --print-architecture)                                        # arm64 on the relay's host, amd64 elsewhere
R=/opt/sigelo-relay/app/deploy/ntfy                                   # these files, as deploy.sh put them
D=$(mktemp -d) && cd "$D" && curl -fsSLO "https://github.com/binwiederhier/ntfy/releases/download/v$V/ntfy_${V}_linux_$A.tar.gz" \
  && curl -fsSLO "https://github.com/binwiederhier/ntfy/releases/download/v$V/checksums.txt" \
  && grep " ntfy_${V}_linux_$A.tar.gz\$" checksums.txt | sha256sum -c - \
  && tar -xzf "ntfy_${V}_linux_$A.tar.gz" && install -o root -g root -m 0755 "ntfy_${V}_linux_$A/ntfy" /usr/local/bin/ntfy
/usr/local/bin/ntfy --help >/dev/null && echo ok && cd / && rm -rf "$D"

# 2. User, config (this host's public addresses exempt from the rate limit: the relay's wakes come from them), unit, journal.
useradd --system --no-create-home --shell /usr/sbin/nologin ntfy
install -d -m 0755 /etc/ntfy
A4=$(ip -4 -o addr show scope global | awk '{sub("/.*","",$4); print $4; exit}')   # or type them; IPv6 optional
A6=$(ip -6 -o addr show scope global | awk '{sub("/.*","",$4); print $4; exit}')
ADDRS="$A4${A6:+,$A6}"; echo "$ADDRS"                                  # no empty entry when there is no IPv6
sed "s|HOST_ADDRESSES|$ADDRS|" "$R/server.yml" > /etc/ntfy/server.yml && chmod 0644 /etc/ntfy/server.yml
install -m 0644 "$R/ntfy.service" /etc/systemd/system/ntfy.service
printf '[Journal]\nMaxRetentionSec=7day\n' > /etc/systemd/journald@ntfy.conf
systemctl daemon-reload && systemctl enable --now ntfy
# The UnifiedPush topics open to all, nothing else (needs the auth file the service just made):
runuser -u ntfy -- /usr/local/bin/ntfy access everyone 'up*' read-write
runuser -u ntfy -- /usr/local/bin/ntfy access                        # shows: everyone, up*, read-write

# 3. The certificate (the relay's webroot, as relay/deploy/README.md "Certificate"), then nginx.
printf '%s\n' 'server {' '    listen 80;' '    listen [::]:80;' '    server_name push.sigelo.ai;' '    access_log off;' \
  '    error_log /var/log/nginx/sigelo/error.log crit;' '    location ^~ /.well-known/acme-challenge/ {' '        root /var/www/acme;' '    }' \
  '    location / {' '        return 404;' '    }' '}' > /etc/nginx/conf.d/sigelo-push.conf
nginx -t && systemctl reload nginx
certbot certonly --webroot -w /var/www/acme --cert-name push.sigelo.ai -d push.sigelo.ai
install -m 0644 "$R/nginx-push.conf" /etc/nginx/conf.d/sigelo-push.conf
nginx -t && systemctl reload nginx                                  # the relay's deploy hook already reloads nginx at renewals
```

The relay needs nothing for this: push is on by default (`RELAY_PUSH`, `RELAY_PUSH_KEY` in
relay/deploy/README.md); it makes `/var/lib/sigelo-relay/push.key` at its first start with push.mjs. Its
wakes go out over https to any public address: the host's nftables output policy must let the relay's
user connect out on 443 (it does unless output is filtered).

## Check

```sh
curl -fsS https://push.sigelo.ai/v1/health                                    # {"healthy":true}
T=up$(head -c 9 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 12)
curl -s -o /dev/null -w '%{http_code}\n' -d hi "https://push.sigelo.ai/$T?up=1"  # 507: no subscriber yet (50701)
curl -fsS -o /dev/null "https://push.sigelo.ai/$T/json?poll=1"                # a subscriber (as the phone's app)
curl -fsS -d hi "https://push.sigelo.ai/$T?up=1" && echo                      # 200: a UnifiedPush topic takes a message
curl -s -o /dev/null -w '%{http_code}\n' -d hi https://push.sigelo.ai/news    # 403: any other topic is refused
journalctl --namespace=ntfy -n 20                                             # warnings only
```

On a phone: Sigelo → Settings → Notifications → Built in (the default) shows "Ready: sigelo wakes when a
message waits." and "Relay: registered." Swipe Sigelo away, send it a message from another device: "New
activity" shows. The alternative, Push app: the ntfy app (F-Droid) → Settings → Default server
`https://push.sigelo.ai`; then Sigelo → Settings → Notifications → Push app: "Ready: ntfy wakes sigelo when a
message waits."

## Remove

```sh
systemctl disable --now ntfy && rm /etc/nginx/conf.d/sigelo-push.conf && nginx -t && systemctl reload nginx
```

Phones pointed at it then get no wakes; sigelo says nothing until the user opens it (a relay wake to a
gone endpoint fails, and the relay tries again at the next message).
