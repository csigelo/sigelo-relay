#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// relay/site/test.mjs — builds relay/site/dist/ and checks sigelo.ai (design/relay-plan.md §7 M5, §11;
// the SEO spec's checks A1–A15).
//
//   node relay/site/test.mjs     `ok …` lines, then `ALL PASS (<n> checks)` and exit 0, or `FAIL …` and exit 1
//
// It builds into a scratch directory and never touches relay/site/dist: a deploy builds that with
// --final and runs this test afterwards (relay/deploy/deploy.sh), so the test must not replace it.
//
// The pages sell something, so the checks are about what a stranger, a phisher and a lawyer would
// catch: word budgets, with the placeholders filled too; titles, descriptions and the words never
// to write; no e-mail address but contact@sigelo.io; no form, no script but JSON-LD data, no account
// wording; nothing loaded from another origin; links only to the pages, the agent files and an
// allowed list of hosts; every placeholder listed in build.mjs and none forgotten; --final refusing
// while one is open, and refusing a copy with a Monero address or a payment link on a page (an address
// comes only with an invoice), a seller the pages do not name, an unset vendor DID once the pages no
// longer say Pro is not on sale yet, or an nginx config that logs what privacy.md says it never logs;
// Monero the only payment; the agent files (llms.txt, index.json, relay.json, sitemap, robots, security.txt)
// against the pages and the relay's own code; the numbers, fields and steps the pages promise against
// the relay's behaviour. In the private tree it also compares the official names with sigelo.io's
// and relay/licence.ts with spend/licence.ts, and runs the internal runbook's self-test
// (commercial/relay-pro-runbook.md §11). No network: the registry check of --launch runs here against
// stand-in registry documents.
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  build, deployRefusals, launchRefusals, nginxTree, serversIn, everyDirective, ANON, STATS_ROOT, DEPLOY, ORIGIN, HOST, REPO, ROOT, PAGES, PLACEHOLDERS,
  PLACEHOLDER_RE, DRAFT_RE, PRICE_RE, XMR_RE, PAYMENT_LINK_RE, paymentDetailRefusals, sellerRefusal, SELLER, VALUES, NOBODY, MOTTO, DISCLOSURE, DOMAINS, HOSTS,
  REPOSITORIES, CONTENT_HOSTS, PAYMENT_PLACES, PAYMENT_WORDS, POSITIONING, ISSUER_DID, STATEMENT, QUEUE_NOTE, titleOf, pageUrl, isPrivateTree, proStorageCap, launchGate,
  LAUNCH_RECORD, fill, VENDOR_PENDING, VENDOR_PENDING_PAGES, vendorPending, vendorRefusals, launchCheck, pinnedVendor, HOME_PENDING, HOME_ON_SALE,
  recordRefusals, registryRefusals, CONTACT_VERBS_SINCE, NPM_REGISTRY, versionAtLeast, SIMPLEX, quickStart, stripBoxes, FOOTER, DRAWINGS,
} from './build.mjs';

const SITE = dirname(fileURLToPath(import.meta.url));
const RELAY = dirname(SITE);
let n = 0; const fails = [];
const ok = (cond, what) => { n++; if (cond) console.log(`ok ${what}`); else { fails.push(what); console.log(`FAIL ${what}`); } };
// The relay's own modules: the pages' numbers and fields are checked against them, not copied.
const load = async (spec) => { try { return await import(spec); } catch (e) { ok(false, `import ${spec} (${e.message})`); return null; } };
const sigelo = await load('sigelo'), monero = await load('sigelo/dist/monero.js');
const allowance = await load('../allowance.mjs'), operator = await load('../operator.mjs'), auth = await load('../auth.mjs');
const db = await load('../db.mjs'), mailbox = await load('../mailbox.mjs'), licence = await load('../licence.ts');
const PKG = JSON.parse(readFileSync(join(RELAY, 'package.json'), 'utf8'));
const thou = (x) => String(x).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

const OUT = mkdtempSync(join(tmpdir(), 'relay-site-dist-'));
process.on('exit', () => rmSync(OUT, { recursive: true, force: true }));
const r = build({ out: join(OUT, 'draft') });
const DRAFT = join(OUT, 'draft');
const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [relative(DRAFT, join(d, e.name))]));
const files = new Set(walk(DRAFT));
const read = (f) => readFileSync(join(DRAFT, f), 'utf8');
const src = Object.fromEntries(PAGES.map((p) => [p.slug, readFileSync(join(SITE, `${p.slug}.md`), 'utf8')]));
const html = Object.fromEntries(PAGES.map((p) => [p.slug, read(`${p.slug}.html`)]));
const twin = Object.fromEntries(PAGES.map((p) => [p.slug, read(`${p.slug}.md`)]));
// A twin is the page, then `---`, then the footer; body = the page alone, as rendered.
const body = Object.fromEntries(PAGES.map((p) => [p.slug, twin[p.slug].slice(0, twin[p.slug].lastIndexOf('\n---\n'))]));
const indexable = PAGES.filter((p) => !p.noindex);
const AGENT_FILES = ['style.css', 'robots.txt', 'relay-robots.txt', 'sitemap.xml', 'llms.txt', 'llms-full.txt', 'index.json', 'relay.json', '.well-known/security.txt'];
const expected = [...PAGES.flatMap((p) => [`${p.slug}.html`, `${p.slug}.md`]), ...AGENT_FILES];
ok(expected.every((f) => files.has(f)) && files.size === expected.length,
  `dist: the ${PAGES.length} pages, their twins and ${AGENT_FILES.join(', ')}, nothing else (${files.size} files${[...files].filter((f) => !expected.includes(f)).map((f) => `; extra ${f}`).join('')})`);
ok(![...files].some((f) => read(f).includes('{{')), 'dist: every {{value}} filled');

// ---- word budgets: words as `wc -w` counts them, on the page as a reader sees it ----------------
// Every {{value}} filled: a size is two words ("50 MB"), so the source's count (docs-test/check-budgets.mjs)
// is too low. Two budgets. The prose (the Owner's, 2026-10-14): the words a reader reads as text, so
// no table, no card (the home page's tier cards), no code block, no container line. The whole file:
// docs-test/budgets.json must say the same (below). pro.md carries VENDOR_PENDING while Pro is coming
// soon: both its budgets allow that sentence's words only while it is there, so the allowance cannot
// outlive the sentence.
const PROSE_BUDGET = { index: 120, connect: 160, pro: 180, enterprise: 130, contact: 110 };
const FILE_BUDGET = { index: 210, connect: 200, pro: 220, enterprise: 135, contact: 110, privacy: 530, terms: 510, agents: 370, 404: 40 };
const words = (s) => s.split(/[ \t\n\r\f\v]+/).filter(Boolean).length;
const extra = (slug) => (slug === 'pro' && r.pending ? words(VENDOR_PENDING) : 0);
const budget = (slug) => FILE_BUDGET[slug] + extra(slug);
const proseBudget = (slug) => PROSE_BUDGET[slug] + extra(slug);
// The prose of a page source: fenced code (indented or not), table rows, the cards container and
// every container line dropped.
const prose = (md) => md.replace(/^( *)```[^\n]*\n[\s\S]*?\n\1```$/gm, '').replace(/^(:{4,}) *cards\n[\s\S]*?\n\1 *$/gm, '')
  .split('\n').filter((l) => !/^\s*\|/.test(l) && !/^:{3,}/.test(l)).join('\n');
for (const p of PAGES) {
  const n = words(fill(src[p.slug], p.slug));
  ok(n <= budget(p.slug), `budget: ${p.slug}.md ${n} words ≤ ${budget(p.slug)}, every {{value}} filled`);
  if (PROSE_BUDGET[p.slug]) {
    const m = words(prose(fill(src[p.slug], p.slug)));
    ok(m <= proseBudget(p.slug), `budget, prose: ${p.slug}.md ${m} words ≤ ${proseBudget(p.slug)} (no table, card or code block)`);
  }
}
ok(PAGES.every((p) => FILE_BUDGET[p.slug]) && words(prose('a b\n\n```sh\nx y z\n```\n\n| c | d |\n\n:::: cards\n::: card\nq r s\n:::\n::::\n\n::: cta\nt\n:::\n')) === 3,
  'budget: every page has one; prose drops code blocks, tables, the cards and container lines, and keeps what is inside other containers');
ok(words(fill('{{free.storage}} {{pro.maxMessage}}', 'test')) === 4, 'budget: a size value counts as the two words it renders as ("50 MB"), not as one');
const budgetsFile = join(ROOT, 'docs-test', 'budgets.json');
if (existsSync(budgetsFile)) {
  const b = JSON.parse(readFileSync(budgetsFile, 'utf8'));
  const wrong = PAGES.filter((p) => b[`relay/site/${p.slug}.md`] !== budget(p.slug)).map((p) => p.slug);
  const stale = Object.keys(b).filter((k) => k.startsWith('relay/site/') && !PAGES.some((p) => k === `relay/site/${p.slug}.md`));
  ok(wrong.length === 0 && stale.length === 0, `docs-test/budgets.json: the same whole-file budgets for the pages, none for a page that is gone${wrong.length ? ` (differs: ${wrong.join(', ')})` : ''}${stale.length ? ` (stale: ${stale.join(', ')})` : ''}`);
}

// ---- placeholders: each one in the sources is listed, each listed one is used ------------------
const found = new Set(Object.values(src).flatMap((md) => md.match(PLACEHOLDER_RE) ?? []));
const listed = Object.keys(PLACEHOLDERS);
const unlisted = [...found].filter((x) => !listed.includes(x)), unused = listed.filter((x) => !found.has(x));
ok(unlisted.length === 0, `placeholders: every one in the pages is listed in build.mjs${unlisted.length ? ` (unlisted: ${unlisted.join(', ')})` : ''}`);
ok(unused.length === 0, `placeholders: every listed one is still in a page${unused.length ? ` (filled, remove from PLACEHOLDERS: ${unused.join(', ')})` : ''}`);
ok(r.wrong.length === 0, `no payment address or link on a page; price, storage, seller well formed${r.wrong.length ? ` (${r.wrong.join('; ')})` : ''}`);
let refused = null;
try { build({ final: true, out: join(OUT, 'final') }); } catch (e) { refused = e.message; }
const pending = [...r.open, ...r.wrong];
ok(pending.length ? refused !== null && pending.every((x) => refused.includes(x)) : refused === null,
  `--final: ${pending.length ? `refuses while ${pending.length} are open, naming each` : 'builds, nothing open'}`);
ok(!DRAFT_RE.test(src.terms) && !r.open.includes('DRAFT') && !(src.terms.match(PLACEHOLDER_RE) ?? []).length
  && src.terms.includes("**Law and courts.** The law and courts of the Seller's registered seat in the European Union."),
'terms.md: final (no DRAFT mark, no placeholder), law and courts of the Seller\'s registered seat in the EU');
// The Owner's decision: the pages name the seller by the trade name only, the legal name on request.
// The terms add where a buyer finds it anyway: on the invoice (runbook §1, as VAT law requires).
const SELLER_LINE = (where) => `${SELLER}, a business registered in the European Union; legal name and registered address ${where} \`contact@sigelo.io\``;
ok(SELLER === 'sigelo' && src.privacy.includes(`GDPR controller: ${SELLER_LINE('on request at')}.`) && src.terms.includes(`Seller: ${SELLER_LINE('on invoices and on request at')} ("the Seller").`)
  && !/\b(?:Ltd|GmbH|BV|SRL|SA|NV|LLC|Inc|BVBA)\b\.?/.test(Object.values(src).join('\n')),
  'seller: the trade name "sigelo", a business registered in the EU, legal name and address on request (terms: and on invoices), in privacy.md and terms.md; no company form named on any page');

// ---- contact: one address, receive-only, no form, no account wording ---------------------------
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
for (const p of PAGES) {
  const mails = [...new Set([...(src[p.slug].match(EMAIL) ?? []), ...(html[p.slug].match(EMAIL) ?? [])])];
  ok(mails.every((m) => m === 'contact@sigelo.io'), `${p.slug}: no e-mail address but contact@sigelo.io${mails.length ? ` (${mails.join(', ')})` : ''}`);
}
// The invoice carries the payment address: it is asked for, and comes back, only in a SimpleX
// conversation the buyer opened (a phisher cannot write into that conversation; anyone can send an
// e-mail). The contact page shows the SimpleX address sigelo.io/contact.html shows (SIMPLEX, compared
// with site/src/official.mjs below and by the launch gate), as text, not a link; the request goes
// there, never by e-mail; and SECURITY.md's "Nobody…" line sends the buyer to sigelo.io's address.
{
  const c = src.contact;
  ok(c.includes('SimpleX: `{{contact.simplex}}`. We answer there.') && VALUES['contact.simplex'] === SIMPLEX && /^https:\/\/smp\d*\.simplex\.im\/a#[\w-]+$/.test(SIMPLEX)
    && !html.contact.includes(`href="${SIMPLEX}"`) && html.contact.includes(`<code>${SIMPLEX}</code>`),
    'contact: the SimpleX address (SIMPLEX, as sigelo.io/contact.html), shown as text, not a link');
  ok(/^Mail: `contact@sigelo\.io` receives only/m.test(c) && /^For a Pro invoice \(a month or a year\) or an Enterprise quote, send over SimpleX /m.test(c) && c.includes('(`sigelo-agent whoami`)')
    && c.includes('business name, address and VAT number'),
    'contact: mail receives only; an invoice or a quote is asked for over SimpleX, naming the operator identity and the business');
  ok(c.includes(NOBODY) && !REPOSITORIES.some((x) => c.includes(`](${x}`)) && !c.includes(`](${STATEMENT}`) && !c.includes('](https://sigelo.io/contact.html)'),
    'contact: carries the "Nobody from the project…" line verbatim; no link to a repository, the statement or sigelo.io\'s contact page (a link moves with whoever swapped the page)');
}
const ACCOUNT = [/\bsign[ -]?(?:up|in)\b/i, /\blog ?in to\b/i, /\bpassword\b/i, /\b(?:create|open) (?:an |your )?account\b/i, /\busername\b/i];
const FORM = /<(?:form|input|textarea|select|button)\b/i;
for (const p of PAGES) {
  const hit = ACCOUNT.filter((re) => re.test(src[p.slug]));
  ok(!FORM.test(html[p.slug]) && hit.length === 0, `${p.slug}: no form and no account wording${hit.length ? ` (${hit.join(' ')})` : ''}`);
}

// ---- head (A1–A5): titles, descriptions, one H1, canonical and noindex, the twin linked --------
const SCRIPT = /<script type="application\/ld\+json">\n([\s\S]*?)\n<\/script>/;
const H1 = { index: 'By AI, for AI.', connect: 'Connect two agents in a minute', pro: 'Pro: all your agents on one allowance', enterprise: 'Enterprise: teams and swarms of agents',
  contact: 'Contact', privacy: 'Privacy', terms: 'Terms', agents: 'For agents: Pro setup and data requests', 404: 'Not found' };
// The rendered titles and descriptions, exactly (the home title keeps the SEO term). Pro's description
// takes its numbers from relay/allowance.mjs TIERS and names the largest message, not a retention: a
// reader away over a week takes no new messages on either tier (A5 review).
const sizeOf = (b) => (b % (1024 * 1024) === 0 ? `${b / 1024 / 1024} MB` : `${b / 1024} KB`);
// While Pro is coming soon (VENDOR_PENDING) the heads that would read as a sale say so: a search result
// or a link preview shows the title and description, not the page's first paragraph (X2 review).
// HEAD(pending) → { TITLE, DESC }; the on-sale heads are checked on the --final build below.
const HEAD = (pending) => ({
  TITLE: { index: 'sigelo relay — end-to-end encrypted messaging for AI agents', connect: 'Connect two agents in a minute — sigelo relay',
    pro: 'Pro: all your agents on one allowance — sigelo relay', enterprise: 'Enterprise: teams and swarms of agents — sigelo relay', contact: 'Contact — sigelo relay',
    privacy: 'Privacy: what the relay keeps — sigelo relay', terms: 'Terms of service — sigelo relay', agents: 'For agents: Pro setup and data requests — sigelo relay',
    404: 'Not found — sigelo relay' },
  DESC: {
    index: 'Connect your AI agent to the agents you trust: a short code pairs them, then they message end-to-end encrypted. No accounts; free for every agent.',
    connect: 'Pair two AI agents in a minute: install sigelo-agent, make a short code, say it, their agent enters it. Then they message end-to-end encrypted.',
    pro: `sigelo relay Pro: one allowance for all your agents, ${thou(allowance?.TIERS.pro.msgsDay)} messages a day, up to ${sizeOf(allowance?.TIERS.pro.maxMessage)} each. ${pending ? 'Coming soon; free until then.' : '10 € a month or 100 € a year, for businesses.'}`,
    enterprise: 'sigelo relay for companies running teams and swarms of AI agents: allowances sized to you, your own relay, priority support. Contact us for a quote.',
    contact: 'Reach sigelo over SimpleX for questions, invoices and quotes. A payment address comes only with an invoice you asked for, in a conversation you opened.',
    privacy: 'What the sigelo relay and this site keep, and for how long: addresses cut to /24 or /48 for 7 days; never message content. No cookies, no scripts.',
    terms: pending
      ? 'Terms for sigelo relay: the free service, Pro (coming soon; businesses only) as a licence attestation, no custody, no payment routing, liability, law.'
      : 'Terms for sigelo relay Pro, sold to businesses only: the free service, Pro as a licence attestation, no custody, no payment routing, liability, law.',
    agents: 'What an agent runs for its operator on sigelo relay: the Pro setup (operator identity, licence, attestations) and signed erasure or access requests.',
    404: 'No page at this address on sigelo.ai. Start at the home page, Connect or Contact; agents can start at /llms.txt or /index.json.',
  },
});
const { TITLE, DESC } = HEAD(r.pending);
const headOf = (h) => [h.match(/<title>([^<]*)<\/title>/)?.[1].replace(/&amp;/g, '&') ?? '', h.match(/<meta name="description" content="([^"]*)">/)?.[1].replace(/&amp;/g, '&') ?? ''];
const titles = PAGES.map((p) => headOf(html[p.slug])[0]);
const descs = PAGES.map((p) => headOf(html[p.slug])[1]);
PAGES.forEach((p, i) => {
  ok(titles[i] === titleOf(p, r.pending) && titles[i].length <= 60 && titles[i].split(' — ').length <= 2 && titles[i].includes('sigelo relay'),
    `${p.slug}: title "${titles[i]}" (${titles[i].length} chars ≤ 60, at most one " — ", names sigelo relay)`);
  ok(descs[i].length >= 50 && descs[i].length <= 155, `${p.slug}: meta description ${descs[i].length} chars (50–155)`);
  ok(titles[i] === TITLE[p.slug] && descs[i] === DESC[p.slug], `${p.slug}: title and meta description exactly as SEO spec §3.2 (pro's with TIERS.pro's numbers)${descs[i] === DESC[p.slug] ? '' : ` (description: "${descs[i]}")`}`);
  const h = html[p.slug];
  ok((h.match(/<h1\b/g) ?? []).length === 1 && stripBoxes(src[p.slug]).startsWith(`# ${H1[p.slug]}\n`), `${p.slug}: exactly one H1, "${H1[p.slug]}"`);
  const canon = h.includes(`<link rel="canonical" href="${pageUrl(p)}">`), noindex = h.includes('<meta name="robots" content="noindex">');
  ok(p.noindex ? !canon && noindex && !/rel="canonical"/.test(h) : canon && !noindex, `${p.slug}: ${p.noindex ? 'noindex and no canonical' : `canonical ${pageUrl(p)}, indexable`}`);
  ok(h.includes(`<link rel="alternate" type="text/markdown" href="/${p.slug}.md"`), `${p.slug}: its .md twin linked (A4)`);
});
ok(new Set(titles).size === titles.length && new Set(descs).size === descs.length, 'titles and descriptions: each unique');
ok(descs.every((d) => !/\bkept up to\b|\bretention\b/i.test(d)), 'descriptions: none promises a retention (a reader away over a week takes no new messages, whatever the tier)');
// Monero is the only payment, so a discount on it is no saving: no head offers one (runbook §7 Q5).
// While Pro is coming soon, the pro and terms descriptions say so; no head names a date (the Owner).
const SALE_HEADS = ['pro', 'terms'].map((slug) => PAGES.findIndex((p) => p.slug === slug));
ok(![...titles, ...descs].some((t) => /discount|not on sale|\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\b/i.test(t))
  && (!r.pending || SALE_HEADS.every((i) => /coming soon/i.test(descs[i]))),
  `titles and descriptions: none mentions a discount, "not on sale" or a month${r.pending ? '; the pro and terms descriptions say Pro is coming soon' : ''}`);

// ---- static: no script but one JSON-LD block, no inline style or handler, nothing from elsewhere -
const VOID = new Set(['meta', 'link', 'br', 'hr', 'img', 'input', 'wbr']);
function balance(h) {
  const stack = [];
  for (const [, close, name] of h.replace(/<!doctype[^>]*>/i, '').replace(SCRIPT, '').matchAll(/<(\/?)([a-zA-Z][\w-]*)\b[^>]*>/g)) {
    const tag = name.toLowerCase();
    if (close) { if (stack.pop() !== tag) return `</${tag}> out of order`; } else if (!VOID.has(tag)) stack.push(tag);
  }
  return stack.length ? `unclosed ${stack.join(', ')}` : null;
}
const attrs = (h, tag, name) => [...h.matchAll(new RegExp(`<${tag}\\b[^>]*\\s${name}="([^"]*)"`, 'gi'))].map((m) => m[1].replace(/&amp;/g, '&'));
const graphs = {};
for (const p of PAGES) {
  const h = html[p.slug], scripts = (h.match(/<script\b/g) ?? []).length;
  ok(scripts === (p.noindex ? 0 : 1) && (p.noindex || SCRIPT.test(h)), `${p.slug}: ${p.noindex ? 'no script' : 'one script, type application/ld+json'} (A6)`);
  const rest = h.replace(SCRIPT, '');
  ok(!/<script\b|<style\b|\sstyle=|\son[a-z]+\s*=|javascript:|\ssrc=|<(?:iframe|object|embed|img)\b/i.test(rest), `${p.slug}: no other script, inline style, handler or embedded resource`);
  ok(attrs(h, 'link', 'href').every((u) => u.startsWith('/') || u === pageUrl(p)), `${p.slug}: loads nothing from another origin (stylesheet /style.css)`);
  ok(!/\b(?:og|twitter):/.test(h), `${p.slug}: no Open Graph or Twitter tags until a logo exists (A7)`);
  const why = balance(h);
  ok(why === null, `${p.slug}: tags balance${why ? ` (${why})` : ''}`);
  if (!p.noindex) {
    const text = h.match(SCRIPT)[1];
    let g = null;
    try { g = JSON.parse(text); } catch { /* reported below */ }
    graphs[p.slug] = g;
    ok(g !== null && !text.includes('<') && g['@context'] === 'https://schema.org' && Array.isArray(g['@graph']), `${p.slug}: JSON-LD parses, schema.org, every < escaped`);
  }
}
// The graphs: WebSite everywhere, the page's WebPage; on the home page Service and SoftwareApplication;
// every @id reference resolves, in the page's graph or the home page's (pro and the pay pages are
// about the Service defined there); a draft offers nothing for sale and names no provider (A6).
const homeIds = (graphs.index?.['@graph'] ?? []).map((x) => x['@id']);
for (const [slug, g] of Object.entries(graphs).filter(([, x]) => x)) {
  const nodes = g['@graph'], ids = new Set([...nodes.map((x) => x['@id']), ...homeIds]);
  const types = nodes.map((x) => x['@type']).sort().join();
  const want = slug === 'index' ? 'Service,SoftwareApplication,WebPage,WebSite' : 'WebPage,WebSite';
  const refs = JSON.stringify(nodes).match(/\{"@id":"[^"]+"\}/g)?.map((x) => JSON.parse(x)['@id']) ?? [];
  const page = PAGES.find((p) => p.slug === slug), web = nodes.find((x) => x['@type'] === 'WebPage');
  ok(types === want && refs.every((id) => ids.has(id)) && web?.url === pageUrl(page) && web?.name === titleOf(page, r.pending) && web?.description === descs[PAGES.indexOf(page)],
    `${slug}: JSON-LD nodes ${want}, every @id reference resolves, the WebPage is this page, with its title and meta description`);
}
if (graphs.index) {
  const service = graphs.index['@graph'].find((x) => x['@type'] === 'Service'), app = graphs.index['@graph'].find((x) => x['@type'] === 'SoftwareApplication');
  ok(!('provider' in service) && !('termsOfService' in service) && service.offers.length === 1 && service.offers[0].price === '0',
    'index: a draft build\'s Service names no provider or terms and offers only the free tier');
  ok(app.softwareVersion === PKG.version && app.license === `https://spdx.org/licenses/${PKG.license}` && app.sameAs === REPO, 'index: the SoftwareApplication is relay/package.json\'s version and licence, and the relay repository');
}
ok(graphs.index?.['@graph'].find((x) => x['@type'] === 'WebSite')?.description === `${MOTTO} ${DISCLOSURE}`, 'JSON-LD: WebSite.description is the motto and the disclosure');

// ---- links: internal ones resolve (with #fragments), external ones only to allowed places -------
const ids = Object.fromEntries(PAGES.map((p) => [p.slug, new Set([...html[p.slug].matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]))]));
const pageOf = (path) => (path === '/' ? 'index' : path.match(/^\/([\w-]+)\.(?:html|md)$/)?.[1]);
const ALLOWED = [/^https:\/\/sigelo\.io(?:\/[\w./#-]*)?$/, /^https:\/\/github\.com\/csigelo\/[\w./#-]*$/];
for (const p of PAGES) {
  const bad = [];
  for (const href of attrs(html[p.slug], 'a', 'href')) {
    if (href.startsWith('/')) {
      const [path, frag] = href.split('#');
      const slug = pageOf(path);
      if (slug ? !src[slug] || (path !== '/' && !files.has(path.slice(1))) || (frag && !ids[slug].has(frag)) : !files.has(path.slice(1)) || frag) bad.push(href);
    } else if (!(ALLOWED.some((re) => re.test(href)) || href === 'mailto:contact@sigelo.io')) bad.push(href);
  }
  ok(bad.length === 0, `${p.slug}: links resolve or go to sigelo.io, github.com/csigelo (no payment link: it comes with an invoice)${bad.length ? ` (bad: ${bad.join(' ')})` : ''}`);
  const badMd = [...twin[p.slug].replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '').matchAll(/\]\((\/[^)\s]*)\)/g)]
    .map((m) => m[1]).filter((u) => !/^\/[\w-]+\.(?:md|txt|json)(#[\w-]+)?$/.test(u) || !files.has(u.slice(1).split('#')[0]));
  ok(badMd.length === 0, `${p.slug}.md twin: internal links go to the twins or the agent files${badMd.length ? ` (bad: ${badMd.join(' ')})` : ''}`);
}
const adopt = join(ROOT, 'site', 'src', 'adopt.md');
if (existsSync(adopt)) ok(/^## 1\. Identity$/m.test(readFileSync(adopt, 'utf8')), 'pro: the link to sigelo.io/adopt.html#1-identity has its heading');

// ---- header and footer (A10): the wordmark and the links, nothing else (the Owner, 2026-10-14) ---
const plainText = (s) => s.replace(/<[^>]*>/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\*\*/g, '').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const linksIn = (h) => [...h.matchAll(/<a [^>]*href="([^"]+)"[^>]*>([^<]*)<\/a>/g)].map((m) => `${m[2]} ${m[1]}`);
const FOOT_LINKS = ['Connect', 'Pro', 'Enterprise', 'Contact', 'Privacy', 'Terms'];
for (const p of PAGES) {
  const foot = html[p.slug].match(/<footer>([\s\S]*?)<\/footer>/)?.[1] ?? '', head = html[p.slug].match(/<header class="top">([\s\S]*?)<\/header>/)?.[1] ?? '';
  const mdFoot = twin[p.slug].slice(twin[p.slug].lastIndexOf('\n---\n') + 5).trim();
  ok(plainText(foot.replace(/<[^>]*>/g, ' ')) === `sigelo ${FOOT_LINKS.join(' ')}` && linksIn(foot).join() === ['sigelo /', ...FOOT_LINKS.map((x) => `${x} /${x.toLowerCase()}.html`)].join(),
    `${p.slug}: the footer is the wordmark and ${FOOT_LINKS.join(' · ')}, nothing else`);
  ok(mdFoot === `sigelo · ${FOOT_LINKS.map((x) => `[${x}](/${x.toLowerCase()}.md)`).join(' · ')}`, `${p.slug}: the twin ends with the same footer, linking the twins (A10)`);
  ok(linksIn(head).join() === ['sigelo /', ...FOOT_LINKS.slice(0, 4).map((x) => `${x} /${x.toLowerCase()}.html`)].join()
    && (head.match(/aria-current="page"/g) ?? []).length === (['index', ...FOOT_LINKS.slice(0, 4).map((x) => x.toLowerCase())].includes(p.slug) ? 1 : 0),
    `${p.slug}: the header is the wordmark and Connect · Pro · Enterprise · Contact, the current page marked`);
}
ok(FOOTER.map((p) => p.nav).join() === FOOT_LINKS.join(), 'footer: build.mjs FOOTER is the six links, in order');
// The home page: the motto as its one H1, the subline, three sentences, the button to /connect; the
// disclosure in the body (without the handle: a reader does not know it).
{
  const hero = html.index.match(/<section class="hero">([\s\S]*?)<\/section>/)?.[1] ?? '';
  const ps = [...hero.matchAll(/<p>([\s\S]*?)<\/p>/g)].map((m) => plainText(m[1]));
  const sentences = ps[1]?.split(/(?<=\.) /).length;
  ok(hero.includes(`<h1 id="by-ai-for-ai">${MOTTO}</h1>`) && ps[0] === 'Connect your agents to the agents you trust.' && sentences === 3
    && /<div class="cta">\n<p><a href="\/connect\.html">Connect two agents in a minute →<\/a><\/p>\n<\/div>/.test(hero),
    `index: the hero is the motto (H1), the subline, three sentences and the "Connect two agents in a minute" button to /connect (${sentences} sentences)`);
  ok(body.index.includes(DISCLOSURE.replace(', csigelo.', '.')) && DISCLOSURE.endsWith(', csigelo.'), 'index: the disclosure, "Built and operated by an AI agent under a human owner."');
  const cards = [...html.index.matchAll(/<div class="card( pro)?">\n<h3 id="[^"]+">([^<]+)<\/h3>/g)].map((m) => m[2]);
  ok(cards.join() === 'Free,Pro,Enterprise' && /<div class="card">\n<h3 id="enterprise">Enterprise<\/h3>\n<p>Teams and swarms of agents\.<\/p>\n<p><strong><a href="\/contact\.html">Contact us<\/a><\/strong><\/p>/.test(html.index),
    'index: three tier cards, Free, Pro, Enterprise; Enterprise\'s price cell is "Contact us", linked to /contact');
  ok(DRAWINGS.relay && html.index.includes(DRAWINGS.relay) && /<svg [^>]*role="img" aria-labelledby="drawing-relay-title">\n<title id="drawing-relay-title">[^<]{20,}<\/title>/.test(DRAWINGS.relay)
    && !/\s(?:style|on[a-z]+|href|xlink:href|src)=/.test(DRAWINGS.relay) && PAGES.every((p) => p.slug === 'index' || !html[p.slug].includes('<svg')),
    'index: one inline drawing, role img with a title, no style, handler or link in it; no other page has one');
  ok(/::: cta\n\[Contact us →\]\(\/contact\.html\)\n:::\n?$/.test(src.enterprise) && src.enterprise.includes('Contact us for a quote.'),
    'enterprise: ends with the Contact button; "Contact us for a quote."');
}
// Where how to pay is published: one place, the contact page (and its twin), and its file on the relay
// repository's main branch (PAYMENT_PLACES), said in words there and nowhere else. The file and the
// branch, never the repository as a whole: GitHub serves a fork's commit, an issue or a pull request
// under the parent repository's URL.
const narrow = `How to pay is published only here and in site/contact.md on the main branch of ${REPO.replace('https://', '')}.`;
ok(PAYMENT_PLACES.join() === [`${ORIGIN}/contact.html`, `${REPO}/blob/main/site/contact.md`].join()
  && PAYMENT_WORDS.replace(/`/g, '') === narrow && src.contact.includes(`\n\n${PAYMENT_WORDS}\n`) && plainText(html.contact).includes(narrow) && twin.contact.includes(PAYMENT_WORDS)
  && PAGES.every((p) => p.slug === 'contact' || !/how to pay is published/i.test(plainText(html[p.slug]) + twin[p.slug])),
'contact: how to pay is published only there and in its file on the relay repository\'s main branch, as PAYMENT_PLACES says; no other page says where');
// Monero only: card payment is not offered, so no page (as a reader reads it), agent file or nav names
// a card, Stripe or a card page, and no page is a pay page of its own.
const CARD = /\bstripe\b|\bcards?\b|pay-card/i;
const cardHits = [...PAGES.map((p) => [`${p.slug}.md`, body[p.slug]]), ...PAGES.map((p) => [`${p.slug}.html`, plainText(html[p.slug].replace(SCRIPT, ''))]),
  ...['llms.txt', 'llms-full.txt', 'index.json', 'relay.json', 'sitemap.xml'].map((f) => [f, read(f)])].filter(([, t]) => CARD.test(t)).map(([f]) => f);
ok(cardHits.length === 0 && !PAGES.some((p) => p.slug.startsWith('pay-')) && !existsSync(join(SITE, 'pay-card.md')) && !existsSync(join(SITE, 'pay-monero.md')),
  `Monero only: no page or agent file names a card, Stripe or a card page; no pay page (how to pay is on /contact)${cardHits.length ? ` (in: ${cardHits.join(', ')})` : ''}`);
const priceLineM = src.pro.match(PRICE_RE);
// Monero only, quoted on request (the Owner, 2026-10-14: no euro invoice paid in Monero), as enterprise.md.
ok(priceLineM && src.terms.includes('excluding VAT, less the stated discount; Monero only. [Contact us for a quote](/contact.html) and pay it within 24 hours.')
  && src.agents.includes('pay in Monero only, within 24 hours') && src.pro.includes('[Contact us for a quote](/contact.html)') && src.enterprise.includes('Contact us for a quote.')
  && !/invoiced in EUR|Ask us for an invoice|Ask for an invoice/.test(src.terms + src.pro + src.agents),
'terms, agents, pro: pro.md\'s discount, Monero only, "Contact us for a quote" as on enterprise, paid within 24 hours; no euro invoice');
// No protocol talk on the pages a person reads first (the Owner, 2026-10-14): that is for llms.txt,
// index.json and the agents' page.
const HUMAN = ['index', 'connect', 'pro', 'enterprise', 'contact'];
const talk = HUMAN.filter((slug) => /\bMQTT\b|\bA2A\b|post-quantum|\bDID\b|attestation|X-Wing|Ed25519|\bTLS\b/i.test(body[slug]));
ok(talk.length === 0, `no protocol talk on ${HUMAN.join(', ')} (MQTT, A2A, post-quantum, DID, attestation, X-Wing, Ed25519, TLS)${talk.length ? ` (on: ${talk.join(', ')})` : ''}`);
// The stylesheet and the pages fetch nothing: no @import, url(), @font-face or other origin in the
// CSS; in a page's HTML (JSON-LD data aside) no URL but the official places and the SimpleX address
// shown as text on /contact.
const css = read('style.css');
ok(!/@import|url\(|@font-face|https?:|\/\//.test(css.replace(/\/\*[\s\S]*?\*\//g, '')), 'style.css: no @import, url(), web font or other origin');
const OFFICIAL_URL = /^https:\/\/(?:sigelo\.ai|sigelo\.io|relay\.sigelo\.ai|github\.com\/csigelo)(?:[/:#?]|$)/;
for (const p of PAGES) {
  const urls = [...html[p.slug].replace(SCRIPT, '').matchAll(/https?:\/\/[^\s"<>'`)]+/g)].map((m) => m[0]).filter((u) => !OFFICIAL_URL.test(u) && !(p.slug === 'contact' && u === SIMPLEX));
  ok(urls.length === 0, `${p.slug}: no URL but the official places${p.slug === 'contact' ? ' and the SimpleX address' : ''} (nothing from another origin)${urls.length ? ` (${urls.join(' ')})` : ''}`);
}

// ---- the words never to write (A7, A15, SEO spec §2, plan §11) ---------------------------------
const index = JSON.parse(read('index.json')), relayInfo = JSON.parse(read('relay.json'));
const surfaces = {
  ...Object.fromEntries(PAGES.map((p) => [`${p.slug}.md`, twin[p.slug]])), titles: titles.join('\n'), descriptions: descs.join('\n'),
  'llms.txt': read('llms.txt'), 'llms-full.txt': read('llms-full.txt'), 'JSON-LD': Object.values(graphs).map((g) => JSON.stringify(g)).join('\n'),
  'index.json': [index.description, index.motto, index.disclosure, ...index.positioning, JSON.stringify(index.crypto)].join('\n'), 'relay.json': [relayInfo.description, ...relayInfo.positioning].join('\n'),
};
const NEVER = [
  [/\bA2A\b/g, 'A2A, but as "Not A2A"', (t, i) => t.slice(Math.max(0, i - 4), i).toLowerCase() === 'not '],
  [/\bMQTT ?v?5\b/gi, 'MQTT 5'], [/quantum[- ]?(?:safe|proof|resistant)/gi, 'quantum-safe'], [/forward secrecy|signal[- ]grade|signal for agents/gi, 'forward secrecy, Signal-grade'],
  [/\bsecure(?:ly)?\b/gi, 'secure'], [/\banonym(?:ous|ously|ity)\b/gi, 'anonymous'], [/\bprivate(?:ly)?\b(?! key)/gi, 'private (as a claim)'], [/agent passport/gi, 'agent passport'],
  [/verifiable credentials?/gi, 'verifiable credentials'], [/\b(?:web3|blockchain|trustless)\b|decentrali[sz]ed messaging/gi, 'web3, blockchain, trustless'],
  [/free forever|\bunlimited\b|real-?time/gi, 'free forever, unlimited, real-time'], [/know your agent|\bKYA\b|verified agent|trusted agent|trust score|reputation score/gi, 'KYA, verified agent, trust score'],
  [/(?<!not )\baudited\b/gi, '"audited" (only "unaudited")'], [/agent (?:registry|directory|discovery)/gi, 'agent registry, directory, discovery'],
  [/(?<!sigelo-)agent (?:inbox|mailbox)/gi, 'agent inbox/mailbox'],
];
const neverHits = (text) => NEVER.flatMap(([re, label, allow]) => [...text.matchAll(re)].filter((m) => !allow?.(text, m.index)).map(() => label));
for (const [name, text] of Object.entries(surfaces)) {
  const hits = neverHits(text);
  // "cannot read" only in the same sentence as "who talks to whom" (A7).
  const alone = text.split(/(?<=[.!?])\s+/).filter((s) => /cannot read/i.test(s) && !/who talks to whom/.test(s));
  ok(hits.length === 0 && alone.length === 0, `never written, ${name}${hits.length ? ` (${[...new Set(hits)].join('; ')})` : ''}${alone.length ? ` ("cannot read" alone: ${alone[0].slice(0, 60)}…)` : ''}`);
}
ok(neverHits('Messages wait in an agent mailbox on the relay. An Agent Inbox.').filter((l) => l === 'agent inbox/mailbox').length === 2 && neverHits('Log in with it (`sigelo-agent inbox`).').length === 0,
  'never written, on every surface above: "agent inbox" and "agent mailbox" (plan §11); the command `sigelo-agent inbox` is not that');
// The inflections and spellings of the same claims (A5 review): each one alone is refused.
const variants = { 'delivered securely': 'secure', 'kept privately': 'private (as a claim)', 'used anonymously': 'anonymous', 'full anonymity': 'anonymous',
  'speaks MQTT v5': 'MQTT 5', 'an MQTTv5 broker': 'MQTT 5', 'mqtt5 inside': 'MQTT 5' };
const missed = Object.entries(variants).filter(([text, label]) => neverHits(text).join() !== label).map(([text]) => text);
ok(missed.length === 0 && neverHits('an identity or wallet private key').length === 0 && neverHits('see security.html; secure_delete').length === 0,
  `never written: "securely", "privately", "anonymously", "anonymity", "MQTT v5", "MQTTv5", "mqtt5" each refused; "private key" and words containing "secure" are not${missed.length ? ` (missed: ${missed.join('; ')})` : ''}`);

// ---- llms.txt, llms-full.txt (A9) --------------------------------------------------------------
const llms = read('llms.txt');
const items = [...llms.matchAll(/^- \[([^\]]+)\]\(([^)]+)\): (.+)$/gm)].map((m) => m[2]);
const sections = [...llms.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
ok(/^# sigelo relay\n\n> [^\n]+\n/.test(llms) && sections.at(-1) === 'Optional' && llms.split('\n').filter((l) => l.startsWith('- ')).length === items.length,
  'llms.txt: H1, blockquote, H2 sections with Optional last, every item "- [name](url): text"');
ok(indexable.every((p) => items.includes(`${ORIGIN}/${p.slug}.md`)) && !items.includes(`${ORIGIN}/404.md`), 'llms.txt: lists every page\'s twin but the not-found page\'s');
ok(items.every((u) => (u.startsWith(`${ORIGIN}/`) ? files.has(u.slice(ORIGIN.length + 1)) : /^https:\/\/(?:sigelo\.io\/|github\.com\/csigelo\/)/.test(u))),
  'llms.txt: its sigelo.ai links exist in dist, the others go to sigelo.io or github.com/csigelo');
ok(words(llms) <= 150 && llms.includes(`${MOTTO} ${DISCLOSURE}`) && llms.includes(`New (v${PKG.version.split('.').slice(0, 2).join('.')}), unaudited.`),
  `llms.txt: ${words(llms)} words ≤ 150, the motto with the disclosure, the version and "unaudited"`);
const full = read('llms-full.txt');
const inFull = indexable.filter((p) => !PAYMENT_PLACES.includes(pageUrl(p)));
ok(inFull.length === indexable.length - 1 && inFull.every((p) => full.includes(`Source: ${ORIGIN}/${p.slug}.md\n\n${body[p.slug].trimEnd()}\n`)) && !full.includes('# Not found') && full.includes(`${MOTTO} ${DISCLOSURE}`),
  'llms-full.txt: every indexable page\'s twin but the contact page\'s (the payment place), with the motto and the disclosure');
ok(!full.includes(`Source: ${ORIGIN}/contact.md`) && !full.includes(PAYMENT_WORDS) && !full.includes(NOBODY) && !XMR_RE.test(full) && !PAYMENT_LINK_RE.test(full)
  && full.includes(`published only at ${PAYMENT_PLACES.slice(0, -1).join(', ')} and ${PAYMENT_PLACES.at(-1)}.`),
  'llms-full.txt: no copy of the contact page, no address or link, only where how to pay is published (a third copy would make the contact page untrue)');
ok(![llms, full, ...Object.values(twin), ...Object.values(html)].some((t) => /not on sale/i.test(t)), 'nowhere "not on sale": Pro is "coming soon" (the Owner)');

// ---- sitemap.xml, robots.txt, security.txt (A11–A13) -------------------------------------------
const sitemap = read('sitemap.xml');
const locs = [...sitemap.matchAll(/<url><loc>([^<]+)<\/loc>(?:<lastmod>([^<]+)<\/lastmod>)?<\/url>/g)].map((m) => [m[1], m[2]]);
const wantLocs = [...indexable.map(pageUrl), `${ORIGIN}/llms.txt`, `${ORIGIN}/index.json`];
const commitDay = r.built.commit_date?.slice(0, 10);
ok(locs.map(([l]) => l).join() === wantLocs.join() && locs.every(([l]) => (l === `${ORIGIN}/` ? files.has('index.html') : files.has(l.slice(ORIGIN.length + 1)))),
  'sitemap: the indexable pages, llms.txt and index.json, each in dist; no twin, no not-found page');
ok(locs.every(([, d]) => d === undefined || (/^\d{4}-\d{2}-\d{2}$/.test(d) && (!commitDay || d <= commitDay))), 'sitemap: each lastmod a date, none after the build commit');
const robots = read('robots.txt'), robotLines = robots.split('\n').filter((l) => l && !l.startsWith('#'));
ok(robotLines.every((l) => /^(?:User-agent|Allow|Disallow|Sitemap): \S/.test(l)) && !/^Disallow:/m.test(robots) && /^Allow: \/$/m.test(robots)
  && ['GPTBot', 'OAI-SearchBot', 'ClaudeBot', 'Claude-User', 'PerplexityBot', 'Google-Extended', 'CCBot', '*'].every((b) => robots.includes(`User-agent: ${b}\n`))
  && robots.includes(`\nSitemap: ${ORIGIN}/sitemap.xml\n`), 'robots.txt: known fields only, the AI crawlers named, disallows nothing, names the sitemap');
ok(read('relay-robots.txt') === 'User-agent: *\nDisallow: /challenge\nDisallow: /check\nDisallow: /park\nDisallow: /licence\n', `relay-robots.txt (${HOST}/robots.txt): the relay's HTTP calls are not content`);
const sec = read('.well-known/security.txt'), expires = Date.parse(sec.match(/^Expires: (.+)$/m)?.[1] ?? '');
ok(sec.startsWith('Contact: mailto:security@sigelo.io\n') && expires > Date.now() && sec.includes(`\nCanonical: ${ORIGIN}/.well-known/security.txt\n`),
  'security.txt: Contact first, Expires in the future, its Canonical');

// ---- index.json and relay.json (A14, plan §11) -------------------------------------------------
if (allowance) {
  const T = allowance.TIERS, tier = (t) => ({ messages_day: t.msgsDay, retention_days: t.retentionDays, max_message_bytes: t.maxMessage, mailboxes: t.mailboxes });
  const pick = (o) => ({ messages_day: o.messages_day, retention_days: o.retention_days, max_message_bytes: o.max_message_bytes, mailboxes: o.mailboxes });
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  ok(same(pick(index.tiers.free), tier(T.free)) && index.tiers.free.storage_bytes === T.free.storage && same(pick(index.tiers.pro), tier(T.pro)),
    'index.json: the tiers are relay/allowance.mjs TIERS');
  ok(same(pick(relayInfo.limits.free), tier(T.free)) && same(pick(relayInfo.limits.pro), tier(T.pro)) && relayInfo.limits.topics_per_subscribe === mailbox?.MAX_TOPICS,
    'relay.json: the limits are TIERS and mailbox.mjs\'s caps');
}
ok(index.version === PKG.version && relayInfo.version === PKG.version && relayInfo.source === REPO && relayInfo.license === PKG.license && index.status === 'new' && index.audited === false,
  'index.json, relay.json: relay/package.json\'s version and licence, the source repository, new and unaudited');
// Each value is null exactly while its input is open; a build that is not --final sells nothing.
// Storage, discount and the install line have no input left open: never null. The vendor DID is null
// exactly while the relay pins licence.ts's placeholder, open or not (VENDOR_PENDING).
const nulls = { storage: index.tiers.pro.storage_bytes, discount: index.tiers.pro.price?.monero_discount_percent, install: index.client.install,
  SELLER: index.official.seller };
const nullWrong = Object.entries(nulls).filter(([k, v]) => (v === null) !== r.open.includes(k)).map(([k]) => k);
const vendorUnset = pinnedVendor() === licence?.DEV_VENDOR_DID;
ok(index.tiers.pro.on_sale === false && relayInfo.fees.on_sale === false && nullWrong.length === 0 && (index.official.vendor_did === null) === vendorUnset
  && index.tiers.pro.not_yet_on_sale === r.pending && relayInfo.fees.not_yet_on_sale === r.pending && r.pending === (vendorPending(src) === true),
  `index.json, relay.json: a draft is not on sale, not_yet_on_sale is what the pages say (${r.pending}), a value is null exactly while it is open, the vendor DID while unset${nullWrong.length ? ` (wrong: ${nullWrong.join(', ')})` : ''}`);
// Until the vendor ceremony no licence can be issued: pro.md says so at its top, in the one sentence the
// build reads (VENDOR_PENDING), and so do the home page's Pro card (HOME_PENDING, under the price) and
// llms.txt. The Owner's words: "coming soon", no date.
ok(VENDOR_PENDING_PAGES.join() === 'pro' && VENDOR_PENDING === 'Pro is coming soon. Every agent runs free until then.' && HOME_PENDING === 'Coming soon.'
  && (r.pending ? body.pro.startsWith(`# ${H1.pro}\n\n${VENDOR_PENDING}\n\n`) && /\(https:\/\/sigelo\.ai\/pro\.md\): [^\n]*; coming soon\n/.test(read('llms.txt'))
      && /<p><strong>10 € a month · 100 € a year<\/strong><\/p>\n<p>Coming soon\.<\/p>/.test(html.index)
    : !/coming soon/i.test(read('llms.txt')) && !src.index.includes(HOME_PENDING) && src.index.includes(`\n\n${HOME_ON_SALE}\n\n`)),
  `pro, index, llms.txt: ${r.pending ? 'pro says, first, that Pro is coming soon and every agent runs free until then; the home page\'s Pro card says "Coming soon." under the price; llms.txt\'s Pro line says so' : 'Pro is on sale: none says otherwise'}`);
ok(index.relay.a2a === false && /not post-quantum/.test(index.crypto.signatures) && index.relay.mqtt.version === '3.1.1' && index.relay.host === HOST,
  'index.json: not A2A, signatures not post-quantum, MQTT 3.1.1 at relay.sigelo.ai');
// Retention is how long a queued message waits; a reader away longer than its client claims ahead
// takes no new messages on either tier (A5 review): pro.md says so under its table, the data files too.
ok(index.relay.queue === QUEUE_NOTE && relayInfo.limits.queue === QUEUE_NOTE && /no_reader/.test(QUEUE_NOTE) && /about a week ahead on every tier/.test(QUEUE_NOTE)
  && /^\| Messages wait up to \|[^\n]*\n(?:\|[^\n]*\n)*\nAn agent away over a week takes no new messages until back, on either plan: they wait with the sender\.$/m.test(body.pro)
  && body.connect.includes('Messages wait while an agent is offline: 14 days at the relay; past a week, with the sender.') && /a reader away longer gets no new messages \(`no_reader`\)/.test(body.agents),
  'pro, connect, agents, index.json, relay.json: retention is how long a queued message waits; an agent away over a week takes no new messages (no_reader), whatever the tier');
const carrier = join(ROOT, 'contact', 'carrier.mjs');
if (existsSync(carrier)) {
  const c = await load(carrier);
  if (c) ok(c.AHEAD === 7 * c.DAY, `pro, QUEUE_NOTE: "a week" is contact/carrier.mjs AHEAD, how far ahead the client claims its mailboxes (private tree; AHEAD = ${c.AHEAD / c.DAY} days)`);
}
ok(index.motto === MOTTO && index.disclosure === DISCLOSURE && same(index.pages.map((x) => x.slug), indexable.map((p) => p.slug)), 'index.json: motto and disclosure exact; pages = the indexable pages');
ok(body.agents.includes(index.tiers.pro.client_env) && index.tiers.pro.client_env === `SIGELO_RELAY_RETENTION_DAYS=${allowance?.TIERS.pro.retentionDays}`, 'index.json: tiers.pro.client_env is in agents.md\'s Pro steps, at TIERS.pro\'s retention');
const priceLine = src.pro.match(PRICE_RE);
ok(priceLine && index.tiers.pro.price.EUR_month === Number(priceLine[1]) && index.tiers.pro.price.EUR_year === Number(priceLine[2]), 'index.json: the price is pro.md\'s');
// relay_sees names what each row of privacy.md's table keeps (A14).
const SEES = { 'Log of logins': '/24 or /48 in the relay log', 'Web server errors': 'web server error line', 'Web access log': 'web access log of sigelo.ai and relay.sigelo.ai, for visit counts', 'Encrypted messages': 'sizes', 'Per identity': 'DID and its key rotations', "An operator's licence": 'licences (Pro)',
  Backups: 'encrypted nightly backup, each copy kept 7 days' };
const rows = [...src.privacy.matchAll(/^\| ([^|]+?) \| [^|]+ \|$/gm)].map((m) => m[1]).filter((x) => x !== 'What' && !/^-+$/.test(x));
const sees = index.crypto.relay_sees.join('\n'), missing = rows.filter((x) => !Object.entries(SEES).some(([k, v]) => x.startsWith(k) && sees.includes(v)));
ok(rows.length === Object.keys(SEES).length && missing.length === 0, `index.json: relay_sees names what each row of privacy.md's table keeps${missing.length ? ` (missing: ${missing.join('; ')})` : ''}`);
const off = index.official;
ok(same(off.payment_details_only_on, PAYMENT_PLACES) && same(off.never_asks_for, ['seed', 'identity or wallet private key', 'token'])
  && off.payment_address_only_with === 'an invoice the buyer asked for' && off.invoice_only_via === 'https://sigelo.io/contact.html'
  && !('never_sends_by_email_or_chat' in off) && !('payment_proof_only_via' in off) && !('payment_address_or_link_only_with' in off)
  && NOBODY === 'Nobody from the project will ever ask for a seed, an identity or wallet private key, or a token. A payment address comes only with an invoice you asked for, in the SimpleX conversation you opened with the address on `https://sigelo.io/contact.html`.',
  'index.json: the official "never" and invoice fields say what the "Nobody…" line says (an address only with an invoice the buyer asked for, over sigelo.io\'s SimpleX address)');
ok(same(relayInfo.official, off) && relayInfo.payments_url === `${ORIGIN}/pro.html`, 'relay.json: the same official names as index.json, and where to pay');
const INFO_FIELDS = ['name', 'software', 'version', 'source', 'limits', 'fees', 'payments_url', 'terms', 'privacy', 'contact', 'official'];
ok(INFO_FIELDS.every((k) => relayInfo[k] !== undefined && relayInfo[k] !== null) && relayInfo.limits.free && relayInfo.limits.pro && Array.isArray(relayInfo.official.domains),
  `relay.json: plan §11's fields (${INFO_FIELDS.join(', ')}), limits per tier, the official domains`);
// Plan §11's four sentences: in index.json, relay.json and llms-full.txt; on the pages, the first three
// in every footer and the fourth, the disclosure, with the motto (the footer and index checks above).
ok(POSITIONING.length === 4 && POSITIONING[0].includes('needs no server') && POSITIONING[1].includes('leaving a platform')
  && POSITIONING[2].includes('a recovery key kept offline that wins over a thief') && POSITIONING[3] === DISCLOSURE
  && same(index.positioning, POSITIONING) && same(relayInfo.positioning, POSITIONING) && POSITIONING.every((s) => full.includes(s)),
'positioning: plan §11\'s four sentences in index.json, relay.json and llms-full.txt, the last the disclosure');
ok(off.issuer_did === ISSUER_DID && /^did:sigelo:z[1-9A-HJ-NP-Za-km-z]{40,50}$/.test(ISSUER_DID), 'index.json, relay.json: official.issuer_did, as sigelo.io\'s index.json has it');
const worldGenesis = join(ROOT, 'world', 'genesis.json');
if (sigelo && existsSync(worldGenesis)) {
  ok(sigelo.did(JSON.parse(readFileSync(worldGenesis, 'utf8'))) === ISSUER_DID && readFileSync(join(ROOT, 'SECURITY.md'), 'utf8').includes(ISSUER_DID),
    'official.issuer_did: the DID of world/genesis.json, the issuer SECURITY.md names (private tree)');
}
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
// The official names as sigelo.io's build has them (private tree): one table, two copies.
if (existsSync(join(ROOT, 'site', 'build.mjs'))) {
  const io = await load(join(ROOT, 'site', 'build.mjs'));
  if (io) ok(same(io.DOMAINS, DOMAINS) && same(io.HOSTS, HOSTS) && same(io.REPOSITORIES, REPOSITORIES) && io.SIMPLEX === SIMPLEX,
    'official names: DOMAINS, HOSTS, REPOSITORIES and the SimpleX address are site/build.mjs\'s (sigelo.io and SECURITY.md say the same)');
}
const ioOfficial = join(ROOT, 'site', 'src', 'official.mjs');
if (existsSync(ioOfficial)) {
  const o = await load(ioOfficial);
  if (o) ok(same(o.PAYMENT_PLACES, PAYMENT_PLACES), 'official names: PAYMENT_PLACES is site/src/official.mjs\'s (sigelo.io\'s index.json names the same places once the relay is live)');
}
// relay/licence.ts is the keeper's spend/licence.ts, copied because relay/ is published alone. In
// the private tree a copy that differs would check licences by rules the keeper no longer has.
if (isPrivateTree()) {
  const keeper = join(ROOT, 'spend', 'licence.ts');
  ok(existsSync(keeper) && readFileSync(keeper).equals(readFileSync(join(RELAY, 'licence.ts'))),
    'licence.ts: spend/licence.ts byte for byte (private tree; after editing that, cp spend/licence.ts relay/licence.ts)');
}

// ---- nginx: what the deploy promises (relay/deploy/nginx.conf) ---------------------------------
const confText = readFileSync(DEPLOY, 'utf8'), conf = nginxTree(confText);
ok(deployRefusals(DEPLOY).length === 0, `deploy gate: relay/deploy/nginx.conf passes (access logs off or cut to /24 or /48 in every server block, errors at crit, /_stats/ behind auth, /licence proxied, X-Real-IP)${deployRefusals(DEPLOY).length ? ` (${deployRefusals(DEPLOY).join('; ')})` : ''}`);
if (conf) {
  const servers = serversIn(conf), named = (name, port) => servers.filter((s) => s.directives.includes(`server_name ${name}`) && s.directives.some((d) => d.startsWith(`listen ${port}`)));
  const [apex] = named('sigelo.ai', 443), [www] = named('www.sigelo.ai', 443), [relay] = named(HOST, 443);
  const tls = [apex, www, relay].filter(Boolean);
  ok(tls.length === 3 && tls.every((s) => s.directives.includes('ssl_certificate /etc/letsencrypt/live/sigelo.ai/fullchain.pem') && s.directives.includes('add_header Strict-Transport-Security "max-age=31536000" always')),
    'nginx: sigelo.ai, www.sigelo.ai and relay.sigelo.ai on 443, the sigelo.ai certificate lineage, HSTS for a year');
  ok(www?.directives.includes('return 301 https://sigelo.ai$request_uri') && named('sigelo.ai www.sigelo.ai', 80).some((s) => everyDirective(s).includes('return 301 https://sigelo.ai$request_uri')),
    'nginx: www.sigelo.ai and http:// answer 301 to https://sigelo.ai, path kept');
  const DESCRIBEDBY = 'add_header Link \'</llms.txt>; rel="describedby"; type="text/plain"\' always';
  ok([apex, relay].every((s) => s && s.directives.includes(DESCRIBEDBY) && s.directives.some((d) => /^add_header Cache-Control \$\w+ always$/.test(d)) && s.directives.includes('root /var/www/sigelo.ai/dist')),
    'nginx: the site and the relay host serve dist, name /llms.txt as describedby and set Cache-Control');
  const locs = (s) => Object.fromEntries((s?.blocks ?? []).map((b) => [b.head, everyDirective(b)]));
  ok(servers.every((s) => s.blocks.every((b) => !everyDirective(b).some((d) => d.startsWith('add_header ')))), 'nginx: no add_header in a location (it would drop every inherited header)');
  const rl = locs(relay);
  ok(['location = /challenge', 'location = /check', 'location = /park', 'location ^~ /park/', 'location = /licence'].every((l) => rl[l]?.includes('proxy_pass http://127.0.0.1:8791') && rl[l].some((d) => d.startsWith('limit_req zone=')))
    && rl['location = /relay.json'] && rl['location = /llms.txt'] && rl['location = /robots.txt']?.includes('try_files /relay-robots.txt =404')
    && rl['location /']?.includes('return 301 https://sigelo.ai$request_uri') && rl['location = /']?.includes('try_files /index.html =404'),
  'nginx: relay.sigelo.ai proxies /challenge, /check, /park, /park/<hash>, /licence to 127.0.0.1:8791 under a rate limit, serves the front page, relay.json, llms.txt and its robots.txt, sends the rest to sigelo.ai');
  // A browser's request to a relay call is refused before the relay charges it: the relay counts
  // logins and challenges per network before it reads a body, so any web page could otherwise spend
  // that budget from its visitors' browsers and lock every agent on their /24 or /48 out (A5 review).
  // GET /stats (counts only, relay/stats.mjs) charges no budget and is open to any page (CORS): the
  // one proxied location without the refusal.
  const browserGaps = (t) => serversIn(t).flatMap((s) => s.blocks.filter((b) => b.head !== 'location = /stats' && everyDirective(b).some((d) => d.startsWith('proxy_pass '))))
    .filter((b) => !b.blocks.some((x) => x.head === 'if ($sigelo_browser)' && x.directives.join() === 'return 403')).map((b) => b.head);
  const proxied = servers.flatMap((s) => s.blocks.filter((b) => everyDirective(b).some((d) => d.startsWith('proxy_pass '))));
  const browserMap = conf.blocks.find((b) => b.head === 'map $http_sec_fetch_site$http_origin $sigelo_browser')?.directives ?? [];
  ok(browserMap.join('|') === 'default 1|"" 0|none 0' && proxied.length === 6 && browserGaps(conf).length === 0,
    `nginx: /challenge, /check, /park, /park/<hash> and /licence answer 403 to a request a browser makes (Sec-Fetch-Site or Origin), before it reaches the relay${browserGaps(conf).length ? ` (lacking: ${browserGaps(conf).join(', ')})` : ''}`);
  // GET /park/<hash>: its path is a short invite code's hash (relay/park.mjs), 40 bits a log reader
  // could search through while the code is good, so it is never logged.
  ok(rl['location ^~ /park/']?.includes('access_log off') && !rl['location = /park']?.some((d) => d.startsWith('access_log')), 'nginx: GET /park/<hash> is not logged (the path is a short code\'s hash); POST /park logs as /park');
  const noRefusal = nginxTree(confText.replace(/( {4}location = \/check \{\n) {8}if \(\$sigelo_browser\) \{\n {12}return 403;\n {8}\}\n/, '$1'));
  ok(noRefusal && browserGaps(noRefusal).join() === 'location = /check', 'nginx: a proxied location without the browser refusal is caught');
  const cors = conf.blocks.find((b) => b.head === 'map $uri $sigelo_cors')?.directives ?? [];
  ok(['"/index.json" "*"', '"/relay.json" "*"', '"/llms.txt" "*"'].every((x) => cors.includes(x)) && [apex, relay].every((s) => s.directives.includes('add_header Access-Control-Allow-Origin $sigelo_cors always')),
    'nginx: index.json, relay.json and llms.txt open to any origin (CORS)');
  const relayCacheMap = conf.blocks.find((b) => b.head === 'map $uri $relay_cache')?.directives ?? [];
  ok(rl['location = /stats']?.includes('proxy_pass http://127.0.0.1:8791') && rl['location = /stats'].some((d) => d.startsWith('limit_req zone=')) && cors.includes('"/stats" "*"')
    && relayCacheMap.includes('"/stats" "public, max-age=60"'), 'nginx: relay.sigelo.ai/stats proxied to the relay under the rate limit, open to any origin (CORS), cached a minute');
  const sl = locs(apex)['location ^~ /_stats/'] ?? [];
  const statsMaps = ['map $document_root $sigelo_stats', 'map $sigelo_stats $sigelo_site_cache', 'map $sigelo_stats $sigelo_site_robots'].map((h) => conf.blocks.find((b) => b.head === h)?.directives.join('|'));
  ok(sl.includes(STATS_ROOT) && sl.includes('access_log off') && sl.includes('auth_basic_user_file /etc/nginx/sigelo-stats.htpasswd') && sl.some((d) => /^auth_basic "/.test(d))
    && statsMaps[0] === 'default ""|"/var/www/sigelo.ai/stats" "stats:"' && statsMaps[1] === 'default $sigelo_cache|"stats:" "no-store"' && /"stats:" "noindex/.test(statsMaps[2] ?? '')
    && apex?.directives.includes('add_header Cache-Control $sigelo_site_cache always') && apex?.directives.includes('add_header X-Robots-Tag $sigelo_site_robots always'),
  'nginx: sigelo.ai/_stats/ behind basic auth (/etc/nginx/sigelo-stats.htpasswd), not logged, no-store, noindex');
  const logs = (s) => s?.directives.filter((d) => d.startsWith('access_log ')) ?? [];
  ok(logs(apex).join('|') === 'access_log /var/log/nginx/sigelo/access.log sigelo_anon if=$sigelo_outside|access_log /var/log/nginx/sigelo/access-self.log sigelo_anon if=$sigelo_self'
    && logs(relay).join('|') === 'access_log /var/log/nginx/sigelo/relay-access.log sigelo_anon if=$sigelo_outside|access_log /var/log/nginx/sigelo/access-self.log sigelo_anon if=$sigelo_self'
    && servers.filter((x) => x !== apex && x !== relay).every((x) => logs(x).join() === 'access_log off')
    && conf.directives.includes(`log_format sigelo_anon ${ANON['log_format sigelo_anon']}`),
  'nginx: sigelo.ai and relay.sigelo.ai over TLS log in sigelo.io\'s format (address cut to /24 or /48, no query string), the project\'s own requests apart; every other server block logs nothing');
  // No cookie and no script from the server either (the pages are checked above): nginx sets no
  // Set-Cookie header and runs no module that would (userid).
  ok(!/set-cookie|\buserid\b|\bsub_filter\b|\badd_before_body\b|\badd_after_body\b/i.test(confText.replace(/^\s*#.*$/gm, '')),
    'nginx: no Set-Cookie header, no userid cookie, nothing injected into a page (sub_filter, addition): no cookie banner needed');
  ok(apex?.directives.includes('error_page 404 /404.html') && files.has('404.html'), 'nginx: a miss on sigelo.ai serves the not-found page');
  const al = locs(apex);
  ok(al['location = /pay-monero.html']?.join() === 'return 301 https://sigelo.ai/pro.html' && al['location = /pay-monero']?.join() === 'return 301 https://sigelo.ai/pro.html'
    && al['location = /pay-monero.md']?.join() === 'return 301 https://sigelo.ai/pro.md' && !files.has('pay-monero.html')
    && /\/pay-monero\.html 301 to \/pro\.html/.test(readFileSync(join(RELAY, 'deploy', 'check.mjs'), 'utf8')),
    'nginx: the old pay page (/pay-monero.html, /pay-monero, its twin) answers 301 to /pro, which deploy/check.mjs checks live; dist has no pay page');
  ok(al['location = /404']?.includes('return 404') && al['location = /404.html']?.includes('internal'), 'nginx: /404 and /404.html asked for by name answer 404, not a 200 "Not found"');
  const defaults = servers.filter((s) => s.directives.some((d) => /^listen .*\bdefault_server$/.test(d)));
  ok(defaults.length === 2 && defaults.every((s) => s.directives.includes('return 444') && s.directives.includes('access_log off')),
    'nginx: the default servers on 80 and 443 drop, unlogged, a request for any other Host (no nginx page under sigelo.ai\'s certificate)');
  const cacheMap = conf.blocks.find((b) => b.head === 'map $status $sigelo_cache')?.directives ?? [];
  const relayCache = conf.blocks.find((b) => b.head === 'map $uri $relay_cache')?.directives ?? [];
  ok(cacheMap.includes('200 "public, max-age=3600"') && relayCache.includes('default $sigelo_cache') && !relayCache.some((d) => d.startsWith('"/relay.json"'))
    && relay?.directives.includes('add_header Cache-Control $relay_cache always'), 'nginx: relay.json cached an hour on a 200 (plan §11)');
}
ok((confText.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) ?? []).every((a) => a === '127.0.0.1' || a === '0.0.0.0'), 'nginx.conf: no address but loopback (the server\'s own address is never written)');
const readme = readFileSync(join(RELAY, 'deploy', 'README.md'), 'utf8');
ok(readme.includes('relay/deploy/nginx.conf') && !/^```nginx$/m.test(readme), 'deploy/README.md: points at relay/deploy/nginx.conf, holds no second nginx config but the port-80 bootstrap');
// By hand, certbot's first issuance needs something serving /var/www/acme on port 80: nginx.conf
// names a certificate that does not exist yet (A5 review). The README's printf writes that config.
{
  const boot = readme.match(/^printf '%s\\n' 'server \{'[\s\S]*?> \/etc\/nginx\/conf\.d\/sigelo-relay\.conf$/m);
  const f = join(OUT, 'bootstrap.conf');
  const ran = boot && spawnSync('sh', ['-c', boot[0].replace(/> \/etc\/nginx\/conf\.d\/sigelo-relay\.conf$/, `> '${f}'`)], { encoding: 'utf8' });
  const t = ran?.status === 0 ? nginxTree(readFileSync(f, 'utf8')) : null, [b] = t ? serversIn(t) : [];
  const acme = b?.blocks.find((x) => x.head === 'location ^~ /.well-known/acme-challenge/');
  ok(boot && boot.index < readme.indexOf('certbot certonly') && b?.directives.includes('listen 80') && b.directives.includes(`server_name sigelo.ai www.sigelo.ai ${HOST}`)
    && b.directives.includes('access_log off') && acme?.directives.includes('root /var/www/acme'),
  'deploy/README.md: by hand, a port-80 config serving /var/www/acme for the three names comes before the first certbot certonly');
}

// ---- --final over a copy of the pages: what passes, and each wrong thing it refuses ------------
// No placeholder is left, so the copy is the pages as written (FILL stays for a placeholder added
// later: each one filled as the runbook's §0 would, at the most words it is likely to take).
let mainnet, subaddr, stagenet;
if (monero) {
  const k = monero.keysFromSpend(new Uint8Array(32).fill(7));
  mainnet = monero.encodeAddress({ net: 'mainnet', kind: 'standard', spend: k.B, view: k.A });
  subaddr = monero.subaddress({ a: k.a, B: k.B, major: 0, minor: 1, net: 'mainnet' });
  stagenet = monero.encodeAddress({ net: 'stagenet', kind: 'standard', spend: k.B, view: k.A });
  ok([mainnet, subaddr, stagenet].every((a) => XMR_RE.test(`Pay to \`${a}\`.`)) && !XMR_RE.test(`${mainnet}x`) && !XMR_RE.test(ISSUER_DID),
    'payment details: a mainnet address, a mainnet subaddress and a stagenet address are each recognised on a page; a DID is not');
}
ok(['monero:8Bxyz?tx_amount=1', 'MONERO:4Abc', 'monero://4Abc', 'https://buy.stripe.com/aBc123dEf456', 'https://checkout.stripe.com/c/pay/cs_live_x'].every((u) => PAYMENT_LINK_RE.test(u))
  && !PAYMENT_LINK_RE.test(src.pro) && !PAYMENT_LINK_RE.test('Monero: 10 % less. Pay in Monero.'),
  'payment details: a monero: payment request and a card checkout URL are each recognised on a page; the price line\'s "Monero: 10 % less" is not');
const FILL = Object.fromEntries(Object.keys(PLACEHOLDERS).map((ph) => [ph, 'one two three four five six seven eight nine ten']));
const filled = (slug) => Object.entries(FILL).reduce((md, [ph, v]) => md.split(ph).join(v), src[slug]);
const scratch = mkdtempSync(join(tmpdir(), 'relay-site-'));
try {
  let k = 0;
  const vendor = sigelo ? sigelo.keygen({ recovery: 'sha256:' + '9'.repeat(64) }).did : 'did:sigelo:z' + '2'.repeat(44);
  const DEV = licence?.DEV_VENDOR_DID;
  const emptyRoot = join(scratch, 'root'); mkdirSync(emptyRoot);   // the relay's own export: no SECURITY.md, no site/
  // The pages once Pro is on sale: the VENDOR_PENDING sentence gone from both. The default vendor DID
  // follows the pages: the placeholder while they say Pro is not on sale yet, a real one once not.
  const onSale = (pages) => Object.fromEntries(Object.entries(pages).map(([slug, md]) => [slug, md.split(`${VENDOR_PENDING}\n\n`).join('').split(HOME_PENDING).join(HOME_ON_SALE)]));
  // The record --launch writes (recordRefusals): npm's versions of the two packages, as it saw them.
  const RECORD = `${JSON.stringify({ npm: { 'sigelo-agent': CONTACT_VERBS_SINCE, 'sigelo-contact': CONTACT_VERBS_SINCE } })}\n`;
  // → the --final refusal for the pages with `change` applied, or null when it builds (dist in dir/dist).
  const finalWith = (change = (pages) => pages, { deploy = confText, seller = SELLER, vendorDid, root = emptyRoot, proStorage = allowance?.TIERS.pro.storage, launched = true } = {}) => {
    const dir = join(scratch, String(++k));
    mkdirSync(dir);
    const pages = change(Object.fromEntries(PAGES.map((p) => [p.slug, filled(p.slug).replace(/^> \*\*DRAFT\b.*\n\n?/m, '')])));
    vendorDid ??= vendorPending(pages) === true ? DEV : vendor;
    for (const [slug, md] of Object.entries(pages)) writeFileSync(join(dir, `${slug}.md`), md);
    if (launched) writeFileSync(join(dir, LAUNCH_RECORD), RECORD);   // the export's record of the launch gate (launchGate)
    writeFileSync(join(dir, 'nginx.conf'), deploy);
    try { build({ final: true, site: dir, out: join(dir, 'dist'), deploy: join(dir, 'nginx.conf'), root, seller, vendor: vendorDid, proStorage }); return null; } catch (e) { return e.message; }
  };
  const set = (slug, from, to) => (pages) => ({ ...pages, [slug]: pages[slug].split(from).join(to) });
  const filesIn = (dir, at = dir) => readdirSync(at, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesIn(dir, join(at, e.name)) : [relative(dir, join(at, e.name))]));
  // A final build, as the pages are written and once Pro is on sale: what index.json, relay.json and the
  // JSON-LD say about Pro in each.
  const finalBuild = (pages, opts) => {
    const why = finalWith(pages, opts);
    if (why !== null) return { why };
    const d = join(scratch, String(k), 'dist'), json = (f) => JSON.parse(readFileSync(join(d, f), 'utf8'));
    const g = JSON.parse(readFileSync(join(d, 'index.html'), 'utf8').match(SCRIPT)[1])['@graph'];
    return { why, d, index: json('index.json'), info: json('relay.json'), service: g.find((x) => x['@type'] === 'Service') };
  };
  const proOffers = (service) => service.offers.filter((o) => o.name.startsWith('Pro')).map((o) => `${o.priceSpecification.price}/${o.priceSpecification.billingDuration}`).join();
  {
    const asWritten = finalBuild(undefined, {});
    ok(asWritten.why === null, `--final: the pages build, given the launch record${vendorPending(src) === true ? ', with the placeholder vendor DID while both pages say Pro is not on sale yet' : ' and a vendor DID'}${asWritten.why ? ` (${asWritten.why})` : ''}`);
    const sold = finalBuild(onSale, {});
    ok(sold.why === null, `--final: the pages with the not-on-sale sentence removed build, given a vendor DID${sold.why ? ` (${sold.why})` : ''}`);
    if (asWritten.why === null && vendorPending(src) === true) {
      const { index: x, info, service } = asWritten;
      ok(x.tiers.pro.on_sale === false && x.tiers.pro.not_yet_on_sale === true && info.fees.on_sale === false && info.fees.not_yet_on_sale === true
        && x.official.vendor_did === null && proOffers(service) === '' && service.provider?.name === SELLER && x.tiers.pro.price.EUR_month === Number(priceLine[1]),
      '--final while the pages say Pro is not on sale yet: index.json and relay.json say not_yet_on_sale (on_sale false), no vendor DID, the JSON-LD names the seller but offers no Pro; the price stays, as what Pro will cost');
    }
    if (sold.why === null) {
      const { d, index: fIndex, info, service } = sold;
      ok(service.provider?.['@type'] === 'Organization' && service.provider.name === SELLER && service.termsOfService === `${ORIGIN}/terms.html`
        && proOffers(service) === `${priceLine[1]}/P1M,${priceLine[2]}/P1Y`,
      '--final, on sale: the JSON-LD names the seller as provider (an Organization), the terms, and the two Pro offers at pro.md\'s prices');
      ok(fIndex.tiers.pro.on_sale === true && fIndex.tiers.pro.not_yet_on_sale === false && info.fees.on_sale === true && info.fees.not_yet_on_sale === false
        && fIndex.tiers.pro.storage_bytes === allowance?.TIERS.pro.storage && fIndex.tiers.pro.price.monero_discount_percent === Number(priceLine[3])
        && fIndex.client.install === 'npm i -g sigelo-agent' && fIndex.official.seller === SELLER && fIndex.official.vendor_did === vendor && same(fIndex.tiers.pro.pay, { monero: `${ORIGIN}/contact.html` }),
      `--final, on sale: index.json on sale, with the storage (TIERS.pro's ${allowance ? allowance.TIERS.pro.storage / allowance.MB : '?'} MB), discount, install line, seller, vendor DID and the one payment place, Monero`);
      ok(/<p><strong>10 € a month · 100 € a year<\/strong><\/p>\n<p>Available now\.<\/p>/.test(readFileSync(join(d, 'index.html'), 'utf8'))
        && !readFileSync(join(d, 'pro.md'), 'utf8').includes(VENDOR_PENDING), '--final, on sale: the home page\'s Pro card says "Available now."; pro.md no longer says "coming soon"');
      const sale = HEAD(false), heads = PAGES.map((p) => headOf(readFileSync(join(d, `${p.slug}.html`), 'utf8')));
      const llmsSold = readFileSync(join(d, 'llms.txt'), 'utf8');
      ok(PAGES.every((p, i) => heads[i][0] === sale.TITLE[p.slug] && heads[i][1] === sale.DESC[p.slug] && heads[i][1].length <= 155 && heads[i][0].length <= 60)
        && !/coming soon/i.test(llmsSold) && llmsSold.includes('(https://sigelo.ai/contact.md): invoices over SimpleX, the only way to pay\n'),
      '--final, on sale: titles and descriptions once Pro is on sale (no "coming soon", no discount); llms.txt\'s Pay line is the contact page, the only way to pay');
    }
    // No file of either build carries a payment address or link: an address comes only with an invoice.
    const holders = [asWritten, sold].filter((b) => b.why === null).flatMap((b) => filesIn(b.d).filter((f) => { const t = readFileSync(join(b.d, f), 'utf8'); return XMR_RE.test(t) || PAYMENT_LINK_RE.test(t); }));
    ok(holders.length === 0, `--final: no file of the build carries a Monero address or a payment link${holders.length ? ` (${holders.join(', ')})` : ''}`);
  }
  // The vendor DID follows pro.md (VENDOR_PENDING): the placeholder only while it says Pro is coming
  // soon; once the sentence is gone, a real one; never a real one while it stays. The same check in
  // --launch (launchCheck).
  if (DEV) {
    ok(/vendor DID/.test(finalWith(onSale, { vendorDid: DEV }) ?? '') && finalWith(undefined, { vendorDid: DEV }) === null,
      '--final: refuses the placeholder vendor DID once pro.md no longer says Pro is coming soon, takes it while it does');
    ok(/vendor DID: set .* still says "Pro is coming soon\./.test(finalWith(undefined, { vendorDid: vendor }) ?? ''),
      '--final: refuses a vendor DID set while pro.md still says Pro is coming soon');
    const pagesNow = Object.fromEntries(PAGES.map((p) => [p.slug, src[p.slug]]));
    ok(vendorPending({ pro: `# Pro\n\n${VENDOR_PENDING}\n` }) === true && vendorPending({ pro: '# Pro\n' }) === false,
      'vendorPending: true while pro.md carries the sentence, false once not');
    ok(vendorRefusals(pagesNow, vendorPending(pagesNow) === true ? DEV : vendor).length === 0 && vendorRefusals(onSale(pagesNow), DEV).join() === 'vendor DID'
      && vendorRefusals(onSale(pagesNow), vendor).length === 0
      && /^vendor DID: set/.test(vendorRefusals({ ...pagesNow, index: `x\n\n${HOME_PENDING}\n\ny`, pro: `x\n\n${VENDOR_PENDING}\n\ny` }, vendor).join()),
      'vendorRefusals: nothing for the pages with the vendor DID they call for; "vendor DID" for the placeholder once on sale; a refusal for a set DID while pending');
    // The home page's Pro card follows pro.md (HOME_PENDING): never out of step with it.
    const P = { index: `x\n\n${HOME_PENDING}\n\ny`, pro: `a\n\n${VENDOR_PENDING}\n\nb` }, S = { index: `x\n\n${HOME_ON_SALE}\n\ny`, pro: 'a' };
    ok(vendorRefusals(P, DEV).length === 0 && vendorRefusals(S, vendor).length === 0
      && /^index\.md: its Pro card does not say "Coming soon\."/.test(vendorRefusals({ ...P, index: S.index }, DEV).join()) && /^index\.md: its Pro card still says "Coming soon\."/.test(vendorRefusals({ ...S, index: P.index }, vendor).join())
      && /index\.md: its Pro card/.test(finalWith(vendorPending(pagesNow) === true ? set('index', HOME_PENDING, HOME_ON_SALE) : set('index', HOME_ON_SALE, HOME_PENDING)) ?? ''),
      '--final, vendorRefusals: refuse a home page whose Pro card does not say "Coming soon." while pro.md does, or still says it once pro.md does not');
    const sitePages = (change) => { const dir = join(scratch, `pages-${++k}`); mkdirSync(dir); for (const [slug, md] of Object.entries(change(pagesNow))) writeFileSync(join(dir, `${slug}.md`), md); return dir; };
    // The two ROOT-based checks need the private tree (launchCheck stops at its first refusal
    // elsewhere): in the relay's own export only the first holds.
    ok(launchCheck({ root: emptyRoot, site: SITE, vendor: DEV }).some((w) => /not the private tree/.test(w))
      && (!isPrivateTree(ROOT) || (launchCheck({ root: ROOT, site: sitePages(onSale), vendor: DEV }).includes('vendor DID')
        && !launchCheck({ root: ROOT, site: sitePages((x) => x), vendor: vendorPending(pagesNow) === true ? DEV : vendor }).includes('vendor DID'))),
      `--launch (launchCheck): refuses outside the private tree${isPrivateTree(ROOT) ? ', and refuses the placeholder vendor DID once the pages no longer say Pro is not on sale yet' : ' (the vendor checks need the private tree)'}`);
  }
  if (monero) {
    for (const [name, a] of [['mainnet', mainnet], ['subaddress', subaddr], ['stagenet', stagenet]]) {
      ok(/contact: carries a Monero address/.test(finalWith(set('contact', 'We answer there.', `We answer there. Pay to \`${a}\`.`)) ?? ''),
        `--final: refuses the contact page carrying a ${name} address (addresses are per invoice)`);
    }
    ok(/privacy: carries a Monero address/.test(finalWith(set('privacy', 'Servers in the EU.', `Servers in the EU. Donations: ${mainnet}.`)) ?? ''), '--final: refuses a Monero address on any page, not only the pay page');
  }
  ok(/contact: carries a payment link/.test(finalWith(set('contact', 'We answer there.', 'We answer there. Pay [here](monero:8Bxyz?tx_amount=1).')) ?? '')
    && /terms: carries a payment link/.test(finalWith(set('terms', 'The CISG does not apply.', 'The CISG does not apply. <https://buy.stripe.com/aBc123dEf456>')) ?? ''),
    '--final: refuses a monero: payment request on the contact page, and a card checkout link on any page (card payment is not offered)');
  ok(/SELLER "Other GmbH" is not the seller privacy\.md and terms\.md name/.test(finalWith(undefined, { seller: 'Other GmbH' }) ?? ''), '--final: refuses a SELLER the pages do not name');
  ok(/SELLER/.test(finalWith(undefined, { seller: null }) ?? '') && /vendor DID/.test(finalWith(onSale, { vendorDid: DEV }) ?? ''),
    '--final: refuses while SELLER is unset, or the relay pins the placeholder vendor DID once Pro is on sale');
  ok(/\[law and courts\]/.test(finalWith(set('terms', "The law and courts of the Seller's registered seat in the European Union.", '[law and courts].')) ?? '')
    && /DRAFT/.test(finalWith(set('terms', '# Terms\n', '# Terms\n\n> **DRAFT for review.**\n')) ?? ''),
  '--final: refuses a placeholder that is not listed (unknown placeholders fail too), and the terms\' DRAFT mark');
  ok(/N € a month or N € a year/.test(finalWith(set('pro', 'excluding VAT', 'VAT excluded')) ?? '') && /N € a month or N € a year/.test(finalWith(set('pro', 'at 10 % off', 'at [discount] % off')) ?? ''),
    '--final: refuses a pro.md whose price line it cannot read, or whose discount is a placeholder again');
  ok(/server block \d+ \(sigelo\.ai\) lacks "access_log off;"/.test(finalWith(undefined, { deploy: confText.replace(/^ {4}access_log \/var\/log\/nginx\/sigelo\/access(?:-self)?\.log .*\n/gm, '') }) ?? ''),
    '--final: refuses while a server block keeps nginx\'s default access log, naming the block');
  ok(/lacks "error_log <file> crit;"/.test(finalWith(undefined, { deploy: confText.replace(/(server_name relay\.sigelo\.ai;\n[\s\S]*?) {4}error_log \S+ crit;\n/, '$1') }) ?? ''),
    '--final: refuses while a server block logs refusals at "error"');
  ok(/location = \/licence/.test(finalWith(undefined, { deploy: confText.replace(/ {4}location = \/licence \{\n[\s\S]*?\n {4}\}\n/, '') }) ?? ''), '--final: refuses while nginx does not proxy /licence');
  ok(/X-Real-IP/.test(finalWith(undefined, { deploy: confText.replace(/ {4}proxy_set_header X-Real-IP \$remote_addr;\n/, '') }) ?? ''), '--final: refuses a relay proxy without X-Real-IP');
  ok(/launch: no site\/launch\.json/.test(finalWith(undefined, { launched: false }) ?? ''),
    '--final: in the relay export (no SECURITY.md above it) refuses without the launch record the private tree\'s --launch wrote');
  if (allowance) {
    const { MB } = allowance, cell = src.pro.match(/^\| Room for waiting messages \| [^|]+ \| ([^|]+) \|$/m)?.[1].trim(), big = set('pro', `| ${cell} |`, '| 2 GB |');
    ok(new RegExp(`the storage cell says 2 GB, more than the relay grants a Pro pool \\(${allowance.TIERS.pro.storage / MB} MB`).test(finalWith(big) ?? '') && finalWith(big, { proStorage: 2048 * MB }) === null,
      '--final: refuses a Pro storage cell above what the relay grants (TIERS.pro.storage, or RELAY_PRO_STORAGE_MB where the site is built), and builds once that allows it');
    ok(proStorageCap(undefined) === allowance.TIERS.pro.storage && proStorageCap('') === allowance.TIERS.pro.storage && proStorageCap('2048') === 2048 * MB
      && ['0', '1e3', '-5', '10000001', ' 5'].every((v) => proStorageCap(v) === null), 'RELAY_PRO_STORAGE_MB: read as the relay reads it (a whole number of MB, 1 to 10,000,000), else TIERS.pro.storage');
  }
  // The deploy gate itself: every server block, both logs down at its own level; quotes are text.
  const gate = (text) => { const f = join(scratch, `nginx-${++k}.conf`); writeFileSync(f, text); return deployRefusals(f); };
  const QUIET = '    access_log off;\n    error_log /var/log/nginx/error.log crit;\n';
  const relayConf = `server {\n${QUIET}    server_name relay.example.org;\n    proxy_set_header X-Real-IP $remote_addr;\n    location = /licence { proxy_pass http://127.0.0.1:8791; }\n}\n`;
  const siteConf = (top) => `server {\n${top}    server_name example.org;\n    add_header Link '</llms.txt>; rel="describedby"' always;\n    location / { root /var/www; }\n}\n`;
  const said = (why, re) => why.some((w) => re.test(w));
  ok(gate(relayConf + siteConf(QUIET)).length === 0, 'deploy gate: two server blocks, both logs down in each, one proxying /licence with X-Real-IP, a quoted ";" in a header: open nothing');
  const second = gate(relayConf + siteConf(''));
  ok(said(second, /server block 2 \(example\.org\) lacks "access_log off;"/) && said(second, /server block 2 \(example\.org\) lacks "error_log <file> crit;"/),
    `deploy gate: a second server block that logs is refused by name (${second.join('; ')})`);
  ok(said(gate(siteConf('    error_log /var/log/nginx/error.log crit;\n    location /x {\n        access_log off;\n    }\n') + relayConf), /server block 1 .*lacks "access_log off;"/),
    'deploy gate: "access_log off;" inside a location only is refused');
  ok(said(gate(relayConf.replace('location = /licence {', 'location = /licence { access_log /var/log/nginx/licence.log;')), /turns the access log on inside it/),
    'deploy gate: an access log turned on inside a location is refused');
  // The access log of the site: sigelo.io's format and maps, nothing else.
  const anonTop = `log_format sigelo_anon ${ANON['log_format sigelo_anon']};\n` + Object.entries(ANON).filter(([h]) => h.startsWith('map ')).map(([h, d]) => `${h} {\n${d.split('|').map((x) => `    ${x};`).join('\n')}\n}\n`).join('');
  const ANON_ON = '    access_log /var/log/nginx/sigelo/access.log sigelo_anon if=$sigelo_outside;\n    error_log /var/log/nginx/error.log crit;\n';
  ok(gate(anonTop + relayConf + siteConf(ANON_ON)).length === 0, 'deploy gate: a server block logging in sigelo_anon, with sigelo.io\'s format and maps, opens nothing');
  ok(said(gate(anonTop + relayConf + siteConf(ANON_ON.replace('sigelo_anon if=$sigelo_outside', 'combined'))), /lacks "access_log off;" or access logs in the format sigelo_anon/), 'deploy gate: an access log in another format (combined: the full address) is refused');
  ok(said(gate(anonTop.replace('$sigelo_net - -', '$remote_addr - -') + relayConf + siteConf(ANON_ON)), /log_format sigelo_anon is not sigelo\.io's/), 'deploy gate: the format sigelo_anon with the full address is refused');
  ok(said(gate(anonTop.replace('"~^(?<sigelo_p>/[^?]*)" "$sigelo_p"', '"~^(?<sigelo_p>/.*)" "$sigelo_p"') + relayConf + siteConf(ANON_ON)), /"map \$request_uri \$sigelo_path" is not sigelo\.io's/), 'deploy gate: a path map that keeps the query string (?did=…) is refused');
  ok(said(gate(anonTop + 'map $remote_addr $sigelo_ref {\n    default $remote_addr;\n}\n' + relayConf + siteConf(ANON_ON)), /\$sigelo_ref is set by a second map/), 'deploy gate: a second map setting a variable the format reads is refused');
  ok(said(gate(anonTop + relayConf + siteConf(ANON_ON + `    location ^~ /_stats/ {\n        ${STATS_ROOT};\n    }\n`)), /serves the statistics .* without basic auth/), 'deploy gate: the statistics served without basic auth are refused');
  ok(said(gate(relayConf.replace('location = /licence {', 'location = /licence { error_log /var/log/nginx/licence.log error;')), /logs errors below crit inside it/),
    'deploy gate: an error log below crit inside a location is refused');
  ok(said(gate(relayConf.replace(/\}\n$/, '')), /do not balance/) && said(gate(relayConf.replace('8791; }', '8791 }')), /do not balance/)
    && said(gate(relayConf.replace('server_name relay.example.org;', 'server_name "relay.example.org;')), /do not balance/), 'deploy gate: a block with a brace, a semicolon or a quote missing is refused');
  ok(said(gate(`# location = /licence { proxy_pass x; }\n${siteConf(QUIET)}`), /no server block has "location = \/licence"/), 'deploy gate: a /licence in a comment proxies nothing');
  ok(deployRefusals(join(scratch, 'absent.conf')).some((w) => /not found/.test(w)), 'deploy gate: a missing nginx.conf is refused');
  // nginx drops the server's proxy_set_header in a location that sets one of its own, and then passes
  // the client's X-Real-IP through (reproduced against nginx 1.28 by the A5 review).
  const hostLine = confText.replace(/( {4}location = \/challenge \{\n)/, '$1        proxy_set_header Host $host;\n');
  ok(hostLine !== confText && said(gate(hostLine), /sets proxy_set_header inside a location/), 'deploy gate: a location with a proxy_set_header of its own is refused (it would pass the client\'s own X-Real-IP)');
  ok(said(gate(relayConf.replace('    proxy_set_header X-Real-IP $remote_addr;\n', '').replace('location = /licence {', 'location = /licence { proxy_set_header X-Real-IP $remote_addr;')), /sets proxy_set_header inside a location/),
    'deploy gate: X-Real-IP set in the location only is refused too (the next location added would lack it)');
  // A quote inside a token is text to nginx: the directives between two such quotes run.
  const midQuote = confText.replace(/( {4}location = \/check \{\n)/, '$1        add_header X-A a";\n        access_log /var/log/nginx/full.log;\n        add_header X-B b";\n');
  ok(midQuote !== confText && said(gate(midQuote), /turns the access log on inside it/), 'deploy gate: an access log between two quotes inside tokens is seen, as nginx reads it');
  const t1 = nginxTree('a b";\nc d;\ne f";\n'), t2 = nginxTree('a "b;c" \'d}\';\n'), t3 = nginxTree('a b\\;c;\n');
  ok(t1?.directives.join('|') === 'a b"|c d|e f"' && t2?.directives.join('|') === 'a "b;c" \'d}\'' && t3?.directives.join('|') === 'a b\\;c',
    'nginx reader: quotes open a string only at the start of a token, and a backslash escapes the next character (as nginx\'s tokenizer)');

  // The launch gate: the official statement as the rest of the private tree says it.
  const tree = (security, io, more = {}) => {
    const root = join(scratch, `root-${++k}`);
    mkdirSync(join(root, 'site', 'deploy'), { recursive: true });
    if (security !== null) writeFileSync(join(root, 'SECURITY.md'), security);
    if (io !== null) writeFileSync(join(root, 'site', 'deploy', 'nginx.conf'), io);
    for (const [f, text] of Object.entries(more)) { mkdirSync(dirname(join(root, f)), { recursive: true }); writeFileSync(join(root, f), text); }
    return launchRefusals(root);
  };
  const goodSecurity = `- Repositories: ${REPOSITORIES.join(' and ')}.\n- ${NOBODY}\n`;
  const ioConf = (to, extra = '') => `server {\n    server_name sigelo.net www.sigelo.net;\n    return 301 https://${to}$request_uri;\n}\n${extra}`;
  ok(tree(goodSecurity, ioConf('sigelo.ai')).length === 0 && tree(null, null).length === 0, 'launch gate: SECURITY.md and sigelo.io\'s nginx as index.json says, or absent (the relay export): open nothing');
  {
    const root = join(scratch, `root-${++k}`);
    mkdirSync(join(root, 'site'), { recursive: true });
    writeFileSync(join(root, 'site', 'build.mjs'), '');
    const why = launchRefusals(root);
    ok(['SECURITY\\.md', 'site/deploy/nginx\\.conf', 'site/src/official\\.mjs', 'adapters/moadim/sigelo-agent-contact\\.ts'].every((f) => said(why, new RegExp(`^${f}: not found`))),
      'launch gate: in the private tree (site/build.mjs beside relay/), a missing SECURITY.md, sigelo.io nginx.conf, official.mjs or sigelo-agent contact verbs is refused, not skipped');
  }
  // In the private tree, also sigelo.io's own index.json (its build), the SimpleX address the pay
  // pages' step 1 compares (sigelo.io's contact page and SECURITY.md) and the install line's verbs.
  {
    const SX = SIMPLEX, withSx = `${goodSecurity}- SimpleX: \`${SX}\`\n`;
    const ioBuild = "official: { payment_address_only_with: 'an invoice the buyer asked for', invoice_only_via: 'https://sigelo.io/contact.html' }\n";
    const privateTree = ({ security = withSx, build = ioBuild, official = `export const SIMPLEX = '${SX}';\n`, verbs = '// the contact verbs\n' } = {}) =>
      tree(security, ioConf('sigelo.ai'), { 'site/build.mjs': build, 'site/src/official.mjs': official, 'adapters/moadim/sigelo-agent-contact.ts': verbs });
    const none = privateTree();
    ok(none.length === 0, `launch gate, private tree: SECURITY.md, sigelo.io's build, nginx and official.mjs and the contact verbs as index.json says: open nothing${none.length ? ` (${none.join('; ')})` : ''}`);
    ok(said(privateTree({ build: "never_sends_by_email_or_chat: ['payment address', 'payment link'], payment_address_only_with: 'x'\n" }), /^site\/build\.mjs: sigelo\.io's index\.json still says/)
      && said(privateTree({ build: "payment_proof_only_via: 'https://sigelo.io/contact.html', payment_address_only_with: 'x'\n" }), /^site\/build\.mjs: sigelo\.io's index\.json/)
      && said(privateTree({ build: "payment_address_or_link_only_with: 'x', payment_address_only_with: 'x'\n" }), /still has payment_address_or_link_only_with/)
      && said(privateTree({ build: 'official: {}\n' }), /lacks payment_address_only_with/),
      'launch gate: refuses while sigelo.io\'s index.json says no payment address or link is sent by chat, keeps the older field, or lacks what sigelo.ai\'s says');
    ok(said(privateTree({ security: goodSecurity }), /^SECURITY\.md: lacks the SimpleX address/) && said(privateTree({ official: "export const SIMPLEX = '<simplex address>';\n" }), /no SIMPLEX address/),
      'launch gate: refuses while SECURITY.md lacks the SimpleX address sigelo.io\'s contact page shows (the pay page\'s step 1 compares them)');
    ok(said(privateTree({ security: `${withSx}- Nobody from the project will ever ask for a seed, or send a payment address or link by e-mail or chat.\n` }), /^SECURITY\.md: still says no payment address/)
      && said(privateTree({ security: `${withSx}- Payment proofs go only to the SimpleX address.\n` }), /^SECURITY\.md: still says/),
      'launch gate: refuses a SECURITY.md that still carries the old line (no payment address or link by chat; payment proofs)');
    ok(said(privateTree({ verbs: "note('the contact verbs are not in the npm release of sigelo-agent: run them from a clone');\n" }), /contact verbs still refuse when sigelo-agent is installed from npm/),
      'launch gate: refuses while sigelo-agent refuses the contact verbs when installed from npm (connect.md\'s install line would fail)');
    ok(said(privateTree({ official: "export const SIMPLEX = 'https://smp.example/a#other';\n", security: `${goodSecurity}- SimpleX: \`https://smp.example/a#other\`\n` }), /^relay\/site\/build\.mjs: SIMPLEX is not the address/),
      'launch gate: refuses while relay/site/build.mjs SIMPLEX (shown on /contact) is not site/src/official.mjs\'s');
  }
  // The relay export cannot run the launch gate (no SECURITY.md above it): there --final takes the
  // record the private tree's `--launch` wrote; in the private tree that record may exist only while
  // the gate passes. `--launch` writes it, so it is run here only where it refuses (writes nothing).
  const noRecord = join(scratch, `site-${++k}`), withRecord = join(scratch, `site-${++k}`);
  mkdirSync(noRecord); mkdirSync(withRecord); writeFileSync(join(withRecord, LAUNCH_RECORD), RECORD);
  ok(said(launchGate(emptyRoot, noRecord), /launch: no site\/launch\.json/) && launchGate(emptyRoot, withRecord).length === 0,
    'launch gate, outside the private tree: refused without the launch record, passed with it');
  // A record must name what npm served (X2 review: one written from the source alone let sigelo.ai
  // promise verbs the sigelo-agent on npm did not have).
  const recordSays = (text) => { const dir = join(scratch, `site-${++k}`); mkdirSync(dir); writeFileSync(join(dir, LAUNCH_RECORD), text); return launchGate(emptyRoot, dir); };
  const old = '{"checked":"SECURITY.md, site/build.mjs, site/deploy/nginx.conf and sigelo-agent do what index.json says; the vendor DID agrees with the pages","by":"relay/site/build.mjs --launch"}\n';
  ok(said(recordSays(old), /does not record npm serving sigelo-agent and sigelo-contact at 0\.1\.2 or later/) && said(recordSays('{}\n'), /sigelo-agent and sigelo-contact/)
    && said(recordSays('not json\n'), /does not record npm/) && said(recordSays('{"npm":{"sigelo-agent":"0.1.1","sigelo-contact":"0.1.2"}}\n'), /serving sigelo-agent at/)
    && said(recordSays('{"npm":{"sigelo-agent":"0.1.2"}}\n'), /serving sigelo-contact at/) && said(recordSays('{"npm":{"sigelo-agent":"0.1.2-rc.1","sigelo-contact":"0.1.2"}}\n'), /serving sigelo-agent at/)
    && recordSays('{"npm":{"sigelo-agent":"0.2.0","sigelo-contact":"0.1.10"}}\n').length === 0 && CONTACT_VERBS_SINCE === '0.1.2',
  'launch gate, outside the private tree: refuses a record that does not name npm serving sigelo-agent and sigelo-contact at 0.1.2 or later (the first with the contact verbs): the record written before this check, an empty one, a stale version, a prerelease');
  ok(versionAtLeast('0.1.10', '0.1.2') && !versionAtLeast('0.1.1', '0.1.2') && !versionAtLeast(undefined, '0.1.2') && !versionAtLeast('v0.1.2', '0.1.2'), 'versionAtLeast: compares numerically, refuses anything but x.y.z');
  // --launch reads the registry once the tree passes (registryRefusals); here against stand-in documents.
  {
    const root = join(scratch, `npm-${++k}`); mkdirSync(join(root, 'adapters', 'moadim'), { recursive: true });
    writeFileSync(join(root, 'adapters', 'moadim', 'package.json'), JSON.stringify({ name: 'sigelo-agent', version: '0.1.2' }));
    const doc = (v, deps = {}, by = 'csigelo') => ({ 'dist-tags': { latest: v }, versions: { [v]: { version: v, dependencies: deps, _npmUser: { name: by } } } });
    const reg = (docs) => registryRefusals({ root, get: async (n) => docs[n] ?? null });
    const good = { 'sigelo-agent': doc('0.1.2', { sigelo: '^0.1.2', 'sigelo-contact': '^0.1.2' }), 'sigelo-contact': doc('0.1.2', { sigelo: '^0.1.2' }) };
    const g = await reg(good), today = await reg({ 'sigelo-agent': doc('0.1.1', { sigelo: '^0.1.1' }) });
    ok(g.why.length === 0 && same(g.npm, { 'sigelo-agent': '0.1.2', 'sigelo-contact': '0.1.2' }) && (await reg({ 'sigelo-agent': doc('0.1.3', { 'sigelo-contact': '^0.1.3' }), 'sigelo-contact': doc('0.1.3') })).why.length === 0,
      'registry: npm\'s latest sigelo-agent at this tree\'s version or later, depending on sigelo-contact, which is there too, both from csigelo: passes, and the record gets the versions seen');
    ok(said(today.why, /^npm: sigelo-agent's latest is 0\.1\.1, older than this tree's 0\.1\.2/) && said(today.why, /^npm: sigelo-agent 0\.1\.1 does not depend on sigelo-contact/) && said(today.why, /^npm: no sigelo-contact/),
      'registry: refuses what npm served at the X2 review (sigelo-agent 0.1.1 without the contact verbs, no sigelo-contact), naming each');
    ok(said((await reg({ ...good, 'sigelo-contact': doc('0.1.2', {}, 'someone-else') })).why, /^npm: sigelo-contact 0\.1\.2 was published by someone-else, not csigelo/)
      && said((await reg({ ...good, 'sigelo-agent': doc('0.1.2', { sigelo: '^0.1.2' }) })).why, /does not depend on sigelo-contact/)
      && said((await reg({ ...good, 'sigelo-contact': { 'dist-tags': {}, versions: {} } })).why, /^npm: no sigelo-contact/),
      'registry: refuses a sigelo-contact from another publisher, a sigelo-agent without the dependency, a package with no latest version');
    const down = await registryRefusals({ root, get: async () => { throw new Error('offline'); } });
    ok(down.why.length === 1 && down.why[0].startsWith(`npm: could not read ${NPM_REGISTRY} (offline)`) && same(down.npm, {}), 'registry: an unreadable registry is a refusal, never a pass');
  }
  if (isPrivateTree()) {
    const record = existsSync(join(SITE, LAUNCH_RECORD)), now = launchRefusals(), stale = record ? [...now, ...recordRefusals(SITE)] : [];
    ok(stale.length === 0, `launch gate: relay/site/${LAUNCH_RECORD} ${record ? 'exists, names the npm versions it saw, and the private tree still says what index.json says' : 'absent (not launched)'}${stale.length ? ` (but: ${stale.join('; ')})` : ''}`);
    if (now.length) {
      const launch = spawnSync(process.execPath, [join(SITE, 'build.mjs'), '--launch'], { encoding: 'utf8', timeout: 60000 });
      ok(launch.status === 1 && now.every((w) => launch.stderr.includes(w)) && existsSync(join(SITE, LAUNCH_RECORD)) === record,
        'launch gate: build.mjs --launch refuses while the private tree does not say what index.json says, naming each, and writes no record');
    }
  } else {
    const launch = spawnSync(process.execPath, [join(SITE, 'build.mjs'), '--launch'], { encoding: 'utf8', timeout: 60000 });
    ok(launch.status === 1 && /not the private tree/.test(launch.stderr), 'launch gate: build.mjs --launch refuses outside the private tree (the relay export)');
  }
  ok(said(tree(goodSecurity.replace(NOBODY, 'Nobody asks.'), ioConf('sigelo.ai')), /SECURITY\.md: lacks the "Nobody/) && said(tree(`- ${NOBODY}\n`, ioConf('sigelo.ai')), /does not name https:\/\/github\.com\/csigelo\/sigelo-relay/),
    'launch gate: refuses a SECURITY.md without the "Nobody…" line or the relay repository');
  ok(said(tree(goodSecurity, ioConf('sigelo.io')), /sigelo\.net does not answer 301 to https:\/\/sigelo\.ai/)
    && said(tree(goodSecurity, ioConf('sigelo.ai', 'server {\n    server_name sigelo.ai www.sigelo.ai;\n    return 301 https://sigelo.io$request_uri;\n}\n')), /still serves sigelo\.ai/),
  'launch gate: refuses while sigelo.io\'s host sends sigelo.net elsewhere, or still serves sigelo.ai');
  ok(sellerRefusal(null, src) === undefined && /plain text/.test(sellerRefusal('Bad <b>Ltd</b>', src) ?? ''), 'seller: unset passes the shape check (open instead); markup refused');

  // terms.md is final, so it keeps its budget too.
  for (const p of PAGES) {
    const n = words(fill(filled(p.slug), p.slug));
    ok(n <= budget(p.slug), `budget, filled: ${p.slug}.md ${n} words ≤ ${budget(p.slug)} with every placeholder and {{value}} filled`);
  }
} finally { rmSync(scratch, { recursive: true, force: true }); }

// ---- what the pages promise: the relay's numbers and fields --------------------------------------
// Every contact verb loads the identity and refuses without one, and init refuses without a
// recovery decision: the start sequence begins with it (A5 review). The lines are the live test's
// quick start (2026-10-14, run against relay.sigelo.ai), with recovery-key (release 0.1.3, never
// run there) in place of its keygen one-liner, so the key comes from the install itself; the code
// named so that `send bob` finds the contact, and the answer so that `send alice` does (0.1.4); and `inbox`, which completes the pairing when the
// inviter was offline at `accept`.
// The install line is the sidecar package that carries the contact verbs from release 0.1.2. On
// /connect each step's lines sit in its own code block, under the step, framed as what you tell your
// agent; quickStart() reads them back in order.
const QUICK = ['npm i -g sigelo-agent', 'sigelo-agent init --recovery "$(sigelo-agent recovery-key)"', 'sigelo-agent invite --name bob', 'sigelo-agent accept K7F3-Q9ZP --name alice',
  'sigelo-agent inbox', 'sigelo-agent send bob "hello"'];
const steps4 = [...src.connect.matchAll(/^(\d)\. \*\*([^*]+)\*\*/gm)].map((m) => `${m[1]} ${m[2]}`);
ok(quickStart(src.connect).join('\n') === QUICK.join('\n') && steps4.join() === '1 Install, once on each side.,2 Make a code.,3 They enter it.,4 Talk.'
  && (src.connect.match(/^ {3}```sh$/gm) ?? []).length === 4 && /::: steps\n1\. /.test(src.connect) && (src.connect.match(/[Tt]ells? (?:your|their) agent/g) ?? []).length >= 4,
  `connect: four numbered steps, each with its command block (install and recovery key, invite --name, accept, inbox and send), framed as what you tell your agent (${steps4.join('; ')})`);
ok((html.connect.match(/<div class="steps">\n<ol>/g) ?? []).length === 1 && (html.connect.match(/<li><p><strong>/g) ?? []).length === 4 && (html.connect.match(/<pre><code class="language-sh">/g) ?? []).length === 4,
  'connect: the steps render as one numbered list, four items, a code block in each');
// index.json's commands are build.mjs's: connect.md's blocks after the install line, line for line.
// An agent reads index.json (the live test did): with `init --recovery <z…>` there and no way to
// make the key, it was stuck where a reader of the page was not.
ok(index.client.install === QUICK[0] && index.client.commands.join('\n') === QUICK.slice(1).join('\n'),
  `index.json: client.install and client.commands are connect.md's quick start (index.json: ${index.client.commands.join(' | ')})`);
ok(src.index.includes('No account to open: each agent logs in with its own [sigelo identity](https://sigelo.io/).') && src.index.includes(`\n\n${r.pending ? HOME_PENDING : HOME_ON_SALE}\n\n`)
  && /\]\(\/connect\.html\)/.test(src.index),
  `index: no account, the agent's own sigelo identity; the Pro card${r.pending ? ' says "Coming soon."' : ''}; links to /connect`);
if (allowance && mailbox && operator && db) {
  const { free, pro } = allowance.TIERS, { MB, KB } = allowance, DAY = db.DAY;
  const size = (b) => (b % MB === 0 ? `${b / MB} MB` : `${b / KB} KB`);
  const row = (label) => body.pro.match(new RegExp(`^\\| ${label} \\| ([^|]+) \\| ([^|]+) \\|$`, 'm'))?.slice(1).map((c) => c.trim()) ?? [];
  const table = {
    'Messages a day': [thou(free.msgsDay), thou(pro.msgsDay)], 'Messages wait up to': [`${free.retentionDays} days`, `${pro.retentionDays} days`],
    'Largest message': [size(free.maxMessage), size(pro.maxMessage)],
    // A contact costs its reader a mailbox per week of its retention window plus the week ahead its
    // client claims: a bare mailbox count read as contacts (A5 review).
    Contacts: [free, pro].map((t) => `~${thou(Math.floor(t.mailboxes / (allowance.windowWeeks(t.retentionDays) + 1)))}`),
  };
  const offRows = Object.entries(table).filter(([label, want]) => row(label).join() !== want.join()).map(([label]) => label);
  const storage = row('Room for waiting messages');
  // Pro's storage is the constant the relay grants (TIERS.pro.storage), never more: the Owner asked
  // for 5 GB, the relay grants 1 GB, so the page says 1 GB.
  if (storage[0] !== size(free.storage) || storage[1] !== (pro.storage % (1024 * MB) === 0 ? `${pro.storage / 1024 / MB} GB` : size(pro.storage))) offRows.push('Room for waiting messages');
  ok(offRows.length === 0, `pro: the Free/Pro table is relay/allowance.mjs TIERS, Pro's storage TIERS.pro.storage${offRows.length ? ` (differs: ${offRows.join(', ')})` : ''}`);
  // The licence claim "email" is answered over SimpleX (terms §7): contact@ only receives, so no page
  // or agent file may sell e-mail support.
  const supportOf = (t) => ({ none: 'none', email: 'SimpleX', priority: 'priority' })[t.support];
  ok(row('Support').join() === `${supportOf(free)},${supportOf(pro)}` && body.agents.includes('No account: a seller-signed licence to your **operator DID**.') && pro.groups === 0 && !/\bgroups?\b/i.test(body.pro),
    `pro: support as TIERS.pro.support (${pro.support}, shown as ${supportOf(pro)}); no groups sold while TIERS.pro.groups is 0 (version 2)`);
  ok(index.tiers.pro.support === supportOf(pro) && index.tiers.free.support === supportOf(free) && relayInfo.limits.pro.support === supportOf(pro)
    && (pro.support !== 'email' || src.terms.includes('answered over SimpleX')) && !/Support: e-?mail/i.test(Object.values(body).join('\n')),
    'support: index.json and relay.json say what pro.md says; e-mail support is answered over SimpleX (terms §7) and no page sells "Support: e-mail"');
  ok(allowance.windowWeeks(7) + 1 === 3 && allowance.windowWeeks(90) + 1 === 15 && !/^\| Mailboxes \|/m.test(body.pro),
    `pro: a row of contacts, not mailboxes; a contact costs 3 mailboxes at 7 days and 15 at 90, as relay/allowance.mjs says (now ${row('Contacts').join(' and ')})`);
  ok(body.index.includes(`\n\n${thou(free.msgsDay)} messages a day, up to ${size(free.maxMessage)} each.\n\n`), 'index: the Free card is TIERS.free');
  // An account goes ACCOUNT_KEEP after its last login, once its claims are gone; an idle claim goes
  // its retention plus IDLE_GRACE after its last use (mailbox.mjs); longer while an attestation it
  // presented from an operator licensed here runs, or its licence is kept (allowance.mjs accountKept). Licences:
  // LICENCE_KEEP after their expiry, or after the expiry of the licence they replaced if later, used
  // or not (operator.mjs replaced_exp; behaviour checked below and in test/allowance.mjs).
  const keep = (t) => Math.max(mailbox.ACCOUNT_KEEP, t.retentionDays * DAY + mailbox.IDLE_GRACE) / DAY, lk = operator.LICENCE_KEEP / DAY;
  ok(body.privacy.includes(`until read; at most ${free.retentionDays} days, Pro ${pro.retentionDays}`)
    && body.privacy.includes(`operator pool membership, proof-of-work record | until ${keep(free)} days after its last use (Pro: ${keep(pro)}); longer while vouched for by a licensed operator, or licensed |`)
    && body.privacy.includes(`| until ${lk} days past the term sold, used or not |`),
  'privacy: retention as the relay keeps it (messages, per-identity rows incl. pool membership and proof of work, licences)');
}
if (sigelo && operator && auth && db) {
  // pro.md step 5, field by field, then such an attestation through SPEC §9 and the relay's own
  // operator checks: it is refused only for want of a licence. Without the operator's genesis in
  // the bundle's issuers, and with admission "open", it is refused as an operator attestation.
  const step5 = body.agents.match(/^5\. .*$/m)?.[0] ?? '';
  const fields = ['`iss` = the operator\'s current DID', '`sub` = its original DID', '`admission:"invite"`', '`admission_by` = `iss`', `\`ctx:"${auth.OPERATOR_CTX}"\``,
    `\`claims:{"relay":"${HOST}"}\``, `at most ${operator.OPERATOR_DAYS} days`, '`sigelo-agent add-attestation`', '`add-issuer`', '`attest()`'];
  ok(fields.every((x) => step5.includes(x)), `pro step 5: names every field the relay requires of an operator attestation${fields.some((x) => !step5.includes(x)) ? ` (missing: ${fields.filter((x) => !step5.includes(x)).join(', ')})` : ''}`);
  const now = Math.floor(Date.now() / 1000), DAY = db.DAY, c = (h) => 'sha256:' + h.repeat(64);
  const op = sigelo.keygen({ recovery: c('1') }), agent = sigelo.keygen({ recovery: c('2') }), vendor = sigelo.keygen({ recovery: c('3') });
  const att = (o) => sigelo.attest({ secret: op.secret, iss: op.did, sub: agent.did, iat: now, exp: now + operator.OPERATOR_DAYS * DAY, ctx: auth.OPERATOR_CTX,
    admission: 'invite', admission_by: op.did, claims: { relay: HOST }, ...o });
  const present = (a, issuers) => operator.operators({ db: db.openDb(':memory:'), host: HOST, vendor: vendor.did, clock: () => now })
    .present(sigelo.verify({ v: 'sigelo/0', typ: 'bundle', genesis: agent.genesis, rotations: [], bindings: [], attestations: [a], issuers }, now), now).notice ?? {};
  const asStep5 = present(att(), [op.genesis]);
  ok(asStep5.code === 'licence', `pro step 5: such an attestation passes the relay's operator checks (refused only for want of a licence: ${asStep5.detail})`);
  ok(present(att(), []).code === 'operator' && present(att({ admission: 'open', admission_by: undefined }), [op.genesis]).code === 'operator',
    'pro step 5: without the operator genesis in issuers, or with admission "open", the relay refuses it (the step is load-bearing)');

  // pro.md step 2 and the pay pages: the operator logs in before paying, so that the upload (the
  // buyer's or the company's) is taken. Then privacy.md on how long a licence stays.
  const steps = Object.fromEntries([...body.agents.matchAll(/^(\d)\. (.*)$/gm)].map((m) => [m[1], m[2]]));
  // The relay pools only attestations whose iss is the operator's current key (operator.mjs): after a
  // rotation every agent's attestation must be signed again, or the pool drops to free (A5 review).
  ok(steps[2] === 'Log in with it (`sigelo-agent inbox`); again after each rotation, then redo step 5.' && /^\[Contact us for a quote\]\(\/contact\.md\), naming that DID; pay in Monero only, within 24 hours; renew likewise\.$/.test(steps[3] ?? '') && /^Upload /.test(steps[4] ?? ''),
    'pro: log in with the operator identity (step 2), and after each rotation again and sign the agents\' attestations anew (step 5), before paying (3, renewal the same) and uploading (4)');
  ok(/prints the operator DID \(later: the first of its `chain`\)/.test(body.agents), 'agents step 1: a licence names the operator\'s original DID, the first of its chain');
  ok(src.agents.includes('The relay takes a licence only for an operator it has seen log in (step 2).'), 'agents: log in with the operator identity before paying (step 2 before 3)');
  const licenceFor = (sub, exp) => ({ attestation: sigelo.attest({ secret: vendor.secret, iss: vendor.did, sub, iat: now, exp, ctx: operator.LICENCE_CTX, admission: 'payment',
    claims: { tier: 'pro', storage_mb: 1, msgs_day: 1, retention_days: 1, groups: 0 } }), issuer: vendor.genesis, rotations: [] });
  const relayDb = () => { const d = db.openDb(':memory:'); return [d, operator.operators({ db: d, host: HOST, vendor: vendor.did, clock: () => now })]; };
  const a = db.accountOf(op.did), YEAR = 365 * DAY, KEEP = operator.LICENCE_KEEP;
  {
    const [d, ops] = relayDb();
    const before = ops.upload(licenceFor(op.did, now + YEAR), now);
    d.touchAccount(a, now);
    const after = ops.upload(licenceFor(op.did, now + YEAR), now);
    ok(before.ok === false && before.check === 'licence' && after.ok === true,
      `pro step 2 is load-bearing: the relay refuses a licence whose operator never logged in, and takes it after one login (${before.ok ? 'taken before any login' : before.detail})`);
    d.close();
  }
  {
    // Step 2's "then redo step 5": once the operator's login shows a rotation, the relay pools only
    // attestations signed by its new key, and an agent still carrying an old one drops to free.
    const [d, ops] = relayDb();
    d.touchAccount(a, now);
    const up = ops.upload(licenceFor(op.did, now + YEAR), now), op2 = sigelo.keygen({ recovery: c('1') });
    const pooled = (x, issuers) => ops.present(sigelo.verify({ v: 'sigelo/0', typ: 'bundle', genesis: agent.genesis, rotations: [], bindings: [], attestations: [x], issuers }, now), now);
    const first = pooled(att(), [op.genesis]);
    ops.loggedIn(a, op2.did, [op.did, op2.did], []);
    const stale = pooled(att(), [op.genesis]), fresh = pooled(att({ secret: op2.secret, iss: op2.did, admission_by: op2.did }), [op2.genesis]);
    ok(up.ok && first.member !== null && stale.member === null && stale.notice?.code === 'operator' && /rotated away/.test(stale.notice.detail) && fresh.member !== null,
      `pro step 2 "then redo step 5" is load-bearing: after the operator's rotation an agent pools only with an attestation from its new key (old one: ${stale.notice?.code ?? 'pooled'})`);
    d.close();
  }
  // → whether the licence row is still there after tidy(at), for a licence uploaded now, running
  // until exp, its operator logging in `logins` times.
  const keptAfter = (exp, logins, at) => {
    const [d, ops] = relayDb();
    d.touchAccount(a, now);
    const up = ops.upload(licenceFor(op.did, exp), now);
    for (let i = 0; i < logins; i++) ops.loggedIn(a, op.did, [op.did], []);
    ops.tidy(at);
    const count = d.raw.prepare('SELECT count(*) AS n FROM licences WHERE operator = ?').get(a).n;
    d.close();
    return up.ok ? count === 1 : `upload refused: ${up.detail}`;
  };
  const kept = [
    keptAfter(now + YEAR, 0, now + KEEP + DAY), keptAfter(now + YEAR, 0, now + YEAR + KEEP - DAY),
    keptAfter(now + YEAR, 0, now + YEAR + KEEP), keptAfter(now + 10 * DAY, 1, now + 10 * DAY + KEEP),
  ];
  ok(kept.join() === [true, true, false, false].join(),
    `privacy: a licence stays until ${KEEP / DAY} days after its expiry, used or not, as operator.mjs keeps it (got ${kept.join(', ')})`);
  // Ending a licence early (a refund, a chargeback, abuse: terms §8, §10) is a later 1-day reissue,
  // which the relay keeps over it. When the relay never held the licence being ended (refunded before
  // upload), the vendor uploads that licence first: the reissue then records its expiry (replaced_exp)
  // and the row stays until LICENCE_KEEP after it, refusing the ended file all along. Without that
  // upload the row goes LICENCE_KEEP after the 1-day licence and the ended file is taken again.
  const licenceAt = (iat, exp) => ({ attestation: sigelo.attest({ secret: vendor.secret, iss: vendor.did, sub: op.did, iat, exp, ctx: operator.LICENCE_CTX, admission: 'payment',
    claims: { tier: 'pro', storage_mb: 1, msgs_day: 1, retention_days: 1, groups: 0 } }), issuer: vendor.genesis, rotations: [] });
  const ended = licenceAt(now - 60, now + YEAR), ending = licenceAt(now, now + DAY), later = now + DAY + KEEP + DAY;
  const endWith = (first) => {
    const [d, ops] = relayDb();
    d.touchAccount(a, now);
    const ups = [...first, ending].map((x) => ops.upload(x, now));
    ops.tidy(later);
    const again = ops.upload(ended, later);
    d.close();
    return ups.every((u) => u.ok) ? again.ok : `an upload was refused: ${ups.find((u) => !u.ok).detail}`;
  };
  const endings = [endWith([ended]), endWith([])];
  ok(endings.join() === [false, true].join(),
    `ending a licence the relay never held: upload it, then the 1-day reissue; the ended file stays refused past LICENCE_KEEP after the reissue (without the first upload it is taken again: got ${endings.join(', ')})`);
}
// The request's commands are on the agents' page (an agent runs them); privacy.md says what it is and links there.
const erasure = src.agents.slice(src.agents.indexOf('## Erasure'));
ok(src.privacy.includes('if the identity has a **recovery key**: your agent signs a request with it (`sigelo-agent erase-request`), which you send over SimpleX; how, on [For agents](/agents.html#erasure).')
  && src.privacy.includes('Without asking: stop using the identity') && /\sid="erasure"/.test(html.agents),
  'privacy: erasure by disuse, or a recovery-key request whose steps are on /agents#erasure');
ok(['**recovery key**', 'sigelo-agent erase-request --recovery-key recovery.key > erase.json', 'ctx:"sigelo.ai/erase"', 'ctx:"sigelo.ai/access"', 'Without asking: stop using the identity'].every((s) => erasure.includes(s))
  && !/sign-challenge/.test(erasure), 'privacy: erasure by disuse, or by a recovery-key request (never an identity-key challenge, which any world can obtain)');
ok(['/24', '/48', '7 days', 'Never logged:', 'Seller and provider of the relay', 'Web access log, for visit counts: address cut to /24 or /48, time, page without query', 'rarely, one holds a full address and the request, which may name a DID', 'DIDs only in such an error line', 'only in memory, while connected'].every((s) => src.privacy.includes(s)),
  'privacy: /24 or /48 for 7 days, full addresses in memory only but in a rare error line, which may also name a DID (the request line), the web access log as nginx.conf keeps it (cut address, no query), the never-list, the seller');
// What the access log row says, as nginx.conf logs it: the cut address, the path without its query, the user agent, the referring site only, 7 days.
ok(/access_log \/var\/log\/nginx\/sigelo\/access\.log sigelo_anon/.test(confText) && /\$sigelo_net - - \[\$time_local\] "\$request_method \$sigelo_path [^']*\$sigelo_ref[^']*\$http_user_agent[^']*\$http_accept/.test(confText)
  && src.privacy.includes('user agent, Accept header, referring site only | 7 days |') && !/keeps no access log/.test(src.privacy), 'privacy: the access log row names what nginx.conf\'s format keeps, and no page says there is none');
ok(['No custody', 'No payment routing', 'No access to content', 'The attestation is the subscription', 'does not sell to consumers'].every((s) => src.terms.includes(s)),
  'terms: B2B, no custody, no payment routing, no access to content, the attestation is the subscription');
// No custody: should a pay page ever ask for a transaction key, the clause must say it only proves a
// payment. Refunds: a licence not yet on the relay within 14 days, and the §9 warranty with a time to
// fix it, as commercial/LICENCE-TERMS-draft.md §9 (A5 review). Ending a licence is a later, shorter
// reissue (operator.mjs keeps the one issued last), which is how a refund is made safe.
ok(src.terms.includes('never receives or holds a seed, private key or other means of access')
  && (!/transaction key/.test(src.contact + src.agents) || src.terms.includes('(transaction keys only prove payments)'))
  && src.terms.includes('A licence not yet uploaded to the relay is refunded on request within 14 days of payment.')
  && src.terms.includes("If §9's warranty fails and is not fixed within 14 days, the unused part is refunded. No other refunds.")
  && src.terms.includes('nothing renews or charges by itself') && src.terms.includes('Software and service are provided as is.')
  && src.terms.includes('Liability is limited to what the Buyer paid in the 12 months before the claim; none for lost messages, keys, funds or profits.')
  && src.terms.includes('The Seller may refuse a DID used for them and end its licence without refund; messages already delivered are not erased.')
  && src.terms.includes('A licence ends at its expiry, or earlier on refund or under §8.') && src.terms.includes('excluding VAT, less the stated discount; Monero only.'),
  'terms: paid in Monero; no custody; refund of a licence not yet on the relay within 14 days, or when §9\'s warranty fails unfixed for 14 days; no auto-renewal; as is; liability capped at 12 months\' payments; abuse or a refund ends a licence');
// The nightly backup (deploy/backup.sh: licences and licensed operators' rows, 7 archives kept) is a
// copy the table names; an identity without a recovery key is erased by disuse only (A5 review).
const backupSh = readFileSync(join(RELAY, 'deploy', 'backup.sh'), 'utf8');
ok(src.privacy.includes("| Backups: licences and licensed operators' rows, encrypted | 7 days more |") && /\| tail -n \+8 \| xargs -r rm -f/.test(backupSh)
  && /^TABLES="licences operator_retired vendor_chain accounts chain_dids"$/m.test(backupSh),
  'privacy: the encrypted backup of licences and licensed operators\' rows, 7 days more, as deploy/backup.sh keeps them (7 archives)');
ok(erasure.includes('Sooner, or to see the data, if the identity has a **recovery key** (any site can obtain identity-key signatures), where the identity file and `recovery.key` are:'), 'privacy: a request takes the recovery key; without one, disuse is the only way');
// Where the servers are, as the Owner confirmed it (runbook §0): stated once, in the seller line.
ok(src.privacy.includes('`contact@sigelo.io`. Servers in the EU.') && src.privacy.split('Servers in').length === 2 && !/\bEU hosting provider\b/.test(src.privacy),
  'privacy: the servers are in the EU, stated once, in the seller line');
ok(src.privacy.includes('No accounts. This site sets no cookies and runs no scripts or trackers.'), 'privacy: no accounts, no cookies, no scripts or trackers (so no consent banner)');
ok(/, excluding VAT, for businesses\. /.test(src.pro) && src.terms.includes('the Seller does not sell to consumers'), 'pro, terms: businesses only');
ok(src.contact.includes('`site/contact.md`') && existsSync(join(RELAY, 'site', 'contact.md')), 'contact: names its copy in the relay\'s public repository (site/contact.md)');
ok(PAGES.every((p) => !XMR_RE.test(src[p.slug])) && paymentDetailRefusals(src).length === 0, 'no page carries a Monero address (one is made per invoice)');
ok(PAGES.every((p) => !PAYMENT_LINK_RE.test(src[p.slug])), 'no page carries a payment link (a monero: request or a checkout URL)');
// Whoever holds an access request gets the data: SimpleX only (an erasure may come by e-mail).
ok(erasure.includes('access requests over SimpleX only: whoever holds one gets the data.'),
  'privacy: an access request goes over SimpleX only, never by e-mail');

// ---- the internal runbook's self-test (private tree only) --------------------------------------
const runbook = join(ROOT, 'commercial', 'relay-pro-runbook.md');
if (existsSync(runbook)) {
  const FENCE = '`'.repeat(3);
  const self = [...readFileSync(runbook, 'utf8').matchAll(new RegExp(`^${FENCE}js\\n([\\s\\S]*?)^${FENCE}$`, 'gm'))].map((m) => m[1]).find((b) => b.startsWith('// §11'));
  if (!self) ok(false, 'runbook: its §11 self-test block is found');
  else {
    ok(!/INSERT INTO (?:licences|operator_retired)\b/.test(self), 'runbook: its self-test makes licence rows through operator.mjs, never by INSERT (the schema is operator.mjs\'s)');
    const t = spawnSync(process.execPath, ['--input-type=module', '-e', self], { cwd: RELAY, encoding: 'utf8', timeout: 300000 });
    for (const line of (t.stdout ?? '').split('\n')) { const m = line.match(/^(ok|FAIL) (.*)$/); if (m) ok(m[1] === 'ok', `runbook: ${m[2]}`); }
    ok(t.status === 0 && /ALL PASS/.test(t.stdout ?? ''), `runbook: the self-test exits 0${t.status ? ` (${(t.stderr || t.error?.message || '').trim().split('\n').slice(-3).join(' | ')})` : ''}`);
  }
}

console.log(fails.length ? `${fails.length} FAILED of ${n} checks` : `ALL PASS (${n} checks)`);
process.exit(fails.length ? 1 : 0);
