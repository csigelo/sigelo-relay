// SPDX-License-Identifier: AGPL-3.0-only
// relay/home.mjs — home-relay groups, sigelo-home/0 (the wire: sigelo's apps/contact/GROUPS.md;
// relay/deploy/README.md "The protocol in one screen", step 8). The group's members' apps log in
// here as they log in at a contact's relay; relays never talk to each other.
//
//   g/<32 hex>     a group's log: one numbered row per entry (seq 1, 2, 3…, never reused). Written by
//                  holders of the epoch's write key (the credential the relay checks), read by the
//                  sessions that opened it. Rows are not deleted on read: they go at the owner's
//                  retention, or with the group. Delivered as lane (1 byte: 0 log, 1 door) ‖ seq
//                  (8 bytes, big-endian) ‖ the bytes stored, QoS 0.
//   d/<32 hex>     a link's door: anyone logged in may publish one request (kind 0x04) while the
//                  link lives; it is stored as a lane 1 row of the group's log and delivered only to
//                  sessions that opened the group as admin.
//   $sigelo/home   control requests, JSON, never delivered: create, epoch, open, close, forget, door,
//                  undoor, handover, name, moved, end, drop. The answer {code: "home", typ, topic,
//                  id, …} or the refusal {code, detail, id} comes on $sigelo/notice before the PUBACK.
//   GET /group/<name>, GET /groups   a supergroup's name card; the listed public ones.
//
// The relay reads bytes 0-71 of an entry (version, kind, flags, keep slot, epoch, credential
// signature) and nothing after them: it never decrypts. It sees headers, sizes, counts and timing
// (deploy/README.md "What a home relay sees").
//
// At rest (db.mjs's rules): times by the UTC day (a door's end by the hour: the link's own); no DID;
// no writer with a row; the accounts that opened a group (its wake list) sealed under the push key
// file's key, the topic as additional data, so a copy of the database alone names no member. What
// changes often and names nobody new (a group's day of use, a wake list) is kept in memory and
// written by the sweep each minute.
//
// Wakes (push.mjs): a row stored wakes the phone of each account on the
// group's wake list that has no session with the group open here (a door row: admins only; never the
// writer's), with push.mjs's one wake until it logs in again. Only an open of the current epoch puts an
// account on the list: a kicked member, forgotten by an admin, does not come back by opening an old one.
import { createCipheriv, createDecipheriv, createHash, createPublicKey, hkdfSync, randomBytes, verify as edVerify } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { attest, canonicalize, did as didOf, parseBytes, verify, verifySig } from 'sigelo';
import { DAY, accountOf, dayOf } from './db.mjs';
// allowance.mjs is read inside functions only (TIERS, chargeOf): it imports auth.mjs, which imports
// mailbox.mjs, which imports this module, so nothing of it is read while the modules load.
import { TIERS, chargeOf } from './allowance.mjs';
import { checkVendorAttestation } from './licence.ts';

const KB = 1024, MB = 1024 * KB;
export const HOME_V = 'sigelo-home/0', HOME_TOPIC = '$sigelo/home', GROUP2_V = 'sigelo-group/2';
export const GROUP = /^g\/[0-9a-f]{32}$/, DOOR = /^d\/[0-9a-f]{32}$/;
// The entry (apps/contact/home-wire.mjs, GROUPS.md "The entry"): bytes 0-71 are the relay's.
export const VERSION = 0x02, KIND_ENTRY = 0x03, KIND_DOOR = 0x04;
export const FLAG = Object.freeze({ admin: 1, keep: 2, letters: 4 });
export const HEAD = 72, BODY = 148, TAG = 16, BLOCK = 256;
export const MIN_ENTRY = BODY + BLOCK + TAG, MAX_ENTRY = 1024 * KB;
// A door request: 0x02 0x04 ‖ link id (8) ‖ X-Wing ciphertext (1,120) ‖ nonce (24) ‖ sealed padded body.
export const DOOR_HEAD = 2 + 8 + 1120, MIN_DOOR = DOOR_HEAD + 24 + BLOCK + TAG, MAX_DOOR = 16 * KB;
export const MAX_CONTROL = 16 * KB;
// Keep slots in use: 1-8 the state parts, 9 the avatar (home-wire.mjs KEEP_STATE, KEEP_AVATAR).
export const KEEP_SLOTS = 9;
// Rows one read sends a session catching up (mailbox.mjs QUEUE_PAGE).
export const PAGE = 1024;
// Groups one session holds open (one subscribe token each).
export const OPEN_MAX = 64;
// A renewal registered and not yet switched lapses after PENDING_SECONDS; at most one switch per
// SWITCH_GAP seconds and SWITCHES_DAY a UTC day per group.
export const PENDING_SECONDS = 600, SWITCH_GAP = 10, SWITCHES_DAY = 200;
// Doors (links) live at once per group; GRP codes parked per group; a link's life.
export const DOORS_MAX = 16, CODES_MAX = 16, LINK_MIN = 3600, LINK_MAX = 366 * DAY, LINK_CAP_MAX = 500, SKEW = 300;
// Keep slots: at most KEEP_BYTES a group, or KEEP_PER_MEMBER a member of its cap when that is more.
export const KEEP_BYTES = 4 * MB, KEEP_PER_MEMBER = 3 * KB;
// In channel mode an entry under the member credential is at most CHANNEL_ENTRY (a reaction, a
// vote, a new gkey); members drop a non-admin post anyway.
export const CHANNEL_ENTRY = 4 * KB;
// Entries a second per group: free owners, paid owners and supergroups. Three token buckets of these numbers a group:
// entries under the member credential, entries under the admin credential, and door requests (a joiner's), so neither a
// member who writes as fast as the bucket fills nor a flood of door requests holds back an admin's kick, renewal or add.
export const ENTRY_RATE = Object.freeze({ free: Object.freeze({ perSecond: 2, burst: 20 }), paid: Object.freeze({ perSecond: 20, burst: 200 }) });
// A group nobody opened or wrote for IDLE, past its retention, goes; an account leaves a wake list
// WAKE_KEEP after its last open; a name is kept NAME_GRACE past its slot for renewal.
export const IDLE = 30 * DAY, WAKE_KEEP = 30 * DAY, NAME_GRACE = 90 * DAY;
// The supergroup slot (GROUPS.md "Supergroups"): a SPEC §5 attestation by the relay operator.
export const SLOT_CTX = 'sigelo-relay/group-name', SLOT_DAYS = 366, SLOT_MEMBERS_MAX = 10000, NAME = /^[a-z0-9-]{3,32}$/, LISTED_PAGE = 100;
// Rows the sweep deletes at once (db.mjs DELETE_BATCH).
const BATCH = 512;
const TYPS = ['create', 'epoch', 'open', 'close', 'forget', 'door', 'undoor', 'handover', 'name', 'moved', 'end', 'drop'];
const CLOSED = { moved: 1, end: 2 }, CLOSED_NAME = ['', 'moved', 'end'];

const SCHEMA = `
-- WITHOUT ROWID: a rowid would number rows in the order they were written (db.mjs's header).
CREATE TABLE IF NOT EXISTS homes (
  topic      TEXT PRIMARY KEY,           -- g/<32 hex>
  owner      TEXT NOT NULL,              -- the payer: hex SHA-256 of the owner's original DID (accountOf)
  pool       TEXT,                       -- the owner's operator pool at its last row; NULL = its own allowance
  created    INTEGER NOT NULL,           -- start of a UTC day
  last_used  INTEGER NOT NULL,           -- last open or row, a day (written by the sweep)
  epoch      INTEGER NOT NULL,           -- the current epoch
  pending    BLOB,                       -- JCS {epoch, write, admin, parts, got, members, channel} of a renewal not yet switched
  seq        INTEGER NOT NULL DEFAULT 0, -- the last seq given (lanes 0 and 1 share it)
  channel    INTEGER NOT NULL DEFAULT 0,
  cap        INTEGER NOT NULL,           -- members a renewal may name: the owner's tier or the slot's at create or the last switch, or that switch's members when more (a Pro that ended)
  bytes      INTEGER NOT NULL DEFAULT 0, -- the rows' charge (allowance.mjs chargeOf), counted against the owner
  keep_bytes INTEGER NOT NULL DEFAULT 0, -- the kept rows' bytes
  closed     INTEGER NOT NULL DEFAULT 0, -- 1 moved, 2 ended: the log takes no more rows
  handed     INTEGER NOT NULL DEFAULT 0, -- 1 + the at (a seq) of the last handover taken: an op with a lower at is a replay
  wake       BLOB                        -- sealed [[account, admin, day]]: who opened it (the header)
) STRICT, WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS homes_owner ON homes (owner);
CREATE INDEX IF NOT EXISTS homes_pool ON homes (pool) WHERE pool IS NOT NULL;
CREATE TABLE IF NOT EXISTS home_epochs (
  topic  TEXT NOT NULL REFERENCES homes (topic) ON DELETE CASCADE,
  epoch  INTEGER NOT NULL,
  write  BLOB NOT NULL,                  -- Ed25519 public key, 32 bytes: the member credential
  admin  BLOB NOT NULL,                  -- the admin credential
  first  INTEGER NOT NULL,               -- first seq of the epoch
  last   INTEGER,                        -- last seq readable under it; NULL while current
  PRIMARY KEY (topic, epoch)
) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS home_rows (
  topic   TEXT NOT NULL REFERENCES homes (topic) ON DELETE CASCADE,
  seq     INTEGER NOT NULL,
  lane    INTEGER NOT NULL,              -- 0 log, 1 door
  slot    INTEGER NOT NULL DEFAULT 0,    -- keep slot (1-9): a newer row of the slot replaces it; 0 = not kept
  payload BLOB NOT NULL,                 -- the entry or door request as received
  bytes   INTEGER NOT NULL,
  expires INTEGER,                       -- start of a UTC day; NULL for a kept row
  PRIMARY KEY (topic, seq)
) STRICT, WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS home_rows_expires ON home_rows (expires) WHERE expires IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS home_rows_slot ON home_rows (topic, slot) WHERE slot > 0;
CREATE TABLE IF NOT EXISTS home_doors (
  door    TEXT PRIMARY KEY,              -- d/<32 hex>
  topic   TEXT NOT NULL REFERENCES homes (topic) ON DELETE CASCADE,
  exp     INTEGER NOT NULL,              -- the link's end, rounded up to the hour
  cap     INTEGER NOT NULL,              -- requests a UTC day
  day     INTEGER NOT NULL DEFAULT 0,    -- the UTC day n counts
  n       INTEGER NOT NULL DEFAULT 0
) STRICT, WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS home_doors_topic ON home_doors (topic);
CREATE TABLE IF NOT EXISTS home_codes (
  code_hash TEXT PRIMARY KEY,            -- hex SHA-256("sigelo-group/2 code" ‖ the GRP code)
  door      TEXT NOT NULL REFERENCES home_doors (door) ON DELETE CASCADE,
  invite    TEXT NOT NULL,               -- the long invite (base64url of its JCS): public to whoever holds the code
  exp       INTEGER NOT NULL             -- the invite's exp, at most its door's
) STRICT, WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS home_codes_door ON home_codes (door);
CREATE TABLE IF NOT EXISTS home_names (
  name      TEXT PRIMARY KEY,            -- the supergroup's name here, [a-z0-9-]{3,32}
  owner     TEXT NOT NULL,               -- the slot's holder (account): the name is theirs while the slot runs
  topic     TEXT UNIQUE,                 -- the group it points at now; NULL between groups
  slot      BLOB NOT NULL,               -- JCS {attestation, issuer, rotations}: the operator's slot, as loaded
  card      BLOB,                        -- JCS {card, chain}: the owner's signed card and chain; NULL until named
  slot_exp  INTEGER NOT NULL,            -- the slot attestation's exp
  members   INTEGER NOT NULL,            -- the slot's claims
  storage   INTEGER NOT NULL,            -- bytes, added to the owner's
  retention INTEGER NOT NULL,            -- seconds
  listed    INTEGER NOT NULL DEFAULT 0
) STRICT, WITHOUT ROWID;
`;
// The charge and the kept bytes of each group, kept by triggers as queue_totals is (allowance.mjs):
// every way a row goes counts (expired, replaced in its slot, the group dropped).
const TRIGGERS = `
CREATE TRIGGER IF NOT EXISTS home_rows_in AFTER INSERT ON home_rows BEGIN
  UPDATE homes SET bytes = bytes + max(new.bytes, 256) + 384, keep_bytes = keep_bytes + CASE WHEN new.slot > 0 THEN new.bytes ELSE 0 END WHERE topic = new.topic;
END;
CREATE TRIGGER IF NOT EXISTS home_rows_out AFTER DELETE ON home_rows BEGIN
  UPDATE homes SET bytes = bytes - max(old.bytes, 256) - 384, keep_bytes = keep_bytes - CASE WHEN old.slot > 0 THEN old.bytes ELSE 0 END WHERE topic = old.topic;
END;
`;
const TABLES = ['homes', 'home_epochs', 'home_rows', 'home_doors', 'home_codes', 'home_names'];
// Rebuilt in key order by the sweep (db.mjs keepSorted): a group's rows are in its own seq order,
// which every member sees anyway; the other tables would keep the order groups were made in.
const SORTED = ['homes', 'home_epochs', 'home_doors', 'home_codes', 'home_names'];

// ---------------------------------------------------------------- bytes and signatures
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const sha256 = (b) => createHash('sha256').update(b).digest();
const b64 = (s, n) => (typeof s === 'string' && /^[A-Za-z0-9_-]+$/.test(s) && (n === undefined || Buffer.from(s, 'base64url').length === n) ? Buffer.from(s, 'base64url') : null);
const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const SPKI = Buffer.from('302a300506032b6570032100', 'hex');
const edKey = (raw) => createPublicKey({ key: Buffer.concat([SPKI, Buffer.from(raw)]), format: 'der', type: 'spki' });
const edOk = (key, msg, sig) => { try { return edVerify(null, msg, key, sig); } catch { return false; } };
/** What an entry's credential signature covers: "sigelo-home/0 entry\n" ‖ topic ‖ bytes 0-7 ‖ SHA-256(bytes 72 to the end). */
export const entryInput = (bytes, topic) => Buffer.concat([Buffer.from(`${HOME_V} entry\n${topic}`), bytes.subarray(0, 8), sha256(bytes.subarray(HEAD))]);
/** What an open's proof covers: "sigelo-home/0 open\n" ‖ topic ‖ epoch (u32) ‖ the session's account (64 hex) ‖ the UTC day number (u32). */
export const openInput = (topic, epoch, account, day) => Buffer.concat([Buffer.from(`${HOME_V} open\n${topic}`), u32(epoch), Buffer.from(account), u32(day)]);
/** What a control request's sig covers: "sigelo-home/0 control\n" ‖ JCS(the request without sig). */
export const controlInput = (req) => { const { sig, ...rest } = req; return Buffer.from(`${HOME_V} control\n${canonicalize(rest)}`); };
/** A group's topic from its gid (home-wire.mjs topicOf). */
export const topicOf = (gid) => 'g/' + sha256(Buffer.concat([Buffer.from(`${HOME_V} topic\n`), Buffer.from(gid, 'hex')])).subarray(0, 16).toString('hex');

/** The relay's reading of an entry, bytes 0-71 only: → {flags, slot, epoch, admin} or {why}. */
export function readEntry(b) {
  if (b.length < MIN_ENTRY) return { why: `${b.length} bytes: shorter than a head, a header and one padded block (${MIN_ENTRY})` };
  if (b.length > MAX_ENTRY) return { why: `${b.length} bytes, at most ${MAX_ENTRY}` };
  if (b[0] !== VERSION) return { why: `version byte ${b[0]}, this relay knows ${VERSION}` };
  if (b[1] !== KIND_ENTRY) return { why: `kind ${b[1]}, a log entry is ${KIND_ENTRY}` };
  if ((b.length - BODY - TAG) % BLOCK !== 0) return { why: `${b.length} bytes is not a head, a header and a padded body` };
  const flags = b[2], slot = b[3], epoch = b.readUInt32BE(4);
  if (flags > 7) return { why: 'flags: bits 0 to 2 only (admin credential, keep, letters part)' };
  const keep = (flags & FLAG.keep) !== 0;
  if (keep ? !(slot >= 1 && slot <= KEEP_SLOTS) : slot !== 0) return { why: `keep slot: 1 to ${KEEP_SLOTS} with the keep flag (state 1-8, avatar 9), else 0` };
  if ((flags & (FLAG.keep | FLAG.letters)) && !(flags & FLAG.admin)) return { why: 'a kept entry or a letters part goes under the admin credential' };
  if (keep && (flags & FLAG.letters)) return { why: 'a letters part is never kept' };
  if (epoch < 1) return { why: 'epoch 0: an entry is under epoch 1 or later' };
  return { flags, slot, epoch, admin: (flags & FLAG.admin) !== 0 };
}
/** A door request's shape (the relay opens nothing): → null, or why not. */
export function doorRefusal(b) {
  if (b.length < MIN_DOOR || b.length > MAX_DOOR) return `a door request is ${MIN_DOOR} to ${MAX_DOOR} bytes, not ${b.length}`;
  if (b[0] !== VERSION || b[1] !== KIND_DOOR) return `a door request is version ${VERSION}, kind ${KIND_DOOR}`;
  if ((b.length - DOOR_HEAD - 24 - TAG) % BLOCK !== 0) return 'a door request\'s body is padded to 256-byte blocks';
  return null;
}

// The wake list's seal (push.mjs's key file, a key of its own derived from it).
const wakeKey = (seal) => Buffer.from(hkdfSync('sha256', seal, Buffer.alloc(0), 'sigelo-relay-home/0 wake', 32));
function sealWake(key, topic, list) {
  const nonce = randomBytes(12), c = createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
  c.setAAD(Buffer.from(topic));
  const ct = Buffer.concat([c.update(JSON.stringify(list)), c.final()]);
  return Buffer.concat([nonce, ct, c.getAuthTag()]);
}
function openWake(key, topic, blob) {
  if (blob === null || blob === undefined) return [];
  const b = Buffer.from(blob), d = createDecipheriv('chacha20-poly1305', key, b.subarray(0, 12), { authTagLength: 16 });
  d.setAAD(Buffer.from(topic));
  d.setAuthTag(b.subarray(b.length - 16));
  return JSON.parse(Buffer.concat([d.update(b.subarray(12, b.length - 16)), d.final()]).toString('utf8'));
}

// A chain {genesis, rotations} with the rotations this relay keeps for that identity merged in
// (db.mjs chainOf): → {original, current, key} or a refusal text. SPEC §9 by the sigelo library.
function resolveChain(db, chain, now) {
  if (!isObject(chain) || Object.keys(chain).sort().join() !== 'genesis,rotations' || !Array.isArray(chain.rotations) || chain.rotations.length > 64) return 'chain: {genesis, rotations} (at most 64)';
  let original;
  try { original = didOf(chain.genesis); } catch { return 'chain: the genesis is not a sigelo genesis'; }
  let kept = [];
  try { kept = db.chainOf(accountOf(original), original); } catch { kept = []; }
  const seen = new Set(chain.rotations.map((r) => canonicalize(r)));
  const rotations = [...chain.rotations, ...kept.filter((r) => !seen.has(canonicalize(r)))];
  let r;
  try { r = verify({ v: 'sigelo/0', typ: 'bundle', genesis: chain.genesis, rotations, bindings: [], attestations: [], issuers: [] }, now); } catch (e) { return `chain: REJECT: ${e.message}`; }
  const node = [chain.genesis, ...rotations.map((x) => x.next_genesis)].find((g) => { try { return didOf(g) === r.did; } catch { return false; } });
  if (!node) return 'chain: its current key is not in it';
  return { original, current: r.did, key: node.key };
}

// The operator's slot file, {attestation, issuer, rotations?} as a licence file is (operator.mjs):
// a SPEC §5 attestation by the operator identity (`operator`, its original DID), ctx SLOT_CTX,
// admission "invite" by itself, claims {relay, name, members, storage_mb, retention_days}.
// → {ok: true, body} or {ok: false, why}.
export function checkSlot(raw, { host, operator, now }) {
  if (!operator) return { ok: false, why: 'this relay names no operator (RELAY_OPERATOR_DID): it sells no supergroup slot' };
  const claims = (c) => {
    const whole = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;
    return isObject(c) && Object.keys(c).sort().join() === 'members,name,relay,retention_days,storage_mb' && c.relay === host && typeof c.name === 'string' && NAME.test(c.name)
      && whole(c.members, 1, SLOT_MEMBERS_MAX) && whole(c.storage_mb, 0, 1e7) && whole(c.retention_days, 1, 3660)
      ? undefined : `a slot's claims are {"relay": "${host}", "name": [a-z0-9-]{3,32}, "members": 1 to ${SLOT_MEMBERS_MAX}, "storage_mb": N, "retention_days": N}`;
  };
  const v = checkVendorAttestation(raw, now, { vendor: operator, ctx: SLOT_CTX, claims, seen: () => undefined, seenRefusal: () => '', seenBy: 'this relay' });
  if (!v.ok) return { ok: false, why: v.why.replace(/the licence('s)?/g, 'the slot$1').replace(/vendor/g, 'operator') };
  const b = v.attestation.body;
  if (b.admission !== 'invite' || b.admission_by !== b.iss) return { ok: false, why: 'a slot says admission "invite", admission_by = its iss' };
  if (b.exp - b.iat > SLOT_DAYS * DAY) return { ok: false, why: `a slot lives at most ${SLOT_DAYS} days` };
  if (!/^did:sigelo:z[1-9A-HJ-NP-Za-km-z]{20,60}$/.test(b.sub)) return { ok: false, why: 'a slot names the group owner by its original DID' };
  return { ok: true, body: b };
}
/** Store a checked slot (the operator verb `node home.mjs slot <file>`): its name for its sub. A name another holds while its slot runs is refused. → {name, exp}. */
export function storeSlot(raw, body, db, now) {
  const r = db.prepare('SELECT owner, slot_exp FROM home_names WHERE name = ?').get(body.claims.name), owner = accountOf(body.sub);
  if (r && r.owner !== owner && r.slot_exp + NAME_GRACE > now) throw new Error(`the name ${body.claims.name} is held here by another owner until ${new Date((r.slot_exp + NAME_GRACE) * 1000).toISOString().slice(0, 10)}`);
  const c = body.claims;
  if (r && r.owner !== owner) db.prepare('DELETE FROM home_names WHERE name = ?').run(c.name);
  db.prepare(`INSERT INTO home_names (name, owner, slot, slot_exp, members, storage, retention) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
    ON CONFLICT (name) DO UPDATE SET slot = ?3, slot_exp = ?4, members = ?5, storage = ?6, retention = ?7`)
    .run(c.name, owner, Buffer.from(canonicalize(raw)), body.exp, c.members, c.storage_mb * MB, c.retention_days * DAY);
  return { name: c.name, exp: body.exp };
}

// The long invite a GRP code parks (home-wire.mjs checkInvite, the parts the relay reads): base64url
// of the JCS of {body, sig, genesis}, body {v, typ: "invite", gid, name, owner, home, door, door_key,
// link, by, iat, exp, approve, moved_from?}, signed by `by` under `genesis`. → the body, or why not.
const INVITE_KEYS = ['approve', 'by', 'door', 'door_key', 'exp', 'gid', 'home', 'iat', 'link', 'name', 'owner', 'typ', 'v'];
export function readGroupInvite(text) {
  const raw = b64(text);
  if (raw === null || raw.length > 8 * KB) return { why: 'invite: base64url of at most 8 KiB' };
  let inv;
  try { inv = parseBytes(raw); } catch { return { why: 'invite: not strict JSON' }; }
  if (!isObject(inv) || Object.keys(inv).sort().join() !== 'body,genesis,sig' || canonicalize(inv) !== raw.toString('utf8')) return { why: 'invite: the JCS of {body, sig, genesis}' };
  const b = inv.body;
  const keys = isObject(b) ? Object.keys(b).filter((k) => k !== 'moved_from').sort().join() : '';
  if (keys !== INVITE_KEYS.join() || b.v !== GROUP2_V || b.typ !== 'invite' || typeof b.gid !== 'string' || !/^[0-9a-f]{32}$/.test(b.gid)
    || typeof b.door !== 'string' || !DOOR.test(b.door) || !Number.isSafeInteger(b.exp) || !Number.isSafeInteger(b.iat) || typeof b.home !== 'string') return { why: `invite: not a ${GROUP2_V} invite body` };
  let by;
  try { by = didOf(inv.genesis); } catch { return { why: 'invite: genesis is not a sigelo genesis' }; }
  if (by !== b.by || !verifySig(inv.genesis.key, b, inv.sig)) return { why: 'invite: not signed by its by' };
  return { body: b };
}

// A JSON request read strictly (sigelo parseBytes: duplicate keys refused). → the object, or null.
function readJson(bytes) { try { const v = parseBytes(bytes); return isObject(v) ? v : null; } catch { return null; } }
// The exact keys of each control request (deploy/README.md step 8); sig? optional on epoch.
const SHAPES = {
  create: ['write', 'admin', 'members', 'channel'],
  epoch: ['epoch', 'write', 'admin', 'parts', 'members', 'channel'],
  open: ['epoch', 'since', 'as', 'proof'],
  close: ['forget'],
  forget: ['account', 'sig'],
  door: ['door', 'exp', 'cap', 'sig'],
  undoor: ['door', 'sig'],
  handover: ['op', 'chain'],
  name: ['card', 'chain', 'listed'],
  moved: ['seq'],
  end: ['seq'],
  drop: [],
};
function shapeRefusal(r) {
  const want = ['v', 'typ', 'topic', ...SHAPES[r.typ]], have = Object.keys(r).filter((k) => !(r.typ === 'epoch' && k === 'sig'));
  if (have.length !== want.length || !want.every((k) => Object.hasOwn(r, k))) return `${r.typ}: exactly {${want.join(', ')}${r.typ === 'epoch' ? ', sig?' : ''}}`;
  const whole = (v, min, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(v) && v >= min && v <= max;
  const key32 = (k) => b64(r[k], 32) !== null;
  switch (r.typ) {
    case 'create': return key32('write') && key32('admin') && whole(r.members, 1) && typeof r.channel === 'boolean' ? null : 'create: write and admin (32-byte public keys, base64url), members (≥ 1), channel (true or false)';
    case 'epoch': return whole(r.epoch, 2, 0xffffffff) && key32('write') && key32('admin') && whole(r.parts, 1, 64) && whole(r.members, 1) && typeof r.channel === 'boolean' && (r.sig === undefined || b64(r.sig, 64) !== null)
      ? null : 'epoch: epoch (the current + 1), write, admin, parts (1-64), members, channel, sig? (64 bytes, base64url)';
    case 'open': return whole(r.epoch, 1, 0xffffffff) && whole(r.since, 0) && (r.as === 'member' || r.as === 'admin') && b64(r.proof, 64) !== null ? null : 'open: epoch, since (a seq), as (member or admin), proof (64 bytes, base64url)';
    case 'close': return typeof r.forget === 'boolean' ? null : 'close: forget (true or false)';
    case 'forget': return typeof r.account === 'string' && /^[0-9a-f]{64}$/.test(r.account) && b64(r.sig, 64) !== null ? null : 'forget: account (64 hex), sig';
    case 'door': return typeof r.door === 'string' && DOOR.test(r.door) && whole(r.exp, 0) && whole(r.cap, 1, LINK_CAP_MAX) && b64(r.sig, 64) !== null ? null : `door: door (d/ and 32 hex), exp, cap (1-${LINK_CAP_MAX}), sig`;
    case 'undoor': return typeof r.door === 'string' && DOOR.test(r.door) && b64(r.sig, 64) !== null ? null : 'undoor: door, sig';
    case 'handover': return isObject(r.op) && Object.keys(r.op).sort().join() === 'body,sig' && isObject(r.chain) ? null : 'handover: op {body, sig} (the owner\'s handover body), chain {genesis, rotations} (the owner\'s)';
    case 'name': return isObject(r.card) && Object.keys(r.card).sort().join() === 'body,sig' && isObject(r.chain) && typeof r.listed === 'boolean' ? null : 'name: card {body, sig}, chain {genesis, rotations} (the owner\'s), listed';
    case 'moved': case 'end': return whole(r.seq, 1) ? null : `${r.typ}: seq (the ${r.typ} entry's)`;
    default: return null;
  }
}

/**
 * db: db.mjs; host: RELAY_HOST; clock() → unix seconds; policy: allowance.mjs's (tierOf, sender,
 * freeUsed, freeQueue; none: the free numbers, no storage count); stats: stats.mjs; sealKey: 32
 * bytes (push.mjs pushKeys(file).seal); operator: the operator's original DID (RELAY_OPERATOR_DID)
 * or null; diskFull(); log(line). Its notices go out through mailbox.mjs's notify (refusals) and
 * a client's own publish (answers and rows). limits: tests' overrides of the numbers above. push:
 * push.mjs's pushWakes (wake(account)), or null: no wakes.
 */
export function homes({ db, host, clock, policy = {}, stats = null, sealKey, operator = null, diskFull = () => false, log = () => {}, limits = {}, push = null }) {
  const L = { pendingSeconds: PENDING_SECONDS, switchGap: SWITCH_GAP, switchesDay: SWITCHES_DAY, entryRate: ENTRY_RATE, openMax: OPEN_MAX, page: PAGE, ...limits };
  db.rebuild(SCHEMA, TABLES);
  // A relay's file from before the handed column: it is added, 0 (no handover taken yet).
  if (!db.raw.prepare("SELECT 1 FROM pragma_table_info('homes') WHERE name = 'handed'").get()) db.raw.exec('ALTER TABLE homes ADD COLUMN handed INTEGER NOT NULL DEFAULT 0');
  db.raw.exec(TRIGGERS);
  db.keepSorted(SCHEMA + TRIGGERS, SORTED);
  const key = wakeKey(sealKey);
  const q = (sql) => db.raw.prepare(sql);
  const s = {
    home: q('SELECT * FROM homes WHERE topic = ?'),
    homeNew: q('INSERT INTO homes (topic, owner, pool, created, last_used, epoch, channel, cap) VALUES (?1, ?2, ?3, ?4, ?4, 1, ?5, ?6)'),
    homeRow: q('UPDATE homes SET seq = ?2, pool = ?3 WHERE topic = ?1'),
    homePool: q('UPDATE homes SET pool = ?2 WHERE topic = ?1'),
    homeUsed: q('UPDATE homes SET last_used = ?2 WHERE topic = ?1 AND last_used < ?2'),
    homePending: q('UPDATE homes SET pending = ?2 WHERE topic = ?1'),
    homeSwitch: q('UPDATE homes SET epoch = ?2, pending = NULL, channel = ?3, cap = ?4 WHERE topic = ?1'),
    homeOwner: q('UPDATE homes SET owner = ?2, pool = ?3, cap = ?4, handed = ?5 WHERE topic = ?1'),
    homeClose: q('UPDATE homes SET closed = ?2 WHERE topic = ?1'),
    homeWake: q('UPDATE homes SET wake = ?2 WHERE topic = ?1'),
    homeDrop: q('DELETE FROM homes WHERE topic = ?'),
    owned: q('SELECT count(*) AS n FROM homes WHERE owner = ? AND closed = 0'),
    bytesOwner: q('SELECT coalesce(sum(bytes), 0) AS n FROM homes WHERE owner = ? AND pool IS NULL'),
    bytesPool: q('SELECT coalesce(sum(bytes), 0) AS n FROM homes WHERE pool = ?'),
    bytesFree: q('SELECT coalesce(sum(bytes), 0) AS n FROM homes WHERE pool IS NULL'),
    epoch: q('SELECT * FROM home_epochs WHERE topic = ? AND epoch = ?'),
    epochNew: q('INSERT INTO home_epochs (topic, epoch, write, admin, first) VALUES (?, ?, ?, ?, ?)'),
    epochEnd: q('UPDATE home_epochs SET last = ?3 WHERE topic = ?1 AND epoch = ?2'),
    rowPut: q('INSERT INTO home_rows (topic, seq, lane, slot, payload, bytes, expires) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    rowSlot: q('SELECT seq, bytes FROM home_rows WHERE topic = ? AND slot = ?'),
    rowDrop: q('DELETE FROM home_rows WHERE topic = ? AND seq = ?'),
    rowAt: q('SELECT seq FROM home_rows WHERE topic = ? AND seq = ?'),
    keptExpire: q('UPDATE home_rows SET expires = ?2 WHERE topic = ?1 AND expires IS NULL'),
    page: q('SELECT seq, lane, payload FROM home_rows WHERE topic = ?1 AND seq > ?2 AND seq <= ?3 AND (lane = 0 OR ?4 = 1) AND (expires IS NULL OR expires > ?5) ORDER BY seq LIMIT ?6'),
    rowsLeft: q('SELECT 1 FROM home_rows WHERE topic = ? LIMIT 1'),
    door: q('SELECT * FROM home_doors WHERE door = ?'),
    doorNew: q('INSERT INTO home_doors (door, topic, exp, cap) VALUES (?, ?, ?, ?) ON CONFLICT (door) DO UPDATE SET exp = excluded.exp, cap = excluded.cap'),
    doorCount: q('UPDATE home_doors SET day = ?2, n = CASE WHEN day = ?2 THEN n + 1 ELSE 1 END WHERE door = ?1'),
    doorDrop: q('DELETE FROM home_doors WHERE door = ?'),
    doorsLive: q('SELECT count(*) AS n FROM home_doors WHERE topic = ? AND exp > ?'),
    codesOf: q('SELECT count(*) AS n FROM home_codes c JOIN home_doors d ON d.door = c.door WHERE d.topic = ? AND c.exp > ?'),
    code: q('SELECT c.invite, c.exp, d.topic, d.exp AS door_exp FROM home_codes c JOIN home_doors d ON d.door = c.door WHERE c.code_hash = ?'),
    codePut: q('INSERT INTO home_codes (code_hash, door, invite, exp) VALUES (?, ?, ?, ?)'),
    codeDrop: q('DELETE FROM home_codes WHERE code_hash = ?'),
    name: q('SELECT * FROM home_names WHERE name = ?'),
    nameOf: q('SELECT * FROM home_names WHERE topic = ?'),
    nameBind: q('UPDATE home_names SET topic = ?2, card = ?3, listed = ?4 WHERE name = ?1'),
    nameFree: q('UPDATE home_names SET topic = NULL WHERE topic = ?'),
    listed: q(`SELECT name, card FROM home_names WHERE listed = 1 AND card IS NOT NULL AND topic IS NOT NULL AND slot_exp > ? AND name > ? ORDER BY name LIMIT ${LISTED_PAGE}`),
    expireRows: q('DELETE FROM home_rows WHERE (topic, seq) IN (SELECT topic, seq FROM home_rows WHERE expires <= ? LIMIT ?)'),
    expireDoors: q('DELETE FROM home_doors WHERE door IN (SELECT door FROM home_doors WHERE exp <= ? LIMIT ?)'),
    expireCodes: q('DELETE FROM home_codes WHERE code_hash IN (SELECT code_hash FROM home_codes WHERE exp <= ? LIMIT ?)'),
    idle: q('SELECT topic, owner, closed, last_used FROM homes WHERE topic > ? AND last_used <= ? ORDER BY topic LIMIT 64'),
    closedEmpty: q('SELECT topic FROM homes h WHERE closed > 0 AND NOT EXISTS (SELECT 1 FROM home_rows r WHERE r.topic = h.topic) LIMIT 64'),
    namesOld: q('DELETE FROM home_names WHERE slot_exp <= ?'),
    counts: q('SELECT (SELECT count(*) FROM homes) AS groups, (SELECT count(*) FROM home_rows) AS rows'),
  };
  // allowance.mjs's queue totals, when its policy runs: the owner's mailboxes count in the same storage.
  const hasQueue = db.raw.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name IN ('queue_totals', 'pool_queue')").get().n === 2;
  if (hasQueue) { s.queued = q('SELECT bytes FROM queue_totals WHERE account = ?'); s.poolQueued = q('SELECT bytes FROM pool_queue WHERE pool = ?'); }

  // ---- memory: sessions, brakes, wake lists, days of use (the header) ----
  const opened = new Map();   // client → Map(topic → state {epoch, admin, sent, live, busy})
  const readers = new Map();  // topic → Set(client)
  const buckets = new Map();  // topic ‖ lane ('', ' admin', ' door') → {tokens, at}: entries a second
  const switches = new Map(); // topic → {at, day, n}: renewals switched
  const pendingAt = new Map();// topic → when its pending renewal was registered (memory: a restart lapses it)
  const once = new Map();     // door → {day, accounts}: one request per account per link per day
  const wakes = new Map();    // topic → {list: Map(account → [admin, day]), dirty}
  const used = new Map();     // topic → the day of its last open or row, written by the sweep
  const now0 = () => clock();
  const today = (now) => Math.floor(now / DAY);

  // The owner's numbers at `now`: allowance.mjs's tier (free without a policy) and the slot of the
  // name bound to the group, while it runs.
  function terms(h, now) {
    const t = policy.tierOf?.(h.owner, now) ?? { pool: null, limits: { ...TIERS.free, retention: TIERS.free.retentionDays * DAY } };
    const n = s.nameOf.get(h.topic), slot = n && n.slot_exp > now ? n : null;
    return {
      pool: t.pool, paid: t.pool !== null || slot !== null, slot,
      groups: t.limits.homeGroups ?? TIERS.free.homeGroups,
      cap: slot ? slot.members : t.limits.homeMembers ?? TIERS.free.homeMembers,
      storage: t.limits.storage + (slot ? slot.storage : 0),
      retention: slot ? Math.max(slot.retention, t.limits.retention) : t.limits.retention,
      maxEntry: slot ? MAX_ENTRY : Math.min(MAX_ENTRY, t.limits.maxMessage),
    };
  }
  const tierOf = (account, now) => policy.tierOf?.(account, now) ?? { pool: null, limits: { ...TIERS.free } };

  function wakeOf(topic, blob) {
    let w = wakes.get(topic);
    if (!w) {
      let list = [];
      try { list = openWake(key, topic, blob === undefined ? s.home.get(topic)?.wake : blob); } catch { log('home wake list unreadable: started anew'); }
      w = { list: new Map(list.map(([a, admin, day]) => [a, [admin, day]])), dirty: false };
      wakes.set(topic, w);
    }
    return w;
  }
  const touch = (topic, now) => used.set(topic, dayOf(now));

  // ---- delivery ----
  const frame = (lane, seq, payload) => { const h = Buffer.alloc(9); h[0] = lane; h.writeBigUInt64BE(BigInt(seq), 1); return Buffer.concat([h, payload]); };
  const answer = (client, n, done = () => {}) => client.publish({ topic: '$sigelo/notice', payload: Buffer.from(JSON.stringify({ code: 'home', ...n })), qos: 0, retain: false }, () => done());
  function endOpen(client, topic) {
    opened.get(client)?.delete(topic);
    const r = readers.get(topic);
    if (r) { r.delete(client); if (r.size === 0) readers.delete(topic); }
  }
  // Rows after st.sent, a page at a time, until a read finds nothing (mailbox.mjs queued, the same
  // way): a row stored meanwhile is read by the next page; once a read finds nothing the session is
  // live and every new row goes to it as it is stored (store). At the end of a closed epoch: the
  // epoch notice, and the open ends; of a closed log: the closed notice.
  function pump(client, topic, st) {
    if (st.live || st.busy || opened.get(client)?.get(topic) !== st) return;
    const now = now0(), h = s.home.get(topic), e = h && s.epoch.get(topic, st.epoch);
    if (!h || !e) { endOpen(client, topic); return answer(client, { typ: 'dropped', topic }); }
    const until = e.last ?? Number.MAX_SAFE_INTEGER;
    const rows = s.page.all(topic, st.sent, until, st.admin ? 1 : 0, now, L.page);
    if (rows.length === 0) {
      if (e.last !== null) { endOpen(client, topic); return answer(client, { typ: 'epoch', topic, epoch: st.epoch + 1 }); }
      if (h.closed) { endOpen(client, topic); return answer(client, { typ: 'closed', topic, why: CLOSED_NAME[h.closed] }); }
      st.live = true;
      return;
    }
    st.busy = true;
    let left = rows.length;
    const next = () => { if (--left === 0) { st.busy = false; try { pump(client, topic, st); } catch { endOpen(client, topic); } } };
    for (const r of rows) {
      st.sent = r.seq;
      client.publish({ topic, payload: frame(r.lane, r.seq, Buffer.from(r.payload.buffer, r.payload.byteOffset, r.payload.byteLength)), qos: 0, retain: false }, next);
    }
  }
  // A row just stored: to every live session of the group (a door row to admins only).
  function broadcast(topic, lane, seq, payload) {
    const r = readers.get(topic);
    if (!r) return;
    const bytes = frame(lane, seq, payload);
    for (const client of r) {
      const st = opened.get(client)?.get(topic);
      if (!st?.live || (lane === 1 && !st.admin)) continue;
      st.sent = seq;
      client.publish({ topic, payload: bytes, qos: 0, retain: false }, () => {});
    }
  }
  // The phones to wake for a row just stored: the wake list's accounts with no session that opened the
  // group here (a door row: admins only), never the writer's. push.mjs keeps it to one wake until the
  // account logs in again.
  function wakeAll(topic, lane, writer) {
    if (!push) return;
    const here = new Set([writer]);
    for (const client of readers.get(topic) ?? []) { const a = opened.get(client)?.get(topic)?.account; if (a) here.add(a); }
    for (const [account, [admin]] of wakeOf(topic).list) if (!here.has(account) && (lane === 0 || admin)) push.wake(account);
  }
  // Every session of the group stops being live and reads on to what is left (pump): after a
  // switch (they reach the old epoch's end), a close of the log, a drop.
  function wakeReaders(topic) {
    for (const client of [...(readers.get(topic) ?? [])]) {
      const st = opened.get(client)?.get(topic);
      if (!st) continue;
      st.live = false;
      try { pump(client, topic, st); } catch { endOpen(client, topic); }
    }
  }

  // ---- charging (allowance.mjs's rules, the owner as the reader) ----
  // The writer: its proof of work and its messages today. The owner: its storage (with its
  // mailboxes' queue: one allowance), and the free tier's ceiling for a free owner. → refusal or null.
  function charge(h, t, writer, bytes, now) {
    const p = policy.sender?.({ sender: writer, now });
    if (p) return p;
    if (policy.tierOf) {
      const tw = policy.tierOf(writer, now), sent = tw.pool ? db.poolSentToday(tw.pool, now) : db.sentToday(writer, now);
      if (sent >= tw.limits.msgsDay) return { code: 'quota_messages', detail: `${tw.pool ? 'your operator\'s pool' : 'this identity (free tier)'} sent ${tw.limits.msgsDay} messages today, its most: the count starts again at 00:00 UTC` };
      const c = chargeOf(bytes);
      // The group is charged where its owner draws now (a Pro begun or ended since its last row).
      if (h.pool !== t.pool) { s.homePool.run(h.topic, t.pool); h.pool = t.pool; }
      const usedNow = t.pool
        ? (hasQueue ? s.poolQueued.get(t.pool)?.bytes ?? 0 : 0) + s.bytesPool.get(t.pool).n
        : (hasQueue ? s.queued.get(h.owner)?.bytes ?? 0 : 0) + s.bytesOwner.get(h.owner).n;
      if (usedNow + c > t.storage) return { code: 'quota_storage', side: 'owner', detail: `owner over quota: the group's owner has ${usedNow} of ${t.storage} bytes stored here (its groups' rows, a row counts its size, at least 256, plus 384, and its mailboxes): it frees as rows expire` };
      if (!t.pool && typeof policy.freeUsed === 'function' && policy.freeUsed() + s.bytesFree.get().n + c > policy.freeQueue) {
        return { code: 'quota_storage', side: 'relay', detail: `this relay's free tier is full (${policy.freeQueue} bytes): free owners' groups take nothing more until rows expire` };
      }
    }
    return null;
  }
  // lane: '' (the member credential), ' admin' (the admin credential), ' door' (door requests): a bucket each (ENTRY_RATE).
  function rated(topic, paid, now, lane = '') {
    const lim = paid ? L.entryRate.paid : L.entryRate.free;
    let b = buckets.get(topic + lane);
    if (!b) { if (buckets.size > 100000) buckets.clear(); b = { tokens: lim.burst, at: now }; buckets.set(topic + lane, b); }
    b.tokens = Math.min(lim.burst, b.tokens + Math.max(0, now - b.at) * lim.perSecond); b.at = now;
    if (b.tokens < 1) return { code: 'rate', detail: `more than ${lim.perSecond} entries a second to this group (burst ${lim.burst}): slow down` };
    b.tokens -= 1;
    return null;
  }

  // ---- an entry to g/ ----
  function entry(session, topic, b) {
    const now = now0(), h = s.home.get(topic);
    if (!h) return { code: 'home_unknown', detail: 'no group lives at this topic here: create it first, or it was dropped' };
    if (h.closed) return { code: 'home_closed', detail: `this group's log is closed (${CLOSED_NAME[h.closed]}): it takes no more entries` };
    const e = readEntry(b);
    if (e.why) return { code: 'group_entry', detail: e.why };
    if (e.epoch !== h.epoch) return { code: 'home_epoch', detail: `an entry under epoch ${e.epoch}; the group is at epoch ${h.epoch}: read the letters, then send it again under the new epoch` };
    const t = terms(h, now);
    if (b.length > t.maxEntry) return { code: 'too_large', detail: `entry over ${t.maxEntry} bytes, the largest this group's owner may keep` };
    const ep = s.epoch.get(topic, h.epoch);
    if (!edOk(edKey(e.admin ? ep.admin : ep.write), entryInput(b, topic), b.subarray(8, HEAD))) {
      return { code: 'home_credential', detail: `the credential signature does not verify under this epoch's ${e.admin ? 'admin' : 'member'} write key` };
    }
    if (h.channel && !e.admin && b.length > CHANNEL_ENTRY) return { code: 'home_channel', detail: `channel mode: an entry under the member credential is at most ${CHANNEL_ENTRY} bytes (a reaction, a vote, a key)` };
    let pending = null;
    if (e.flags & FLAG.letters) {
      pending = h.pending ? JSON.parse(Buffer.from(h.pending).toString('utf8')) : null;
      const at = pendingAt.get(topic);
      if (!pending || at === undefined || now - at > L.pendingSeconds) return { code: 'home_epoch', detail: 'a letters part with no renewal registered (or it lapsed after 10 minutes): register the next epoch first' };
    }
    if (diskFull()) return { code: 'relay_full', detail: 'this relay stores nothing until disk use falls below 70 %' };
    if (e.slot > 0) {
      const old = s.rowSlot.get(topic, e.slot)?.bytes ?? 0, most = Math.max(KEEP_BYTES, KEEP_PER_MEMBER * t.cap);
      if (h.keep_bytes - old + b.length > most) return { code: 'quota_storage', side: 'owner', detail: `keep slots over ${most} bytes for this group` };
    }
    return rated(topic, t.paid, now, e.admin ? ' admin' : '') ?? charge(h, t, session.account, b.length, now) ?? store(session, h, t, 0, e.slot, b, now, pending);
  }
  // In one transaction: the row (replacing its keep slot's), the group's seq, the renewal's count
  // and the switch when this was its last letters part. Then the live sessions.
  function store(session, h, t, lane, slot, b, now, pending) {
    const topic = h.topic, seq = h.seq + 1;
    let switched = false;
    db.tx(() => {
      if (slot > 0) { const old = s.rowSlot.get(topic, slot); if (old) s.rowDrop.run(topic, old.seq); }
      s.rowPut.run(topic, seq, lane, slot, b, b.length, slot > 0 ? null : dayOf(now + t.retention));
      s.homeRow.run(topic, seq, t.pool);
      if (lane === 1) s.doorCount.run(session.door, today(now));
      if (pending) {
        pending.got++;
        if (pending.got < pending.parts) s.homePending.run(topic, Buffer.from(canonicalize(pending)));
        else {
          s.epochEnd.run(topic, h.epoch, seq);
          s.epochNew.run(topic, pending.epoch, b64(pending.write), b64(pending.admin), seq + 1);
          s.homeSwitch.run(topic, pending.epoch, pending.channel ? 1 : 0, Math.max(t.cap, pending.members));
          switched = true;
        }
      }
    });
    if (policy.tierOf) { const tw = policy.tierOf(session.account, now); db.countSent(session.account, now, tw.pool); }
    touch(topic, now);
    stats?.count('stored');
    if (switched) {
      pendingAt.delete(topic);
      // Admin is proved per epoch (an open as admin under the new admin key): an admin made member or removed by this
      // renewal keeps no door-row wakes and parks or cancels no GRP code. The admins open again as admin at once.
      const w = wakeOf(topic);
      for (const v of w.list.values()) if (v[0]) { v[0] = false; w.dirty = true; }
      const sw = switches.get(topic), d = today(now);
      switches.set(topic, { at: now, day: d, n: sw && sw.day === d ? sw.n + 1 : 1 });
    }
    broadcast(topic, lane, seq, b);
    wakeAll(topic, lane, session.account);
    if (switched) wakeReaders(topic);
    return null;
  }

  // ---- a door request to d/ ----
  function doorRequest(session, door, b) {
    const now = now0(), d = s.door.get(door);
    if (!d || d.exp <= now) return { code: 'home_door', detail: 'no live link has this door here: it ended, or the link was unlinked' };
    const h = s.home.get(d.topic);
    if (!h || h.closed) return { code: 'home_door', detail: 'the group of this door takes no requests now' };
    const o = once.get(door);
    if (o && o.day === today(now) && o.accounts.has(session.account)) return { code: 'home_once', detail: 'this identity sent this link a request today already: one a day' };
    if (d.day === today(now) && d.n >= d.cap) return { code: 'home_door', detail: `this link took its ${d.cap} requests today: try again after 00:00 UTC` };
    const why = doorRefusal(b);
    if (why) return { code: 'group_entry', detail: why };
    if (diskFull()) return { code: 'relay_full', detail: 'this relay stores nothing until disk use falls below 70 %' };
    const t = terms(h, now);
    const r = rated(h.topic, t.paid, now, ' door') ?? charge(h, t, session.account, b.length, now) ?? store({ ...session, door }, h, t, 1, 0, b, now, null);
    if (r) return r;
    if (!o || o.day !== today(now)) { if (once.size > 100000) once.clear(); once.set(door, { day: today(now), accounts: new Set([session.account]) }); } else o.accounts.add(session.account);
    return null;
  }

  // ---- control requests ($sigelo/home) ----
  const no = (code, detail) => ({ refusal: { code, detail } });
  const yes = (typ, topic, extra = {}) => ({ answer: { typ, topic, ...extra } });
  const adminSigned = (h, req) => {
    const e = s.epoch.get(h.topic, h.epoch);
    return edOk(edKey(e.admin), controlInput(req), b64(req.sig, 64));
  };
  function control(client, session, bytes) {
    if (bytes.length > MAX_CONTROL) return no('too_large', `a control request is at most ${MAX_CONTROL} bytes`);
    const r = readJson(bytes);
    if (!r || r.v !== HOME_V || !TYPS.includes(r.typ) || typeof r.topic !== 'string' || !GROUP.test(r.topic)) return no('home_request', `not a ${HOME_V} request: JSON {v: "${HOME_V}", typ: ${TYPS.join(' | ')}, topic: g/<32 hex>, …}`);
    const bad = shapeRefusal(r);
    if (bad) return no('home_request', bad);
    const now = now0(), h = s.home.get(r.topic);
    if (r.typ === 'create') return create(session, r, h, now);
    if (!h) return no('home_unknown', 'no group lives at this topic here');
    const owner = h.owner === session.account;
    switch (r.typ) {
      case 'open': return open(client, session, r, h, now);
      case 'close': {
        endOpen(client, r.topic);
        if (r.forget) { const w = wakeOf(r.topic); if (w.list.delete(session.account)) w.dirty = true; }
        return yes('closed', r.topic);
      }
      case 'forget': {
        if (!adminSigned(h, r)) return no('home_credential', 'forget: sig does not verify under this epoch\'s admin write key');
        const w = wakeOf(r.topic);
        if (w.list.delete(r.account)) w.dirty = true;
        return yes('forgot', r.topic);
      }
      case 'epoch': return renew(session, r, h, owner, now);
      case 'door': {
        if (h.closed) return no('home_closed', 'this group\'s log is closed');
        if (!adminSigned(h, r)) return no('home_credential', 'door: sig does not verify under this epoch\'s admin write key');
        if (r.exp <= now || r.exp > now + LINK_MAX + SKEW) return no('home_door', 'exp: a link ends in the future, at most 366 days from now');
        const d = s.door.get(r.door);
        if (d && d.topic !== r.topic) return no('home_taken', 'this door is another group\'s');
        if (!d && s.doorsLive.get(r.topic, now).n >= DOORS_MAX) return no('home_door', `${DOORS_MAX} live links in this group, its most: unlink one first`);
        const exp = Math.ceil(r.exp / 3600) * 3600;
        db.tx(() => s.doorNew.run(r.door, r.topic, exp, r.cap));
        return yes('door', r.topic, { door: r.door, exp, cap: r.cap });
      }
      case 'undoor': {
        if (!adminSigned(h, r)) return no('home_credential', 'undoor: sig does not verify under this epoch\'s admin write key');
        const d = s.door.get(r.door);
        if (!d || d.topic !== r.topic) return no('home_door', 'no such door in this group');
        db.tx(() => s.doorDrop.run(r.door));
        return yes('undoor', r.topic, { door: r.door });
      }
      case 'handover': return handover(session, r, h, now);
      case 'name': return name(session, r, h, owner, now);
      case 'moved': case 'end': {
        if (!owner) return no('home_owner', `${r.typ}: only the owner's session closes the log`);
        if (h.closed) return no('home_closed', 'this group\'s log is closed already');
        if (r.seq !== h.seq || !s.rowAt.get(r.topic, r.seq)) return no('home_request', `${r.typ}: seq must be the log's last row (${h.seq}), the owner's ${r.typ} entry`);
        const t = terms(h, now);
        db.settle(() => db.tx(() => {
          s.homeClose.run(r.topic, CLOSED[r.typ]);
          s.keptExpire.run(r.topic, dayOf(now + t.retention));
          db.raw.prepare('DELETE FROM home_doors WHERE topic = ?').run(r.topic);
          s.nameFree.run(r.topic);
        }));
        wakeReaders(r.topic);
        return yes(r.typ, r.topic, { seq: r.seq });
      }
      case 'drop': {
        if (!owner) return no('home_owner', 'drop: only the owner\'s session deletes the group');
        drop(r.topic);
        return yes('dropped', r.topic);
      }
    }
    return no('home_request', 'unknown request');
  }

  function create(session, r, h, now) {
    if (h) return no('home_taken', 'a group lives at this topic already');
    if (diskFull()) return no('relay_full', 'this relay makes no group until disk use falls below 70 %');
    const p = policy.sender?.({ sender: session.account, now });
    if (p) return { refusal: p };
    const t = terms({ owner: session.account, topic: r.topic }, now);
    if (s.owned.get(session.account).n >= t.groups) return no('home_limit', `this owner has ${t.groups} home groups here, its tier's most${t.pool ? '' : ' (free: 3; Pro: more)'}: end one first`);
    if (r.members > t.cap) return no('home_cap', `${r.members} members: this owner's groups hold at most ${t.cap} here${t.pool ? '' : ' (free: 8; Pro: up to about 1,000)'}`);
    db.settle(() => db.tx(() => {
      s.homeNew.run(r.topic, session.account, t.pool, dayOf(now), r.channel ? 1 : 0, t.cap);
      s.epochNew.run(r.topic, 1, b64(r.write), b64(r.admin), 1);
    }));
    return yes('created', r.topic, { epoch: 1, seq: 0, cap: t.cap });
  }

  function open(client, session, r, h, now) {
    const e = s.epoch.get(r.topic, r.epoch);
    if (!e) return no('home_epoch', `epoch ${r.epoch} is not one of this group's here (it is at ${h.epoch}${h.pending ? ', a renewal pending' : ''})`);
    const admin = r.as === 'admin', d = today(now), proof = b64(r.proof, 64);
    const good = [d, d - 1, d + 1].some((day) => edOk(edKey(admin ? e.admin : e.write), openInput(r.topic, r.epoch, session.account, day), proof));
    if (!good) return no('home_credential', `open: proof does not verify under epoch ${r.epoch}'s ${admin ? 'admin' : 'member'} write key over (topic, epoch, your account, the UTC day)`);
    const mine = opened.get(client) ?? new Map();
    if (!mine.has(r.topic) && mine.size >= L.openMax) return no('rate', `${L.openMax} groups open on this session, its most: close one first`);
    const w = wakeOf(r.topic), had = w.list.get(session.account);
    const t = terms(h, now);
    if (!had && w.list.size >= t.cap) return no('home_cap', `this group's wake list holds ${t.cap} accounts, its most: a new member opens once one leaves${t.paid ? '' : ' (the owner\'s tier: free 8)'}`);
    // The current epoch's open only: an old epoch's reader (a kicked member) reads to its end, and is never woken.
    if (r.epoch === h.epoch && (!had || had[0] !== admin || had[1] !== dayOf(now))) { w.list.set(session.account, [admin, dayOf(now)]); w.dirty = true; }
    touch(r.topic, now);
    opened.set(client, mine);
    // From `since`, earlier epochs' rows included (a joiner's welcome gives it keys for the newest
    // state parts and the roster rows after them, which may lie there), to the epoch's end: never
    // past it, so a member without the next epoch's key reads nothing after the renewal.
    const st = { epoch: r.epoch, admin, sent: r.since, live: false, busy: false, account: session.account };
    mine.set(r.topic, st);
    let set = readers.get(r.topic);
    if (!set) { set = new Set(); readers.set(r.topic, set); }
    set.add(client);
    return { ...yes('opened', r.topic, { epoch: r.epoch, first: e.first, last: e.last ?? h.seq, current: h.epoch, cap: t.cap }), then: () => { try { pump(client, r.topic, st); } catch { endOpen(client, r.topic); } } };
  }

  function renew(session, r, h, owner, now) {
    if (h.closed) return no('home_closed', 'this group\'s log is closed');
    if (r.sig === undefined ? !owner : !adminSigned(h, r)) return no('home_credential', 'epoch: sig by this epoch\'s admin write key, or none from the owner\'s own session');
    if (r.epoch !== h.epoch + 1) return no('home_epoch', `epoch ${r.epoch}: the next is ${h.epoch + 1}`);
    const at = pendingAt.get(r.topic);
    if (h.pending && at !== undefined && now - at <= L.pendingSeconds && !(owner && r.sig === undefined)) return no('home_epoch', 'a renewal is pending (10 minutes, then it lapses): one at a time');
    const sw = switches.get(r.topic);
    if (sw && now - sw.at < L.switchGap) return no('home_epoch', `the last renewal switched ${now - sw.at} s ago: at most one per ${L.switchGap} s`);
    if (sw && sw.day === today(now) && sw.n >= L.switchesDay) return no('home_epoch', `${L.switchesDay} renewals today, the most a day: after 00:00 UTC`);
    // A renewal is never refused for the tier alone: a group whose owner's Pro ended still renews for the members it had at
    // its last switch (a kick must cut the kicked member off), and only new accounts are held out (open, home_cap).
    const t = terms(h, now), most = Math.max(t.cap, h.cap);
    if (r.members > most) return no('home_cap', `${r.members} members: this group holds at most ${most}`);
    const pending = { epoch: r.epoch, write: r.write, admin: r.admin, parts: r.parts, got: 0, members: r.members, channel: r.channel };
    db.tx(() => s.homePending.run(r.topic, Buffer.from(canonicalize(pending))));
    pendingAt.set(r.topic, now);
    return yes('pending', r.topic, { epoch: r.epoch, parts: r.parts });
  }

  function handover(session, r, h, now) {
    const c = resolveChain(db, r.chain, now);
    if (typeof c === 'string') return no('home_credential', `handover: ${c}`);
    const b = r.op.body;
    if (accountOf(c.original) !== h.owner) return no('home_owner', 'handover: chain is not the owner\'s');
    if (!isObject(b) || b.v !== GROUP2_V || b.typ !== 'handover' || typeof b.gid !== 'string' || !/^[0-9a-f]{32}$/.test(b.gid) || topicOf(b.gid) !== r.topic || b.from !== c.current || typeof b.to !== 'string') {
      return no('home_request', 'handover: op.body is the owner\'s handover for this group, from its current DID');
    }
    if (!verifySig(c.key, b, r.op.sig)) return no('home_credential', 'handover: op.sig does not verify under the owner\'s current key as this relay keeps its chain');
    // A replay: an owner who handed the group on and got it back holds the old op, still signed by the same owner. Each
    // owner's handover is written after it became owner in the log, so its `at` (the last seq it had read) is past the
    // `at` of the handover that made it owner; an op whose `at` is not past the last one taken is refused.
    if (!Number.isSafeInteger(b.at) || b.at < h.handed) return no('home_request', `handover: this op (at ${b.at}) is older than the last handover taken here (at ${h.handed - 1}): a replay`);
    if (accountOf(b.to) !== session.account) return no('home_owner', 'handover: only the session of the new owner (op.body.to) takes the group');
    const t = terms({ owner: session.account, topic: r.topic }, now);
    if (s.owned.get(session.account).n >= t.groups) return no('home_limit', `the new owner has ${t.groups} home groups here, its tier's most`);
    if (wakeOf(r.topic).list.size > t.cap) return no('home_cap', `the group has more members than the new owner's tier holds (${t.cap})`);
    db.settle(() => db.tx(() => s.homeOwner.run(r.topic, session.account, t.pool, t.cap, b.at + 1)));
    return yes('handover', r.topic);
  }

  function name(session, r, h, owner, now) {
    if (!owner) return no('home_owner', 'name: only the owner\'s session names its group');
    const b = r.card.body;
    if (!isObject(b) || b.v !== GROUP2_V || b.typ !== 'card' || typeof b.name !== 'string' || !NAME.test(b.name)) return no('home_request', `name: card.body is a ${GROUP2_V} card`);
    const n = s.name.get(b.name);
    if (!n || n.slot_exp <= now) return no('home_slot', `no slot runs for the name ${b.name} here: the relay's operator sells them`);
    if (n.owner !== session.account) return no('home_name', `the name ${b.name} is another owner's here`);
    const bound = s.nameOf.get(r.topic);
    if (bound && bound.name !== b.name) return no('home_name', `this group is named ${bound.name} here already`);
    const c = resolveChain(db, r.chain, now);
    if (typeof c === 'string') return no('home_credential', `name: ${c}`);
    const keys = Object.keys(b).sort().join();
    if (keys !== 'about,avatar,gid,home,iat,invite,name,owner,public,typ,v' || accountOf(c.original) !== session.account || b.owner !== c.original || b.home !== host
      || typeof b.gid !== 'string' || !/^[0-9a-f]{32}$/.test(b.gid) || topicOf(b.gid) !== r.topic || typeof b.public !== 'boolean' || b.public !== (b.invite !== null)) {
      return no('home_request', 'name: the card is {v, typ, name, home (this relay), gid (this group), owner (your original DID), public, about, avatar, invite, iat}, public with an invite');
    }
    // A private card shows the name, about and owner only (GROUPS.md "Supergroups"): no invite, no avatar.
    // A public one's invite is a live link of this group, here, by its owner's group (readGroupInvite).
    if (typeof b.about !== 'string' || b.about.length > 500 || !Number.isSafeInteger(b.iat)) return no('home_request', 'name: about (at most 500 characters), iat (unix seconds)');
    if (!b.public && b.avatar !== null) return no('home_request', 'name: a private card shows the name, about and owner only (avatar null)');
    if (b.public) {
      const inv = readGroupInvite(b.invite);
      if (inv.why) return no('home_request', `name: the card's ${inv.why}`);
      if (inv.body.gid !== b.gid || inv.body.home !== host || inv.body.owner !== b.owner || inv.body.exp <= now) return no('home_request', 'name: the card\'s invite is not a live link of this group here');
    }
    if (!verifySig(c.key, b, r.card.sig)) return no('home_credential', 'name: card.sig does not verify under the owner\'s current key');
    const card = Buffer.from(canonicalize({ card: r.card, chain: r.chain }));
    db.settle(() => db.tx(() => s.nameBind.run(b.name, r.topic, card, r.listed && b.public ? 1 : 0)));
    return yes('named', r.topic, { name: b.name, exp: n.slot_exp, members: n.members });
  }

  function drop(topic) {
    db.settle(() => db.tx(() => { s.nameFree.run(topic); s.homeDrop.run(topic); }));
    wakes.delete(topic); used.delete(topic); pendingAt.delete(topic); for (const lane of ['', ' admin', ' door']) buckets.delete(topic + lane);
    switches.delete(topic);
    for (const client of [...(readers.get(topic) ?? [])]) { endOpen(client, topic); answer(client, { typ: 'dropped', topic }); }
  }

  // ---- the hooks mailbox.mjs calls ----
  // A publish to g/, d/ or $sigelo/home by session (auth.mjs). → null (stored), {code, detail} (refused),
  // or {answer, then?} for a control request: mailbox.mjs writes the answer before the PUBACK.
  function publish(client, session, packet) {
    const t = packet.topic, b = packet.payload;
    try {
      if (t === HOME_TOPIC) {
        const r = control(client, session, b);
        if (r.refusal) return r.refusal;
        return { answer: r.answer, then: r.then };
      }
      if (GROUP.test(t)) return entry(session, t, b);
      if (DOOR.test(t)) return doorRequest(session, t, b);
    } catch (e) { log(`home bug ${e.name}`); throw e; }
    return { code: 'home_request', detail: 'not a home topic' };
  }
  // A SUBSCRIBE to g/: granted at QoS 0 to a session that opened it (rows are sent on open anyway).
  const subscribable = (client, topic) => opened.get(client)?.has(topic) === true;
  // The session's connection ended.
  function gone(client) {
    const mine = opened.get(client);
    if (!mine) return;
    for (const topic of [...mine.keys()]) endOpen(client, topic);
    opened.delete(client);
  }
  const answerOf = (n, id) => Buffer.from(JSON.stringify({ code: 'home', ...n, id }));

  // ---- GRP codes (park.mjs: a third code kind beside one-time and public codes) ----
  const codes = {
    has: (hash, now = now0()) => { const c = s.code.get(hash); return c !== undefined && c.exp > now && c.door_exp > now; },
    // Parked by an account that opened the group as admin. → {exp, group: true}, or throws [check, why].
    park({ code_hash, invite, exp }, now, account) {
      const r = readGroupInvite(invite);
      if (r.why) throw ['park', r.why];
      const b = r.body, d = s.door.get(b.door);
      if (b.home !== host) throw ['park', `invite: its home is ${JSON.stringify(b.home)}, not this relay`];
      if (!d || d.exp <= now || topicOf(b.gid) !== d.topic) throw ['park', 'invite: its door is not a live link of its group here (register the door first)'];
      if (!(wakeOf(d.topic).list.get(account)?.[0])) throw ['park', 'a GRP code is parked by an admin of its group (a session that opened it as admin)'];
      if (!Number.isSafeInteger(exp) || exp <= now || exp > b.exp || exp > d.exp || exp > now + LINK_MAX + SKEW) throw ['park', 'exp: in the future, no later than the invite\'s exp and its door\'s'];
      if (s.code.get(code_hash)) throw ['park_taken', 'a code is parked under this hash: make another'];
      if (s.codesOf.get(d.topic, now).n >= CODES_MAX) throw ['park_full', `${CODES_MAX} GRP codes for this group, its most: unlink one first`];
      db.tx(() => s.codePut.run(code_hash, b.door, invite, exp));
      return { exp, group: true };
    },
    // → the long invite (not spent: fetched as often as needed until exp), or null.
    fetch(hash, now = now0()) { const c = s.code.get(hash); return c && c.exp > now && c.door_exp > now ? c.invite : null; },
    // Its group's admins (on the wake list as admin) may cancel. → true or false.
    cancel(hash, account, now = now0()) {
      const c = s.code.get(hash);
      if (!c || c.exp <= now || !(wakeOf(c.topic).list.get(account)?.[0])) return false;
      db.tx(() => s.codeDrop.run(hash));
      return true;
    },
  };

  // ---- GET /group/<name>, GET /groups (public by design: the card, the slot, the owner's chain) ----
  function card(nameAsked, now = now0()) {
    if (typeof nameAsked !== 'string' || !NAME.test(nameAsked)) return null;
    const n = s.name.get(nameAsked);
    if (!n || n.card === null || n.topic === null || n.slot_exp <= now) return null;
    const c = JSON.parse(Buffer.from(n.card).toString('utf8')), slot = JSON.parse(Buffer.from(n.slot).toString('utf8'));
    return { card: c.card, slot: slot.attestation, chain: c.chain, issuer: slot.issuer, ...(slot.rotations && { issuer_rotations: slot.rotations }) };
  }
  // A page of LISTED_PAGE names after `after` (a client's answer stays under 64 KiB: 100 × about 500 + name).
  function listing(now = now0(), after = '') {
    return s.listed.all(now, typeof after === 'string' && NAME.test(after) ? after : '').map((r) => { const c = JSON.parse(Buffer.from(r.card).toString('utf8')).card.body; return { name: r.name, about: c.about }; });
  }

  // ---- the sweep (server.mjs, each minute, before mailbox.mjs's: its checkpoint truncates the WAL) ----
  let idleFrom = '';
  // What memory holds to the file: the days of use, the wake lists changed (an account gone 30 days
  // after its last open leaves). Inside the caller's transaction.
  function persist(now) {
    for (const [topic, day] of used) s.homeUsed.run(topic, day);
    used.clear();
    for (const [topic, w] of wakes) {
      const before = w.list.size;
      for (const [a, [, day]] of w.list) if (day + WAKE_KEEP <= now) w.list.delete(a);
      if (w.list.size !== before) w.dirty = true;
      if (w.dirty && s.home.get(topic)) s.homeWake.run(topic, sealWake(key, topic, [...w.list].map(([a, [admin, day]]) => [a, admin, day])));
      w.dirty = false;
      if (!readers.has(topic)) wakes.delete(topic);
    }
  }
  function sweep(now = now0()) {
    let rows = 0, dropped = 0;
    const gone = [];
    db.tx(() => {
      persist(now);
      rows = Number(s.expireRows.run(now, BATCH).changes);
      s.expireDoors.run(now, BATCH);
      s.expireCodes.run(now, BATCH);
      s.namesOld.run(now - NAME_GRACE);
      for (const r of s.closedEmpty.all()) gone.push(r.topic);
      const page = s.idle.all(idleFrom, dayOf(now) - IDLE);
      for (const r of page) {
        const t = terms({ owner: r.owner, topic: r.topic }, now);
        if (!readers.has(r.topic) && r.last_used + Math.max(IDLE, t.retention) <= now) gone.push(r.topic);
      }
      idleFrom = page.length === 64 ? page.at(-1).topic : '';
    });
    for (const topic of new Set(gone)) { drop(topic); dropped++; }
    for (const [topic] of pendingAt) if (now - pendingAt.get(topic) > L.pendingSeconds) pendingAt.delete(topic);
    if (rows || dropped) log(`sweep homes rows=${rows} dropped=${dropped}`);
    return { rows, dropped };
  }

  return {
    publish, subscribable, gone, answerOf, codes, card, listing, sweep,
    // GET /stats: counts only.
    counts: () => { const c = s.counts.get(); return { total: c.groups, rows: c.rows }; },
    // Tests and reports: the wake list's accounts of a group.
    wakeList: (topic) => [...wakeOf(topic).list.keys()],
    // server.mjs close(), before the database closes.
    close: () => db.tx(() => persist(now0())),
  };
}

/**
 * The operator signs a slot (`node home.mjs slot issue`): its identity file (sigelo-agent's format, a plain
 * `secret`), the group owner's ORIGINAL DID, the name and the numbers it sells. → the slot file
 * {attestation, issuer (the operator's original genesis), rotations}, checked as the relay will check it.
 */
export function issueSlot(store, { owner, relay, name, members, storage_mb, retention_days, days = SLOT_DAYS, now }) {
  if (typeof store?.secret !== 'string' || !/^([0-9a-f]{2})+$/.test(store.secret) || !isObject(store.genesis)) throw new Error('not a plain identity file (secret, genesis, rotations): a sealed or keychain identity signs no slot here');
  const rotations = store.rotations ?? [], current = rotations.length ? rotations.at(-1).next_genesis : store.genesis, iss = didOf(current);
  if (!Number.isSafeInteger(days) || days < 1 || days > SLOT_DAYS) throw new Error(`--days: 1 to ${SLOT_DAYS}`);
  const attestation = attest({ secret: Uint8Array.from(Buffer.from(store.secret, 'hex')), iss, sub: owner, iat: now, exp: now + days * DAY, ctx: SLOT_CTX, admission: 'invite', admission_by: iss,
    claims: { relay, name, members, storage_mb, retention_days } });
  const raw = { attestation, issuer: store.genesis, rotations };
  const v = checkSlot(raw, { host: relay, operator: didOf(store.genesis), now });
  if (!v.ok) throw new Error(v.why);
  return raw;
}

// node home.mjs slot issue …: the operator signs a supergroup slot (GROUPS.md "Supergroups"), on its own
// machine (the identity never needs to be on the relay). node home.mjs slot <file|->: loads one beside the
// running relay (RELAY_DB, RELAY_HOST, RELAY_OPERATOR_DID as the relay's; the relay must have run this
// version once, for its tables). The slot file is laid out as a licence file ({attestation, issuer, rotations}).
const USAGE = `usage:
  node home.mjs slot issue <operator identity file> <owner original DID> <name> --members N --storage-mb N --retention-days N [--days 366] [--relay host]
      → the slot file on stdout (--relay: default RELAY_HOST)
  node home.mjs slot <file|->   loads it here (RELAY_DB, RELAY_HOST, RELAY_OPERATOR_DID: the relay's)`;
const isMain = () => { try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } };
if (process.argv[1] && isMain()) {
  const [verb, file, ...rest] = process.argv.slice(2);
  const die = (why) => { console.error(`home: ${why}`); process.exit(1); };
  if (verb !== 'slot' || !file) die(USAGE);
  const now = Math.floor(Date.now() / 1000);
  if (file === 'issue') {
    const flags = new Map(), args = [];
    for (let i = 0; i < rest.length; i++) {
      if (!rest[i].startsWith('--')) { args.push(rest[i]); continue; }
      if (!['--members', '--storage-mb', '--retention-days', '--days', '--relay'].includes(rest[i]) || rest[i + 1] === undefined || flags.has(rest[i])) die(USAGE);
      flags.set(rest[i], rest[++i]);
    }
    const num = (f, d) => { const v = flags.get(f) ?? d; if (v === undefined) die(`${f} is needed\n${USAGE}`); if (!/^\d+$/.test(String(v))) die(`${f}: a whole number`); return Number(v); };
    if (args.length !== 3) die(USAGE);
    let store;
    try { store = parseBytes(readFileSync(args[0])); } catch (e) { die(`${args[0]}: ${e.message}`); }
    const relay = flags.get('--relay') ?? process.env.RELAY_HOST;
    if (!relay) die('--relay: the relay\'s host (or RELAY_HOST)');
    let raw;
    try {
      raw = issueSlot(store, { owner: args[1], relay, name: args[2], members: num('--members'), storage_mb: num('--storage-mb'), retention_days: num('--retention-days'), days: num('--days', SLOT_DAYS), now });
    } catch (e) { die(e.message); }
    process.stdout.write(canonicalize(raw) + '\n');
    const c = raw.attestation.body.claims;
    console.error(`home: slot ${c.name}@${c.relay} for ${raw.attestation.body.sub}: ${c.members} members, ${c.storage_mb} MB, ${c.retention_days} days, until ${new Date(raw.attestation.body.exp * 1000).toISOString().slice(0, 10)}`);
    process.exit(0);
  }
  const path = process.env.RELAY_DB || '/var/lib/sigelo-relay/relay.db';
  let raw;
  try { raw = parseBytes(readFileSync(file === '-' ? 0 : file)); } catch (e) { die(`${file}: ${e.message}`); }
  const v = checkSlot(raw, { host: process.env.RELAY_HOST, operator: process.env.RELAY_OPERATOR_DID, now });
  if (!v.ok) die(v.why);
  if (!existsSync(path)) die(`no relay database at ${path} (RELAY_DB)`);
  const db = new DatabaseSync(path);
  db.exec('PRAGMA busy_timeout = 5000');
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'home_names'").get()) die(`${path} has no home_names table: start this relay version once, then load`);
  db.exec('BEGIN IMMEDIATE');
  let r;
  try { r = storeSlot(raw, v.body, db, now); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); die(e.message); }
  db.close();
  console.log(`home: slot ${r.name} until ${new Date(r.exp * 1000).toISOString().slice(0, 10)}`);
}
