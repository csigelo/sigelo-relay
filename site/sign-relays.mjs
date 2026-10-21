#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// relay/site/sign-relays.mjs — signs the relay registry (ROADMAP §9 item 4): relays.src.json →
// relays.json, a bundle of the RELEASE identity (registry.mjs), as release/sign-release.sh signs
// release.json. The maintainer runs it after registry-add.mjs, then commits both files.
//
//   node relay/site/sign-relays.mjs <release identity file> [--days <n>]   (default 366)
//
// The identity file is sigelo-agent's format and must be the pinned release identity (or a
// rotation of it): release/release-identity.json, SIGELO_RELEASE_GENESIS overrides. Never the
// maintainer's own identity; never a key in this tree.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { did, parse } from 'sigelo';
import { REGISTRY_CTX, REGISTRY_DAYS, checkEntries, checkRegistry, signSelf } from './registry.mjs';

const SITE = dirname(fileURLToPath(import.meta.url));
const die = (m) => { console.error(`sign-relays.mjs: ${m}`); process.exit(1); };
const args = process.argv.slice(2);
const at = args.indexOf('--days'), days = at === -1 ? REGISTRY_DAYS : Number(args.splice(at, 2)[1]);
if (args.length !== 1 || !Number.isSafeInteger(days) || days < 1 || days > REGISTRY_DAYS) die(`usage: sign-relays.mjs <release identity file> [--days 1..${REGISTRY_DAYS}]`);
const src = process.env.SIGELO_RELAYS_SRC ?? join(SITE, 'relays.src.json'), out = process.env.SIGELO_RELAYS_OUT ?? join(SITE, 'relays.json');
const pinPath = process.env.SIGELO_RELEASE_GENESIS ?? join(SITE, '..', '..', 'release', 'release-identity.json');
let store, pin, relays;
try { store = parse(readFileSync(args[0], 'utf8')); } catch (e) { die(`${args[0]}: ${e.message}`); }
try { pin = did(parse(readFileSync(pinPath, 'utf8'))); } catch (e) { die(`${pinPath}: ${e.message} (SIGELO_RELEASE_GENESIS names the pinned genesis)`); }
if (did(store.genesis) !== pin) die(`${args[0]} is ${did(store.genesis)}, not the pinned release identity ${pin}`);
try { relays = JSON.parse(readFileSync(src, 'utf8')).relays; checkEntries(relays); } catch (e) { die(`${src}: ${e.message}`); }
const iat = Math.floor(Date.now() / 1000);
const bundle = signSelf(store, { ctx: REGISTRY_CTX, claims: { relays }, iat, exp: iat + days * 86400 });
const r = checkRegistry(bundle, iat, pin);
writeFileSync(out, JSON.stringify(bundle, null, 2) + '\n');
console.log(`relays.json: ${Object.keys(r.relays).length} relays, signed by ${r.did}, valid ${days} days`);
