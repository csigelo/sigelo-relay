#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// relay/host-statement.mjs — writes the relay's /.well-known/sigelo-relay.json (ROADMAP §9 item 4):
// a bundle of the relay's identity (its operator's identity file, sigelo-agent's format) with one
// self-issued attestation, ctx "sigelo-relay/host", claims {host}, valid --days (at most 366). Serve
// it on the relay's host (deploy/README.md "Registry"); relay/site/registry-add.mjs checks it.
//
//   node relay/host-statement.mjs <identity file> <host[:port]> [--days <n>] > sigelo-relay.json
import { readFileSync } from 'node:fs';
import { parse } from 'sigelo';
import { HOST_CTX, HOST_DAYS, checkHostStatement, isHost, relayTag, signSelf } from './site/registry.mjs';

const die = (m, code = 1) => { console.error(`host-statement.mjs: ${m}`); process.exit(code); };
const args = process.argv.slice(2);
const at = args.indexOf('--days'), days = at === -1 ? HOST_DAYS : Number(args.splice(at, 2)[1]);
if (args.length !== 2 || !isHost(args[1]) || !Number.isSafeInteger(days) || days < 1 || days > HOST_DAYS) die(`usage: host-statement.mjs <identity file> <host[:port]> [--days 1..${HOST_DAYS}]`, 2);
let store;
try { store = parse(readFileSync(args[0], 'utf8')); } catch (e) { die(`${args[0]}: ${e.message}`); }
const iat = Math.floor(Date.now() / 1000);
const bundle = signSelf(store, { ctx: HOST_CTX, claims: { host: args[1] }, iat, exp: iat + days * 86400 });
const { did } = checkHostStatement(bundle, args[1], iat);
process.stdout.write(JSON.stringify(bundle, null, 2) + '\n');
console.error(`${args[1]} (tag ${relayTag(args[1])}): signed by ${did}, valid ${days} days`);
