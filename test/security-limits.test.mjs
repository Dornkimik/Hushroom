import { randomUUID } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Security, sessionCapacity, validateOrigin } from '../lib/security.mjs';
import { Histories } from '../lib/histories.mjs';

const req = (ip, forwarded) => ({ socket: { remoteAddress: ip }, headers: { ...(forwarded ? { 'x-forwarded-for': forwarded } : {}) } });
test('production requires an exact HTTPS origin instead of silently omitting transport protection', () => {
  assert.equal(validateOrigin('https://silenzachat.cc', true), 'https://silenzachat.cc');
  assert.equal(validateOrigin(undefined), undefined);
  assert.equal(validateOrigin('http://127.0.0.1:3000'), 'http://127.0.0.1:3000');
  for (const value of [undefined, '', 'http://silenzachat.cc']) assert.throws(() => validateOrigin(value, true), /Production requires/);
  for (const value of ['https://silenzachat.cc/', 'https://silenzachat.cc/chat', 'https://u:p@silenzachat.cc', 'https://silenzachat.cc?x=1', 'invalid']) {
    assert.throws(() => validateOrigin(value), /exact HTTP or HTTPS origin/);
  }
});
test('proxy trust stops spoofing and isolates legitimate clients and username throttles', () => {
  const direct = new Security();
  assert.equal(direct.client(req('127.0.0.1', '192.0.2.1')), direct.client(req('127.0.0.1', '192.0.2.2')));
  assert.equal(direct.client(req('::ffff:127.0.0.1')), direct.client(req('127.0.0.1')));
  const proxy = new Security({ trustedProxies: '127.0.0.1,10.0.0.0/8,2001:db8:ffff::/48' });
  const alice = proxy.client(req('127.0.0.1', '198.51.100.1, 10.0.0.2'));
  const bob = proxy.client(req('127.0.0.1', '198.51.100.2, 10.0.0.2'));
  assert.notEqual(alice, bob);
  assert.equal(alice, proxy.client(req('127.0.0.1', '203.0.113.66, 198.51.100.1, 10.0.0.2')));
  assert.equal(alice, proxy.client(req('2001:db8:ffff::1', '198.51.100.1')));
  assert.throws(() => proxy.client(req('127.0.0.1')), /trusted proxy/);
  assert.throws(() => proxy.client(req('127.0.0.1', 'bad-address')), /Invalid forwarded/);
  assert.throws(() => new Security({ trustedProxies: '0.0.0.0/33' }), /TRUSTED_PROXY_ADDRESSES/);
  for (let i = 0; i < 10; i++) proxy.auth(alice, 'SameAccount');
  assert.throws(() => proxy.auth(alice, 'SameAccount'), { status: 429 });
  assert.doesNotThrow(() => proxy.auth(bob, 'SameAccount'));
});

test('guest and service-wide limits reset, bound state, and reserve account capacity', () => {
  let now = 0;
  const guard = new Security({ now: () => now });
  for (let i = 0; i < 30; i++) guard.guest('client');
  assert.throws(() => guard.guest('client'), { status: 429 });
  now = 600000; assert.doesNotThrow(() => guard.guest('client'));
  // No service-wide bucket: many busy clients cannot lock out a new visitor.
  for (let i = 0; i < 2000; i++) guard.guest(`client-${i}`);
  assert.doesNotThrow(() => guard.guest('another'));
  for (let i = 0; i < 3000; i++) guard.auth(`client-${i}`, 'name');
  assert.doesNotThrow(() => guard.auth('another', 'name'));
  const sessions = new Map(Array.from({ length: 4000 }, (_, i) => [i, { id: String(i) }]));
  assert.throws(() => sessionCapacity(sessions), { status: 503 });
  assert.doesNotThrow(() => sessionCapacity(sessions, 'member'));
  for (let i = 0; i < 10; i++) sessions.set(`member-${i}`, { accountId: 'member' });
  assert.throws(() => sessionCapacity(sessions, 'member'), { status: 429 });
  assert.doesNotThrow(() => sessionCapacity(sessions, 'member', sessions.get('member-0')));
});

test('private budgets cover send/edit, release deletions, expire while peers remain, and clean orphan attachments', () => {
  let now = 0;
  const removed = [], attachments = { remove: id => { if (id) removed.push(id); } };
  const history = new Histories({ attachments, now: () => now, maxBytes: 250, perUserBytes: 180, perUserConversations: 2, ttl: 100 });
  const small = [{ id: 'm', sender: 'a', encrypted: 'x'.repeat(20), attachment: { id: 'image' } }];
  history.set('dm:a:b', small);
  const firstBytes = history.bytes;
  assert.throws(() => history.set('dm:a:b', [{ sender: 'a', encrypted: 'x'.repeat(181) }]), { status: 503 });
  assert.equal(history.bytes, firstBytes); assert.deepEqual(history.get('dm:a:b'), small);
  history.set('dm:a:c', [{ sender: 'a', encrypted: 'x' }]);
  assert.throws(() => history.set('dm:a:d', [{ sender: 'a', encrypted: 'x' }]), { status: 503 });
  history.set('dm:a:c', []);
  assert.doesNotThrow(() => history.set('dm:a:d', [{ sender: 'a', encrypted: 'x' }]));
  history.sweep(new Set(['a', 'd']));
  assert.equal(history.has('dm:a:b'), false); assert.ok(removed.includes('image'));
  now = 100; assert.equal(history.get('dm:a:d'), undefined);
  assert.equal(history.bytes, 0); assert.equal(history.users.size, 0);
  const global = new Histories({ maxBytes: 50, perUserBytes: 1000 });
  global.set('dm:a:b', [{ encrypted: 'x'.repeat(20) }]);
  assert.throws(() => global.set('dm:c:d', [{ encrypted: 'x'.repeat(20) }]), { status: 503 });
  global.delete('dm:a:b'); assert.equal(global.bytes, 0);
  assert.doesNotThrow(() => global.set('dm:c:d', [{ encrypted: 'x'.repeat(20) }]));
});

test('private quotas charge only the sender, so a victim cannot be filled up by others', () => {
  const history = new Histories({ perUserBytes: 320, perUserConversations: 2, maxBytes: 100000, perClientBytes: 100000 });
  const msg = (sender, size = 20) => ({ id: randomUUID(), sender, encrypted: 'x'.repeat(size) });
  // Three attackers start conversations with the victim and send a lot; none of it counts against the victim.
  for (const attacker of ['x1', 'x2', 'x3']) history.set(`dm:${attacker}:v`, [msg(attacker, 150)]);
  assert.doesNotThrow(() => history.set('dm:v:w', [msg('v', 150)]));
  assert.doesNotThrow(() => history.set('dm:v:y', [msg('v', 20)]));
  // The victim's own sending is still bounded.
  assert.throws(() => history.set('dm:v:z', [msg('v', 20)]), { status: 503 });
  assert.throws(() => history.set('dm:x1:v', [msg('x1', 150), msg('x1', 150)]), { status: 503 });
  history.delete('dm:v:y'); assert.doesNotThrow(() => history.set('dm:v:z', [msg('v', 20)]));
});

test('IPv6 clients in one /48 share network-wide buckets', () => {
  const security = new Security({ trustedProxies: '100.64.0.0/10', clientIpHeader: 'X-Real-IP' });
  const from = ip => security.client({ socket: { remoteAddress: '100.64.0.2' }, headers: { 'x-real-ip': ip } });
  const keys = Array.from({ length: 8 }, (_, i) => from(`2001:db8:1:${(i + 1).toString(16)}::1`));
  assert.equal(new Set(keys).size, 8);
  let blocked = false;
  for (const key of keys) for (let i = 0; i < 30; i++) { try { security.guest(key); } catch (e) { assert.equal(e.status, 429); blocked = true; } }
  assert.equal(blocked, true); // 8 × 30 exceeds the /48's shared allowance of 120.
  assert.doesNotThrow(() => security.guest(from('2001:db8:2::1')));
  assert.doesNotThrow(() => security.guest(from('198.51.100.7')));
  const sessions = new Map(keys.flatMap((key, k) => Array.from({ length: 15 }, (_, i) => [`${k}-${i}`, { id: `${k}-${i}`, clientKey: key }])));
  assert.throws(() => sessionCapacity(sessions, undefined, undefined, from('2001:db8:1:99::1')), { status: 429 });
  assert.doesNotThrow(() => sessionCapacity(sessions, undefined, undefined, from('2001:db8:2::1')));
});
