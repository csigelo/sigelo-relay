#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// deploy/stats-chart.mjs — the relay's counts as one static HTML page: GET /stats (relay/stats.mjs)
// on stdin, the page on stdout. deploy/stats.sh runs it every 10 minutes into
// /var/www/sigelo.ai/stats/relay.html, served at https://sigelo.ai/_stats/relay.html behind basic
// auth. Inline SVG and inline CSS, no script, nothing fetched: the page works under the /_stats/
// CSP (deploy/nginx.conf). Every value is checked to be a whole number before it is drawn, and
// every text is escaped: the input comes from the relay process, not from root.
//
//   node stats-chart.mjs < stats.json > relay.html
//   node stats-chart.mjs --self-test
import { readFileSync } from 'node:fs';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const whole = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : 0);
const fmt = (n) => n.toLocaleString('en');
const DAY_RE = /^\d{4}-\d\d-\d\d$/;

// The four series of the brief: 30-day lines, one panel each (small multiples, one colour).
const SERIES = [
  { key: 'identities', title: 'Identities', note: 'total at the end of the day' },
  { key: 'delivered', title: 'Messages delivered', note: 'a day' },
  { key: 'refusals', title: 'Refusals', note: 'notices and refused logins, a day' },
  { key: 'sessions_peak', title: 'Sessions', note: 'most connected at once, a day' },
];

// days → 30 points, oldest first, a missing day as a gap (null).
function points(days, key, last) {
  const by = new Map(days.map((d) => [d.day, d]));
  const end = Date.parse(`${last}T00:00:00Z`), out = [];
  for (let i = 29; i >= 0; i--) {
    const day = new Date(end - i * 86400e3).toISOString().slice(0, 10), d = by.get(day);
    out.push({ day, v: d ? (key === 'refusals' ? whole(d.refused) + whole(d.login_refused) : whole(d[key])) : null });
  }
  return out;
}

// One panel: a line over 30 days, the y axis from 0 to a round maximum, the last value labelled.
function panel(s, pts) {
  const W = 560, H = 180, L = 44, R = 16, T = 14, B = 26, w = W - L - R, h = H - T - B;
  const vals = pts.map((p) => p.v).filter((v) => v !== null), max = Math.max(1, ...vals);
  const step = 10 ** Math.floor(Math.log10(max)), top = Math.ceil(max / step) * step;
  const x = (i) => L + (i / (pts.length - 1)) * w, y = (v) => T + h - (v / top) * h;
  let path = '', pen = false;
  pts.forEach((p, i) => { if (p.v === null) { pen = false; return; } path += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`; pen = true; });
  const grid = [0, top / 2, top].map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${L - 6}" y="${y(v) + 4}" class="tick" text-anchor="end">${esc(fmt(v))}</text>`).join('');
  const ticks = [0, 14, 29].map((i) => `<text x="${x(i)}" y="${H - 6}" class="tick" text-anchor="${i === 0 ? 'start' : i === 29 ? 'end' : 'middle'}">${esc(pts[i].day.slice(5))}</text>`).join('');
  const lastI = pts.findLastIndex((p) => p.v !== null);
  const dot = lastI < 0 ? '' : `<circle cx="${x(lastI)}" cy="${y(pts[lastI].v)}" r="3.5" class="dot"/>`;
  const now = lastI < 0 ? '–' : fmt(pts[lastI].v);
  const title = `${s.title}, last 30 days`;
  const desc = pts.filter((p) => p.v !== null).map((p) => `${p.day}: ${p.v}`).join('; ') || 'no data yet';
  return `<section class="card"><h2>${esc(s.title)} <span class="now">${esc(now)}</span></h2><p class="note">${esc(s.note)}</p>
<svg viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="t-${s.key} d-${s.key}"><title id="t-${s.key}">${esc(title)}</title><desc id="d-${s.key}">${esc(desc)}</desc>${grid}${ticks}<path d="${path}" class="line"/>${dot}</svg></section>`;
}

export function page(stats) {
  if (stats === null || typeof stats !== 'object') throw new Error('not a stats object');
  const days = (Array.isArray(stats.days) ? stats.days : []).filter((d) => d && DAY_RE.test(d.day));
  const last = DAY_RE.test(stats.day) ? stats.day : days.at(-1)?.day ?? new Date().toISOString().slice(0, 10);
  const m = stats.messages ?? {}, sum = (o) => Object.values(o ?? {}).reduce((a, b) => a + whole(b), 0);
  const tiles = [
    ['Identities', whole(stats.identities?.total), `+${fmt(whole(stats.identities?.new_today))} today`],
    ['Sessions now', whole(stats.sessions?.now), `peak ${fmt(whole(stats.sessions?.peak_today))} today`],
    ['Logins today', whole(stats.logins_today), `${fmt(sum(stats.logins_refused_today))} refused`],
    ['Delivered today', whole(m.delivered_today), `${fmt(whole(m.stored_today))} stored, ${fmt(whole(m.queued))} queued`],
    ['Mailboxes', whole(stats.mailboxes_claimed), `${fmt(whole(stats.pow_solved_today))} proofs of work today`],
    ['Free queue used', typeof stats.free_queue_used_pct === 'number' && stats.free_queue_used_pct >= 0 ? `${stats.free_queue_used_pct} %` : '–', `${fmt(whole(stats.pro_licences_active))} Pro licences`],
  ].map(([k, v, sub]) => `<div class="tile"><div class="k">${esc(k)}</div><div class="v">${esc(typeof v === 'number' ? fmt(v) : v)}</div><div class="sub">${esc(sub)}</div></div>`).join('');
  const byName = (title, o) => {
    const rows = Object.entries(o ?? {}).filter(([k]) => /^[a-z][a-z_]{0,31}$/.test(k)).map(([k, v]) => [k, whole(v)]).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
    return `<section class="card"><h2>${esc(title)}</h2>${rows.length ? `<table>${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td class="n">${esc(fmt(v))}</td></tr>`).join('')}</table>` : '<p class="note">none today</p>'}</section>`;
  };
  const at = typeof stats.at === 'string' && /^[\dTZ:-]+$/.test(stats.at) ? stats.at : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><title>Relay counts</title>
<style>
:root{--bg:#fbfaf7;--card:#fff;--ink:#1d1d1b;--muted:#6b6a65;--grid:#e6e3dc;--accent:#2a6fdb}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--card:#1e1e1c;--ink:#ecebe6;--muted:#a3a19a;--grid:#34332f;--accent:#7aa7f5}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1180px;margin:0 auto;padding:20px 16px 40px}h1{font-size:22px;margin:0 0 4px}.at{color:var(--muted);margin:0 0 18px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin-bottom:14px}
.tile,.card{background:var(--card);border:1px solid var(--grid);border-radius:10px;padding:12px 14px}
.k{color:var(--muted);font-size:13px}.v{font-size:26px;font-weight:600;font-variant-numeric:tabular-nums}.sub{color:var(--muted);font-size:13px}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,520px),1fr));gap:14px}
h2{font-size:16px;margin:0}.now{float:right;font-variant-numeric:tabular-nums}.note{color:var(--muted);font-size:13px;margin:2px 0 6px}
svg{width:100%;height:auto;display:block}.grid{stroke:var(--grid);stroke-width:1}.tick{fill:var(--muted);font-size:11px}
.line{fill:none;stroke:var(--accent);stroke-width:2.25;stroke-linejoin:round;stroke-linecap:round}.dot{fill:var(--accent)}
table{width:100%;border-collapse:collapse}td{padding:3px 0;border-bottom:1px solid var(--grid)}td.n{text-align:right;font-variant-numeric:tabular-nums}
nav{margin-top:18px;color:var(--muted)}nav a{color:var(--accent)}
</style></head><body><main>
<h1>sigelo relay: counts</h1><p class="at">${esc(at)} · from https://relay.sigelo.ai/stats · counts only, no identifier · UTC days</p>
<div class="tiles">${tiles}</div>
<div class="grid2">${SERIES.map((s) => panel(s, points(days, s.key, last))).join('\n')}
${byName('Notices today, by code', m.refused_today)}
${byName('Logins refused today, by check', stats.logins_refused_today)}</div>
<nav><a href="index.html">sigelo.ai visits</a> · <a href="api.html">relay.sigelo.ai calls</a> · <a href="summary.txt">summary.txt</a> · <a href="daily.log">daily.log</a></nav>
</main></body></html>
`;
}

if (process.argv[2] === '--self-test') {
  // Hostile text in every string field and in the refusal names; numbers out of range.
  const evil = '<script>alert(1)</script>';
  const html = page({ v: evil, at: evil, day: '2026-10-14', identities: { total: 5, new_today: -3 }, logins_today: 1e300, logins_refused_today: { [evil]: 4, bundle: 2 },
    sessions: { now: 2, peak_today: 3 }, mailboxes_claimed: 4, messages: { queued: 1, stored_today: 2, delivered_today: 3, refused_today: { rate: 1 } },
    pow_solved_today: 1, free_queue_used_pct: evil, pro_licences_active: 0, days: [{ day: '2026-10-13', identities: 4, delivered: 9, refused: 1, login_refused: 1, sessions_peak: 2 }, { day: evil }, { day: '2026-10-14', identities: 5, delivered: 3 }] });
  const bad = [/<script/i.test(html) && 'a script element', /alert\(1\)/.test(html) && 'hostile text', !/<svg/.test(html) && 'no chart', (html.match(/<svg/g) ?? []).length !== 4 && 'not four charts',
    !html.includes('bundle') && 'a refusal name dropped', /\bon\w+=/.test(html) && 'an event handler', /https?:\/\/(?!relay\.sigelo\.ai\/stats)/.test(html.replace(/<svg[^>]*>/g, '')) && 'something fetched'].filter(Boolean);
  console.log(bad.length ? `FAIL stats-chart.mjs self-test: ${bad.join(', ')}` : 'stats-chart.mjs self-test: escaped, four charts, no script, nothing fetched');
  process.exit(bad.length ? 1 : 0);
} else if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  process.stdout.write(page(JSON.parse(readFileSync(0, 'utf8'))));
}
