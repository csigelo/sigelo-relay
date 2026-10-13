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
// while one is open, and refusing a filled copy with a stagenet, mistyped or invented address, a
// Stripe test link, a seller the pages do not name or an nginx config that logs what privacy.md says
// it never logs; the agent files (llms.txt, index.json, relay.json, sitemap, robots, security.txt)
// against the pages and the relay's own code; the numbers, fields and steps the pages promise against
// the relay's behaviour. In the private tree it also compares the official names with sigelo.io's
// and relay/licence.ts with spend/licence.ts, and runs the internal runbook's self-test
// (commercial/relay-pro-runbook.md §11). No network.
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  build, deployRefusals, launchRefusals, nginxTree, serversIn, everyDirective, DEPLOY, ORIGIN, HOST, REPO, ROOT, PAGES, PLACEHOLDERS,
  PLACEHOLDER_RE, DRAFT_RE, STRIPE_RE, PRICE_RE, addressRefusal, linkRefusal, sellerRefusal, VALUES, NOBODY, MOTTO, DISCLOSURE, DOMAINS, HOSTS,
  REPOSITORIES, CONTENT_HOSTS, PAYMENT_PLACES, PAYMENT_WORDS, POSITIONING, ISSUER_DID, STATEMENT, QUEUE_NOTE, titleOf, pageUrl, isPrivateTree, proStorageCap, launchGate,
  LAUNCH_RECORD, fill,
} from './build.mjs';

const SITE = dirname(fileURLToPath(import.meta.url));
const RELAY = dirname(SITE);
let n = 0; const fails = [];
const ok = (cond, what) => { n++; if (cond) console.log(`ok ${what}`); else { fails.push(what); console.log(`FAIL ${what}`); } };
// The relay's own modules: the pages' numbers and fields are checked against them, not copied.
const load = async (spec) => { try { return await import(spec); } catch (e) { ok(false, `import ${spec} (${e.message})`); return null; } };
const sigelo = await load('sigelo'), monero = await load('sigelo/dist/monero.js');
const allowance = await load('../allowance.mjs'), operator = await load('../operator.mjs'), auth = await load('../auth.mjs');
const db = await load('../db.mjs'), mailbox = await load('../mailbox.mjs');
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
// is too low. With every placeholder filled too: below, after the --final checks.
const BUDGET = { index: 120, pro: 200, privacy: 530, 404: 40 };
const budget = (slug) => BUDGET[slug] ?? 500;
const words = (s) => s.split(/[ \t\n\r\f\v]+/).filter(Boolean).length;
for (const p of PAGES) {
  const n = words(fill(src[p.slug], p.slug));
  ok(n <= budget(p.slug), `budget: ${p.slug}.md ${n} words ≤ ${budget(p.slug)}, every {{value}} filled`);
}
ok(words(fill('{{free.storage}} {{pro.maxMessage}}', 'test')) === 4, 'budget: a size value counts as the two words it renders as ("50 MB"), not as one');
const budgetsFile = join(ROOT, 'docs-test', 'budgets.json');
if (existsSync(budgetsFile)) {
  const b = JSON.parse(readFileSync(budgetsFile, 'utf8'));
  const wrong = PAGES.filter((p) => b[`relay/site/${p.slug}.md`] !== budget(p.slug)).map((p) => p.slug);
  ok(wrong.length === 0, `docs-test/budgets.json: the same budgets for the pages${wrong.length ? ` (differs: ${wrong.join(', ')})` : ''}`);
}

// ---- placeholders: each one in the sources is listed, each listed one is used ------------------
const found = new Set(Object.values(src).flatMap((md) => md.match(PLACEHOLDER_RE) ?? []));
const listed = Object.keys(PLACEHOLDERS);
const unlisted = [...found].filter((x) => !listed.includes(x)), unused = listed.filter((x) => !found.has(x));
ok(unlisted.length === 0, `placeholders: every one in the pages is listed in build.mjs${unlisted.length ? ` (unlisted: ${unlisted.join(', ')})` : ''}`);
ok(unused.length === 0, `placeholders: every listed one is still in a page${unused.length ? ` (filled, remove from PLACEHOLDERS: ${unused.join(', ')})` : ''}`);
ok(r.wrong.length === 0, `payment details, price, storage, seller: placeholders or well formed${r.wrong.length ? ` (${r.wrong.join('; ')})` : ''}`);
let refused = null;
try { build({ final: true, out: join(OUT, 'final') }); } catch (e) { refused = e.message; }
const pending = [...r.open, ...r.wrong];
ok(pending.length ? refused !== null && pending.every((x) => refused.includes(x)) : refused === null,
  `--final: ${pending.length ? `refuses while ${pending.length} are open, naming each` : 'builds, nothing open'}`);
ok(!src.terms.includes('[law and courts]') || DRAFT_RE.test(src.terms), 'terms.md: marked DRAFT while the lawyer\'s inputs are open');

// ---- contact: one address, receive-only, no form, no account wording ---------------------------
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
for (const p of PAGES) {
  const mails = [...new Set([...(src[p.slug].match(EMAIL) ?? []), ...(html[p.slug].match(EMAIL) ?? [])])];
  ok(mails.every((m) => m === 'contact@sigelo.io'), `${p.slug}: no e-mail address but contact@sigelo.io${mails.length ? ` (${mails.join(', ')})` : ''}`);
}
// Whoever holds a txid and its tx key can claim the payment as theirs: SimpleX only, never e-mail.
const step2 = src['pay-monero'].match(/^2\. [\s\S]*?(?=^3\. )/m)?.[0] ?? '';
ok(step2.startsWith('2. Then send over SimpleX, to the address on `https://sigelo.io/contact.html` opened the same way (typed), never by e-mail') && !step2.includes('contact@'),
  'pay-monero: the transaction id and key go over SimpleX only, never by e-mail, to the address on sigelo.io\'s contact page reached by typing it');
const ACCOUNT = [/\bsign[ -]?(?:up|in)\b/i, /\blog ?in to\b/i, /\bpassword\b/i, /\b(?:create|open) (?:an |your )?account\b/i, /\busername\b/i];
const FORM = /<(?:form|input|textarea|select|button)\b/i;
for (const p of PAGES) {
  const hit = ACCOUNT.filter((re) => re.test(src[p.slug]));
  ok(!FORM.test(html[p.slug]) && hit.length === 0, `${p.slug}: no form and no account wording${hit.length ? ` (${hit.join(' ')})` : ''}`);
}

// ---- head (A1–A5): titles, descriptions, one H1, canonical and noindex, the twin linked --------
const SCRIPT = /<script type="application\/ld\+json">\n([\s\S]*?)\n<\/script>/;
const H1 = { index: 'sigelo relay: encrypted messages between AI agents', pro: 'Pro: one allowance for all your agents', 'pay-monero': 'Pay Pro in Monero',
  'pay-card': 'Pay Pro by card', privacy: 'Privacy', terms: 'Terms', 404: 'Not found' };
// SEO spec §3.2's rendered titles and descriptions, exactly. Pro's description takes its numbers from
// relay/allowance.mjs TIERS, and names the largest message instead of the spec's "kept up to N days":
// a reader away over a week takes no new messages on either tier (A5 review), so that promised more.
const sizeOf = (b) => (b % (1024 * 1024) === 0 ? `${b / 1024 / 1024} MB` : `${b / 1024} KB`);
const TITLE = { index: 'sigelo relay — end-to-end encrypted messaging for AI agents', pro: 'Pro: one allowance for all your agents — sigelo relay',
  'pay-monero': 'Pay Pro in Monero, at a discount — sigelo relay', 'pay-card': 'Pay Pro by card (Stripe) — sigelo relay',
  privacy: 'Privacy: what the relay keeps — sigelo relay', terms: 'Terms of service — sigelo relay', 404: 'Not found — sigelo relay' };
const DESC = {
  index: 'AI agents pair by a one-line code and exchange end-to-end encrypted messages over MQTT. The relay holds them while one is offline. No accounts; free tier.',
  pro: `sigelo relay Pro pools one allowance across your agents: ${thou(allowance?.TIERS.pro.msgsDay)} messages a day, up to ${sizeOf(allowance?.TIERS.pro.maxMessage)} each. A licence attestation to your operator DID; no account.`,
  'pay-monero': 'Pay sigelo relay Pro in Monero, at a discount: send XMR to the published address, then your operator DID, transaction id and key over SimpleX.',
  'pay-card': 'Pay sigelo relay Pro by card through a Stripe checkout, with your operator DID. The seller never sees the card number; the licence is issued by hand.',
  privacy: 'What the sigelo relay and this site keep, and for how long: addresses cut to /24 or /48 for 7 days; never message content. No cookies, no scripts.',
  terms: 'Terms for sigelo relay Pro, sold to businesses only: the free service, Pro as a licence attestation, no custody, no payment routing, liability, law.',
  404: 'No page at this address on sigelo.ai. The relay pages: home, Pro, payment, privacy and terms; agents can start at /llms.txt or /index.json.',
};
const titles = PAGES.map((p) => html[p.slug].match(/<title>([^<]*)<\/title>/)?.[1].replace(/&amp;/g, '&') ?? '');
const descs = PAGES.map((p) => html[p.slug].match(/<meta name="description" content="([^"]*)">/)?.[1].replace(/&amp;/g, '&') ?? '');
PAGES.forEach((p, i) => {
  ok(titles[i] === titleOf(p) && titles[i].length <= 60 && titles[i].split(' — ').length <= 2 && titles[i].includes('sigelo relay'),
    `${p.slug}: title "${titles[i]}" (${titles[i].length} chars ≤ 60, at most one " — ", names sigelo relay)`);
  ok(descs[i].length >= 50 && descs[i].length <= 155, `${p.slug}: meta description ${descs[i].length} chars (50–155)`);
  ok(titles[i] === TITLE[p.slug] && descs[i] === DESC[p.slug], `${p.slug}: title and meta description exactly as SEO spec §3.2 (pro's with TIERS.pro's numbers)${descs[i] === DESC[p.slug] ? '' : ` (description: "${descs[i]}")`}`);
  const h = html[p.slug];
  ok((h.match(/<h1\b/g) ?? []).length === 1 && src[p.slug].startsWith(`# ${H1[p.slug]}\n`), `${p.slug}: exactly one H1, "${H1[p.slug]}"`);
  const canon = h.includes(`<link rel="canonical" href="${pageUrl(p)}">`), noindex = h.includes('<meta name="robots" content="noindex">');
  ok(p.noindex ? !canon && noindex && !/rel="canonical"/.test(h) : canon && !noindex, `${p.slug}: ${p.noindex ? 'noindex and no canonical' : `canonical ${pageUrl(p)}, indexable`}`);
  ok(h.includes(`<link rel="alternate" type="text/markdown" href="/${p.slug}.md"`), `${p.slug}: its .md twin linked (A4)`);
});
ok(new Set(titles).size === titles.length && new Set(descs).size === descs.length, 'titles and descriptions: each unique');
ok(descs.every((d) => !/\bkept up to\b|\bretention\b/i.test(d)), 'descriptions: none promises a retention (a reader away over a week takes no new messages, whatever the tier)');

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
  ok(types === want && refs.every((id) => ids.has(id)) && web?.url === pageUrl(page) && web?.name === titleOf(page),
    `${slug}: JSON-LD nodes ${want}, every @id reference resolves, the WebPage is this page`);
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
    } else if (!(ALLOWED.some((re) => re.test(href)) || (p.slug === 'pay-card' && STRIPE_RE.test(href)) || href === 'mailto:contact@sigelo.io')) bad.push(href);
  }
  ok(bad.length === 0, `${p.slug}: links resolve or go to sigelo.io, github.com/csigelo${p.slug === 'pay-card' ? ', buy.stripe.com' : ''}${bad.length ? ` (bad: ${bad.join(' ')})` : ''}`);
  const badMd = [...twin[p.slug].replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '').matchAll(/\]\((\/[^)\s]*)\)/g)]
    .map((m) => m[1]).filter((u) => !/^\/[\w-]+\.(?:md|txt|json)(#[\w-]+)?$/.test(u) || !files.has(u.slice(1).split('#')[0]));
  ok(badMd.length === 0, `${p.slug}.md twin: internal links go to the twins or the agent files${badMd.length ? ` (bad: ${badMd.join(' ')})` : ''}`);
}
const adopt = join(ROOT, 'site', 'src', 'adopt.md');
if (existsSync(adopt)) ok(/^## 1\. Identity$/m.test(readFileSync(adopt, 'utf8')), 'pro: the link to sigelo.io/adopt.html#1-identity has its heading');

// ---- footer (A8, A10): the same text in the page and its twin; motto, seller, official names ----
const plainText = (s) => s.replace(/<[^>]*>/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\*\*/g, '').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
for (const p of PAGES) {
  const foot = html[p.slug].match(/<footer>\n([\s\S]*?)\n<\/footer>/)?.[1] ?? '', mdFoot = twin[p.slug].slice(twin[p.slug].lastIndexOf('\n---\n') + 5);
  const text = plainText(foot);
  ok(text === plainText(mdFoot) && text.length > 0, `${p.slug}: the twin ends with the page's footer, word for word (A10)`);
  const motto = text.includes(`${MOTTO} ${DISCLOSURE}`);
  ok(p.slug === 'index' ? !motto : motto, `${p.slug}: ${p.slug === 'index' ? 'the footer leaves the motto to the body' : 'the footer holds the motto with the disclosure'}`);
  // Plan §11's first three sentences on every page, not only in the machine-readable files (A5 review).
  ok(POSITIONING.slice(0, 3).every((x) => text.includes(x)) && text.includes('Identity by sigelo.') && foot.includes('Identity by <a href="https://sigelo.io/">sigelo</a>.'),
    `${p.slug}: the footer carries plan §11's three positioning sentences after "Identity by sigelo."`);
  ok(text.includes('Seller and provider: ') && [...CONTENT_HOSTS, ...REPOSITORIES.map((x) => x.replace('https://', ''))].every((x) => text.includes(x))
    && ['href="https://sigelo.io/"', `href="${STATEMENT}"`, 'href="/privacy.html"', 'href="/terms.html"', 'href="/llms.txt"', 'href="/index.json"', `href="/${p.slug}.md"`].every((x) => foot.includes(x)),
  `${p.slug}: the footer has the seller line, every official host and repository, links to sigelo.io and its official statement, privacy, terms, /llms.txt, /index.json and the twin`);
}
ok(/^\*\*By AI, for AI\.\*\*\n\nBuilt and operated by an AI agent under a human owner, csigelo\.\n/m.test(src.index), 'index: "**By AI, for AI.**" directly followed by the disclosure paragraph (A8)');
// One list of where payment details appear: the footer's sentence, index.json, each pay page. The
// files and the branch, never the repository as a whole: GitHub serves a fork's commit, an issue or
// a pull request under the parent repository's URL.
const narrow = `Payment details appear only on sigelo.ai and in site/pay-monero.md and site/pay-card.md on the main branch of ${REPO.replace('https://', '')}.`;
ok(PAYMENT_PLACES.join() === [`${ORIGIN}/pay-monero.html`, `${ORIGIN}/pay-card.html`, `${REPO}/blob/main/site/pay-monero.md`, `${REPO}/blob/main/site/pay-card.md`].join()
  && PAYMENT_WORDS === narrow && PAGES.every((p) => plainText(html[p.slug]).includes(narrow) && twin[p.slug].includes(narrow))
  && PAGES.every((p) => !plainText(html[p.slug]).includes(`Payment details appear only on sigelo.ai and in ${REPO.replace('https://', '')}`)),
'footer: payment details only on sigelo.ai\'s two pay pages and in their two files on the relay repository\'s main branch, as PAYMENT_PLACES says; never "in" the repository as a whole');
// The second copy is reached from sigelo.io's statement, typed: a link on the page would move with
// the address whoever swapped it. "Only on sigelo.ai": the page and its twin both serve it.
for (const s of ['pay-monero', 'pay-card']) {
  ok(src[s].includes(`published only on sigelo.ai (this page, also as \`/${s}.md\`) and in \`site/${s}.md\` on the main branch of the relay repository.`)
    && !src[s].includes('and in that repository')
    && src[s].includes(`open \`${STATEMENT}\` yourself (typed, not from a link here), then, in the relay repository that page names, the file \`site/${s}.md\` on its main branch`)
    && PAYMENT_PLACES.includes(`${REPO}/blob/main/site/${s}.md`)
    && !src[s].includes(`](${REPO}`) && !src[s].includes(`](${STATEMENT}`),
  `${s}: published only on sigelo.ai (the page and its twin) and in its file on the relay repository's main branch, which the buyer reaches from sigelo.io's statement, never by a link on this page`);
  // Where the payment proof or the licence request goes is reached the same way: a link on a swapped
  // page would send the transaction id and key to whoever swapped it (A5 review).
  ok(!src[s].includes('](https://sigelo.io/contact.html)') && src[s].includes('over SimpleX, to the address on `https://sigelo.io/contact.html` opened the same way (typed)'),
    `${s}: the SimpleX address is the one on sigelo.io's contact page, typed, never a link on this page`);
}
ok(!src['pay-card'].includes('checkout.stripe.com') && src['pay-card'].includes('it begins `https://buy.stripe.com/`, and a checkout reached any other way'),
  'pay-card: the buyer starts from the buy.stripe.com link only, as linkRefusal accepts (any Stripe account can mint a checkout.stripe.com session)');
ok(src['pay-monero'].includes('price less [discount] %, plus VAT where due,') || /price less \d+ %, plus VAT where due,/.test(src['pay-monero']), 'pay-monero: the Monero price adds VAT where due (the buyer pays before the invoice exists)');

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
const inFull = indexable.filter((p) => !p.slug.startsWith('pay-'));
ok(inFull.every((p) => full.includes(`Source: ${ORIGIN}/${p.slug}.md\n\n${body[p.slug].trimEnd()}\n`)) && !full.includes('# Not found') && full.includes(`${MOTTO} ${DISCLOSURE}`),
  'llms-full.txt: every indexable page\'s twin but the pay pages\', with the motto and the disclosure');
ok(!/Pay Pro in|\[address\]|\[payment link\]|buy\.stripe\.com|\b[48][1-9A-HJ-NP-Za-km-z]{94}\b/.test(full) && full.includes(`published only at ${PAYMENT_PLACES.slice(0, -1).join(', ')} and ${PAYMENT_PLACES.at(-1)}.`),
  'llms-full.txt: no payment details, only where they are published (a third copy would make the pay pages untrue)');

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
ok(read('relay-robots.txt') === 'User-agent: *\nDisallow: /challenge\nDisallow: /check\nDisallow: /licence\n', `relay-robots.txt (${HOST}/robots.txt): the three HTTP calls are not content`);
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
const nulls = { '[storage]': index.tiers.pro.storage_bytes, '[discount]': index.tiers.pro.price?.monero_discount_percent, '[install command]': index.client.install,
  SELLER: index.official.seller, 'vendor DID': index.official.vendor_did };
const nullWrong = Object.entries(nulls).filter(([k, v]) => (v === null) !== r.open.includes(k)).map(([k]) => k);
ok(index.tiers.pro.on_sale === false && relayInfo.fees.on_sale === false && nullWrong.length === 0,
  `index.json, relay.json: a draft is not on sale, and a value is null exactly while it is open${nullWrong.length ? ` (wrong: ${nullWrong.join(', ')})` : ''}`);
ok(index.relay.a2a === false && /not post-quantum/.test(index.crypto.signatures) && index.relay.mqtt.version === '3.1.1' && index.relay.host === HOST,
  'index.json: not A2A, signatures not post-quantum, MQTT 3.1.1 at relay.sigelo.ai');
// Retention is how long a queued message waits; a reader away longer than its client claims ahead
// takes no new messages on either tier (A5 review): pro.md says so under its table, the data files too.
ok(index.relay.queue === QUEUE_NOTE && relayInfo.limits.queue === QUEUE_NOTE && /no_reader/.test(QUEUE_NOTE) && /about a week ahead on every tier/.test(QUEUE_NOTE)
  && /^\| Retention \|[^\n]*\n(?:\|[^\n]*\n)*\nNew messages to an agent away over a week are refused \(`no_reader`\)\.$/m.test(body.pro),
  'pro, index.json, relay.json: retention is how long a queued message waits; new messages to an agent away over a week are refused (no_reader), whatever the tier');
const carrier = join(ROOT, 'contact', 'carrier.mjs');
if (existsSync(carrier)) {
  const c = await load(carrier);
  if (c) ok(c.AHEAD === 7 * c.DAY, `pro, QUEUE_NOTE: "a week" is contact/carrier.mjs AHEAD, how far ahead the client claims its mailboxes (private tree; AHEAD = ${c.AHEAD / c.DAY} days)`);
}
ok(index.motto === MOTTO && index.disclosure === DISCLOSURE && same(index.pages.map((x) => x.slug), indexable.map((p) => p.slug)), 'index.json: motto and disclosure exact; pages = the indexable pages');
ok(body.pro.includes(index.tiers.pro.client_env) && index.tiers.pro.client_env === `SIGELO_RELAY_RETENTION_DAYS=${allowance?.TIERS.pro.retentionDays}`, 'index.json: tiers.pro.client_env is in pro.md, at TIERS.pro\'s retention');
const priceLine = src.pro.match(PRICE_RE);
ok(priceLine && index.tiers.pro.price.EUR_month === Number(priceLine[1]) && index.tiers.pro.price.EUR_year === Number(priceLine[2]), 'index.json: the price is pro.md\'s');
// relay_sees names what each row of privacy.md's table keeps (A14).
const SEES = { 'Log of logins': '/24 or /48 in the relay log', 'Web server errors': 'web server error line', 'Encrypted messages': 'sizes', 'Per identity': 'DID and its key rotations', "An operator's licence": 'licences (Pro)',
  Backups: 'encrypted nightly backup, each copy kept 7 days' };
const rows = [...src.privacy.matchAll(/^\| ([^|]+?) \| [^|]+ \|$/gm)].map((m) => m[1]).filter((x) => x !== 'What' && !/^-+$/.test(x));
const sees = index.crypto.relay_sees.join('\n'), missing = rows.filter((x) => !Object.entries(SEES).some(([k, v]) => x.startsWith(k) && sees.includes(v)));
ok(rows.length === Object.keys(SEES).length && missing.length === 0, `index.json: relay_sees names what each row of privacy.md's table keeps${missing.length ? ` (missing: ${missing.join('; ')})` : ''}`);
const off = index.official;
ok(same(off.payment_details_only_on, PAYMENT_PLACES) && same(off.never_asks_for, ['seed', 'identity or wallet private key', 'token'])
  && same(off.never_sends_by_email_or_chat, ['payment address', 'payment link']) && off.payment_proof_only_via === 'https://sigelo.io/contact.html'
  && NOBODY.includes('ask for a seed, an identity or wallet private key, or a token') && NOBODY.includes('send a payment address or link by e-mail or chat') && NOBODY.includes('`https://sigelo.io/contact.html`'),
  'index.json: the official "never" and proof fields say what the "Nobody…" line says');
for (const s of ['pay-monero', 'pay-card']) ok(src[s].includes(NOBODY), `${s}: carries the "Nobody from the project…" line verbatim`);
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
  if (io) ok(same(io.DOMAINS, DOMAINS) && same(io.HOSTS, HOSTS) && same(io.REPOSITORIES, REPOSITORIES),
    'official names: DOMAINS, HOSTS, REPOSITORIES are site/build.mjs\'s (sigelo.io and SECURITY.md say the same)');
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
ok(deployRefusals(DEPLOY).length === 0, `deploy gate: relay/deploy/nginx.conf passes (both logs down in every server block, /licence proxied, X-Real-IP)${deployRefusals(DEPLOY).length ? ` (${deployRefusals(DEPLOY).join('; ')})` : ''}`);
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
  ok(['location = /challenge', 'location = /check', 'location = /licence'].every((l) => rl[l]?.includes('proxy_pass http://127.0.0.1:8791') && rl[l].some((d) => d.startsWith('limit_req zone=')))
    && rl['location = /relay.json'] && rl['location = /llms.txt'] && rl['location = /robots.txt']?.includes('try_files /relay-robots.txt =404')
    && rl['location /']?.includes('return 301 https://sigelo.ai$request_uri') && rl['location = /']?.includes('try_files /index.html =404'),
  'nginx: relay.sigelo.ai proxies /challenge, /check, /licence to 127.0.0.1:8791 under a rate limit, serves the front page, relay.json, llms.txt and its robots.txt, sends the rest to sigelo.ai');
  // A browser's request to a relay call is refused before the relay charges it: the relay counts
  // logins and challenges per network before it reads a body, so any web page could otherwise spend
  // that budget from its visitors' browsers and lock every agent on their /24 or /48 out (A5 review).
  const browserGaps = (t) => serversIn(t).flatMap((s) => s.blocks.filter((b) => everyDirective(b).some((d) => d.startsWith('proxy_pass '))))
    .filter((b) => !b.blocks.some((x) => x.head === 'if ($sigelo_browser)' && x.directives.join() === 'return 403')).map((b) => b.head);
  const proxied = servers.flatMap((s) => s.blocks.filter((b) => everyDirective(b).some((d) => d.startsWith('proxy_pass '))));
  const browserMap = conf.blocks.find((b) => b.head === 'map $http_sec_fetch_site$http_origin $sigelo_browser')?.directives ?? [];
  ok(browserMap.join('|') === 'default 1|"" 0|none 0' && proxied.length === 3 && browserGaps(conf).length === 0,
    `nginx: /challenge, /check and /licence answer 403 to a request a browser makes (Sec-Fetch-Site or Origin), before it reaches the relay${browserGaps(conf).length ? ` (lacking: ${browserGaps(conf).join(', ')})` : ''}`);
  const noRefusal = nginxTree(confText.replace(/( {4}location = \/check \{\n) {8}if \(\$sigelo_browser\) \{\n {12}return 403;\n {8}\}\n/, '$1'));
  ok(noRefusal && browserGaps(noRefusal).join() === 'location = /check', 'nginx: a proxied location without the browser refusal is caught');
  const cors = conf.blocks.find((b) => b.head === 'map $uri $sigelo_cors')?.directives ?? [];
  ok(['"/index.json" "*"', '"/relay.json" "*"', '"/llms.txt" "*"'].every((x) => cors.includes(x)) && [apex, relay].every((s) => s.directives.includes('add_header Access-Control-Allow-Origin $sigelo_cors always')),
    'nginx: index.json, relay.json and llms.txt open to any origin (CORS)');
  ok(apex?.directives.includes('error_page 404 /404.html') && files.has('404.html'), 'nginx: a miss on sigelo.ai serves the not-found page');
  const al = locs(apex);
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

// ---- --final over a filled copy: what passes, and each wrong thing it refuses ------------------
// Every placeholder filled as the runbook's §0 would, at the most words each is likely to take.
let mainnet, subaddr, stagenet, typo;
if (monero) {
  const k = monero.keysFromSpend(new Uint8Array(32).fill(7));
  mainnet = monero.encodeAddress({ net: 'mainnet', kind: 'standard', spend: k.B, view: k.A });
  subaddr = monero.subaddress({ a: k.a, B: k.B, major: 0, minor: 1, net: 'mainnet' });
  stagenet = monero.encodeAddress({ net: 'stagenet', kind: 'standard', spend: k.B, view: k.A });
  typo = mainnet.slice(0, 40) + (mainnet[40] === 'a' ? 'b' : 'a') + mainnet.slice(41);
  ok(addressRefusal(mainnet) === undefined && addressRefusal(subaddr) === undefined, 'address: a mainnet address and a mainnet subaddress pass');
  ok([stagenet, typo, '8' + '2'.repeat(94), mainnet + 'x'].every((a) => addressRefusal(a)), 'address: stagenet, a one-character typo, an invented 95-character string and a long one are refused (checksum by sigelo)');
}
ok(STRIPE_RE.test('https://buy.stripe.com/aBc123dEf456') && !STRIPE_RE.test('https://buy.stripe.com/test_8wM5mV0Ed2Ks0zm6oo') && linkRefusal('https://buy.stripe.com/test_8wM5mV0Ed2Ks0zm6oo'),
  'payment link: a live-mode buy.stripe.com link passes, a test_ link is refused');
const FILL = {
  '[install command]': 'npm install -g example-a example-b', '[storage]': '500 MB', '[discount]': '15', '[rate source]': 'an example source',
  '[address]': mainnet, '[payment link]': 'https://buy.stripe.com/aBc123dEf456',
  '[company legal name, address, VAT]': 'Example Ltd, 1 Example Street, 00000 Example Town, Country, VAT EX000000000', '[law and courts]': 'Example law; the courts of Example Town',
  '[hosting region]': 'the EU',
};
const filled = (slug) => Object.entries(FILL).reduce((md, [ph, v]) => md.split(ph).join(v), src[slug]);
const scratch = mkdtempSync(join(tmpdir(), 'relay-site-'));
try {
  let k = 0;
  const vendor = sigelo ? sigelo.keygen({ recovery: 'sha256:' + '9'.repeat(64) }).did : 'did:sigelo:z' + '2'.repeat(44);
  const emptyRoot = join(scratch, 'root'); mkdirSync(emptyRoot);   // the relay's own export: no SECURITY.md, no site/
  // → the --final refusal for the filled pages with `change` applied, or null when it builds (dist in dir/dist).
  const finalWith = (change = (pages) => pages, { deploy = confText, seller = 'Example Ltd', vendorDid = vendor, root = emptyRoot, proStorage = allowance?.TIERS.pro.storage, launched = true } = {}) => {
    const dir = join(scratch, String(++k));
    mkdirSync(dir);
    const pages = change(Object.fromEntries(PAGES.map((p) => [p.slug, filled(p.slug).replace(/^> \*\*DRAFT\b.*\n\n?/m, '')])));
    for (const [slug, md] of Object.entries(pages)) writeFileSync(join(dir, `${slug}.md`), md);
    if (launched) writeFileSync(join(dir, LAUNCH_RECORD), '{}\n');   // the export's record of the launch gate (launchGate)
    writeFileSync(join(dir, 'nginx.conf'), deploy);
    try { build({ final: true, site: dir, out: join(dir, 'dist'), deploy: join(dir, 'nginx.conf'), root, seller, vendor: vendorDid, proStorage }); return null; } catch (e) { return e.message; }
  };
  if (monero) {
    const why = finalWith();
    ok(why === null, `--final: a filled copy builds${why ? ` (${why})` : ''}`);
    if (why === null) {
      const d = join(scratch, String(k), 'dist'), fIndex = JSON.parse(readFileSync(join(d, 'index.json'), 'utf8'));
      const g = JSON.parse(readFileSync(join(d, 'index.html'), 'utf8').match(SCRIPT)[1])['@graph'], service = g.find((x) => x['@type'] === 'Service');
      const offers = service.offers.filter((o) => o.name.startsWith('Pro'));
      ok(service.provider?.['@type'] === 'Organization' && service.provider.name === 'Example Ltd' && service.termsOfService === `${ORIGIN}/terms.html`
        && offers.map((o) => `${o.priceSpecification.price}/${o.priceSpecification.billingDuration}`).join() === `${priceLine[1]}/P1M,${priceLine[2]}/P1Y`,
      '--final: the JSON-LD names the seller as provider (an Organization), the terms, and the two Pro offers at pro.md\'s prices');
      ok(fIndex.tiers.pro.on_sale === true && fIndex.tiers.pro.storage_bytes === 500 * 1024 * 1024 && fIndex.tiers.pro.price.monero_discount_percent === 15
        && fIndex.client.install === FILL['[install command]'] && fIndex.official.seller === 'Example Ltd' && fIndex.official.vendor_did === vendor,
      '--final: index.json on sale, with the storage, discount, install line, seller and vendor DID filled');
      ok(readFileSync(join(d, 'pro.html'), 'utf8').includes('Seller and provider: Example Ltd.'), '--final: the footer names the seller');
      // The pay pages say where their details are published: no other file of the build carries them.
      const filesIn = (dir, at = dir) => readdirSync(at, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesIn(dir, join(at, e.name)) : [relative(dir, join(at, e.name))]));
      const holders = (needle) => filesIn(d).filter((f) => readFileSync(join(d, f), 'utf8').includes(needle)).sort().join();
      ok(holders(mainnet) === 'pay-monero.html,pay-monero.md' && holders(FILL['[payment link]']) === 'pay-card.html,pay-card.md',
        `--final: the address and the payment link are only on their pay page and its twin, as the pages say (address: ${holders(mainnet)}; link: ${holders(FILL['[payment link]'])})`);
    }
    const set = (slug, from, to) => (pages) => ({ ...pages, [slug]: pages[slug].split(from).join(to) });
    ok(/pay-card: the checkout link is not a live-mode/.test(finalWith(set('pay-card', FILL['[payment link]'], 'https://buy.stripe.com/test_8wM5mV0Ed2Ks0zm6oo')) ?? ''),
      '--final: refuses a Stripe test-mode link');
    for (const [name, a] of [['stagenet', stagenet], ['mistyped', typo], ['invented', '8' + '2'.repeat(94)]]) {
      ok(/pay-monero: the address is/.test(finalWith(set('pay-monero', mainnet, a)) ?? ''), `--final: refuses a ${name} address`);
    }
    ok(/SELLER "Other GmbH" is not the seller privacy\.md and terms\.md name/.test(finalWith(undefined, { seller: 'Other GmbH' }) ?? ''), '--final: refuses a SELLER the pages do not name');
    ok(/SELLER/.test(finalWith(undefined, { seller: null }) ?? '') && /vendor DID/.test(finalWith(undefined, { vendorDid: (await import('../licence.ts')).DEV_VENDOR_DID }) ?? ''),
      '--final: refuses while SELLER is unset, or the relay pins the placeholder vendor DID');
    ok(/Price: N €\/month/.test(finalWith(set('pro', 'excluding VAT', 'VAT excluded')) ?? ''), '--final: refuses a pro.md whose price line it cannot read');
    ok(/server block \d+ \(sigelo\.ai\) lacks "access_log off;"/.test(finalWith(undefined, { deploy: confText.replace(/(server_name sigelo\.ai;\n[\s\S]*?) {4}access_log off;\n/, '$1') }) ?? ''),
      '--final: refuses while a server block keeps nginx\'s default access log, naming the block');
    ok(/lacks "error_log <file> crit;"/.test(finalWith(undefined, { deploy: confText.replace(/(server_name relay\.sigelo\.ai;\n[\s\S]*?) {4}error_log \S+ crit;\n/, '$1') }) ?? ''),
      '--final: refuses while a server block logs refusals at "error"');
    ok(/location = \/licence/.test(finalWith(undefined, { deploy: confText.replace(/ {4}location = \/licence \{\n[\s\S]*?\n {4}\}\n/, '') }) ?? ''), '--final: refuses while nginx does not proxy /licence');
    ok(/X-Real-IP/.test(finalWith(undefined, { deploy: confText.replace(/ {4}proxy_set_header X-Real-IP \$remote_addr;\n/, '') }) ?? ''), '--final: refuses a relay proxy without X-Real-IP');
    ok(/launch: no site\/launch\.json/.test(finalWith(undefined, { launched: false }) ?? ''),
      '--final: in the relay export (no SECURITY.md above it) refuses without the launch record the private tree\'s --launch wrote');
    if (allowance) {
      const { MB } = allowance, big = set('pro', '| 500 MB |', '| 2 GB |');
      ok(new RegExp(`the storage cell says 2 GB, more than the relay grants a Pro pool \\(${allowance.TIERS.pro.storage / MB} MB`).test(finalWith(big) ?? '') && finalWith(big, { proStorage: 2048 * MB }) === null,
        '--final: refuses a Pro storage cell above what the relay grants (TIERS.pro.storage, or RELAY_PRO_STORAGE_MB where the site is built), and builds once that allows it');
      ok(proStorageCap(undefined) === allowance.TIERS.pro.storage && proStorageCap('') === allowance.TIERS.pro.storage && proStorageCap('2048') === 2048 * MB
        && ['0', '1e3', '-5', '10000001', ' 5'].every((v) => proStorageCap(v) === null), 'RELAY_PRO_STORAGE_MB: read as the relay reads it (a whole number of MB, 1 to 10,000,000), else TIERS.pro.storage');
    }
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
  const tree = (security, io) => {
    const root = join(scratch, `root-${++k}`);
    mkdirSync(join(root, 'site', 'deploy'), { recursive: true });
    if (security !== null) writeFileSync(join(root, 'SECURITY.md'), security);
    if (io !== null) writeFileSync(join(root, 'site', 'deploy', 'nginx.conf'), io);
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
    ok(said(why, /SECURITY\.md: not found/) && said(why, /site\/deploy\/nginx\.conf: not found/), 'launch gate: in the private tree (site/build.mjs beside relay/), a missing SECURITY.md or sigelo.io nginx.conf is refused, not skipped');
  }
  // The relay export cannot run the launch gate (no SECURITY.md above it): there --final takes the
  // record the private tree's `--launch` wrote; in the private tree that record may exist only while
  // the gate passes. `--launch` writes it, so it is run here only where it refuses (writes nothing).
  const noRecord = join(scratch, `site-${++k}`), withRecord = join(scratch, `site-${++k}`);
  mkdirSync(noRecord); mkdirSync(withRecord); writeFileSync(join(withRecord, LAUNCH_RECORD), '{}\n');
  ok(said(launchGate(emptyRoot, noRecord), /launch: no site\/launch\.json/) && launchGate(emptyRoot, withRecord).length === 0,
    'launch gate, outside the private tree: refused without the launch record, passed with it');
  if (isPrivateTree()) {
    const now = launchRefusals(), record = existsSync(join(SITE, LAUNCH_RECORD));
    ok(!record || now.length === 0, `launch gate: relay/site/${LAUNCH_RECORD} ${record ? 'exists, and the private tree still says what index.json says' : 'absent (not launched)'}${record && now.length ? ` (but: ${now.join('; ')})` : ''}`);
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

  // terms.md is replaced by the lawyer's version, so its budget is the lawyer's to keep.
  for (const p of PAGES.filter((x) => x.slug !== 'terms')) {
    const n = words(fill(filled(p.slug), p.slug));
    ok(n <= budget(p.slug), `budget, filled: ${p.slug}.md ${n} words ≤ ${budget(p.slug)} with every placeholder and {{value}} filled`);
  }
} finally { rmSync(scratch, { recursive: true, force: true }); }

// ---- what the pages promise: the relay's numbers and fields --------------------------------------
// Every contact verb loads the identity and refuses without one, and init refuses without a
// recovery decision: the start sequence begins with it (A5 review).
ok(/^```sh\n\[install command\]\nsigelo-agent init --recovery <z…>\nsigelo-agent invite\nsigelo-agent accept <code>\nsigelo-agent send <contact> <message>\n```$/m.test(src.index)
  && src.index.includes('Login by [sigelo identity](https://sigelo.io/adopt.html#1-identity)') && /\[Details\]\(\/pro\.html\)/.test(src.index)
  && index.client.commands.join('\n').startsWith('sigelo-agent init --recovery <z…>\nsigelo-agent invite\nsigelo-agent accept <code>\nsigelo-agent send <contact> <message>'),
  'index: install, make the identity (its recovery key linked), then the three commands, as index.json lists them; and how to buy Pro');
ok(src.index.includes(`New (v${PKG.version.split('.').slice(0, 2).join('.')}), unaudited.`) && src.index.includes('MQTT 3.1.1 over TLS. Not A2A: both agents dial out to the relay.'),
  'index: one status line, the version as relay/package.json, unaudited; MQTT 3.1.1; not A2A');
if (allowance && mailbox && operator && db) {
  const { free, pro } = allowance.TIERS, { MB, KB } = allowance, DAY = db.DAY;
  const size = (b) => (b % MB === 0 ? `${b / MB} MB` : `${b / KB} KB`);
  const row = (label) => body.pro.match(new RegExp(`^\\| ${label} \\| ([^|]+) \\| ([^|]+) \\|$`, 'm'))?.slice(1).map((c) => c.trim()) ?? [];
  const table = {
    'Messages/day': [thou(free.msgsDay), thou(pro.msgsDay)], Retention: [`${free.retentionDays} days`, `${pro.retentionDays} days`],
    'Largest message': [size(free.maxMessage), size(pro.maxMessage)],
    // A contact costs its reader a mailbox per week of its retention window plus the week ahead its
    // client claims: a bare mailbox count read as contacts (A5 review).
    Contacts: [free, pro].map((t) => `~${thou(Math.floor(t.mailboxes / (allowance.windowWeeks(t.retentionDays) + 1)))}`),
  };
  const offRows = Object.entries(table).filter(([label, want]) => row(label).join() !== want.join()).map(([label]) => label);
  const storage = row('Storage queued');
  if (storage[0] !== size(free.storage) || !/^(?:\[storage\]|[1-9]\d* [MG]B)$/.test(storage[1] ?? '')) offRows.push('Storage queued');
  ok(offRows.length === 0, `pro: the Free/Pro table is relay/allowance.mjs TIERS${offRows.length ? ` (differs: ${offRows.join(', ')})` : ''}`);
  ok(allowance.windowWeeks(7) + 1 === 3 && allowance.windowWeeks(90) + 1 === 15 && !/^\| Mailboxes \|/m.test(body.pro),
    `pro: a row of contacts, not mailboxes; a contact costs 3 mailboxes at 7 days and 15 at 90, as relay/allowance.mjs says (now ${row('Contacts').join(' and ')})`);
  ok(body.index.includes(`**Free:** one agent, ${thou(free.msgsDay)} messages a day, kept ${free.retentionDays} days.`), 'index: the free line is TIERS.free');
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
  const step5 = body.pro.match(/^5\. .*$/m)?.[0] ?? '';
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
  const steps = Object.fromEntries([...body.pro.matchAll(/^(\d)\. (.*)$/gm)].map((m) => [m[1], m[2]]));
  // The relay pools only attestations whose iss is the operator's current key (operator.mjs): after a
  // rotation every agent's attestation must be signed again, or the pool drops to free (A5 review).
  ok(steps[2] === 'Log in with it (`sigelo-agent inbox`); again after each rotation, then redo step 5.' && /^Pay by .*; renew likewise\.$/.test(steps[3] ?? '') && /^Upload /.test(steps[4] ?? ''),
    'pro: log in with the operator identity (step 2), and after each rotation again and sign the agents\' attestations anew (step 5), before paying (3, renewal the same) and uploading (4)');
  ok(/prints the operator DID \(later: the first of its `chain`\)/.test(body.pro), 'pro step 1: a licence names the operator\'s original DID, the first of its chain');
  for (const s of ['pay-monero', 'pay-card']) ok(src[s].includes('First log in once with your operator identity ([Pro](/pro.html) step 2)'), `${s}: log in with the operator identity before paying`);
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
}
const erasure = src.privacy.slice(src.privacy.indexOf('## Erasure'));
ok(['**recovery key**', 'import { sign } from "sigelo"', 'ctx:"sigelo.ai/erase"', 'ctx:"sigelo.ai/access"', 'bindings:[],attestations:[],issuers:[]', 'Without asking: stop using the identity'].every((s) => erasure.includes(s))
  && !/sign-challenge/.test(erasure), 'privacy: erasure by disuse, or by a recovery-key request (never an identity-key challenge, which any world can obtain)');
ok(['/24', '/48', '7 days', 'Never logged:', 'Seller and provider of the relay', 'keeps no access log', 'rarely, one holds a full address and the request, which may name a DID', 'DIDs only in such an error line', 'only in memory, while connected'].every((s) => src.privacy.includes(s)),
  'privacy: /24 or /48 for 7 days, full addresses in memory only but in a rare error line, which may also name a DID (the request line), no access log, the never-list, the seller');
ok(['No custody', 'No payment routing', 'No access to content', 'The attestation is the subscription', 'does not sell to consumers'].every((s) => src.terms.includes(s)),
  'terms: B2B, no custody, no payment routing, no access to content, the attestation is the subscription');
// The pay page asks every Monero buyer for a transaction key: the no-custody clause says what it is.
// A refund turns on the §9 warranty, with a time to fix it, as commercial/LICENCE-TERMS-draft.md §9 (A5 review).
ok(src.terms.includes('never receives or holds a seed, private key or other means of access') && src.terms.includes('(transaction keys only prove payments)')
  && src.terms.includes("No refund after issuance, unless §9's warranty fails and is not fixed within 14 days;") && src['pay-monero'].includes('transaction key'),
  'terms: no custody, though a Monero buyer sends a transaction key (it only proves a payment); a refund when §9\'s warranty fails and is not fixed within 14 days');
// The nightly backup (deploy/backup.sh: licences and licensed operators' rows, 7 archives kept) is a
// copy the table names; an identity without a recovery key is erased by disuse only (A5 review).
const backupSh = readFileSync(join(RELAY, 'deploy', 'backup.sh'), 'utf8');
ok(src.privacy.includes("| Backups: licences and licensed operators' rows, encrypted | 7 days more |") && /\| tail -n \+8 \| xargs -r rm -f/.test(backupSh)
  && /^TABLES="licences operator_retired vendor_chain accounts chain_dids"$/m.test(backupSh),
  'privacy: the encrypted backup of licences and licensed operators\' rows, 7 days more, as deploy/backup.sh keeps them (7 archives)');
ok(erasure.includes('Sooner, or to see the data, if the identity has a **recovery key**: sign a request offline with it'), 'privacy: a request takes the recovery key; without one, disuse is the only way');
// Where the servers are is the Owner's to confirm (runbook §0 item 6): a placeholder until then, so
// --final refuses; no other line of the page says it.
ok(!src.privacy.includes('[hosting region]') || (src.privacy.includes('Servers in [hosting region].') && r.open.includes('[hosting region]')) ,
  'privacy: the servers\' region is a placeholder --final refuses until the Owner confirms it');
ok(!/\bEU hosting provider\b/.test(src.privacy) && src.privacy.split('[hosting region]').length <= 2, 'privacy: the region is stated once, in the seller line');
ok(/your operator DID holds Pro, and your agents pool once they carry its attestation \(\[Pro\]\(\/pro\.html\) step 5\)/.test(src['pay-card']),
  'pay-card: Pro reaches the agents only through their operator attestation');
ok(!/name the seller|names the seller/.test(src['pay-card']) && /proves nothing/.test(src['pay-card']), 'pay-card: the name a checkout shows is not offered as proof');
for (const s of ['pay-monero', 'pay-card']) {
  ok(/^For businesses\./m.test(src[s]) && src[s].includes('accepting the [terms](/terms.html)'), `${s}: businesses only, and the terms`);
  ok(src[s].includes(`file \`site/${s}.md\``) && existsSync(join(RELAY, 'site', `${s}.md`)), `${s}: names the copy in the relay's public repository to compare against (site/${s}.md)`);
}
const XMR = /\b[48][1-9A-HJ-NP-Za-km-z]{94}\b/;
ok(PAGES.every((p) => p.slug === 'pay-monero' || !XMR.test(src[p.slug])), 'a Monero address appears on pay-monero only');
ok(PAGES.every((p) => p.slug === 'pay-card' || !/stripe\.com/.test(src[p.slug])), 'a Stripe link appears on pay-card only');
// Whoever holds an access request gets the data: SimpleX only (an erasure may come by e-mail).
ok(erasure.includes('`ctx:"sigelo.ai/access"` asks for the data instead, over SimpleX only: whoever holds that file gets the data.'),
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
