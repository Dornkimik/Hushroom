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
  for (let i = 0; i < 499; i++) guard.guest(`client-${i}`);
  assert.throws(() => guard.guest('another'), { status: 429 });
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
  const small = [{ id: 'm', encrypted: 'x'.repeat(20), attachment: { id: 'image' } }];
  history.set('dm:a:b', small);
  const firstBytes = history.bytes;
  assert.throws(() => history.set('dm:a:b', [{ encrypted: 'x'.repeat(181) }]), { status: 503 });
  assert.equal(history.bytes, firstBytes); assert.deepEqual(history.get('dm:a:b'), small);
  history.set('dm:a:c', [{ encrypted: 'x' }]);
  assert.throws(() => history.set('dm:a:d', [{ encrypted: 'x' }]), { status: 503 });
  history.set('dm:a:c', []);
  assert.doesNotThrow(() => history.set('dm:a:d', [{ encrypted: 'x' }]));
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
