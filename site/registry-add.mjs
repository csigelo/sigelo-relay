#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// relay/site/registry-add.mjs — lists a relay in the registry (ROADMAP §9 item 4). A maintainer tool:
// it fetches https://<host>/.well-known/sigelo-relay.json (the relay's own statement, registry.mjs:
// signed by its relay identity, naming exactly this host), checks it, computes the host's tag and
// appends {host, did, tier?, note?, added} to relays.src.json. First host for a tag keeps it: a
// collision is refused, and the newcomer picks another host name. Then sign-relays.mjs.
//
//   node relay/site/registry-add.mjs <host> [--tier <t>] [--note <text>] [--from <url>]
//
// --from: fetch the statement there instead (a test's loopback server; http:// only to loopback).
// Listing is free and optional; a relay's codes work unlisted for whoever knows the relay.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'sigelo';
import { WELL_KNOWN, addEntry, checkHostStatement, isHost } from './registry.mjs';

const SITE = dirname(fileURLToPath(import.meta.url));
const die = (m, code = 1) => { console.error(`registry-add.mjs: ${m}`); process.exit(code); };
const args = process.argv.slice(2), flags = {};
for (const f of ['--tier', '--note', '--from']) { const i = args.indexOf(f); if (i !== -1) [, flags[f]] = args.splice(i, 2); }
if (args.length !== 1 || !isHost(args[0])) die('usage: registry-add.mjs <host[:port]> [--tier <t>] [--note <text>] [--from <url>]', 2);
const host = args[0], src = process.env.SIGELO_RELAYS_SRC ?? join(SITE, 'relays.src.json');
if ((flags['--tier'] ?? '').length > 32 || (flags['--note'] ?? '').length > 200) die('--tier: at most 32 characters; --note: at most 200');
const url = flags['--from'] ?? `https://${host}${WELL_KNOWN}`;
const u = new URL(url);
if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname))) die(`${url}: https:// only (http:// to loopback)`);
let res;
try { res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15000) }); } catch (e) { die(`${url}: ${e.cause?.code ?? e.message}`); }
if (res.status !== 200) die(`${url}: answered ${res.status}`);
const text = await res.text();
if (text.length > 65536) die(`${url}: over 64 KiB`);
const now = Math.floor(Date.now() / 1000);
let statement, relays;
try { statement = checkHostStatement(parse(text), host, now); } catch (e) { die(`${url}: ${e.message}`); }
try { relays = JSON.parse(readFileSync(src, 'utf8')).relays; } catch (e) { die(`${src}: ${e.message}`); }
const entry = { host, did: statement.did, ...(flags['--tier'] && { tier: flags['--tier'] }), ...(flags['--note'] && { note: flags['--note'] }), added: new Date(now * 1000).toISOString().slice(0, 10) };
try { relays = addEntry(relays, entry); } catch (e) { die(e.message); }
writeFileSync(src, JSON.stringify({ relays }, null, 2) + '\n');
console.log(`${host}: listed under ${statement.tag} (${statement.did}); now sign: node relay/site/sign-relays.mjs <release identity file>`);
