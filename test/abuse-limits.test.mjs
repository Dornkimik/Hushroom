import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import nacl from 'tweetnacl';
import crypto from '../public/crypto.js';
import { Security, sessionCapacity, trustedProxyList, SESSIONS_PER_CLIENT } from '../lib/security.mjs';
import { Histories } from '../lib/histories.mjs';
import { Attachments, MAX_IMAGE_BYTES } from '../lib/attachments.mjs';
import { Groups } from '../lib/groups.mjs';

const req = (ip, forwarded) => ({ socket: { remoteAddress: ip }, headers: forwarded ? { 'x-forwarded-for': forwarded } : {} });

test('Cloudflare preset attributes CDN traffic to the visitor, not the shared edge', () => {
  assert.throws(() => trustedProxyList('', 'akamai'), /TRUSTED_PROXY_PRESET/);
  const security = new Security({ trustedProxies: trustedProxyList('10.0.0.0/8', 'cloudflare') });
  assert.equal(security.configured, true);
  const alice = security.client(req('10.1.2.3', '198.51.100.1, 162.158.1.1'));
  const bob = security.client(req('10.1.2.3', '198.51.100.2, 162.158.1.1'));
  assert.notEqual(alice, bob);
  assert.equal(alice, security.client(req('10.1.2.3', '198.51.100.1, 104.16.0.9')));
  // A spoofed leftmost entry cannot override the address Cloudflare appended.
  assert.equal(alice, security.client(req('10.1.2.3', '203.0.113.5, 198.51.100.1, 162.158.1.1')));
  assert.equal(new Security().configured, false);
});

test('Railway X-Real-IP is used only from the trusted edge, and IPv6 /64 counts as one client', () => {
  assert.throws(() => new Security({ clientIpHeader: 'bad header' }), /CLIENT_IP_HEADER/);
  const security = new Security({ trustedProxies: '100.64.0.0/10', clientIpHeader: 'X-Real-IP' });
  const viaEdge = (real, forwarded = '172.70.240.62, 79.127.178.81') => ({ socket: { remoteAddress: '100.64.0.2' }, headers: { 'x-real-ip': real, 'x-forwarded-for': forwarded } });
  const visitor = security.client(viaEdge('2003:f7:d742:db00:ad1d:c8ec:f168:bf13'));
  assert.equal(visitor, security.client(viaEdge('2003:f7:d742:db00::1')));
  assert.notEqual(visitor, security.client(viaEdge('2003:f7:d742:db01::1')));
  assert.notEqual(visitor, security.client(viaEdge('198.51.100.1')));
  // Different visitors behind the same Cloudflare edge stay separate.
  assert.notEqual(security.client(viaEdge('198.51.100.1')), security.client(viaEdge('198.51.100.2')));
  assert.throws(() => security.client(viaEdge(undefined)), { status: 503 });
  assert.throws(() => security.client(viaEdge('1.2.3.4, 5.6.7.8')), { status: 503 });
  // A direct, untrusted peer cannot choose its identity with the header.
  const direct = { socket: { remoteAddress: '203.0.113.9' }, headers: { 'x-real-ip': '198.51.100.1' } };
  assert.equal(security.client(direct), security.client({ socket: { remoteAddress: '203.0.113.9' }, headers: {} }));
  assert.notEqual(security.client(direct), security.client(viaEdge('198.51.100.1')));
});

test('one network cannot hold the shared guest capacity, register in bulk, or return after a ban', () => {
  let now = 0;
  const sessions = new Map(Array.from({ length: SESSIONS_PER_CLIENT }, (_, i) => [i, { id: String(i), clientKey: 'attacker' }]));
  assert.throws(() => sessionCapacity(sessions, undefined, undefined, 'attacker'), { status: 429 });
  assert.doesNotThrow(() => sessionCapacity(sessions, undefined, undefined, 'visitor'));
  assert.throws(() => sessionCapacity(sessions, 'account', undefined, 'attacker'), { status: 429 });
  const security = new Security({ now: () => now });
  for (let i = 0; i < 5; i++) security.register('attacker');
  assert.throws(() => security.register('attacker'), { status: 429 });
  assert.doesNotThrow(() => security.register('visitor'));
  security.banClient('attacker', 'banned-id');
  assert.equal(security.clientBanned('attacker'), true); assert.equal(security.clientBanned('visitor'), false);
  security.unbanClient('banned-id'); assert.equal(security.clientBanned('attacker'), false);
  security.banClient('attacker', 'banned-id'); now = 86400000;
  assert.equal(security.clientBanned('attacker'), false);
});

test('private history storage is charged to the sending network, leaving room for others', () => {
  const owners = { a1: 'attacker', a2: 'attacker', a3: 'attacker', a4: 'attacker', v: 'victim', w: 'witness' };
  const history = new Histories({ clientOf: id => owners[id], perClientBytes: 600, perUserBytes: 10000, maxBytes: 100000 });
  const msg = (sender, size = 150) => ({ id: randomUUID(), sender, encrypted: 'x'.repeat(size) });
  history.set('dm:a1:a2', [msg('a1'), msg('a2')]);
  assert.throws(() => history.set('dm:a3:a4', [msg('a3'), msg('a4')]), { status: 503 });
  // Messages the attacker sends to a victim count against the attacker, not the victim.
  assert.throws(() => history.set('dm:a3:v', [msg('a3')]), { status: 503 });
  assert.doesNotThrow(() => history.set('dm:v:w', [msg('v'), msg('w')]));
  assert.doesNotThrow(() => history.set('dm:a1:v', [msg('v')]));
  // Shrinking or deleting existing data is always allowed.
  assert.doesNotThrow(() => history.set('dm:a1:a2', [msg('a1', 10)]));
  assert.doesNotThrow(() => history.set('dm:a3:a4', [msg('a3')]));
});

test('encrypted image storage has a per-network share', async () => {
  const attachments = new Attachments({ maxBytes: 1024 * 1024 * 1024, perUser: 1024 * 1024 * 1024, perClient: MAX_IMAGE_BYTES + 48 });
  const bytes = () => Readable.from([new Uint8Array(32)]);
  await attachments.upload(bytes(), 'a1', 'v', {}, 'attacker');
  await attachments.upload(bytes(), 'a2', 'v', {}, 'attacker');
  await assert.rejects(attachments.upload(bytes(), 'a3', 'v', {}, 'attacker'), { status: 429 });
  await attachments.upload(bytes(), 'v', 'a1', {}, 'victim');
});

test('temporary rooms limit how many rooms and bytes one network can hold, without exposing the network key', () => {
  const user = (clientKey) => { const identity = nacl.box.keyPair(); return { id: randomUUID(), alias: 'x', identity, publicKey: crypto.base64(identity.publicKey), sent: [], clientKey }; };
  const events = [];
  const store = new Groups({ emit: (u, event, data) => events.push(data), broadcast: () => {}, safeUser: u => ({ id: u.id, alias: u.alias, displayAsAdmin: false }), findUser: () => null });
  const attackers = [user('attacker'), user('attacker'), user('attacker')];
  for (const a of attackers.slice(0, 2)) for (let i = 0; i < 3; i++) store.handle('POST', 'create', a, { name: `r${i}` });
  assert.throws(() => store.handle('POST', 'create', attackers[2], { name: 'seventh' }), { status: 429 });
  const visitor = user('visitor');
  const room = store.handle('POST', 'create', visitor, { name: 'mine' });
  const id = randomUUID();
  const envelopes = crypto.encryptGroupMessage({ id, group: room.id, version: room.version, sender: visitor.id, text: 'hello' }, visitor.identity, room.members);
  const sent = store.handle('POST', 'message', visitor, { group: room.id, id, version: room.version, envelopes });
  assert.equal(JSON.stringify(sent).includes('visitor'), false);
  assert.equal(JSON.stringify(events).includes('"visitor"'), false);
});

test('encrypted envelopes authenticate the sender time and keep legacy edits time-free', () => {
  const a = nacl.box.keyPair(), b = nacl.box.keyPair(), id = randomUUID();
  const base = { id, sender: 'a', recipient: 'b', text: 'hi' };
  const message = (encrypted, extra = {}) => ({ id, sender: 'a', recipient: 'b', room: null, encrypted, reply: null, attachment: null, ...extra });
  const timed = crypto.encryptMessage({ ...base, sentAt: 1790000000000 }, a, crypto.base64(b.publicKey));
  assert.equal(crypto.decryptMessage(message(timed), 'b', b, crypto.base64(a.publicKey)).sentAt, 1790000000000);
  const now = crypto.encryptMessage(base, a, crypto.base64(b.publicKey));
  assert.ok(Math.abs(crypto.decryptMessage(message(now), 'b', b, crypto.base64(a.publicKey)).sentAt - Date.now()) < 5000);
  const legacy = crypto.encryptMessage({ ...base, sentAt: null, editVersion: 1 }, a, crypto.base64(b.publicKey));
  assert.equal('sentAt' in crypto.decryptMessage(message(legacy, { editVersion: 1 }), 'b', b, crypto.base64(a.publicKey)), false);
  assert.throws(() => crypto.encryptMessage({ ...base, sentAt: 5 }, a, crypto.base64(b.publicKey)), /time/);
  const members = [{ id: 'a', publicKey: crypto.base64(a.publicKey) }, { id: 'b', publicKey: crypto.base64(b.publicKey) }];
  const envelopes = crypto.encryptGroupMessage({ id, group: 'g', version: 1, sender: 'a', text: 'room', sentAt: 1790000000001 }, a, members);
  const view = { id, group: 'g', version: 1, sender: 'a', encrypted: envelopes.b, reply: null, attachment: null };
  assert.equal(crypto.decryptGroupMessage(view, 'b', b, crypto.base64(a.publicKey)).sentAt, 1790000000001);
});
