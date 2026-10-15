// SPDX-License-Identifier: AGPL-3.0-only
// relay/stats.mjs — the relay's counts, and nothing else: GET /stats on the loopback HTTP port,
// which nginx serves as https://relay.sigelo.ai/stats (CORS open, cached 60 s).
//
// Every number is a count of the whole relay: no DID, account, client id, topic, address or prefix,
// and no list of anything (deploy/README.md "Statistics"; test/run.mjs checks the shape and that no
// identifier of the run reaches it). Read from the tables where they already hold the number
// (identities, mailboxes, messages queued, proofs of work, licences, the free tier's ceiling, gift
// codes loaded and used over all campaigns, no label: gifts.mjs);
// counted in memory where nothing else keeps it (logins, refusals by check or code, messages stored
// and delivered, the most sessions at once), per UTC day.
//
// Day history: stats_days, one row per UTC day (day = its start, as every time in the file) with
// that day's counts as JSON, 90 days kept. Written by the sweep, inside its transaction, every
// minute (mailbox.mjs passes flush as part of its tidy), so a restart loses at most a minute of
// the day's counts (plan §6 lets counters be lost) and today's row is read back at start. A count
// tells nothing of who: the rows hold numbers only.
import { DAY, dayOf } from './db.mjs';

export const KEEP_DAYS = 90, HISTORY_DAYS = 30, CACHE_SECONDS = 60;
const SCHEMA = `
CREATE TABLE IF NOT EXISTS stats_days (
  day    INTEGER PRIMARY KEY,   -- the start of a UTC day (db.mjs dayOf)
  counts TEXT NOT NULL          -- that day's counts, JSON: numbers only (COUNTERS, TAKEN)
) STRICT, WITHOUT ROWID;`;
// Counted in memory per day: plain numbers, and refusals by name (auth.mjs CHECKS, mailbox.mjs codes).
const COUNTERS = ['logins', 'stored', 'delivered', 'sessions_peak'];
const BY_NAME = ['login_refused', 'refused'];
// Read from the tables at each flush, so a past day keeps its last value.
const TAKEN = ['identities', 'new_identities', 'pow_solved', 'mailboxes', 'queued'];
// A name a refusal may carry: lowercase words, as every check and code is. Anything else is
// counted as "other", so no text can ride into the output.
const NAME = /^[a-z][a-z_]{0,31}$/;

const empty = () => ({ ...Object.fromEntries([...COUNTERS, ...TAKEN].map((k) => [k, 0])), ...Object.fromEntries(BY_NAME.map((k) => [k, {}])) });
const iso = (day) => new Date(day * 1000).toISOString().slice(0, 10);
const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
// The stored JSON back to counts: unknown keys dropped, every value a whole number >= 0.
function counted(json) {
  const c = empty();
  let v;
  try { v = JSON.parse(json); } catch { return c; }
  for (const k of [...COUNTERS, ...TAKEN]) if (Number.isSafeInteger(v?.[k]) && v[k] >= 0) c[k] = v[k];
  for (const k of BY_NAME) for (const [name, n] of Object.entries(v?.[k] ?? {})) if (NAME.test(name) && Number.isSafeInteger(n) && n > 0) c[k][name] = n;
  return c;
}

// db: db.mjs; clock() → unix seconds; sessions() → sessions connected now (auth.mjs);
// policy: allowance.mjs's (freeQueue, freeUsed, giftTotals), or {} without M4.
// → { count(kind, name?), sessions(n), flush(now), report(), close() }.
export function relayStats({ db, clock, sessions = () => 0, policy = {} }) {
  const raw = db.raw;
  raw.exec(SCHEMA);
  const has = (t) => raw.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t) !== undefined;
  const one = (sql, ...p) => Number(raw.prepare(sql).get(...p)?.n ?? 0);
  const q = {
    get: raw.prepare('SELECT counts FROM stats_days WHERE day = ?'),
    put: raw.prepare('INSERT INTO stats_days (day, counts) VALUES (?1, ?2) ON CONFLICT (day) DO UPDATE SET counts = ?2'),
    old: raw.prepare('DELETE FROM stats_days WHERE day < ?'),
    days: raw.prepare('SELECT day, counts FROM stats_days WHERE day >= ? ORDER BY day'),
  };
  // Today's counts, read back after a restart; days finished and not yet written (a rollover
  // between two flushes).
  let day = dayOf(clock()), cur = counted(q.get.get(day)?.counts ?? '{}');
  const done = new Map();
  const roll = (now) => {
    const d = dayOf(now);
    if (d === day) return;
    done.set(day, cur);
    day = d; cur = counted(q.get.get(d)?.counts ?? '{}');
    // The day starts with the sessions still connected.
    cur.sessions_peak = Math.max(cur.sessions_peak, sessions());
  };
  // What the tables hold now, for the counts of `d`.
  function taken(now) {
    const d = dayOf(now);
    return {
      identities: one('SELECT count(*) AS n FROM accounts'),
      new_identities: one('SELECT count(*) AS n FROM accounts WHERE created = ?', d),
      pow_solved: has('pow_proofs') ? one('SELECT count(*) AS n FROM pow_proofs WHERE at = ?', d) : 0,
      mailboxes: one('SELECT count(*) AS n FROM claims WHERE dead = 0 AND expires IS NULL'),
      queued: one('SELECT count(*) AS n FROM messages'),
    };
  }
  let cache = null;

  return {
    // One event: kind is a COUNTERS or BY_NAME key; name the check or code for BY_NAME.
    count(kind, name) {
      roll(clock());
      if (BY_NAME.includes(kind)) { const k = NAME.test(name ?? '') ? name : 'other'; cur[kind][k] = (cur[kind][k] ?? 0) + 1; }
      else if (COUNTERS.includes(kind)) cur[kind]++;
    },
    // Sessions connected now (after a login took a seat): the day's peak.
    sessions(n) { roll(clock()); if (n > cur.sessions_peak) cur.sessions_peak = n; },
    // Inside the sweep's transaction (mailbox.mjs): the days finished, then today with what the
    // tables hold now; days past KEEP_DAYS go.
    flush(now = clock()) {
      roll(now);
      for (const [d, c] of done) q.put.run(d, JSON.stringify(c));
      done.clear();
      Object.assign(cur, taken(now));
      q.put.run(day, JSON.stringify(cur));
      q.old.run(day - KEEP_DAYS * DAY);
    },
    // GET /stats: computed at most once a CACHE_SECONDS.
    report() {
      const now = clock();
      if (cache && now - cache.at < CACHE_SECONDS && dayOf(now) === dayOf(cache.at)) return cache.body;
      roll(now);
      const t = taken(now);
      const today = { ...cur, ...t };
      const free = Number.isSafeInteger(policy.freeQueue) && policy.freeQueue > 0 && typeof policy.freeUsed === 'function'
        ? Math.round((policy.freeUsed() / policy.freeQueue) * 1000) / 10 : null;
      const licences = has('licences') ? one('SELECT count(*) AS n FROM licences WHERE exp > ?', now) : 0;
      const past = q.days.all(day - (HISTORY_DAYS - 1) * DAY).filter((r) => r.day < day).map((r) => [r.day, counted(r.counts)]);
      const row = (d, c) => ({
        day: iso(d), identities: c.identities, new_identities: c.new_identities, logins: c.logins, sessions_peak: c.sessions_peak,
        stored: c.stored, delivered: c.delivered, refused: sum(c.refused), login_refused: sum(c.login_refused), pow_solved: c.pow_solved,
      });
      const body = {
        v: 'sigelo-relay-stats/0',
        at: new Date(now * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
        day: iso(day),
        identities: { total: t.identities, new_today: t.new_identities },
        logins_today: today.logins,
        logins_refused_today: { ...today.login_refused },
        sessions: { now: sessions(), peak_today: Math.max(today.sessions_peak, sessions()) },
        mailboxes_claimed: t.mailboxes,
        messages: { queued: t.queued, stored_today: today.stored, delivered_today: today.delivered, refused_today: { ...today.refused } },
        pow_solved_today: t.pow_solved,
        free_queue_used_pct: free,
        pro_licences_active: licences,
        gifts: typeof policy.giftTotals === 'function' ? policy.giftTotals() : { issued: 0, redeemed: 0 },
        days: [...past.map(([d, c]) => row(d, c)), row(day, today)],
      };
      cache = { at: now, body };
      return body;
    },
  };
}
