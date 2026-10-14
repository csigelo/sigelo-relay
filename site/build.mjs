#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// relay/site/build.mjs — renders sigelo.ai (design/relay-plan.md §7 M5, §11) to relay/site/dist/.
//
//   node relay/site/build.mjs           build, and list what is still open before a deploy
//   node relay/site/build.mjs --final   refuse while anything is open or wrong (the deploy gate)
//   node relay/site/build.mjs --launch  in the private tree: the official statement, then what npm
//                                       serves; writes relay/site/launch.json when both pass (launchGate)
//
// Nine pages, each twice, /<page>.html and /<page>.md (the twin ends with the footer as Markdown),
// plus what agents and crawlers read: robots.txt (and relay-robots.txt, which nginx serves as
// relay.sigelo.ai's), sitemap.xml, llms.txt, llms-full.txt, index.json, relay.json (the relay info
// document of plan §11) and .well-known/security.txt. nginx (relay/deploy/nginx.conf) serves
// index.json, relay.json and llms.txt with Access-Control-Allow-Origin: *, so a browser-based agent
// can read them. Static files only: no script but JSON-LD data, no form, no cookie, nothing from
// another origin.
//
// The numbers are not typed into the pages: a source writes {{free.msgsDay}} and the build fills it
// from the relay's own constants (relay/allowance.mjs TIERS, mailbox.mjs, operator.mjs), so a page
// cannot promise what the relay does not do. Open: a placeholder, the terms' DRAFT mark, SELLER
// unset, the vendor DID unset while pro.md does not say Pro is coming soon (VENDOR_PENDING), a
// server fact the pages promise that relay/deploy/nginx.conf does not deliver, and in the private
// tree an official statement (SECURITY.md, sigelo.io's index.json and nginx) or a sigelo-agent source
// that does not yet do what index.json says (in the relay's export, which lacks them, no record of
// that check, or one that does not name the sigelo-agent npm served: launchGate). Wrong: a Monero
// address or a payment link on any page (an address comes only with an invoice), a seller the pages
// do not name, an unreadable price line, or a Pro storage above what the relay grants. Payment is
// Monero only. Node >= 22.18 (it imports ../licence.ts, as the relay does).
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
import { LOOKUPS, PARK_MAX, PARKS, PARK_TTL } from '../park.mjs';
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

// Who sells Pro and operates the relay, as the pages name it (footer, JSON-LD provider, index.json):
// the trade name. The Owner's decision: the pages give no legal name; privacy.md and terms.md say
// "a business registered in the European Union; legal name and registered address on request".
// --final refuses null, and a name privacy.md and terms.md do not begin their seller line with
// (commercial/relay-pro-runbook.md §0).
export const SELLER = 'sigelo';

// Pro is not on sale until the vendor identity exists: the Owner mints it at a terminal
// (commercial/vendor-ceremony-runbook.md §2–3), and no licence can be issued before. pro.md says so in
// this sentence at its top, and the build reads it from the page (vendorPending), so the two cannot
// drift: while it is there, --final and --launch take the relay's placeholder vendor DID, index.json
// and relay.json mark Pro not_yet_on_sale, the JSON-LD offers only the free tier, and the
// descriptions and llms.txt lines that would read as a sale say "coming soon" (PAGES `pending`,
// llmsTxt). The home page's Pro card says so too (HOME_PENDING). Once the sentence is gone, the
// vendor DID is required again. A vendor DID set while the sentence stays, or the home card out of
// step with pro.md, is refused (vendorRefusals). The Owner's words: "coming soon", no date.
export const VENDOR_PENDING = 'Pro is coming soon. Every agent runs free until then.';
export const VENDOR_PENDING_PAGES = ['pro'];
// The home page's Pro card, under its price: this line while Pro is coming soon, the other once on sale.
export const HOME_PENDING = 'Coming soon.';
export const HOME_ON_SALE = 'Available now.';
// → true while every page of VENDOR_PENDING_PAGES carries the sentence, false while none does, and
// why not while only some do.
export function vendorPending(md) {
  const on = VENDOR_PENDING_PAGES.filter((slug) => (md[slug] ?? '').includes(VENDOR_PENDING));
  if (on.length === 0 || on.length === VENDOR_PENDING_PAGES.length) return on.length > 0;
  const off = VENDOR_PENDING_PAGES.filter((slug) => !on.includes(slug));
  return `pages: "${VENDOR_PENDING}" is on ${on.map((x) => `${x}.md`).join(' and ')} but not on ${off.map((x) => `${x}.md`).join(' and ')} (both pages, or neither)`;
}
// The vendor DID against the pages. → [why …]: 'vendor DID' while it is unset (the relay pins
// licence.ts's placeholder) and pro.md does not say Pro is coming soon; a refusal while it is set and
// pro.md still says so; a refusal while the home page's Pro card does not say what pro.md says
// (HOME_PENDING while pending, HOME_ON_SALE once on sale); nothing otherwise.
export function vendorRefusals(md, vendor) {
  const pending = vendorPending(md), set = vendor !== DEV_VENDOR_DID;
  if (typeof pending === 'string') return [pending];
  const why = [];
  const home = md.index ?? '';
  if (pending && !home.includes(`\n\n${HOME_PENDING}\n\n`)) why.push(`index.md: its Pro card does not say "${HOME_PENDING}" under the price, though pro.md says Pro is coming soon`);
  if (!pending && home.includes(HOME_PENDING)) why.push(`index.md: its Pro card still says "${HOME_PENDING}", though pro.md no longer does (write "${HOME_ON_SALE}")`);
  if (!set && !pending) why.push('vendor DID');
  if (set && pending) why.push(`vendor DID: set (${vendor}), but ${VENDOR_PENDING_PAGES.map((x) => `${x}.md`).join(' and ')} still says "${VENDOR_PENDING}": remove that sentence`);
  return why;
}
// The vendor DID the relay pins where this runs: RELAY_VENDOR_DID, else licence.ts's (SIGELO_VENDOR_DID
// or the placeholder), as relay/allowance.mjs reads it.
export const pinnedVendor = () => process.env.RELAY_VENDOR_DID || vendorDid();

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
// SECURITY.md's line, which the contact page carries verbatim (SEO spec §4.10). A payment address is made
// per invoice, so it is sent: only in answer to the buyer's own request, in the SimpleX conversation
// the buyer opened from sigelo.io's contact page (a conversation a phisher cannot write into).
// index.json's official.payment_address_only_with and invoice_only_via say so, as sigelo.io's do.
export const NOBODY = 'Nobody from the project will ever ask for a seed, an identity or wallet private key, or a token. A payment address comes only with an invoice you asked for, in the SimpleX conversation you opened with the address on `https://sigelo.io/contact.html`.';
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
// sigelo.io's official-channels statement.
export const STATEMENT = 'https://sigelo.io/security.html#official-channels';
// Where how to pay is published: the contact page (Monero only, by invoice over SimpleX), and on the
// relay repository's main branch its one file, not the repository as a whole (anyone can put text
// under its URL: an issue, a pull request, a fork's commit, which GitHub serves under the parent's
// URL). The address itself is on neither: it comes with an invoice (NOBODY). index.json says so (as
// payment_details_only_on, the name sigelo.io's site/src/official.mjs uses for the same places), and
// the contact page names the same file and branch in words (PAYMENT_WORDS), so a page that says
// otherwise, anywhere, is not ours. Until 2026-10-14 the place was a pay page, /pay-monero.html,
// which nginx now sends to /pro.html.
export const PAYMENT_PLACES = [`${ORIGIN}/contact.html`, `${REPO}/blob/main/site/contact.md`];
export const PAYMENT_WORDS = `How to pay is published only here and in \`site/contact.md\` on the main branch of \`${REPO.replace(/^https:\/\//, '')}\`.`;
// The SimpleX address sigelo.io's contact page shows (site/src/official.mjs SIMPLEX), copied as
// DOMAINS is: relay/site/test.mjs compares the two in the private tree, and --launch SECURITY.md's.
export const SIMPLEX = 'https://smp10.simplex.im/a#18LjfJawmkVxvFtCHFo-yyzPo8Kr3gPLNts_ovwxmZM';

// The pages. `nav`: the label in the header's nav and the footer; `foot`: in the footer only. The
// home page is reached by the wordmark; the agents' page (the Pro steps and erasure requests, what an
// agent runs for its operator) and the not-found page are in neither: the agents' page is linked from
// /pro and /privacy, and listed in llms.txt, the sitemap and index.json; the not-found page nowhere.
// Titles get " — sigelo relay" but the home page's. `pending`: the title or description while Pro is
// coming soon (VENDOR_PENDING), for each page whose head would otherwise read as a sale; a search
// result or link preview shows the head, not the page's first paragraph. No title or description
// mentions the Monero discount (runbook §7 Q5). The word budgets: relay/site/test.mjs counts each
// page as `wc -w` would with every {{value}} filled, a size being two words ("50 MB"): the prose
// (PROSE_BUDGET there: no table, card, code block or directive line) and the whole file
// (docs-test/budgets.json, which docs-test/check-budgets.mjs checks on the source as written).
export const PAGES = [
  { slug: 'index', nav: null, title: 'sigelo relay — end-to-end encrypted messaging for AI agents',
    description: 'Connect your AI agent to the agents you trust: a short code pairs them, then they message end-to-end encrypted. No accounts; free for every agent.' },
  { slug: 'connect', nav: 'Connect', title: 'Connect two agents in a minute',
    description: 'Pair two AI agents in a minute: install sigelo-agent, make a short code, say it, their agent enters it. Then they message end-to-end encrypted.' },
  { slug: 'pro', nav: 'Pro', title: 'Pro: all your agents on one allowance',
    description: 'sigelo relay Pro: one allowance for all your agents, {{pro.msgsDay}} messages a day, up to {{pro.maxMessage}} each. 10 € a month or 100 € a year, for businesses.',
    pending: { description: 'sigelo relay Pro: one allowance for all your agents, {{pro.msgsDay}} messages a day, up to {{pro.maxMessage}} each. Coming soon; free until then.' } },
  { slug: 'enterprise', nav: 'Enterprise', title: 'Enterprise: teams and swarms of agents',
    description: 'sigelo relay for companies running teams and swarms of AI agents: allowances sized to you, your own relay, priority support. Contact us for a quote.' },
  { slug: 'contact', nav: 'Contact', title: 'Contact',
    description: 'Reach sigelo over SimpleX for questions, invoices and quotes. A payment address comes only with an invoice you asked for, in a conversation you opened.' },
  { slug: 'privacy', nav: 'Privacy', foot: true, title: 'Privacy: what the relay keeps',
    description: 'What the sigelo relay and this site keep, and for how long: addresses cut to /24 or /48 for 7 days; never message content. No cookies, no scripts.' },
  { slug: 'terms', nav: 'Terms', foot: true, title: 'Terms of service',
    description: 'Terms for sigelo relay Pro, sold to businesses only: the free service, Pro as a licence attestation, no custody, no payment routing, liability, law.',
    pending: { description: 'Terms for sigelo relay: the free service, Pro (coming soon; businesses only) as a licence attestation, no custody, no payment routing, liability, law.' } },
  { slug: 'agents', nav: null, title: 'For agents: Pro setup and data requests',
    description: 'What an agent runs for its operator on sigelo relay: the Pro setup (operator identity, licence, attestations) and signed erasure or access requests.' },
  { slug: '404', nav: null, noindex: true, title: 'Not found',
    description: 'No page at this address on sigelo.ai. Start at the home page, Connect or Contact; agents can start at /llms.txt or /index.json.' },
];
export const pageUrl = (p) => (p.slug === 'index' ? `${ORIGIN}/` : `${ORIGIN}/${p.slug}.html`);
const headOf = (p, pending) => ({ title: p.title, description: p.description, ...(pending && p.pending) });
export const titleOf = (p, pending = false) => (p.slug === 'index' ? p.title : `${headOf(p, pending).title} — sigelo relay`);
export const descriptionOf = (p, pending = false) => fill(headOf(p, pending).description, p.slug);

// The relay's numbers, as the pages write them. Days an identity's rows stay after its last use:
// mailbox.mjs drops an account ACCOUNT_KEEP after its last login once its claims are gone, and an
// idle claim its retention plus IDLE_GRACE after its last use (relay/site/test.mjs checks both
// against the code's behaviour where it can).
const thou = (x) => String(x).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const size = (b) => (b % MB === 0 ? `${b / MB} MB` : `${b / KB} KB`);
const days = (s) => String(s / DAY);
const keep = (t) => days(Math.max(ACCOUNT_KEEP, t.retentionDays * DAY + IDLE_GRACE));
// Contacts a tier's mailboxes hold: a contact costs its reader one mailbox per ISO week of its
// retention window and one for the week ahead its client claims (allowance.mjs windowWeeks), so 4
// on the free tier's 14 days and 15 at 90 days. About: near a Monday it may cost one more.
const contacts = (t) => thou(Math.floor(t.mailboxes / (windowWeeks(t.retentionDays) + 1)));
// A tier's support, as the pages and index.json write it (operator.mjs SUPPORT). The licence claim
// "email" is answered over SimpleX: contact@sigelo.io only receives (terms §7), so a page saying
// "e-mail" would sell what no one sends.
const support = (t) => ({ none: 'none', email: 'SimpleX', priority: 'priority' })[t.support];
export const VALUES = Object.freeze({
  'free.storage': size(TIERS.free.storage), 'free.msgsDay': thou(TIERS.free.msgsDay), 'free.retentionDays': String(TIERS.free.retentionDays),
  'free.maxMessage': size(TIERS.free.maxMessage), 'free.mailboxes': thou(TIERS.free.mailboxes), 'free.contacts': contacts(TIERS.free),
  'pro.msgsDay': thou(TIERS.pro.msgsDay), 'pro.retentionDays': String(TIERS.pro.retentionDays),
  'free.support': support(TIERS.free),
  'pro.maxMessage': size(TIERS.pro.maxMessage), 'pro.mailboxes': thou(TIERS.pro.mailboxes), 'pro.contacts': contacts(TIERS.pro), 'pro.support': support(TIERS.pro),
  'keep.account.free': keep(TIERS.free), 'keep.account.pro': keep(TIERS.pro), 'keep.licence': days(LICENCE_KEEP),
  'operator.days': String(OPERATOR_DAYS),
  'contact.simplex': SIMPLEX,
});
// Retention is how long a queued message waits, not how long its reader may stay away: the relay
// queues only to a mailbox its reader holds (no_reader otherwise), and the client claims about a
// week ahead on every tier (contact/carrier.mjs AHEAD, which relay/site/test.mjs checks in the
// private tree). pro.md says so under its table; index.json and relay.json carry this sentence.
export const QUEUE_NOTE = 'retention_days is how long a queued message waits. The relay queues only to mailboxes its reader holds, and clients claim them about a week ahead on every tier, so a reader away longer takes no new messages until it is back (senders get no_reader; sigelo-agent keeps them and sends them again).';
// {{name}} → its value; an unknown name stops the build (a typo would ship a raw token).
export function fill(text, where) {
  return text.replace(/\{\{([\w.]+)\}\}/g, (_, k) => {
    if (!(k in VALUES)) throw new Error(`${where}: unknown value {{${k}}} (VALUES in relay/site/build.mjs)`);
    return VALUES[k];
  });
}

// The inputs the pages still lack, as `[text]` → what fills it. Every one is filled (2026-10-13:
// the Owner's and the orchestrator's decisions, commercial/relay-pro-runbook.md §0). A new one goes
// here with its page; anything shaped like a placeholder that is not listed here fails
// relay/site/test.mjs, and --final refuses any placeholder left in a page, listed or not.
export const PLACEHOLDERS = {};
// `[text]` not followed by `(`: Markdown link text always is, so only placeholders match.
export const PLACEHOLDER_RE = /\[[a-z][^\]\n]*\](?!\()/g;
export const DRAFT_RE = /^> \*\*DRAFT\b/m;
// pro.md's price line, which the JSON-LD offers and index.json read. → [month, year, discount].
export const PRICE_RE = /^\*\*([1-9]\d*) € a month or ([1-9]\d*) € a year\*\*, excluding VAT, for businesses\. You pay in Monero, at ([1-9]\d?) % off\.$/m;
// pro.md's storage cell: N MB or N GB.
export const STORAGE_RE = /^\| Room for waiting messages \| [^|]+ \| ([1-9]\d* [MG]B) \|$/m;
const storageBytes = (cell) => Number(cell.split(' ')[0]) * (cell.endsWith('GB') ? 1024 * MB : MB);
// The most storage the relay grants a Pro pool, whatever a licence claims: RELAY_PRO_STORAGE_MB where
// the site is built, read as relay/allowance.mjs relayPolicyFromEnv reads it on the relay (a whole
// number of MB, 1 to 10,000,000), else TIERS.pro.storage. null when it is set but malformed.
export function proStorageCap(v = process.env.RELAY_PRO_STORAGE_MB) {
  if (v === undefined || v === '') return TIERS.pro.storage;
  return /^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 1e7 ? Number(v) * MB : null;
}

// ---------------------------------------------------------------------------------------------
// A payment address is made per invoice (a Monero subaddress for that invoice alone) and sent only in
// the buyer's own SimpleX conversation (NOBODY). So no page carries a Monero address, of any network,
// standard, sub- or integrated, nor a payment link: a monero: payment request, or a processor's hosted
// checkout URL (Monero is the only payment). One there would be stale, or not ours. → [why …].
// The processor's host is spelled s[t]ripe: the same match, and the launch check that greps the site
// for that name, which must print nothing, finds none in this guard.
export const XMR_RE = /(?<![1-9A-HJ-NP-Za-km-z])[4-9AB][1-9A-HJ-NP-Za-km-z]{94}(?:[1-9A-HJ-NP-Za-km-z]{11})?(?![1-9A-HJ-NP-Za-km-z])/;
export const PAYMENT_LINK_RE = /\bmonero:(?:\/\/)?[1-9A-HJ-NP-Za-km-z]|https?:\/\/(?:[\w-]+\.)*s[t]ripe\.com\b/i;
export function paymentDetailRefusals(md) {
  return Object.entries(md).flatMap(([slug, text]) => [
    XMR_RE.test(text) && `${slug}: carries a Monero address (addresses are made per invoice and never published)`,
    PAYMENT_LINK_RE.test(text) && `${slug}: carries a payment link (a monero: request or a checkout URL; an address comes only with an invoice)`,
  ].filter(Boolean));
}
// → undefined while SELLER is unset or names the seller privacy.md and terms.md name, else why not.
export function sellerRefusal(seller, md) {
  if (seller === null) return undefined;
  if (typeof seller !== 'string' || !/^[^\s<>[\]{}`*_|"]+(?: [^\s<>[\]{}`*_|"]+)*$/.test(seller) || seller.length > 100) return 'SELLER: want the name the pages give the seller, plain text on one line, at most 100 characters';
  const at = [['privacy', `GDPR controller: ${seller}`], ['terms', `Seller: ${seller}`]].filter(([slug, s]) => !md[slug].includes(s));
  return at.length ? `SELLER "${seller}" is not the seller ${at.map(([slug]) => `${slug}.md`).join(' and ')} name${at.length > 1 ? '' : 's'}` : undefined;
}

// What the pages promise about the server, as relay/deploy/nginx.conf ships it. nginx's defaults log
// the full address and the request line (/challenge?did=…): the access log for every request, the
// error log for each refusal by limit_req and each failed proxy call. privacy.md says the web
// access log keeps the address cut to /24 or /48 and no full address but in a rare error line, and
// pro.md step 4 uploads to /licence. So every server block sets its access log at its own level,
// off or to the format sigelo_anon only (ANON_LOG), and inside it a location may only turn it off;
// the format and the maps it reads are exactly sigelo.io's (ANON: the address cut, the path
// without its query, the referrer's host); the error log is down to crit at its own level and
// nothing turns it up; the statistics' root is served behind basic auth, unlogged; one block
// proxies /licence; and every block that proxies to the relay sets X-Real-IP to the
// client's address at its own level, with no proxy_set_header in any location. nginx inherits
// proxy_set_header into a location only while the location sets none of its own; one that sets any
// other header passes the client's own X-Real-IP, which the relay believes from loopback, so a client
// could name a new network for every request and pass every per-network limit.
// → [why …].
const ANON_LOG = /^access_log \/var\/log\/nginx\/sigelo\/[a-z-]+\.log sigelo_anon(?: if=\$sigelo_(?:self|outside))?$/;
export const ANON = {
  'log_format sigelo_anon': `'$sigelo_net - - [$time_local] "$request_method $sigelo_path $server_protocol" $status $body_bytes_sent "$sigelo_ref" "$http_user_agent" "$http_accept" $request_time'`,
  'map $remote_addr $sigelo_net': 'default "0.0.0.0"|"~^(?<sigelo_n4>\\d+\\.\\d+\\.\\d+)\\.\\d+$" "$sigelo_n4.0"|"~*^(?<sigelo_n6>[0-9a-f]+:[0-9a-f]+:[0-9a-f]+):" "$sigelo_n6::"|"~*^(?<sigelo_n6b>[0-9a-f]+:[0-9a-f]+)::" "$sigelo_n6b::"|"~*^(?<sigelo_n6c>[0-9a-f]+)::" "$sigelo_n6c::"',
  'map $request_uri $sigelo_path': 'default "-"|"~^(?<sigelo_p>/[^?]*)" "$sigelo_p"',
  'map $http_referer $sigelo_ref': 'default "-"|"~*^(?<sigelo_rs>https?)://(?<sigelo_rh>[^/:?#]+)" "$sigelo_rs://$sigelo_rh/"',
};
export const STATS_ROOT = 'root /var/www/sigelo.ai/stats';
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
    const inside = everyDirective(s), own = s.directives.filter((d) => /^access_log\b/.test(d));
    const ownOk = own.length > 0 && (own.join() === 'access_log off' || own.every((d) => ANON_LOG.test(d)));
    if (!ownOk || s.blocks.flatMap(everyDirective).some((d) => /^access_log\b/.test(d) && d !== 'access_log off')) {
      why.push(`${name}: ${label} lacks "access_log off;" or access logs in the format sigelo_anon only at its own level, or turns the access log on inside it (privacy.md: addresses cut to /24 or /48, no query string, no DID in any log)`);
    }
    if (inside.some((d) => /^log_format\b/.test(d))) why.push(`${name}: ${label} defines a log format (only the one sigelo_anon at the top)`);
    for (const b of s.blocks.filter((x) => everyDirective(x).includes(STATS_ROOT))) {
      const d = everyDirective(b);
      if (!d.includes('access_log off') || !d.some((x) => /^auth_basic "/.test(x)) || !d.includes('auth_basic_user_file /etc/nginx/sigelo-stats.htpasswd')) {
        why.push(`${name}: ${label} serves the statistics (${b.head}) without basic auth, or logs them`);
      }
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
  // The format and the maps it reads: sigelo.io's, exactly. Any other would keep more (a full
  // address, a query string naming a DID, a referrer's path).
  if (servers.some((s) => s.directives.some((d) => ANON_LOG.test(d)))) {
    const formats = tree.directives.filter((d) => /^log_format\b/.test(d));
    if (formats.length !== 1 || formats[0] !== `log_format sigelo_anon ${ANON['log_format sigelo_anon']}`) why.push(`${name}: log_format sigelo_anon is not sigelo.io's format (the address cut, no query string), or a second format is defined`);
    for (const [head, want] of Object.entries(ANON).filter(([h]) => h.startsWith('map '))) {
      const maps = tree.blocks.filter((b) => b.head === head);
      if (maps.length !== 1 || maps[0].directives.join('|') !== want) why.push(`${name}: "${head}" is not sigelo.io's (the access log keeps what it gives)`);
      const out = head.split(' ').at(-1);
      if (tree.blocks.some((b) => b.head.startsWith('map ') && b.head !== head && b.head.split(' ').at(-1) === out)) why.push(`${name}: ${out} is set by a second map`);
    }
  }
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
// before a deploy (SEO spec §4.10, task 8): SECURITY.md carries the "Nobody…" line, no longer the
// old one that said no payment address or link is ever sent by chat, names the relay's repository
// and carries the SimpleX address sigelo.io's contact page shows (site/src/official.mjs SIMPLEX: the
// contact page sends buyers to compare the two); sigelo.io's own index.json (site/build.mjs) says
// what sigelo.ai's does about payment addresses, in the same fields; site/deploy/nginx.conf
// (sigelo.io's host) no longer serves sigelo.ai, and each live redirect in DOMAINS answers 301 to its
// target there. The file is read, not the live server: it is what the next deploy of sigelo.io
// serves, so the record can be written before that deploy. A redirect marked live: false (its DNS
// does not reach us yet: sigelo.online, sigelo.dev) is not required. And
// the install line connect.md and index.json give works: the sigelo-agent package no longer refuses
// the contact verbs when installed from npm. The private tree is the one with sigelo.io's
// site/build.mjs beside relay/; there every file named here must be found. Elsewhere they are
// absent: see launchGate. → [why …].
export const isPrivateTree = (root = ROOT) => existsSync(join(root, 'site', 'build.mjs'));
// The launch gate as build() applies it. In the private tree: launchRefusals(). Elsewhere (the relay
// export, where deploy.sh runs --final) nothing can be checked, so the record `--launch` wrote in the
// private tree must be here: relay/site/launch.json, committed and exported with the sources, naming
// the sigelo-agent and sigelo-contact npm served when it was written (recordRefusals).
// relay/site/test.mjs fails in the private tree while that record exists and launchRefusals() or
// recordRefusals() does not pass, so it cannot outlive what it records. → [why …].
export const LAUNCH_RECORD = 'launch.json';
export function launchGate(root = ROOT, site = SITE) {
  if (isPrivateTree(root)) return launchRefusals(root);
  return recordRefusals(site);
}
// The record as --final reads it in the export (no network there): JSON naming, under `npm`, the
// sigelo-agent and sigelo-contact versions npm served at --launch, each CONTACT_VERBS_SINCE or later.
// A record written before --launch read the registry names neither, and is refused. → [why …].
export function recordRefusals(site = SITE) {
  const f = join(site, LAUNCH_RECORD), again = 'run relay/site/build.mjs --launch in the private tree, commit what it writes, then export';
  if (!existsSync(f)) return [`launch: no site/${LAUNCH_RECORD}; ${again} (it checks SECURITY.md, sigelo.io's build and nginx, sigelo-agent and what npm serves, which the export cannot)`];
  let rec = null;
  try { rec = JSON.parse(readFileSync(f, 'utf8')); } catch { /* refused below */ }
  const short = LAUNCH_PACKAGES.filter((n) => !versionAtLeast(rec?.npm?.[n], CONTACT_VERBS_SINCE));
  return short.length ? [`launch: site/${LAUNCH_RECORD} does not record npm serving ${short.join(' and ')} at ${CONTACT_VERBS_SINCE} or later (connect.md's install line needs both): publish them, then ${again}`] : [];
}
// What npm serves. connect.md's `npm i -g sigelo-agent` installs npm's latest sigelo-agent, which runs
// the contact verbs only from CONTACT_VERBS_SINCE, through the sigelo-contact package it depends on;
// launchRefusals reads the source, which is ahead of npm until the release is published. So --launch,
// once everything else passes, reads the registry (no credentials): the latest sigelo-agent at least
// this tree's (adapters/moadim/package.json) and depending on sigelo-contact, the latest sigelo-contact
// at least that too, each published by NPM_USER (SECURITY.md names no other publisher). get(name) → the
// package's registry document, null when npm has none, or throws. → { why: [why …], npm: { name: version } }.
export const NPM_REGISTRY = 'https://registry.npmjs.org';
export const NPM_USER = 'csigelo';
export const LAUNCH_PACKAGES = ['sigelo-agent', 'sigelo-contact'];
export const CONTACT_VERBS_SINCE = '0.1.2';
const semver = (v) => (typeof v === 'string' && /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null);
export const versionAtLeast = (v, min) => { const a = semver(v), b = semver(min); return !!a && !!b && (a[0] - b[0] || a[1] - b[1] || a[2] - b[2]) >= 0; };
export async function npmPackument(name) {
  const res = await fetch(`${NPM_REGISTRY}/${name}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
export async function registryRefusals({ root = ROOT, get = npmPackument } = {}) {
  const want = JSON.parse(readFileSync(join(root, 'adapters', 'moadim', 'package.json'), 'utf8')).version;
  const why = [], npm = {};
  let docs;
  try { docs = await Promise.all(LAUNCH_PACKAGES.map((n) => get(n))); } catch (e) {
    return { why: [`npm: could not read ${NPM_REGISTRY} (${e.message}); the record says what npm serves, so it is not written without that`], npm };
  }
  LAUNCH_PACKAGES.forEach((name, i) => {
    const doc = docs[i], v = doc?.['dist-tags']?.latest, meta = doc?.versions?.[v], by = meta?._npmUser?.name;
    if (!meta) { why.push(`npm: no ${name}${name === 'sigelo-agent' ?  " (connect.md's install line)" : ' (sigelo-agent needs it for the contact verbs; the name is ours only once published)'}`); return; }
    npm[name] = v;
    if (!versionAtLeast(v, want)) why.push(`npm: ${name}'s latest is ${v}, older than this tree's ${want}; publish ${want} first${name === 'sigelo-agent' ? ' (`npm i -g sigelo-agent` would install one without the contact verbs connect.md lists)' : ''}`);
    if (by !== NPM_USER) why.push(`npm: ${name} ${v} was published by ${by ?? 'no one named'}, not ${NPM_USER}`);
    if (name === 'sigelo-agent' && !meta.dependencies?.['sigelo-contact']) why.push(`npm: sigelo-agent ${v} does not depend on sigelo-contact, which carries the contact verbs`);
  });
  return { why, npm };
}
export function launchRefusals(root = ROOT) {
  const why = [];
  const security = join(root, 'SECURITY.md'), io = join(root, 'site', 'deploy', 'nginx.conf');
  const ioBuild = join(root, 'site', 'build.mjs'), ioOfficial = join(root, 'site', 'src', 'official.mjs');
  const verbs = join(root, 'adapters', 'moadim', 'sigelo-agent-contact.ts');
  const read = (f) => (existsSync(f) ? readFileSync(f, 'utf8') : null);
  if (isPrivateTree(root)) {
    for (const [f, label] of [[security, 'SECURITY.md'], [io, 'site/deploy/nginx.conf'], [ioOfficial, 'site/src/official.mjs'], [verbs, 'adapters/moadim/sigelo-agent-contact.ts']]) {
      if (!existsSync(f)) why.push(`${label}: not found beside relay/ in the private tree`);
    }
  }
  const s = read(security);
  if (s !== null) {
    if (!s.includes(NOBODY)) why.push('SECURITY.md: lacks the "Nobody from the project…" line the contact page carries (SEO spec §4.10)');
    if (/send a payment address or link by e-mail or chat|Payment proofs/.test(s)) why.push('SECURITY.md: still says no payment address or link is sent by chat, or where payment proofs go; an invoice now carries the address over SimpleX');
    if (!s.includes(REPO)) why.push(`SECURITY.md: does not name ${REPO} as official (the contact page says how to pay is published in its site/contact.md)`);
  }
  // The address the contact page shows: sigelo.io's contact page's, which SECURITY.md carries too.
  const o = read(ioOfficial);
  if (o !== null) {
    const simplex = o.match(/^export const SIMPLEX = '([^'<>\n]+)';$/m)?.[1];
    if (!simplex) why.push('site/src/official.mjs: no SIMPLEX address (the one sigelo.io/contact.html shows)');
    else if (s !== null && !s.includes(simplex)) why.push('SECURITY.md: lacks the SimpleX address sigelo.io/contact.html shows (site/src/official.mjs SIMPLEX), which sigelo.ai/contact.html shows too');
    if (simplex && simplex !== SIMPLEX) why.push('relay/site/build.mjs: SIMPLEX is not the address site/src/official.mjs gives sigelo.io/contact.html (sigelo.ai/contact.html shows it)');
  }
  // sigelo.io's index.json `official`, which SECURITY.md names as the machine-readable statement.
  const b = isPrivateTree(root) ? read(ioBuild) : null;
  if (b !== null && (/never_sends_by_email_or_chat|payment_proof_only_via|payment_address_or_link_only_with/.test(b) || !b.includes('payment_address_only_with'))) {
    why.push('site/build.mjs: sigelo.io\'s index.json still says no payment address or link is sent by chat (never_sends_by_email_or_chat, payment_proof_only_via), still has payment_address_or_link_only_with, or lacks payment_address_only_with, as sigelo.ai\'s index.json has it');
  }
  const v = read(verbs);
  if (v !== null && /not in the npm release of sigelo-agent/.test(v)) {
    why.push('adapters/moadim/sigelo-agent-contact.ts: the contact verbs still refuse when sigelo-agent is installed from npm, so connect.md\'s `npm i -g sigelo-agent` then `sigelo-agent invite` fails');
  }
  const n = read(io);
  if (n !== null) {
    const tree = nginxTree(n);
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
// What --launch checks before it writes the record: the private tree's statement (launchRefusals)
// and the vendor DID against the pages (vendorRefusals), as --final will. → [why …].
export const readPages = (site = SITE) => Object.fromEntries(PAGES.map((p) => [p.slug, readFileSync(join(site, `${p.slug}.md`), 'utf8')]));
export function launchCheck({ root = ROOT, site = SITE, vendor = pinnedVendor() } = {}) {
  if (!isPrivateTree(root)) return ['not the private tree: no site/build.mjs beside relay/, so nothing here says what index.json says'];
  return [...launchRefusals(root), ...vendorRefusals(readPages(site), vendor)];
}

// ---------------------------------------------------------------------------------------------
// Markdown → HTML, copied from site/build.mjs: ATX headings, paragraphs, fenced code, block
// quotes, nested lists, GFM tables, rules, inline code, links, autolinks, bold, italic. No raw
// HTML passes through: every `<` that is not ours is escaped. Added here for the layout, not in
// sigelo.io's copy: containers, `::: name [modifier]` … `:::` (as many colons to close as opened,
// so `::::` holds `:::`), rendered as <div class="name modifier"> (<section> for the hero), and
// `::: svg <name>`, one of DRAWINGS below. Names are [a-z-] only. The .md twins drop those lines.
const BOX = /^(:{3,})[ \t]*([a-z][a-z-]*)(?:[ \t]+([a-z][a-z-]*))?[ \t]*$/;
export const stripBoxes = (md) => md.split('\n').filter((l) => !BOX.test(l) && !/^:{3,}\s*$/.test(l)).join('\n').replace(/\n{3,}/g, '\n\n');
// The drawings, inline SVG: line art in the accent colour (style.css .art), a title for screen
// readers, no script, nothing fetched. relay: an envelope going from one agent through the relay to
// the other.
const agentHead = (x) => `<rect class="art" x="${x - 45}" y="58" width="90" height="80" rx="18"></rect>`
  + `<line class="art" x1="${x}" y1="58" x2="${x}" y2="40"></line><circle class="art-dot" cx="${x}" cy="35" r="6"></circle>`
  + `<circle class="art-dot" cx="${x - 16}" cy="92" r="6"></circle><circle class="art-dot" cx="${x + 16}" cy="92" r="6"></circle>`
  + `<path class="art" d="M${x - 15} 115 q15 10 30 0"></path>`;
const envelope = (x, y) => `<rect class="art art-paper" x="${x}" y="${y}" width="54" height="36" rx="3"></rect><path class="art" d="M${x} ${y} l27 20 l27 -20"></path>`;
export const DRAWINGS = {
  relay: `<figure class="drawing"><svg class="art-svg" viewBox="0 0 640 200" role="img" aria-labelledby="drawing-relay-title">
<title id="drawing-relay-title">Your agent sends an envelope to the sigelo relay, which passes it on to their agent.</title>
${agentHead(95)}${agentHead(545)}
<rect class="art" x="268" y="66" width="104" height="64" rx="12"></rect><line class="art" x1="290" y1="98" x2="350" y2="98"></line>
<path class="art art-dash" d="M150 98 H258"></path><path class="art" d="M250 90 l8 8 l-8 8"></path>
<path class="art art-dash" d="M382 98 H490"></path><path class="art" d="M482 90 l8 8 l-8 8"></path>
${envelope(177, 80)}
<text class="art-label" x="95" y="186" text-anchor="middle">your agent</text>
<text class="art-label" x="320" y="186" text-anchor="middle">sigelo relay</text>
<text class="art-label" x="545" y="186" text-anchor="middle">their agent</text>
</svg></figure>`,
};
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
    const box = line.match(BOX);
    if (box) {
      flush();
      if (box[2] === 'svg') {
        if (!DRAWINGS[box[3]]) throw new Error(`::: svg ${box[3]}: no such drawing (DRAWINGS in relay/site/build.mjs)`);
        out.push(DRAWINGS[box[3]]); i++; continue;
      }
      const close = new RegExp(`^${box[1]}\\s*$`), body = []; i++;
      while (i < lines.length && !close.test(lines[i])) body.push(lines[i]), i++;
      if (i >= lines.length) throw new Error(`${box[1]} ${box[2]}: not closed by ${box[1]}`);
      i++;
      const inner = []; blocks(body, inner, link, ids);
      const tag = box[2] === 'hero' ? 'section' : 'div';
      out.push(`<${tag} class="${box[2]}${box[3] ? ` ${box[3]}` : ''}">\n${inner.join('\n')}\n</${tag}>`);
      continue;
    }
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

// The stylesheet: paper, ink and a wax-red accent (the seal the logo will be), light by default,
// dark by preference. No web font, no image: the drawing is inline SVG in the page.
const STYLE = `/* sigelo relay — one stylesheet: no web fonts, no scripts, nothing fetched. Paper, ink and wax. */
:root {
  --bg: #f7f2e8; --paper: #fcf9f2; --fg: #1f1a17; --muted: #6b625a; --line: #e3d9c6; --code: #efe7d6;
  --accent: #9b2226; --accent-hover: #7a1a1d; --on-accent: #fcf9f2; --link: #9b2226; --art: #9b2226;
  --serif: "Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, "Times New Roman", serif;
  --sans: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #1d1916; --paper: #26211d; --fg: #efe7d8; --muted: #b5aa9b; --line: #3d3530; --code: #2e2823;
    --accent: #9b2226; --accent-hover: #b4292e; --on-accent: #fcf9f2; --link: #ec8d8f; --art: #ec8d8f; }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 1.0625rem/1.65 var(--sans); overflow-wrap: break-word; }
a { color: var(--link); text-underline-offset: .18em; text-decoration-thickness: 1px; }
a:hover { color: var(--fg); }
:focus-visible { outline: 2px solid var(--link); outline-offset: 3px; border-radius: 3px; }

/* header and footer */
.top { border-bottom: 1px solid var(--line); }
.bar { max-width: 62rem; margin: 0 auto; padding: 1rem 20px; display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: .4rem 1.5rem; }
.wordmark { font: 700 1.45rem/1 var(--serif); color: var(--fg); text-decoration: none; letter-spacing: .01em; }
.wordmark:hover { color: var(--link); }
nav ul { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: .3rem 1.2rem; }
nav a { color: var(--muted); text-decoration: none; font-size: .98rem; }
nav a:hover, nav a[aria-current="page"] { color: var(--link); }
nav a[aria-current="page"] { text-decoration: underline; text-decoration-thickness: 2px; text-underline-offset: .4em; }
footer { border-top: 1px solid var(--line); margin-top: 4.5rem; }
footer .bar { padding: 1.6rem 20px 2.4rem; color: var(--muted); font-size: .95rem; }
footer .wordmark { font-size: 1.15rem; color: var(--muted); }

/* the text column; cards and the drawing take more room */
main { max-width: 62rem; margin: 0 auto; padding: 0 20px; }
main > * { max-width: 42rem; margin-left: auto; margin-right: auto; }
main > .cards, main > .drawing { max-width: 62rem; }
h1, h2, h3 { font-family: var(--serif); font-weight: 700; line-height: 1.2; letter-spacing: -.005em; }
h1 { font-size: clamp(2rem, 7vw, 2.8rem); margin-top: 2.6rem; margin-bottom: 1rem; }
h2 { font-size: 1.45rem; margin-top: 2.6rem; margin-bottom: .6rem; }
h3 { font-size: 1.2rem; margin: 0 0 .4rem; }
p, ul, ol, pre, .table { margin-top: 0; margin-bottom: 1.1rem; }
li { margin-bottom: .45rem; }
strong { font-weight: 650; }
code, pre { font-family: var(--mono); font-size: .88em; background: var(--code); border-radius: 6px; }
code { padding: .08em .35em; overflow-wrap: anywhere; }
pre { padding: .85rem 1rem; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; border: 1px solid var(--line); }
pre code { padding: 0; background: none; font-size: 1em; border-radius: 0; }
.table { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-size: .95rem; }
th, td { border-bottom: 1px solid var(--line); padding: .55em .6em; text-align: left; vertical-align: top; }
th { font-weight: 650; border-bottom-width: 2px; }
td:first-child, th:first-child { padding-left: 0; }
.center { text-align: center; } .right { text-align: right; }

/* home: hero, drawing, cards */
.hero { padding: 1rem 0 .4rem; }
.hero h1 { font-size: clamp(2.6rem, 11vw, 4.2rem); margin: 1.4rem 0 .6rem; }
.hero h1 + p { font: 600 clamp(1.25rem, 4.8vw, 1.55rem)/1.35 var(--serif); margin-bottom: 1.1rem; }
.cta { margin: 1.6rem auto 1.4rem; }
.cta p { margin: 0; }
.cta a { display: inline-block; background: var(--accent); color: var(--on-accent); text-decoration: none; font-weight: 650;
  padding: .85rem 1.4rem; border-radius: 10px; border: 1px solid var(--accent); }
.cta a:hover { background: var(--accent-hover); border-color: var(--accent-hover); color: var(--on-accent); }
.drawing { margin: 1.4rem auto 2rem; }
.art-svg { display: block; width: 100%; max-width: 34rem; height: auto; margin: 0 auto; }
.art { fill: none; stroke: var(--art); stroke-width: 2.5; stroke-linecap: round; stroke-linejoin: round; }
.art-paper { fill: var(--paper); }
.art-dot { fill: var(--art); }
.art-dash { stroke-dasharray: 2 9; }
.art-label { fill: var(--muted); font: 25px var(--sans); }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr)); gap: 1.1rem; margin: 2.6rem auto 0; }
.card { background: var(--paper); border: 1px solid var(--line); border-radius: 12px; padding: 1.4rem 1.4rem 1.2rem; display: flex; flex-direction: column; }
.card.pro { border-color: var(--accent); }
.card p { margin-bottom: .7rem; }
.card h3 + p { color: var(--muted); }
.card p:nth-of-type(2) { font: 700 1.3rem/1.3 var(--serif); margin: .2rem 0 .7rem; }
.card p:last-child { margin: auto 0 0; padding-top: .6rem; }
.card p:last-child a { font-weight: 600; }
.card.pro p:nth-of-type(3) { color: var(--link); font-weight: 650; font-size: .85rem; letter-spacing: .06em; text-transform: uppercase; }

/* connect: the numbered steps */
.steps ol { list-style: none; counter-reset: step; padding: 0; margin: 2rem 0; }
.steps li { counter-increment: step; position: relative; margin: 0 0 0 1.1rem; padding: 0 0 1.5rem 2.1rem; border-left: 1px solid var(--line); }
.steps li:last-child { border-left-color: transparent; padding-bottom: 0; }
.steps li::before { content: counter(step); position: absolute; left: -1.1rem; top: -.15rem; width: 2.2rem; height: 2.2rem; border-radius: 50%;
  background: var(--accent); color: var(--on-accent); font: 700 1rem/2.2rem var(--sans); text-align: center; }
.steps li > p:first-child { margin-bottom: .6rem; }
.steps pre { margin-bottom: .7rem; }
`;

// ---------------------------------------------------------------------------------------------
// The footer, every page the same: the wordmark and the six links, nothing else (the Owner). The
// twin ends with it as Markdown, the page as HTML, with the same links in the same order
// (relay/site/test.mjs). The seller is named on privacy and terms; how to pay on contact.
export const FOOTER = PAGES.filter((p) => p.nav);
const href = (p) => (p.slug === 'index' ? '/' : `/${p.slug}.html`);
const footerMd = () => ['sigelo', ...FOOTER.map((p) => `[${p.nav}](${href(p)})`)].join(' · ');
const navList = (pages, page) => `<ul>${pages.map((p) => `<li><a href="${href(p)}"${p.slug === page.slug ? ' aria-current="page"' : ''}>${esc(p.nav)}</a></li>`).join('')}</ul>`;

// JSON-LD (SEO spec §3.4): the WebSite everywhere, the page's WebPage, and on the home page the
// hosted Service and the SoftwareApplication. The seller (provider) and the terms only in a final
// build, the Pro offers only while Pro is on sale (final, and not VENDOR_PENDING): a draft offers
// nothing. None on the not-found page. Every < is written as
// <, so no text in it can close the script element.
function jsonld(page, ctx) {
  const url = pageUrl(page), service = `${ORIGIN}/#service`, software = `${ORIGIN}/#software`;
  const site = { '@type': 'WebSite', '@id': `${ORIGIN}/#website`, url: `${ORIGIN}/`, name: 'sigelo relay', description: `${MOTTO} ${DISCLOSURE}`, inLanguage: 'en' };
  const webPage = { '@type': 'WebPage', '@id': `${url}#page`, url, name: titleOf(page, ctx.pending), description: descriptionOf(page, ctx.pending), isPartOf: { '@id': site['@id'] }, inLanguage: 'en' };
  if (page.slug === 'index') Object.assign(webPage, { about: [{ '@id': service }, { '@id': software }], relatedLink: ['https://sigelo.io/'] });
  if (['connect', 'pro', 'enterprise', 'contact', 'agents'].includes(page.slug)) webPage.about = { '@id': service };
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
        ...(ctx.onSale ? [proOffer('Pro, monthly', ctx.price.month, 'P1M'), proOffer('Pro, yearly', ctx.price.year, 'P1Y')] : [])],
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
  const indexed = page.noindex ? '<meta name="robots" content="noindex">\n' : `<link rel="canonical" href="${pageUrl(page)}">\n`;
  const ld = page.noindex ? '' : `<script type="application/ld+json">\n${jsonld(page, ctx)}\n</script>\n`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${esc(titleOf(page, ctx.pending))}</title>
<meta name="description" content="${esc(descriptionOf(page, ctx.pending))}">
${indexed}<link rel="alternate" type="text/markdown" href="/${page.slug}.md" title="This page as Markdown">
<link rel="stylesheet" href="/style.css">
${ld}</head>
<body>
<header class="top"><div class="bar">
<a class="wordmark" href="/"${page.slug === 'index' ? ' aria-current="page"' : ''}>sigelo</a>
<nav aria-label="Pages">${navList(FOOTER.filter((p) => !p.foot), page)}</nav>
</div></header>
<main>
${body}
</main>
<footer><div class="bar">
<a class="wordmark" href="/">sigelo</a>
<nav aria-label="Footer">${navList(FOOTER, page)}</nav>
</div></footer>
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
function llmsTxt(version, pending) {
  return `# sigelo relay

> End-to-end encrypted messages between AI agents, paired by a short code; login by sigelo identity, no accounts. Messages wait while one is offline; the relay cannot read them, but sees who talks to whom. MQTT 3.1.1 over TLS at ${HOST}:8883. Not A2A. New (v${version}), unaudited.

${MOTTO} ${DISCLOSURE}

## Docs

- [Connect](${ORIGIN}/connect.md): \`invite\` (K7F3-Q9ZP; \`--long\`: sgl1…), \`accept\`, compare four words
- [Relay](${ORIGIN}/index.md): the plans
- [Pro](${ORIGIN}/pro.md): one allowance for all your agents${pending ? '; coming soon' : ''}
- [Agents](${ORIGIN}/agents.md): stolen key, Pro setup, data requests
- [Index](${ORIGIN}/index.json): host, calls, limits, status
- [Identity](https://sigelo.io/llms.txt): the agents' login identity

## Pay

- [Contact](${ORIGIN}/contact.md): invoices over SimpleX, the only way to pay${pending ? '; Pro coming soon' : ''}

## Optional

- [Enterprise](${ORIGIN}/enterprise.md): teams and swarms, by contract
- [Privacy](${ORIGIN}/privacy.md): what the relay keeps
- [Terms](${ORIGIN}/terms.md): businesses only, no custody
- [Source](${REPO}): AGPL-3.0
`;
}

// The quick start: connect.md's ```sh blocks, in order, as one list of lines (an install line, then
// the commands). index.json's client.install and client.commands are these.
export const quickStart = (md) => [...md.matchAll(/^( *)```sh\n([\s\S]*?)\n\1```$/gm)].flatMap((m) => m[2].split('\n').map((l) => l.slice(m[1].length)));

// → { pages, open, wrong, pending, built }. open: the placeholders still in the sources, 'DRAFT' while
// the terms carry their draft mark, SELLER unset, what vendorRefusals(), deployRefusals() and
// launchRefusals() find. wrong: a payment address or link on a page, a seller the pages do not name, a
// price line or storage cell it cannot read. `final` refuses to write anything while either is
// non-empty. pending: the pages say Pro is not on sale yet (VENDOR_PENDING). site, out, deploy and
// root are the sources, the output, the nginx config and the tree around relay/; seller and vendor
// default to SELLER and the DID the relay pins (pinnedVendor). A test builds changed copies through
// these.
export function build({ final = false, site = SITE, out = DIST, deploy = DEPLOY, root = ROOT, seller = SELLER,
  vendor = pinnedVendor(), proStorage = proStorageCap() } = {}) {
  const md = readPages(site);
  const open = [...new Set(Object.values(md).flatMap((text) => text.match(PLACEHOLDER_RE) ?? []))];
  if (DRAFT_RE.test(md.terms)) open.push('DRAFT');
  if (seller === null) open.push('SELLER');
  const vendorSet = vendor !== DEV_VENDOR_DID, pending = vendorPending(md) === true;
  open.push(...vendorRefusals(md, vendor), ...deployRefusals(deploy), ...launchGate(root, site));
  const price = md.pro.match(PRICE_RE), storage = md.pro.match(STORAGE_RE)?.[1];
  const wrong = [
    ...paymentDetailRefusals(md),
    !price && 'pro: no "**N € a month or N € a year**, excluding VAT, for businesses. You pay in Monero, at n % off." line',
    !storage && 'pro: no "| Room for waiting messages | … | N MB or N GB |" row',
    proStorage === null ? 'RELAY_PRO_STORAGE_MB: want a whole number of MB from 1 to 10000000, as the relay reads it'
      : storage && storageBytes(storage) > proStorage
      && `pro: the storage cell says ${storage}, more than the relay grants a Pro pool (${proStorage / MB} MB: RELAY_PRO_STORAGE_MB where the site is built, else TIERS.pro.storage)`,
    sellerRefusal(seller, md),
    !/^did:sigelo:z[1-9A-HJ-NP-Za-km-z]{40,50}$/.test(vendor) && 'vendor DID: RELAY_VENDOR_DID is not a did:sigelo DID',
  ].filter(Boolean);
  if (final && (open.length || wrong.length)) throw new Error(`--final: ${[...open, ...wrong].join('; ')} (commercial/relay-pro-runbook.md §0)`);
  for (const p of PAGES) if (!/^# /.test(stripBoxes(md[p.slug]))) throw new Error(`${p.slug}.md: does not start with an H1 (containers aside)`);

  // Final: every value is filled (the gate above). A draft writes null for each open value and
  // offers nothing for sale.
  const discount = price ? Number(price[3]) : null;
  const [install, ...commands] = quickStart(md.connect);
  const onSale = final && !pending;   // a final build refuses an unset vendor DID unless pending
  const ctx = { final, onSale, pending, seller, price: price && { month: price[1], year: price[2] } };
  const version = PKG.version.split('.').slice(0, 2).join('.');
  const built = { commit: git('rev-parse', 'HEAD'), commit_date: git('log', '-1', '--format=%cI', 'HEAD'),
    dirty: git('status', '--porcelain', '--untracked-files=no', '--', '.') !== null };

  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, '.well-known'), { recursive: true });
  const put = (name, data) => writeFileSync(join(out, name), data);
  const twins = {};
  for (const p of PAGES) {
    const text = fill(md[p.slug], `${p.slug}.md`);
    twins[p.slug] = rewriteMd(stripBoxes(text), linker('md'));
    put(`${p.slug}.md`, `${twins[p.slug].trimEnd()}\n\n---\n\n${rewriteMd(footerMd(), linker('md'))}\n`);
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
  put('relay-robots.txt', 'User-agent: *\nDisallow: /challenge\nDisallow: /check\nDisallow: /park\nDisallow: /licence\n');

  // llms.txt, and llms-full.txt: the pages' twins in one file, for an agent that wants it all at once.
  // The contact page stays out: it says how to pay is published only on itself and in its file on
  // the relay repository (PAYMENT_PLACES), and a third copy would make that untrue.
  put('llms.txt', llmsTxt(version, pending));
  const fullPages = PAGES.filter((p) => !p.noindex && !PAYMENT_PLACES.includes(pageUrl(p)));
  put('llms-full.txt', `# sigelo relay: the pages in one file

${MOTTO} ${DISCLOSURE}

The identity underneath is [sigelo](https://sigelo.io/). ${POSITIONING.slice(0, -1).join(' ')} Messages use hybrid post-quantum key agreement (X-Wing: ML-KEM-768 + X25519); signatures are Ed25519, not post-quantum.

How to pay is left out here: it is published only at ${PAYMENT_PLACES.slice(0, -1).join(', ')} and ${PAYMENT_PLACES.at(-1)}.

${fullPages.map((p) => `---\n\nSource: ${ORIGIN}/${p.slug}.md\n\n${twins[p.slug].trimEnd()}\n`).join('\n')}`);

  // index.json (SEO spec §4.5, §4.10) and relay.json (plan §11): data only, generated from the same
  // constants as the pages.
  const tierJson = (t, per, storage) => ({ per, messages_day: t.msgsDay, retention_days: t.retentionDays, max_message_bytes: t.maxMessage, storage_bytes: storage, mailboxes: t.mailboxes, support: support(t) });
  const tiers = {
    free: tierJson(TIERS.free, 'agent', TIERS.free.storage),
    pro: { ...tierJson(TIERS.pro, 'operator', storage ? storageBytes(storage) : null), client_env: `SIGELO_RELAY_RETENTION_DAYS=${TIERS.pro.retentionDays}`,
      price: price ? { EUR_month: Number(price[1]), EUR_year: Number(price[2]), vat_included: false, monero_discount_percent: discount } : null,
      on_sale: onSale, not_yet_on_sale: pending, page: `${ORIGIN}/pro.html`, pay: { monero: `${ORIGIN}/contact.html` } },
    enterprise: { per: 'contract', price: null, quote: `${ORIGIN}/contact.html`, page: `${ORIGIN}/enterprise.html` },
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
    payment_address_only_with: 'an invoice the buyer asked for',
    invoice_only_via: 'https://sigelo.io/contact.html',
  };
  const http = { challenge: `GET https://${HOST}/challenge?did={did}`, check: `POST https://${HOST}/check`, park: `POST https://${HOST}/park`,
    unpark: `GET https://${HOST}/park/{code_hash}`, licence: `POST https://${HOST}/licence` };
  const contact = { email: 'contact@sigelo.io', email_receive_only: true, simplex: 'https://sigelo.io/contact.html', security: 'security@sigelo.io' };
  const description = 'End-to-end encrypted messages between AI agents: pair by a short invite code, log in with a sigelo identity (no accounts), messages held while one is offline.';
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
        'web access log of sigelo.ai and relay.sigelo.ai, for visit counts: network address cut to /24 or /48, time, path without query, user agent, Accept, referring site; kept 7 days',
        'each identity\'s DID and its key rotations', 'operator pool membership and licences (Pro)',
        'licences and licensed operators\' identity rows, also in an encrypted nightly backup, each copy kept 7 days (deploy/backup.sh)', 'topics read and written, so who talks to whom', 'times',
        'sizes, rounded to 256 bytes'],
    },
    tiers,
    client: { install: install ?? null,
      commands, mcp: null },
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
      invite_topic: { messages: INVITE_MESSAGES, bytes: INVITE_BYTES, days: INVITE_TTL / DAY },
      short_code: { seconds: PARK_TTL, uses: 1, lookups_per_network: { n: LOOKUPS.n, seconds: LOOKUPS.window }, parks_per_network: { n: PARKS.n, seconds: PARKS.window }, parked_max: PARK_MAX } },
    fees: { pro: tiers.pro.price, on_sale: onSale, not_yet_on_sale: pending }, payments_url: `${ORIGIN}/pro.html`,
    terms: `${ORIGIN}/terms.html`, privacy: `${ORIGIN}/privacy.html`, contact, official, docs: { home: `${ORIGIN}/`, index: `${ORIGIN}/index.json`, llms_txt: `${ORIGIN}/llms.txt` },
  }, null, 2) + '\n');

  // sitemap.xml (SEO spec §4.2): the indexable pages, llms.txt and index.json; never a twin, the
  // not-found page or llms-full.txt (each repeats a page). lastmod: the last commit of the source, of
  // the constants it shows when it has {{values}}, and for a generated file of its newest input.
  const valueSources = ['allowance.mjs', 'mailbox.mjs', 'operator.mjs', 'park.mjs'].map((f) => join(RELAY, f));
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
  return { pages: PAGES.length, open, wrong, pending, built };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes('--launch')) {
    // The registry only once the tree passes: a refusal needs no network.
    const why = launchCheck(), seen = why.length ? { why: [], npm: {} } : await registryRefusals();
    why.push(...seen.why);
    for (const w of why) console.error(`relay/site/build --launch: ${w === 'vendor DID' ? 'vendor DID: the relay pins licence.ts\'s placeholder and pro.md no longer says Pro is coming soon' : w}`);
    if (why.length === 0) {
      const checked = 'SECURITY.md, site/build.mjs and site/deploy/nginx.conf say what index.json says; the sigelo-agent source runs the contact verbs from an npm install; npm served sigelo-agent and sigelo-contact from csigelo at the versions under npm; the vendor DID agrees with the pages';
      writeFileSync(join(SITE, LAUNCH_RECORD), `${JSON.stringify({ checked, npm: seen.npm, by: 'relay/site/build.mjs --launch' })}\n`);
      console.log(`relay/site/build --launch: ${checked} (${Object.entries(seen.npm).map(([k, v]) => `${k} ${v}`).join(', ')}); wrote relay/site/${LAUNCH_RECORD}: commit it, then export`);
    }
    process.exit(why.length ? 1 : 0);
  }
  try {
    const r = build({ final: process.argv.includes('--final') });
    console.log(`relay/site/dist: ${r.pages} pages (+ .md twins) and the agent files, from ${r.built.commit?.slice(0, 12) ?? 'no git commit'}${r.built.dirty ? ' (relay/ has uncommitted changes)' : ''}`);
    const label = { DRAFT: "DRAFT — the terms' draft mark (terms.md)", SELLER: 'SELLER — the name the pages give the seller (relay/site/build.mjs)',
      'vendor DID': 'vendor DID — the relay pins licence.ts\'s placeholder and pro.md does not say Pro is coming soon: set RELAY_VENDOR_DID, or the real DID at D1 (in spend/licence.ts, copied to relay/licence.ts), or put VENDOR_PENDING back on pro.md' };
    if (r.pending) console.log('note: Pro is coming soon (pro.md says so): the vendor DID is not required, index.json and relay.json say not_yet_on_sale');
    for (const p of r.open) console.log(`open: ${PLACEHOLDERS[p] ? `${p} — ${PLACEHOLDERS[p]}` : label[p] ?? p}`);
    for (const w of r.wrong) console.log(`wrong: ${w}`);
  } catch (e) { console.error(`relay/site/build: ${e.message}`); process.exit(1); }
}
