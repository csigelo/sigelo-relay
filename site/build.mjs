#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// relay/site/build.mjs — renders sigelo.ai (design/relay-plan.md §7 M5, §11) to relay/site/dist/.
//
//   node relay/site/build.mjs           build, and list what is still open before a deploy
//   node relay/site/build.mjs --final   refuse while anything is open or wrong (the deploy gate)
//   node relay/site/build.mjs --launch  in the private tree: the official statement alone; writes
//                                       relay/site/launch.json when it passes (launchGate)
//
// Seven pages, each twice, /<page>.html and /<page>.md (the twin ends with the footer as Markdown),
// plus what agents and crawlers read: robots.txt (and relay-robots.txt, which nginx serves as
// relay.sigelo.ai's), sitemap.xml, llms.txt, llms-full.txt, index.json, relay.json (the relay info
// document of plan §11) and .well-known/security.txt. nginx (relay/deploy/nginx.conf) serves
// index.json, relay.json and llms.txt with Access-Control-Allow-Origin: *, so a browser-based agent
// can read them. Static files only: no script but JSON-LD data, no form, no cookie, nothing from
// another origin.
//
// The numbers are not typed into the pages: a source writes {{free.msgsDay}} and the build fills it
// from the relay's own constants (relay/allowance.mjs TIERS, mailbox.mjs, operator.mjs), so a page
// cannot promise what the relay does not do. Open: a placeholder, the terms' DRAFT mark, SELLER or
// the vendor DID unset, a server fact the pages promise that relay/deploy/nginx.conf does not
// deliver, and in the private tree an official statement (SECURITY.md, site/deploy/nginx.conf)
// that does not yet say what index.json says (in the relay's export, which lacks both, no record of
// that check: launchGate). Wrong: a filled address, payment link or seller of the wrong shape, or a
// Pro storage above what the relay grants. Node >= 22.18 (it imports ../licence.ts, as the relay does).
// The Markdown renderer and the stylesheet are copied from sigelo's site/build.mjs and
// site/src/style.css (MIT, same authors), not imported: relay/ is published alone, without site/.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KB, MB, TIERS, windowWeeks } from '../allowance.mjs';
import { DAY } from '../db.mjs';
import { ACCOUNT_KEEP, IDLE_GRACE, INVITE_BYTES, INVITE_MESSAGES, INVITE_TTL, MAX_TOPICS } from '../mailbox.mjs';
import { LICENCE_KEEP, OPERATOR_DAYS } from '../operator.mjs';
import { DEV_VENDOR_DID, vendorDid } from '../licence.ts';   // as relay/allowance.mjs, from one level deeper

const SITE = dirname(fileURLToPath(import.meta.url));
const RELAY = dirname(SITE);
export const ROOT = dirname(RELAY);   // the private tree; in the relay's own export, what lies above relay/
export const DIST = join(SITE, 'dist');
export const DEPLOY = join(RELAY, 'deploy', 'nginx.conf');
export const ORIGIN = 'https://sigelo.ai';
export const HOST = 'relay.sigelo.ai';
export const REPO = 'https://github.com/csigelo/sigelo-relay';
const PKG = JSON.parse(readFileSync(join(RELAY, 'package.json'), 'utf8'));

// The company that sells Pro and operates the relay, by legal name only (footer, JSON-LD provider,
// index.json). null until the Owner sets it; --final refuses null, and a name that privacy.md and
// terms.md, once filled, do not begin their seller line with (commercial/relay-pro-runbook.md §0).
export const SELLER = null;

// The official names, as site/build.mjs DOMAINS, HOSTS and REPOSITORIES (sigelo.io's index.json and
// SECURITY.md say the same; relay/site/test.mjs compares the two in the private tree). Copied, not
// imported: relay/ is published alone.
export const DOMAINS = [
  { name: 'sigelo.io', role: 'content', what: 'protocol' },
  { name: 'sigelo.ai', role: 'content', what: 'relay and front page' },
  { name: 'sigelo.net', role: 'redirect', to: 'sigelo.ai', live: true },
  { name: 'sigelo.online', role: 'redirect', to: 'sigelo.ai', live: false },
  { name: 'sigelo.dev', role: 'redirect', to: 'sigelo.io', live: false },
  { name: 'sigelo.org', role: 'parked' },
];
export const HOSTS = [{ name: HOST, what: 'relay broker' }];
export const REPOSITORIES = ['https://github.com/csigelo/sigelo', REPO];
export const CONTENT_HOSTS = [...DOMAINS.filter((d) => d.role === 'content'), ...HOSTS].map((d) => d.name);
// SECURITY.md's line, which both pay pages carry verbatim (SEO spec §4.10).
export const NOBODY = 'Nobody from the project will ever ask for a seed, an identity or wallet private key, or a token, or send a payment address or link by e-mail or chat. Payment proofs (transaction id and transaction key) go only to the SimpleX address on `https://sigelo.io/contact.html`.';
export const MOTTO = 'By AI, for AI.';
export const DISCLOSURE = 'Built and operated by an AI agent under a human owner, csigelo.';
// The four sentences plan §11 says no competitor can truthfully say: index.json and relay.json carry
// them as `positioning`, llms-full.txt as prose, and every page's footer, which is generated and
// outside the word budgets: the first three on every page, the disclosure with the motto (on the home
// page its body has both).
export const POSITIONING = [
  "Verifying an agent's identity needs no server.",
  'The identity survives the agent leaving a platform.',
  'One long-term key, with a recovery key kept offline that wins over a thief who stole the key.',
  DISCLOSURE,
];
// sigelo.io's world issuer DID, as SECURITY.md and sigelo.io's index.json name it (SEO spec §4.10).
// Copied, as DOMAINS is; relay/site/test.mjs compares it with world/genesis.json in the private tree.
export const ISSUER_DID = 'did:sigelo:zEqNZjQDBiiufPs4NHrLw1kJD8rBitbFPyoQJoKuJFTM7';
// sigelo.io's official-channels statement: the second source the pay pages send a buyer to.
export const STATEMENT = 'https://sigelo.io/security.html#official-channels';
// Where payment details are published: the two pay pages, and on the relay repository's main branch
// the one file per page, not the repository as a whole (anyone can put text under its URL: an issue,
// a pull request, a fork's commit, which GitHub serves under the parent's URL). index.json says so,
// as sigelo.io's site/src/official.mjs does; the footer and each pay page name the same files and
// branch in words.
export const PAYMENT_PLACES = [`${ORIGIN}/pay-monero.html`, `${ORIGIN}/pay-card.html`, `${REPO}/blob/main/site/pay-monero.md`, `${REPO}/blob/main/site/pay-card.md`];
export const PAYMENT_WORDS = `Payment details appear only on sigelo.ai and in site/pay-monero.md and site/pay-card.md on the main branch of ${REPO.replace(/^https:\/\//, '')}.`;

// The pages, in nav order (the not-found page has no nav entry: not in the nav, the sitemap,
// llms.txt or index.json's pages). Titles get " — sigelo relay" but the home page's. The word budgets
// (docs-test/budgets.json) hold for what a reader sees: relay/site/test.mjs counts each page as `wc -w`
// would with every {{value}} filled, a size being two words ("50 MB"), and again with every
// placeholder filled as the runbook would. docs-test/check-budgets.mjs counts the source as written.
export const PAGES = [
  { slug: 'index', nav: 'Relay', title: 'sigelo relay — end-to-end encrypted messaging for AI agents',
    description: 'AI agents pair by a one-line code and exchange end-to-end encrypted messages over MQTT. The relay holds them while one is offline. No accounts; free tier.' },
  { slug: 'pro', nav: 'Pro', title: 'Pro: one allowance for all your agents',
    description: 'sigelo relay Pro pools one allowance across your agents: {{pro.msgsDay}} messages a day, up to {{pro.maxMessage}} each. A licence attestation to your operator DID; no account.' },
  { slug: 'pay-monero', nav: 'Pay in Monero', title: 'Pay Pro in Monero, at a discount',
    description: 'Pay sigelo relay Pro in Monero, at a discount: send XMR to the published address, then your operator DID, transaction id and key over SimpleX.' },
  { slug: 'pay-card', nav: 'Pay by card', title: 'Pay Pro by card (Stripe)',
    description: 'Pay sigelo relay Pro by card through a Stripe checkout, with your operator DID. The seller never sees the card number; the licence is issued by hand.' },
  { slug: 'privacy', nav: 'Privacy', title: 'Privacy: what the relay keeps',
    description: 'What the sigelo relay and this site keep, and for how long: addresses cut to /24 or /48 for 7 days; never message content. No cookies, no scripts.' },
  { slug: 'terms', nav: 'Terms', title: 'Terms of service',
    description: 'Terms for sigelo relay Pro, sold to businesses only: the free service, Pro as a licence attestation, no custody, no payment routing, liability, law.' },
  { slug: '404', nav: null, noindex: true, title: 'Not found',
    description: 'No page at this address on sigelo.ai. The relay pages: home, Pro, payment, privacy and terms; agents can start at /llms.txt or /index.json.' },
];
export const pageUrl = (p) => (p.slug === 'index' ? `${ORIGIN}/` : `${ORIGIN}/${p.slug}.html`);
export const titleOf = (p) => (p.slug === 'index' ? p.title : `${p.title} — sigelo relay`);

// The relay's numbers, as the pages write them. Days an identity's rows stay after its last use:
// mailbox.mjs drops an account ACCOUNT_KEEP after its last login once its claims are gone, and an
// idle claim its retention plus IDLE_GRACE after its last use (relay/site/test.mjs checks both
// against the code's behaviour where it can).
const thou = (x) => String(x).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const size = (b) => (b % MB === 0 ? `${b / MB} MB` : `${b / KB} KB`);
const days = (s) => String(s / DAY);
const keep = (t) => days(Math.max(ACCOUNT_KEEP, t.retentionDays * DAY + IDLE_GRACE));
// Contacts a tier's mailboxes hold: a contact costs its reader one mailbox per ISO week of its
// retention window and one for the week ahead its client claims (allowance.mjs windowWeeks), so 3
// on the free tier and 15 at 90 days. About: near a Monday it may cost one more.
const contacts = (t) => thou(Math.floor(t.mailboxes / (windowWeeks(t.retentionDays) + 1)));
export const VALUES = Object.freeze({
  'free.storage': size(TIERS.free.storage), 'free.msgsDay': thou(TIERS.free.msgsDay), 'free.retentionDays': String(TIERS.free.retentionDays),
  'free.maxMessage': size(TIERS.free.maxMessage), 'free.mailboxes': thou(TIERS.free.mailboxes), 'free.contacts': contacts(TIERS.free),
  'pro.msgsDay': thou(TIERS.pro.msgsDay), 'pro.retentionDays': String(TIERS.pro.retentionDays),
  'pro.maxMessage': size(TIERS.pro.maxMessage), 'pro.mailboxes': thou(TIERS.pro.mailboxes), 'pro.contacts': contacts(TIERS.pro),
  'keep.account.free': keep(TIERS.free), 'keep.account.pro': keep(TIERS.pro), 'keep.licence': days(LICENCE_KEEP),
  'operator.days': String(OPERATOR_DAYS),
});
// Retention is how long a queued message waits, not how long its reader may stay away: the relay
// queues only to a mailbox its reader holds (no_reader otherwise), and the client claims about a
// week ahead on every tier (contact/carrier.mjs AHEAD, which relay/site/test.mjs checks in the
// private tree). pro.md says so under its table; index.json and relay.json carry this sentence.
export const QUEUE_NOTE = 'retention_days is how long a queued message waits. The relay queues only to mailboxes its reader holds, and clients claim them about a week ahead on every tier, so a reader away longer takes no new messages until it is back (senders get no_reader).';
// {{name}} → its value; an unknown name stops the build (a typo would ship a raw token).
export function fill(text, where) {
  return text.replace(/\{\{([\w.]+)\}\}/g, (_, k) => {
    if (!(k in VALUES)) throw new Error(`${where}: unknown value {{${k}}} (VALUES in relay/site/build.mjs)`);
    return VALUES[k];
  });
}

// The inputs the pages still lack: the Owner's (plan §9 items 3 and 4), the lawyer's, the client
// package's. A later one-line edit of the page fills each; commercial/relay-pro-runbook.md §0 has the
// commands. Anything shaped like a placeholder that is not listed here fails relay/site/test.mjs.
export const PLACEHOLDERS = {
  '[install command]': 'the line installing the CLI with the contact verbs, once they ship on npm: at most 5 words, index.md\'s budget (index.md)',
  '[storage]': 'the Pro storage allowance, as "N MB" or "N GB" (pro.md)',
  '[discount]': 'the Monero discount in percent (pro.md, pay-monero.md)',
  '[rate source]': 'the EUR/XMR rate a Monero price is computed at (pay-monero.md, terms.md)',
  '[address]': "the company's Monero address (pay-monero.md)",
  '[payment link]': 'the Stripe Payment Link (pay-card.md)',
  '[company legal name, address, VAT]': 'the seller, at most 10 words: privacy.md\'s budget (privacy.md, terms.md); SELLER in build.mjs is its legal name',
  '[hosting region]': 'where the relay host runs, as the Owner confirms it: "the EU", or a region outside it and a transfer clause from the lawyer (privacy.md)',
  '[law and courts]': 'governing law and courts, from the lawyer (terms.md)',
};
// `[text]` not followed by `(`: Markdown link text always is, so only placeholders match.
export const PLACEHOLDER_RE = /\[[a-z][^\]\n]*\](?!\()/g;
export const DRAFT_RE = /^> \*\*DRAFT\b/m;
// pro.md's price line, which the JSON-LD offers and index.json read. → [month, year, discount].
export const PRICE_RE = /^Price: ([1-9]\d*) €\/month or ([1-9]\d*) €\/year, excluding VAT; Monero: (\[discount\]|[1-9]\d?) % less\. Businesses only\.$/m;
// pro.md's storage cell: the placeholder, or N MB / N GB.
export const STORAGE_RE = /^\| Storage queued \| [^|]+ \| (\[storage\]|[1-9]\d* [MG]B) \|$/m;
const storageBytes = (cell) => (cell === '[storage]' ? null : Number(cell.split(' ')[0]) * (cell.endsWith('GB') ? 1024 * MB : MB));
// The most storage the relay grants a Pro pool, whatever a licence claims: RELAY_PRO_STORAGE_MB where
// the site is built, read as relay/allowance.mjs relayPolicyFromEnv reads it on the relay (a whole
// number of MB, 1 to 10,000,000), else TIERS.pro.storage. null when it is set but malformed.
export function proStorageCap(v = process.env.RELAY_PRO_STORAGE_MB) {
  if (v === undefined || v === '') return TIERS.pro.storage;
  return /^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 1e7 ? Number(v) * MB : null;
}

// ---------------------------------------------------------------------------------------------
// Payment details, once filled. A stagenet or mistyped address takes no money, or someone else's;
// a Stripe test-mode link (buy.stripe.com/test_…) takes Stripe's test cards, and a licence issued
// for one is a licence given away. So: a mainnet standard address or subaddress whose checksum the
// sigelo library verifies, and a live-mode Payment Link.
let decodeAddress = null;
try { ({ decodeAddress } = await import('sigelo/dist/monero.js')); } catch { /* addressRefusal refuses then */ }
export const ADDRESS_LINE = /^ {3}`([^`]*)`$/m;                       // pay-monero.md: the address, alone, under step 1
export const LINK_LINE = /^1\. Open the checkout: <([^>]*)>$/m;       // pay-card.md
export const STRIPE_RE = /^https:\/\/buy\.stripe\.com\/(?!test_)[A-Za-z0-9_]+$/;
// → undefined when the address is still the placeholder or is a mainnet address, else why not.
export function addressRefusal(a) {
  if (a === '[address]') return undefined;
  if (typeof a !== 'string' || !/^[48][1-9A-HJ-NP-Za-km-z]{94}$/.test(a)) return 'not 95 base58 characters starting with 4 or 8 (mainnet)';
  if (!decodeAddress) return "its checksum cannot be checked: the relay's dependency sigelo is not installed (npm ci in relay/)";
  let d;
  try { d = decodeAddress(a); } catch (e) { return e.message; }
  if (d.net !== 'mainnet' || (d.kind !== 'standard' && d.kind !== 'subaddress')) return `a ${d.net} ${d.kind} address, not a mainnet address or subaddress`;
  return undefined;
}
// → undefined when the link is still the placeholder or a live-mode Payment Link, else why not.
export function linkRefusal(l) {
  if (l === '[payment link]') return undefined;
  return typeof l === 'string' && STRIPE_RE.test(l) ? undefined : 'not a live-mode https://buy.stripe.com/<id> Payment Link (never test_…)';
}
// → undefined while SELLER is unset or names the seller privacy.md and terms.md name, else why not.
export function sellerRefusal(seller, md) {
  if (seller === null) return undefined;
  if (typeof seller !== 'string' || !/^[^\s<>[\]{}`*_|"]+(?: [^\s<>[\]{}`*_|"]+)*$/.test(seller) || seller.length > 100) return 'SELLER: want a legal name, plain text on one line, at most 100 characters';
  const at = [['privacy', `GDPR controller: ${seller}`], ['terms', `Seller: ${seller}`]].filter(([slug, s]) => !md[slug].includes('[company legal name, address, VAT]') && !md[slug].includes(s));
  return at.length ? `SELLER "${seller}" is not the seller ${at.map(([slug]) => `${slug}.md`).join(' and ')} name${at.length > 1 ? '' : 's'}` : undefined;
}

// What the pages promise about the server, as relay/deploy/nginx.conf ships it. nginx's defaults log
// the full address and the request line (/challenge?did=…): the access log for every request, the
// error log for each refusal by limit_req and each failed proxy call. privacy.md says the site keeps
// no access log and no full address but in a rare error line, and pro.md step 4 uploads to /licence.
// So every server block turns both logs down at its own level, and nothing inside it turns them up
// again; one block proxies /licence; and every block that proxies to the relay sets X-Real-IP to the
// client's address at its own level, with no proxy_set_header in any location. nginx inherits
// proxy_set_header into a location only while the location sets none of its own; one that sets any
// other header passes the client's own X-Real-IP, which the relay believes from loopback, so a client
// could name a new network for every request and pass every per-network limit.
// → [why …].
export function deployRefusals(file = DEPLOY) {
  const name = 'relay/deploy/nginx.conf';
  if (!existsSync(file)) return [`${name}: not found (the nginx config the pages rely on)`];
  const tree = nginxTree(readFileSync(file, 'utf8'));
  if (tree === null) return [`${name}: braces, quotes or semicolons do not balance`];
  const servers = serversIn(tree);
  if (servers.length === 0) return [`${name}: no server block`];
  const why = [];
  const QUIET = /^error_log \S+ (?:crit|alert|emerg)$/;
  servers.forEach((s, i) => {
    const named = s.directives.find((d) => d.startsWith('server_name '));
    const label = `server block ${i + 1}${named ? ` (${named.slice('server_name '.length)})` : ''}`;
    const inside = everyDirective(s);
    if (!s.directives.includes('access_log off') || inside.some((d) => /^access_log\b/.test(d) && d !== 'access_log off')) {
      why.push(`${name}: ${label} lacks "access_log off;" at its own level, or turns the access log on inside it (privacy.md: no access log, no DID in any log)`);
    }
    if (!s.directives.some((d) => QUIET.test(d)) || inside.some((d) => /^error_log\b/.test(d) && !QUIET.test(d))) {
      why.push(`${name}: ${label} lacks "error_log <file> crit;" at its own level, or logs errors below crit inside it (limit_req refusals log the full address and the DID at "error")`);
    }
    if (s.blocks.flatMap(everyDirective).some((d) => /^proxy_set_header\b/.test(d))) {
      why.push(`${name}: ${label} sets proxy_set_header inside a location (there it drops the server's X-Real-IP, and nginx passes the client's own: any address the client names)`);
    }
    if (inside.some((d) => /^proxy_pass\b/.test(d)) && !s.directives.includes('proxy_set_header X-Real-IP $remote_addr')) {
      why.push(`${name}: ${label} proxies to the relay without "proxy_set_header X-Real-IP $remote_addr;" at its own level (the relay would count every client as one address)`);
    }
  });
  if (!servers.some((s) => s.blocks.some((b) => /^location ?= ?\/licence$/.test(b.head)))) why.push(`${name}: no server block has "location = /licence" (pro.md step 4)`);
  return why;
}
// nginx text → { head, directives, blocks } trees: comments dropped, quotes kept as written (a ; or
// a brace inside quotes is text), whitespace runs made one space; null when a brace, a quote or a
// semicolon is missing. Enough for the checks here, not a full parser. Quotes, # and \ as nginx's
// tokenizer reads them: a quote opens a string and a # a comment only at the start of a token, and a
// backslash makes the next character text, in a string or not. Read otherwise, a quote inside a
// token would hide every directive up to the next such quote from the checks, while nginx runs them.
export function nginxTree(text) {
  const root = { head: '', directives: [], blocks: [] }, open = [root];
  let buf = '', quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      buf += ch;
      if (ch === '\\') buf += text[++i] ?? '';
      else if (ch === quote) quote = null;
      continue;
    }
    if ((ch === '"' || ch === "'") && /(^|\s)$/.test(buf)) { quote = ch; buf += ch; continue; }
    if (ch === '\\') { buf += ch + (text[++i] ?? ''); continue; }
    if (ch === '#' && /(^|\s)$/.test(buf)) { while (i < text.length && text[i] !== '\n') i++; buf += ' '; continue; }
    if (ch !== '{' && ch !== ';' && ch !== '}') { buf += ch; continue; }
    const t = buf.trim().replace(/\s+/g, ' ');
    buf = '';
    if (ch === '{') { const b = { head: t, directives: [], blocks: [] }; open.at(-1).blocks.push(b); open.push(b); }
    else if (ch === ';') open.at(-1).directives.push(t);
    else if (open.length === 1 || t) return null;   // a } closing nothing, or ending a directive without its ;
    else open.pop();
  }
  return open.length === 1 && !buf.trim() && quote === null ? root : null;
}
export const serversIn = (b) => b.blocks.flatMap((x) => (x.head === 'server' ? [x] : serversIn(x)));
export const everyDirective = (b) => [...b.directives, ...b.blocks.flatMap(everyDirective)];

// The official statement this site's index.json makes, as the private tree's other files must say it
// before a deploy (SEO spec §4.10, task 8): SECURITY.md carries the "Nobody…" line and names the
// relay's repository; site/deploy/nginx.conf (sigelo.io's host) no longer serves sigelo.ai, and each
// live redirect in DOMAINS answers 301 to its target. The private tree is the one with sigelo.io's
// site/build.mjs beside relay/; there both files must be found. Elsewhere they are absent: see
// launchGate. → [why …].
export const isPrivateTree = (root = ROOT) => existsSync(join(root, 'site', 'build.mjs'));
// The launch gate as build() applies it. In the private tree: launchRefusals(). Elsewhere (the relay
// export, where deploy.sh runs --final) nothing can be checked, so the record `--launch` wrote in the
// private tree must be here: relay/site/launch.json, committed and exported with the sources.
// relay/site/test.mjs fails in the private tree while that record exists and launchRefusals() does
// not pass, so it cannot outlive what it records. → [why …].
export const LAUNCH_RECORD = 'launch.json';
export function launchGate(root = ROOT, site = SITE) {
  if (isPrivateTree(root)) return launchRefusals(root);
  return existsSync(join(site, LAUNCH_RECORD)) ? [] : [`launch: no site/${LAUNCH_RECORD}; run relay/site/build.mjs --launch in the private tree, commit what it writes, then export (it checks SECURITY.md and sigelo.io's nginx, which the export lacks)`];
}
export function launchRefusals(root = ROOT) {
  const why = [];
  const security = join(root, 'SECURITY.md'), io = join(root, 'site', 'deploy', 'nginx.conf');
  if (isPrivateTree(root)) {
    for (const [f, label] of [[security, 'SECURITY.md'], [io, 'site/deploy/nginx.conf']]) if (!existsSync(f)) why.push(`${label}: not found beside relay/ in the private tree`);
  }
  if (existsSync(security)) {
    const s = readFileSync(security, 'utf8');
    if (!s.includes(NOBODY)) why.push('SECURITY.md: lacks the "Nobody from the project…" line the pay pages carry (SEO spec §4.10)');
    if (!s.includes(REPO)) why.push(`SECURITY.md: does not name ${REPO} as official (the pay pages send buyers there to compare)`);
  }
  if (existsSync(io)) {
    const tree = nginxTree(readFileSync(io, 'utf8'));
    if (tree === null) why.push('site/deploy/nginx.conf: braces, quotes or semicolons do not balance');
    else {
      const servers = serversIn(tree), names = (s) => (s.directives.find((d) => d.startsWith('server_name ')) ?? '').split(' ').slice(1);
      if (servers.some((s) => names(s).some((n) => /(^|\.)sigelo\.ai$/.test(n)))) why.push('site/deploy/nginx.conf: still serves sigelo.ai, which moves to the relay\'s host (relay/deploy/nginx.conf)');
      for (const d of DOMAINS.filter((x) => x.role === 'redirect' && x.live)) {
        const blocks = servers.filter((s) => names(s).includes(d.name));
        const ok = blocks.length > 0 && blocks.every((s) => everyDirective(s).includes(`return 301 https://${d.to}$request_uri`));
        if (!ok) why.push(`site/deploy/nginx.conf: ${d.name} does not answer 301 to https://${d.to} in every server block, as index.json's official.redirects says`);
      }
    }
  }
  return why;
}

// ---------------------------------------------------------------------------------------------
// Markdown → HTML, copied from site/build.mjs: ATX headings, paragraphs, fenced code, block
// quotes, nested lists, GFM tables, rules, inline code, links, autolinks, bold, italic. No raw
// HTML passes through: every `<` that is not ours is escaped.
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const slugify = (text) => text.toLowerCase().replace(/<[^>]*>/g, '').replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s/g, '-');
const plain = (md) => md.replace(/`([^`]*)`/g, '$1').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_]{1,2}([^*_]+)[*_]{1,2}/g, '$1');

function inline(src, link) {
  const slots = [];
  const keep = (html) => `\u0000${slots.push(html) - 1}\u0000`;
  let s = src.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_, _t, code) => keep(`<code>${esc(code.replace(/^ (.*) $/, '$1'))}</code>`));
  s = s.replace(/\\([\\`*_[\]()#+\-.!|<>~])/g, (_, c) => keep(esc(c)));
  s = s.replace(/<(https?:\/\/[^\s>]+)>/g, (_, u) => keep(`<a href="${esc(link(u))}">${esc(u)}</a>`));
  s = s.replace(/\[((?:[^\[\]]|\[[^\]]*\])*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, text, url) =>
    keep(`<a href="${esc(link(url))}">${inlineRest(text)}</a>`));
  return restore(inlineRest(s), slots);
  function inlineRest(t) {
    t = esc(t).replace(/&amp;(#?\w+;)/g, '&$1');
    t = t.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/(^|[^\w*])\*(?=[^\s*])([^*]*?[^\s*])\*(?!\w)/g, '$1<em>$2</em>');
    t = t.replace(/(^|[^\w])_(?=\S)([^_]*?\S)_(?!\w)/g, '$1<em>$2</em>');
    return t;
  }
}
function restore(s, slots) {
  for (let i = 0; i < 4 && s.includes('\u0000'); i++) s = s.replace(/\u0000(\d+)\u0000/g, (_, n) => slots[+n]);
  return s;
}
function splitRow(line) {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
  const cells = []; let cur = ''; let tick = 0;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === '\\' && t[i + 1] === '|') { cur += '\\|'; i++; continue; }
    if (c === '`') { let n = 1; while (t[i + n] === '`') n++; cur += t.slice(i, i + n); i += n - 1; tick = tick === n ? 0 : tick || n; continue; }
    if (c === '|' && !tick) { cells.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  cells.push(cur.trim());
  return cells.map((c) => c.replace(/\\\|/g, '|'));
}
const LIST = /^( *)([-*+]|\d{1,9}[.)]) +(.*)$/;
const indentOf = (l) => l.match(/^ */)[0].length;

export function render(md, link, ids = new Map()) {
  const out = [];
  blocks(md.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n'), out, link, ids);
  return out.join('\n');
}
function blocks(lines, out, link, ids) {
  let i = 0;
  const para = [];
  const flush = () => { if (para.length) { out.push(`<p>${inline(para.join('\n'), link)}</p>`); para.length = 0; } };
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*$/.test(line)) { flush(); i++; continue; }
    if (/^\s*<!--/.test(line)) { flush(); while (i < lines.length && !lines[i].includes('-->')) i++; i++; continue; }
    const fence = line.match(/^( {0,3})(`{3,}|~{3,})\s*([\w+-]*)/);
    if (fence) {
      flush();
      const close = new RegExp(`^ {0,3}${fence[2][0]}{${fence[2].length},}\\s*$`);
      const body = []; i++;
      while (i < lines.length && !close.test(lines[i])) body.push(lines[i].slice(Math.min(fence[1].length, indentOf(lines[i])))), i++;
      i++;
      out.push(`<pre><code${fence[3] ? ` class="language-${esc(fence[3])}"` : ''}>${esc(body.join('\n'))}</code></pre>`);
      continue;
    }
    const h = line.match(/^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) {
      flush();
      const n = h[1].length; let id = slugify(plain(h[2])) || 'section';
      if (ids.has(id)) { const k = ids.get(id) + 1; ids.set(id, k); id = `${id}-${k}`; } else ids.set(id, 0);
      out.push(`<h${n} id="${esc(id)}">${inline(h[2], link)}</h${n}>`);
      i++; continue;
    }
    if (/^ {0,3}([-*_])( *\1){2,} *$/.test(line)) { flush(); out.push('<hr>'); i++; continue; }
    if (/^ {0,3}>/.test(line)) {
      flush();
      const body = [];
      while (i < lines.length && /^ {0,3}>/.test(lines[i])) body.push(lines[i].replace(/^ {0,3}> ?/, '')), i++;
      const inner = []; blocks(body, inner, link, ids);
      out.push(`<blockquote>\n${inner.join('\n')}\n</blockquote>`);
      continue;
    }
    if (line.trim().startsWith('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
      flush();
      const head = splitRow(line);
      const align = splitRow(lines[i + 1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : ''));
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) rows.push(splitRow(lines[i])), i++;
      const cell = (tag, c, k) => `<${tag}${align[k] ? ` class="${align[k]}"` : ''}>${inline(c, link)}</${tag}>`;
      out.push('<div class="table"><table>\n<thead><tr>' + head.map((c, k) => cell('th', c, k)).join('') + '</tr></thead>\n<tbody>\n' +
        rows.map((r) => '<tr>' + head.map((_, k) => cell('td', r[k] ?? '', k)).join('') + '</tr>').join('\n') + '\n</tbody></table></div>');
      continue;
    }
    const li = line.match(LIST);
    if (li && (!para.length || li[1].length < 4)) {
      flush();
      i = list(lines, i, out, link, ids);
      continue;
    }
    para.push(line.trim());
    i++;
  }
  flush();
}
function list(lines, i, out, link, ids) {
  const first = lines[i].match(LIST);
  const base = first[1].length;
  const ordered = /\d/.test(first[2]);
  const start = ordered ? parseInt(first[2], 10) : 1;
  const items = [];
  let loose = false;
  while (i < lines.length) {
    const m = lines[i].match(LIST);
    if (!m || m[1].length !== base || /\d/.test(m[2]) !== ordered) break;
    const contentIndent = base + m[2].length + 1;
    const body = [m[3]]; i++;
    let blank = false;
    while (i < lines.length) {
      const l = lines[i];
      if (/^\s*$/.test(l)) { blank = true; body.push(''); i++; continue; }
      const ind = indentOf(l);
      if (ind > base) { body.push(l.slice(Math.min(ind, contentIndent))); blank = false; i++; continue; }
      if (!blank && !LIST.test(l) && !/^ {0,3}(#|>|```|\|)/.test(l)) { body.push(l.trim()); i++; continue; }
      break;
    }
    while (body.length && body[body.length - 1] === '') body.pop();
    if (blank && i < lines.length && LIST.test(lines[i]) && lines[i].match(LIST)[1].length === base) loose = true;
    if (body.some((l, k) => l === '' && k > 0 && body[k + 1] !== undefined && !LIST.test(body[k + 1]))) loose = true;
    items.push(body);
  }
  const tag = ordered ? 'ol' : 'ul';
  out.push(`<${tag}${ordered && start !== 1 ? ` start="${start}"` : ''}>`);
  for (const body of items) {
    const inner = []; blocks(body, inner, link, ids);
    let html = inner.join('\n');
    if (!loose) html = html.replace(/^<p>([\s\S]*?)<\/p>(?=\n<(?:ul|ol)|$)/, '$1');
    out.push(`<li>${html}</li>`);
  }
  out.push(`</${tag}>`);
  return i;
}

// ---------------------------------------------------------------------------------------------
// Links: the sources link pages as /<slug>.html; the .md twins get /<slug>.md, and / is the index.
const SLUGS = new Set(PAGES.map((p) => p.slug));
const linker = (ext) => (url) => {
  const m = url.match(/^\/([\w-]+)\.html(#.*)?$/);
  if (!m || !SLUGS.has(m[1])) return url;
  return (m[1] === 'index' && ext === 'html' ? '/' : `/${m[1]}.${ext}`) + (m[2] ?? '');
};
// The same rewrite inside Markdown, leaving code alone.
function rewriteMd(md, link) {
  let inFence = false;
  return md.split('\n').map((line) => {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; return line; }
    if (inFence) return line;
    return line.split(/(`+[^`]*`+)/).map((part, k) => (k % 2 ? part
      : part.replace(/\]\(([^)\s]+)((?:\s+"[^"]*")?)\)/g, (_, u, t) => `](${link(u)}${t})`))).join('');
  }).join('\n');
}

// sigelo.io's stylesheet minus the parts these pages do not use. Light by default, dark by preference.
const STYLE = `/* sigelo relay — one stylesheet, no web fonts, no scripts. */
:root { --bg: #fdfdfb; --fg: #1d1d1b; --muted: #5d5d58; --line: #d9d9d2; --code: #f1f1ec; --link: #0b5cad; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #151514; --fg: #e6e6e1; --muted: #a3a39c; --line: #3a3a36; --code: #232321; --link: #7fb6f0; }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
body { margin: 0 auto; max-width: 52rem; padding: 0 16px 3rem; background: var(--bg); color: var(--fg);
  font: 1rem/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; overflow-wrap: break-word; }
a { color: var(--link); }
header { border-bottom: 1px solid var(--line); padding: 1rem 0 .5rem; }
.site { margin: 0 0 .5rem; color: var(--muted); }
.site a { color: var(--fg); font-weight: 700; text-decoration: none; }
nav ul { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: .25rem .9rem; font-size: .95rem; }
nav a[aria-current="page"] { color: var(--fg); font-weight: 700; text-decoration: none; }
main { padding-top: .5rem; }
h1, h2, h3 { line-height: 1.25; margin: 1.6em 0 .5em; }
h1 { font-size: 1.7rem; margin-top: 1rem; }
h2 { font-size: 1.3rem; border-bottom: 1px solid var(--line); padding-bottom: .2em; }
code, pre { font: .88em/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: var(--code); border-radius: 3px; }
code { padding: .05em .3em; }
pre { padding: .75rem; overflow-x: auto; }
pre code { padding: 0; background: none; font-size: 1em; }
blockquote { margin: 1em 0; padding: 0 1em; border-left: 4px solid var(--line); color: var(--muted); }
.table { overflow-x: auto; margin: 1em 0; }
table { border-collapse: collapse; font-size: .92rem; }
th, td { border: 1px solid var(--line); padding: .35em .55em; text-align: left; vertical-align: top; }
th { background: var(--code); }
.center { text-align: center; } .right { text-align: right; }
footer { margin-top: 3rem; border-top: 1px solid var(--line); color: var(--muted); font-size: .85rem; }
`;

// ---------------------------------------------------------------------------------------------
// The footer, once in Markdown: the twin ends with it as written, the HTML page renders it, so the
// two say the same (relay/site/test.mjs). The home page leaves out the motto line: its body has it.
const bare = (u) => u.replace(/^https:\/\//, '');
function footerMd(page, seller) {
  const hosts = [...CONTENT_HOSTS.filter((h) => h.endsWith('sigelo.ai')), ...CONTENT_HOSTS.filter((h) => !h.endsWith('sigelo.ai'))]
    .map((h) => (h === 'sigelo.io' ? '[sigelo.io](https://sigelo.io/)' : h));
  const repos = REPOSITORIES.map((r) => (r === REPO ? `[${bare(r)}](${r}) (AGPL-3.0)` : bare(r)));
  return [
    ...(page.slug === 'index' ? [] : [`**${MOTTO}** ${DISCLOSURE}`]),
    `Identity by [sigelo](https://sigelo.io/). ${POSITIONING.slice(0, -1).join(' ')}`,
    `Seller and provider: ${seller ?? 'not yet named'}. [Privacy](/privacy.html) · [Terms](/terms.html)`,
    `[Official](${STATEMENT}): ${[...hosts, ...repos].join(', ')}. ${PAYMENT_WORDS} Agents: [/${page.slug}.md](/${page.slug}.md) · [/llms.txt](/llms.txt) · [/index.json](/index.json)`,
  ].join('\n\n');
}

// JSON-LD (SEO spec §3.4): the WebSite everywhere, the page's WebPage, and on the home page the
// hosted Service and the SoftwareApplication. The seller (provider), the terms and the Pro offers
// only in a final build: a draft offers nothing. None on the not-found page. Every < is written as
// <, so no text in it can close the script element.
function jsonld(page, ctx) {
  const url = pageUrl(page), service = `${ORIGIN}/#service`, software = `${ORIGIN}/#software`;
  const site = { '@type': 'WebSite', '@id': `${ORIGIN}/#website`, url: `${ORIGIN}/`, name: 'sigelo relay', description: `${MOTTO} ${DISCLOSURE}`, inLanguage: 'en' };
  const webPage = { '@type': 'WebPage', '@id': `${url}#page`, url, name: titleOf(page), description: fill(page.description, page.slug), isPartOf: { '@id': site['@id'] }, inLanguage: 'en' };
  if (page.slug === 'index') Object.assign(webPage, { about: [{ '@id': service }, { '@id': software }], relatedLink: ['https://sigelo.io/'] });
  if (['pro', 'pay-monero', 'pay-card'].includes(page.slug)) webPage.about = { '@id': service };
  const graph = [site, webPage];
  if (page.slug === 'index') {
    const free = TIERS.free;
    const proOffer = (name, price, duration) => ({ '@type': 'Offer', name, url: `${ORIGIN}/pro.html`, eligibleCustomerType: 'http://purl.org/goodrelations/v1#Business',
      priceSpecification: { '@type': 'UnitPriceSpecification', price, priceCurrency: 'EUR', valueAddedTaxIncluded: false, billingDuration: duration } });
    graph.push({
      '@type': 'Service', '@id': service, name: 'sigelo relay (hosted)', serviceType: 'End-to-end encrypted message relay for AI agents',
      description: `MQTT 3.1.1 over TLS at ${HOST}:8883. Agents log in with a sigelo identity; no accounts. Messages are held until read, at most ${free.retentionDays} days on the free tier.`,
      url: `${ORIGIN}/`,
      ...(ctx.final && { provider: { '@type': 'Organization', name: ctx.seller }, termsOfService: `${ORIGIN}/terms.html` }),
      availableChannel: { '@type': 'ServiceChannel', serviceUrl: `mqtts://${HOST}:8883` },
      offers: [{ '@type': 'Offer', name: 'Free', price: '0', priceCurrency: 'EUR', description: `One agent: ${VALUES['free.msgsDay']} messages a day, kept ${free.retentionDays} days.` },
        ...(ctx.final ? [proOffer('Pro, monthly', ctx.price.month, 'P1M'), proOffer('Pro, yearly', ctx.price.year, 'P1Y')] : [])],
    }, {
      '@type': 'SoftwareApplication', '@id': software, name: 'sigelo relay',
      description: 'The relay server: an MQTT broker where AI agents log in with their sigelo identity and exchange end-to-end encrypted messages it cannot read, though it sees who talks to whom. Run your own.',
      applicationCategory: 'CommunicationApplication', softwareVersion: PKG.version, softwareRequirements: `Node.js ${PKG.engines.node.replace(/^>=/, '')} or later`,
      license: `https://spdx.org/licenses/${PKG.license}`, isAccessibleForFree: true, sameAs: REPO, offers: { '@type': 'Offer', price: '0', priceCurrency: 'EUR' },
    });
  }
  return JSON.stringify({ '@context': 'https://schema.org', '@graph': graph }, null, 1).replace(/</g, '\\u003c');
}

function htmlPage(page, body, ctx) {
  const nav = PAGES.filter((p) => p.nav).map((p) => `<li><a href="${p.slug === 'index' ? '/' : `/${p.slug}.html`}"${p.slug === page.slug ? ' aria-current="page"' : ''}>${esc(p.nav)}</a></li>`).join('');
  const indexed = page.noindex ? '<meta name="robots" content="noindex">\n' : `<link rel="canonical" href="${pageUrl(page)}">\n`;
  const ld = page.noindex ? '' : `<script type="application/ld+json">\n${jsonld(page, ctx)}\n</script>\n`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${esc(titleOf(page))}</title>
<meta name="description" content="${esc(fill(page.description, page.slug))}">
${indexed}<link rel="alternate" type="text/markdown" href="/${page.slug}.md" title="This page as Markdown">
<link rel="stylesheet" href="/style.css">
${ld}</head>
<body>
<header>
<p class="site"><a href="/">sigelo relay</a></p>
<nav aria-label="Pages"><ul>${nav}</ul></nav>
</header>
<main>
${body}
</main>
<footer>
${render(footerMd(page, ctx.seller), linker('html'))}
</footer>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------------------------
// Git facts for sitemap lastmod, index.json built_from and security.txt Expires; null where git
// cannot tell (no git, no repository, an uncommitted file): the field is then left out, never
// replaced by the build time.
function git(...args) {
  try { return execFileSync('git', ['-C', RELAY, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; } catch { return null; }
}
const lastCommit = (...paths) => git('log', '-1', '--format=%cI', '--', ...paths);

// llms.txt (SEO spec §4.3): one fetch tells an agent what this is and where the rest is.
function llmsTxt(version) {
  return `# sigelo relay

> End-to-end encrypted messages between AI agents. Agents pair by a one-line invite code and log in with a sigelo identity (no accounts). The relay holds messages while one is offline; it cannot read them, but can tell who talks to whom. MQTT 3.1.1 over TLS at ${HOST}:8883. Not A2A. New (v${version}), unaudited.

${MOTTO} ${DISCLOSURE}

## Docs

- [Relay](${ORIGIN}/index.md): what it is, the commands, the free tier
- [Pro](${ORIGIN}/pro.md): one allowance for all your agents, no account
- [Index](${ORIGIN}/index.json): host, port, HTTP calls, limits, encryption, licences, status
- [Identity](https://sigelo.io/llms.txt): the identity agents log in with

## Pay

- [Pay in Monero](${ORIGIN}/pay-monero.md): at a discount, checked by hand
- [Pay by card](${ORIGIN}/pay-card.md): Stripe checkout

## Optional

- [Privacy](${ORIGIN}/privacy.md): what the relay keeps
- [Terms](${ORIGIN}/terms.md): businesses only, no custody
- [Source](${REPO}): the relay, AGPL-3.0
`;
}

// → { pages, open, wrong }. open: the placeholders still in the sources, 'DRAFT' while the terms
// carry their draft mark, SELLER or the vendor DID unset, what deployRefusals() and launchRefusals()
// find. wrong: a filled address, link or seller of the wrong shape. `final` refuses to write anything
// while either is non-empty. site, out, deploy and root are the sources, the output, the nginx
// config and the tree around relay/; seller and vendor default to SELLER and the DID the relay pins
// (RELAY_VENDOR_DID, else licence.ts). A test builds filled copies through these.
export function build({ final = false, site = SITE, out = DIST, deploy = DEPLOY, root = ROOT, seller = SELLER,
  vendor = process.env.RELAY_VENDOR_DID || vendorDid(), proStorage = proStorageCap() } = {}) {
  const md = Object.fromEntries(PAGES.map((p) => [p.slug, readFileSync(join(site, `${p.slug}.md`), 'utf8')]));
  const open = [...new Set(Object.values(md).flatMap((text) => text.match(PLACEHOLDER_RE) ?? []))];
  if (DRAFT_RE.test(md.terms)) open.push('DRAFT');
  if (seller === null) open.push('SELLER');
  const vendorSet = vendor !== DEV_VENDOR_DID;
  if (!vendorSet) open.push('vendor DID');
  open.push(...deployRefusals(deploy), ...launchGate(root, site));
  const address = md['pay-monero'].match(ADDRESS_LINE)?.[1], link = md['pay-card'].match(LINK_LINE)?.[1];
  const price = md.pro.match(PRICE_RE), storage = md.pro.match(STORAGE_RE)?.[1];
  const wrong = [
    address === undefined ? 'pay-monero: no address line under step 1' : addressRefusal(address) && `pay-monero: the address is ${addressRefusal(address)}`,
    link === undefined ? 'pay-card: no "1. Open the checkout: <…>" line' : linkRefusal(link) && `pay-card: the checkout link is ${linkRefusal(link)}`,
    !price && 'pro: no "Price: N €/month or N €/year, excluding VAT; Monero: [discount] % less. Businesses only." line',
    !storage && 'pro: no "| Storage queued | … | [storage] or N MB |" row',
    proStorage === null ? 'RELAY_PRO_STORAGE_MB: want a whole number of MB from 1 to 10000000, as the relay reads it'
      : storage && storage !== '[storage]' && storageBytes(storage) > proStorage
      && `pro: the storage cell says ${storage}, more than the relay grants a Pro pool (${proStorage / MB} MB: RELAY_PRO_STORAGE_MB where the site is built, else TIERS.pro.storage)`,
    sellerRefusal(seller, md),
    !/^did:sigelo:z[1-9A-HJ-NP-Za-km-z]{40,50}$/.test(vendor) && 'vendor DID: RELAY_VENDOR_DID is not a did:sigelo DID',
  ].filter(Boolean);
  if (final && (open.length || wrong.length)) throw new Error(`--final: ${[...open, ...wrong].join('; ')} (commercial/relay-pro-runbook.md §0)`);
  for (const p of PAGES) if (!/^# /.test(md[p.slug])) throw new Error(`${p.slug}.md: does not start with an H1`);

  // Final: every value is filled (the gate above). A draft writes null for each open value and
  // offers nothing for sale.
  const discount = price?.[3] === '[discount]' ? null : Number(price?.[3]);
  const install = md.index.match(/^```sh\n(.*)$/m)?.[1];
  const ctx = { final, seller, price: price && { month: price[1], year: price[2] } };
  const version = PKG.version.split('.').slice(0, 2).join('.');
  const built = { commit: git('rev-parse', 'HEAD'), commit_date: git('log', '-1', '--format=%cI', 'HEAD'),
    dirty: git('status', '--porcelain', '--untracked-files=no', '--', '.') !== null };

  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, '.well-known'), { recursive: true });
  const put = (name, data) => writeFileSync(join(out, name), data);
  const twins = {};
  for (const p of PAGES) {
    const text = fill(md[p.slug], `${p.slug}.md`);
    twins[p.slug] = rewriteMd(text, linker('md'));
    put(`${p.slug}.md`, `${twins[p.slug].trimEnd()}\n\n---\n\n${rewriteMd(footerMd(p, seller), linker('md'))}\n`);
    put(`${p.slug}.html`, htmlPage(p, render(text, linker('html')), ctx));
  }
  put('style.css', STYLE);

  // robots.txt (SEO spec §4.1): everything allowed; the AI crawlers named so the intent is explicit.
  const bots = ['GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-SearchBot', 'Claude-User', 'PerplexityBot', 'Perplexity-User',
    'Google-Extended', 'Applebot', 'Applebot-Extended', 'CCBot', 'Amazonbot', 'Amzn-SearchBot', 'Meta-ExternalAgent', 'Meta-WebIndexer',
    'MistralAI-User', 'MistralAI-Index', 'DuckAssistBot', '*'];
  put('robots.txt', `# sigelo relay. Every crawler is welcome, AI crawlers included.
# For agents: ${ORIGIN}/llms.txt, ${ORIGIN}/index.json, each page as Markdown at /<page>.md
${bots.map((u) => `User-agent: ${u}`).join('\n')}
Allow: /

Sitemap: ${ORIGIN}/sitemap.xml
`);
  // relay.sigelo.ai's own robots.txt (nginx serves this file there): but for the front page, which
  // names sigelo.ai as canonical, its paths redirect to sigelo.ai, and the HTTP calls are not content.
  put('relay-robots.txt', 'User-agent: *\nDisallow: /challenge\nDisallow: /check\nDisallow: /licence\n');

  // llms.txt, and llms-full.txt: the pages' twins in one file, for an agent that wants it all at once.
  // The pay pages stay out: they say their payment details are published only on themselves and in
  // the relay repository (PAYMENT_PLACES), and a third copy would make that untrue.
  put('llms.txt', llmsTxt(version));
  const fullPages = PAGES.filter((p) => !p.noindex && !p.slug.startsWith('pay-'));
  put('llms-full.txt', `# sigelo relay: the pages in one file

${MOTTO} ${DISCLOSURE}

The identity underneath is [sigelo](https://sigelo.io/). ${POSITIONING.slice(0, -1).join(' ')} Messages use hybrid post-quantum key agreement (X-Wing: ML-KEM-768 + X25519); signatures are Ed25519, not post-quantum.

Payment details are left out here: they are published only at ${PAYMENT_PLACES.slice(0, -1).join(', ')} and ${PAYMENT_PLACES.at(-1)}.

${fullPages.map((p) => `---\n\nSource: ${ORIGIN}/${p.slug}.md\n\n${twins[p.slug].trimEnd()}\n`).join('\n')}`);

  // index.json (SEO spec §4.5, §4.10) and relay.json (plan §11): data only, generated from the same
  // constants as the pages.
  const tierJson = (t, per, storage) => ({ per, messages_day: t.msgsDay, retention_days: t.retentionDays, max_message_bytes: t.maxMessage, storage_bytes: storage, mailboxes: t.mailboxes });
  const onSale = final;
  const tiers = {
    free: tierJson(TIERS.free, 'agent', TIERS.free.storage),
    pro: { ...tierJson(TIERS.pro, 'operator', storage ? storageBytes(storage) : null), client_env: `SIGELO_RELAY_RETENTION_DAYS=${TIERS.pro.retentionDays}`,
      price: price ? { EUR_month: Number(price[1]), EUR_year: Number(price[2]), vat_included: false, monero_discount_percent: discount } : null,
      on_sale: onSale, page: `${ORIGIN}/pro.html`, pay: { monero: `${ORIGIN}/pay-monero.html`, card: `${ORIGIN}/pay-card.html` } },
  };
  const redirects = (live) => Object.fromEntries(DOMAINS.filter((d) => d.role === 'redirect' && d.live === live).map((d) => [d.name, `https://${d.to}/`]));
  const official = {
    statement: STATEMENT,
    domains: DOMAINS.map((d) => d.name), content: CONTENT_HOSTS,
    roles: Object.fromEntries([...DOMAINS.filter((d) => d.role === 'content'), ...HOSTS].map((d) => [d.name, d.what])),
    redirects: redirects(true), redirects_pending_dns: redirects(false), parked: DOMAINS.filter((d) => d.role === 'parked').map((d) => d.name),
    repositories: REPOSITORIES, issuer_did: ISSUER_DID, vendor_did: vendorSet ? vendor : null, seller,
    payment_details_only_on: PAYMENT_PLACES,
    never_asks_for: ['seed', 'identity or wallet private key', 'token'],
    never_sends_by_email_or_chat: ['payment address', 'payment link'],
    payment_proof_only_via: 'https://sigelo.io/contact.html',
  };
  const http = { challenge: `GET https://${HOST}/challenge?did={did}`, check: `POST https://${HOST}/check`, licence: `POST https://${HOST}/licence` };
  const contact = { email: 'contact@sigelo.io', email_receive_only: true, simplex: 'https://sigelo.io/contact.html', security: 'security@sigelo.io' };
  const description = 'End-to-end encrypted messages between AI agents: pair by a one-line invite code, log in with a sigelo identity (no accounts), messages held while one is offline.';
  put('index.json', JSON.stringify({
    name: 'sigelo relay', homepage: `${ORIGIN}/`, description, motto: MOTTO, disclosure: DISCLOSURE, positioning: POSITIONING,
    version: PKG.version, status: 'new', audited: false,
    license: { relay: PKG.license, clients: 'MIT' }, repository: REPO, built_from: built,
    relay: { host: HOST, mqtt: { version: '3.1.1', url: `mqtts://${HOST}:8883`, tls: true }, http, wire: 'sigelo-relay/0',
      login: 'sigelo identity (did:sigelo); no accounts', notices_topic: '$sigelo/notice', info: `https://${HOST}/relay.json`, a2a: false, queue: QUEUE_NOTE },
    crypto: {
      key_agreement: 'X-Wing (ML-KEM-768 + X25519), hybrid post-quantum', payload: 'XChaCha20-Poly1305', signatures: 'Ed25519 (not post-quantum)',
      relay_reads_content: false,
      relay_sees: ['network address: full in memory; cut to /24 or /48 in the relay log, kept 7 days; rarely full in a web server error line, with the request, which may name a DID, kept 7 days',
        'each identity\'s DID and its key rotations', 'operator pool membership and licences (Pro)',
        'licences and licensed operators\' identity rows, also in an encrypted nightly backup, each copy kept 7 days (deploy/backup.sh)', 'topics read and written, so who talks to whom', 'times',
        'sizes, rounded to 256 bytes'],
    },
    tiers,
    client: { install: install === '[install command]' ? null : install ?? null,
      commands: ['sigelo-agent init --recovery <z…>', 'sigelo-agent invite', 'sigelo-agent accept <code>', 'sigelo-agent send <contact> <message>', 'sigelo-agent inbox'], mcp: null },
    identity: { home: 'https://sigelo.io/', llms_txt: 'https://sigelo.io/llms.txt', index: 'https://sigelo.io/index.json', spec: 'https://sigelo.io/spec.md', mcp: 'https://sigelo.io/mcp' },
    official,
    agent_surfaces: { llms_txt: `${ORIGIN}/llms.txt`, llms_full_txt: `${ORIGIN}/llms-full.txt`, relay_json: `https://${HOST}/relay.json`,
      sitemap: `${ORIGIN}/sitemap.xml`, security_txt: `${ORIGIN}/.well-known/security.txt` },
    pages: PAGES.filter((p) => !p.noindex).map((p) => ({ slug: p.slug, html: pageUrl(p), markdown: `${ORIGIN}/${p.slug}.md` })),
    contact, privacy: `${ORIGIN}/privacy.html`, terms: `${ORIGIN}/terms.html`,
  }, null, 2) + '\n');
  // relay.json: the relay's own info document, in the spirit of Nostr's NIP-11 (plan §11), served at
  // https://relay.sigelo.ai/relay.json. Limits: the tiers above, and the caps no deployment changes.
  put('relay.json', JSON.stringify({
    name: 'sigelo relay', description: `${description} The relay cannot read them, but can tell who talks to whom.`, positioning: POSITIONING,
    software: REPO, version: PKG.version, source: REPO, license: PKG.license, status: 'new', audited: false,
    host: HOST, mqtt: { version: '3.1.1', url: `mqtts://${HOST}:8883`, tls: true }, http, wire: 'sigelo-relay/0', notices_topic: '$sigelo/notice',
    limits: { free: tiers.free, pro: tierJson(TIERS.pro, 'operator', tiers.pro.storage_bytes), queue: QUEUE_NOTE, topics_per_subscribe: MAX_TOPICS,
      invite_topic: { messages: INVITE_MESSAGES, bytes: INVITE_BYTES, days: INVITE_TTL / DAY } },
    fees: { pro: tiers.pro.price, on_sale: onSale }, payments_url: `${ORIGIN}/pro.html`,
    terms: `${ORIGIN}/terms.html`, privacy: `${ORIGIN}/privacy.html`, contact, official, docs: { home: `${ORIGIN}/`, index: `${ORIGIN}/index.json`, llms_txt: `${ORIGIN}/llms.txt` },
  }, null, 2) + '\n');

  // sitemap.xml (SEO spec §4.2): the indexable pages, llms.txt and index.json; never a twin, the
  // not-found page or llms-full.txt (each repeats a page). lastmod: the last commit of the source, of
  // the constants it shows when it has {{values}}, and for a generated file of its newest input.
  const valueSources = ['allowance.mjs', 'mailbox.mjs', 'operator.mjs'].map((f) => join(RELAY, f));
  const locs = [
    ...PAGES.filter((p) => !p.noindex).map((p) => [pageUrl(p), lastCommit(join(site, `${p.slug}.md`), ...(/\{\{/.test(md[p.slug]) ? valueSources : []))]),
    [`${ORIGIN}/llms.txt`, lastCommit(fileURLToPath(import.meta.url), join(RELAY, 'package.json'))],
    [`${ORIGIN}/index.json`, built.commit_date],   // it names its build commit, so every commit changes it
  ];
  put('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${locs.map(([l, d]) => `<url><loc>${l}</loc>${d ? `<lastmod>${d.slice(0, 10)}</lastmod>` : ''}</url>`).join('\n')}
</urlset>
`);

  // security.txt (RFC 9116). Expires: one year after the build commit, so a stale deploy expires;
  // without git, one year after the build.
  const expires = new Date((built.commit_date ? Date.parse(built.commit_date) : Date.now()) + 365 * DAY * 1000).toISOString().replace(/\.\d+Z$/, '.000Z');
  put('.well-known/security.txt', `Contact: mailto:security@sigelo.io
Expires: ${expires}
Canonical: ${ORIGIN}/.well-known/security.txt
Policy: https://sigelo.io/security.html
Policy: https://sigelo.io/security.html#official-channels
Preferred-Languages: en
`);
  return { pages: PAGES.length, open, wrong, built };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes('--launch')) {
    const why = isPrivateTree() ? launchRefusals() : ['not the private tree: no site/build.mjs beside relay/, so nothing here says what index.json says'];
    for (const w of why) console.error(`relay/site/build --launch: ${w}`);
    if (why.length === 0) {
      writeFileSync(join(SITE, LAUNCH_RECORD), `${JSON.stringify({ checked: 'SECURITY.md and site/deploy/nginx.conf say what index.json says', by: 'relay/site/build.mjs --launch' })}\n`);
      console.log(`relay/site/build --launch: SECURITY.md and site/deploy/nginx.conf say what index.json says; wrote relay/site/${LAUNCH_RECORD}: commit it, then export`);
    }
    process.exit(why.length ? 1 : 0);
  }
  try {
    const r = build({ final: process.argv.includes('--final') });
    console.log(`relay/site/dist: ${r.pages} pages (+ .md twins) and the agent files, from ${r.built.commit?.slice(0, 12) ?? 'no git commit'}${r.built.dirty ? ' (relay/ has uncommitted changes)' : ''}`);
    const label = { DRAFT: "DRAFT — the terms' draft mark (terms.md)", SELLER: 'SELLER — the seller\'s legal name (relay/site/build.mjs)',
      'vendor DID': 'vendor DID — the relay pins licence.ts\'s placeholder: set RELAY_VENDOR_DID, or the real DID at D1 (in spend/licence.ts, copied to relay/licence.ts)' };
    for (const p of r.open) console.log(`open: ${PLACEHOLDERS[p] ? `${p} — ${PLACEHOLDERS[p]}` : label[p] ?? p}`);
    for (const w of r.wrong) console.log(`wrong: ${w}`);
  } catch (e) { console.error(`relay/site/build: ${e.message}`); process.exit(1); }
}
