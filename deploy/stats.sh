#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# deploy/stats.sh — the visit statistics of sigelo.ai and relay.sigelo.ai, rebuilt every 10 minutes
# by sigelo-relay-stats.timer (root) into /var/www/sigelo.ai/stats, which nginx serves at
# https://sigelo.ai/_stats/ behind basic auth (deploy/nginx.conf). Installed by
# site/deploy/server-setup.sh --relay (R16) as /usr/local/sbin/sigelo-relay-stats, with
# stats-chart.mjs beside it as /usr/local/sbin/sigelo-relay-stats-chart.mjs. Server-side only: no
# script, cookie or tracker on the public pages.
#
#   sigelo-relay-stats [LOGDIR [OUTDIR [STATS_URL]]]
#       default /var/log/nginx/sigelo /var/www/sigelo.ai/stats http://127.0.0.1:8791/stats
#
# Writes, each atomically (a .new file moved into place):
#   index.html    GoAccess over sigelo.ai's access.log* (every file logrotate keeps: 7 days)
#   api.html      GoAccess over relay.sigelo.ai's relay-access.log* (the relay's HTTP calls)
#   relay.html    the relay's counts, 30 days, as charts (stats-chart.mjs over GET /stats)
#   summary.txt   visits a day, agents and bots against browsers, top pages, the relay's counts
#                 today: plain text, phone-sized
#   daily.log     summary.txt's block for each finished UTC day, appended once (the last 3,000
#                 lines kept): for reading over ssh, `cat /var/www/sigelo.ai/stats/daily.log`
# The logs are nginx.conf's log_format sigelo_anon: the address already cut to /24 or /48, no query
# string (GoAccess's --anonymize-ip cuts once more; its hosts panel is off). The project's own
# requests (user agent sigelo-selfcheck/) are in access-self.log, which is not read here. Every
# number below is a count; no address or prefix is written to any output.
set -eu
LOGS=${1:-/var/log/nginx/sigelo}
OUT=${2:-/var/www/sigelo.ai/stats}
URL=${3:-http://127.0.0.1:8791/stats}
HERE=$(cd "$(dirname "$0")" && pwd)
CHART=$HERE/sigelo-relay-stats-chart.mjs
[ -f "$CHART" ] || CHART=$HERE/stats-chart.mjs
umask 022
mkdir -p "$OUT"

# cat_logs PREFIX: every rotation of $LOGS/PREFIX.log, oldest first, decompressed.
cat_logs() {
  for f in $(ls -1r "$LOGS/$1".log.* 2>/dev/null) "$LOGS/$1.log"; do
    [ -f "$f" ] || continue
    case $f in *.gz) gzip -dc "$f" ;; *) cat "$f" ;; esac
  done
}
put() { chmod 0644 "$1.new"; mv -f "$1.new" "$1"; }

# GoAccess, as sigelo.io's sigelo-stats runs it (site/deploy/server-setup.sh --stats).
report() {  # PREFIX OUTFILE TITLE
  if ! command -v goaccess >/dev/null 2>&1; then echo "sigelo-relay-stats: no goaccess" >&2; return 0; fi
  if [ ! -s "$LOGS/$1.log" ] && ! ls "$LOGS/$1".log.* >/dev/null 2>&1; then echo "sigelo-relay-stats: no $1.log yet"; return 0; fi
  cat_logs "$1" | grep -v '^- ' | goaccess - --no-global-config \
      --log-format='%h %^ %^ [%d:%t %^] "%m %U %H" %s %b "%R" "%u" "%^" %T' \
      --date-format='%d/%b/%Y' --time-format='%H:%M:%S' \
      --anonymize-ip --ignore-panel=HOSTS --ignore-panel=REMOTE_USER --ignore-panel=GEO_LOCATION \
      --no-query-string --num-tests=0 --html-report-title="$3" \
      -o "$OUT/$2.new.html"
  mv -f "$OUT/$2.new.html" "$OUT/$2.new"
  put "$OUT/$2"
}
report access index.html 'sigelo.ai, last 7 days'
report relay-access api.html 'relay.sigelo.ai HTTP calls, last 7 days'

# The relay's counts: one fetch, kept for the chart and the summary. A relay that is down leaves the
# last chart in place.
json=$(mktemp); trap 'rm -f "$json" "$json.new"' EXIT   # outside the served directory
if node -e '
  const r = await fetch(process.argv[1], { headers: { "user-agent": "sigelo-selfcheck/1 (+https://sigelo.ai/privacy)" }, signal: AbortSignal.timeout(10000) });
  if (!r.ok) process.exit(1);
  process.stdout.write(JSON.stringify(await r.json()));
' --input-type=module "$URL" > "$json.new" 2>/dev/null; then
  mv -f "$json.new" "$json"
  if node "$CHART" < "$json" > "$OUT/relay.html.new"; then put "$OUT/relay.html"; else rm -f "$OUT/relay.html.new"; echo "sigelo-relay-stats: stats-chart.mjs failed" >&2; fi
else
  rm -f "$json.new" "$json"; echo "sigelo-relay-stats: GET $URL failed: relay.html kept" >&2
fi
relayline=$( [ -f "$json" ] && node -e '
  const s = JSON.parse(require("node:fs").readFileSync(0, "utf8")), n = (v) => (Number.isSafeInteger(v) ? v : "-");
  const sum = (o) => Object.values(o ?? {}).reduce((a, b) => a + (Number.isSafeInteger(b) ? b : 0), 0);
  console.log(`relay ${String(s.day).slice(0, 10)}: identities ${n(s.identities?.total)} (+${n(s.identities?.new_today)}), logins ${n(s.logins_today)}, sessions ${n(s.sessions?.now)} (peak ${n(s.sessions?.peak_today)})`);
  console.log(`  messages stored ${n(s.messages?.stored_today)}, delivered ${n(s.messages?.delivered_today)}, queued ${n(s.messages?.queued)}, refused ${sum(s.messages?.refused_today)}, logins refused ${sum(s.logins_refused_today)}`);
  console.log(`  mailboxes ${n(s.mailboxes_claimed)}, pow ${n(s.pow_solved_today)}, free queue ${s.free_queue_used_pct ?? "-"} %, Pro licences ${n(s.pro_licences_active)}`);
' < "$json" 2>/dev/null || true)

# summarize DAY|all: the text summary of the site's and the relay host's logs, for one UTC day
# (YYYY-MM-DD) or the whole window. Classes by user agent, first match wins (stats-agents.sh's of
# sigelo.io): AI agents by name, programmatic clients, other crawlers, browsers, other. 301s are
# redirect hops, not visits; top pages count 200 and 304 only, so scanners' 404s do not crowd
# them. ~vis = distinct (network, user agent, day): an estimate.
summarize() {
  { cat_logs access | sed 's/^/S /'; cat_logs relay-access | sed 's/^/R /'; } | awk -F'"' -v want="$1" '
  function cls(ua,    u, i) {
    u = tolower(ua)
    if (index(u, "claude-code/")) return "ai"
    for (i = 1; i <= nai; i++) if (index(u, tolower(ai[i]))) return "ai"
    if (u ~ /^(node|undici|curl|wget|python-requests|go-http-client|python-urllib|python-httpx|aiohttp|axios|node-fetch|deno|bun)([\/ ]|$)/) return "prog"
    if (u ~ /bot|crawl|spider|slurp/) return "crawl"
    if (u ~ /^mozilla\//) return "browser"
    return "other"
  }
  function top(arr, n, label,    k, best, bk, i) {
    print label
    for (i = 1; i <= n; i++) {
      best = 0; bk = ""
      for (k in arr) if (arr[k] > best) { best = arr[k]; bk = k }
      if (bk == "") { if (i == 1) print "  (none)"; break }
      printf "  %6d %s\n", best, substr(bk, 1, 30); delete arr[bk]
    }
  }
  BEGIN {
    nai = split("ClaudeBot Claude-User Claude-SearchBot anthropic-ai GPTBot OAI-SearchBot ChatGPT-User PerplexityBot Perplexity-User CCBot Amazonbot Amzn-SearchBot Amzn-User Meta-ExternalAgent Meta-ExternalFetcher MistralAI-User DuckAssistBot Google-Agent Google-GeminiNotebook Bytespider", ai, " ")
    split("Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec", m, " ")
    for (i = 1; i <= 12; i++) mon[m[i]] = sprintf("%02d", i)
    split("ai prog crawl browser other", order, " ")
    lab["ai"] = "AI agents"; lab["prog"] = "programmatic"; lab["crawl"] = "other crawlers"; lab["browser"] = "browsers"; lab["other"] = "other"
  }
  NF >= 7 {
    nh = split($1, h, " "); host = h[1]; net = h[2]; day = ""
    for (i = 3; i <= nh; i++) if (substr(h[i], 1, 1) == "[") { day = substr(h[i], 9, 4) "-" mon[substr(h[i], 5, 3)] "-" substr(h[i], 2, 2); break }
    if (day == "" || (want != "all" && day != want)) next
    split($2, r, " "); path = r[2]
    split($3, s, " "); st = s[1]
    if (st == "301") next
    c = cls($6)
    if (host == "R") { api[c]++; if (st == "200") calls[path]++; next }
    req[c]++; total++
    if (!((net SUBSEP $6 SUBSEP day) in seen)) { seen[net, $6, day] = 1; vis[c]++; tvis++; dvis[day]++ }
    if (st == "200" || st == "304") { if (c == "browser") phum[path]++; else if (c == "ai" || c == "prog") pag[path]++ }
  }
  END {
    if (want == "all") { print "visits a day (~vis, sigelo.ai)"; n = 0; for (d in dvis) days[++n] = d
      for (i = 1; i <= n; i++) for (j = i + 1; j <= n; j++) if (days[j] < days[i]) { t = days[i]; days[i] = days[j]; days[j] = t }
      for (i = 1; i <= n; i++) printf "  %s %6d\n", days[i], dvis[days[i]]
      if (n == 0) print "  (none)" }
    printf "%-15s %7s %6s %6s\n", "sigelo.ai", "req", "~vis", "api"
    for (i = 1; i <= 5; i++) printf "%-15s %7d %6d %6d\n", lab[order[i]], req[order[i]], vis[order[i]], api[order[i]]
    printf "%-15s %7d %6d\n", "total", total, tvis
    printf "bots vs browsers: %d vs %d requests\n", req["ai"] + req["prog"] + req["crawl"], req["browser"]
    top(phum, 6, "top pages, browsers")
    top(pag, 6, "top pages, agents")
    top(calls, 5, "relay.sigelo.ai calls (200)")
  }'
}

now=$(date -u '+%Y-%m-%d %H:%M UTC')
{
  printf 'sigelo.ai visits, %s (7 days kept)\n' "$now"
  summarize all
  [ -z "$relayline" ] || printf '%s\n' "$relayline"
} > "$OUT/summary.txt.new"
put "$OUT/summary.txt"

# Yesterday's block, once: the day is in the logs for 7 days, so a run missed for up to a week
# still writes it.
yday=$(date -u -d "@$(( $(date -u +%s) - 86400 ))" '+%Y-%m-%d')
log=$OUT/daily.log
if ! grep -qx "== $yday" "$log" 2>/dev/null; then
  rday=$( [ -f "$json" ] && node -e '
    const s = JSON.parse(require("node:fs").readFileSync(0, "utf8")), d = (s.days ?? []).find((x) => x.day === process.argv[1]);
    if (d) console.log(`relay: identities ${d.identities} (+${d.new_identities}), logins ${d.logins}, peak sessions ${d.sessions_peak}, messages stored ${d.stored}, delivered ${d.delivered}, refused ${d.refused}, logins refused ${d.login_refused}, pow ${d.pow_solved}`);
  ' "$yday" < "$json" 2>/dev/null || true)
  { [ ! -f "$log" ] || tail -n 3000 "$log"; printf '== %s\n' "$yday"; summarize "$yday"; [ -z "$rday" ] || printf '%s\n' "$rday"; } > "$log.new"
  put "$log"
fi
echo "sigelo-relay-stats: $OUT rebuilt ($now)"
