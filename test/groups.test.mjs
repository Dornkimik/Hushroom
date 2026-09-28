import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import nacl from 'tweetnacl';
import crypto from '../public/crypto.js';
import { Groups } from '../lib/groups.mjs';

function setup() {
  let time = Date.now(); const events = [];
  const users = ['a', 'b', 'c', 'd'].map(alias => {
    const identity = nacl.box.keyPair(); return { id: randomUUID(), alias, identity, publicKey: crypto.base64(identity.publicKey), sent: [] };
  });
  const store = new Groups({ now: () => time, emit: (u, event, data) => events.push({ user: u.id, event, data }), broadcast: () => {},
    safeUser: u => ({ id: u.id, alias: u.alias, displayAsAdmin: false }), findUser: id => users.find(u => u.id === id) });
  const call = (u, action, input = {}, method = 'POST') => store.handle(method, action, u, input);
  const send = (u, group, text = 'secret group sentinel', replyTo) => {
    const state = call(u, 'state', { group }, 'GET'), id = randomUUID();
    return { group, id, version: state.version, replyTo, envelopes: crypto.encryptGroupMessage({ id, group, version: state.version, sender: u.id, text, replyTo }, u.identity, state.members) };
  };
  return { store, users, events, call, send, advance: ms => { time += ms; } };
}
test('temporary encrypted rooms enforce invitation, ownership, membership versions, counts and deletion', () => {
  const { store, users: [a,b,c,d], events, call, send } = setup();
  const room = call(a, 'create', { name: 'Test room', description: 'Description', rules: 'Be kind', access: 'invite' });
  const group = room.id;
  assert.equal(room.owner, a.id); assert.equal(room.rules, 'Be kind');
  assert.deepEqual(call(b, '', {}, 'GET'), []);
  assert.throws(() => call(b, 'join', { group }), /invitation/);
  assert.throws(() => call(b, 'state', { group }, 'GET'), /Join/);
  assert.throws(() => call(b, 'history', { group }, 'GET'), /Join/);
  assert.throws(() => call(a, 'message', { group, text: 'plaintext' }), /ciphertext/);
  const early = call(a, 'message', send(a, group, 'before anyone joined'));
  call(a, 'invite', { group, member: b.id });
  assert.equal(call(b, '', {}, 'GET')[0].invited, true);
  const stale = send(a, group);
  call(b, 'join', { group });
  assert.throws(() => call(a, 'message', stale), /Membership changed/);
  assert.deepEqual(call(b, 'history', { group }, 'GET'), []);
  assert.throws(() => call(b, 'message', send(b, group, 'quote hidden history', early.id)), /reply/);
  assert.throws(() => call(b, 'update', { group, name: 'stolen' }), /owner/);
  assert.throws(() => call(b, 'delete', { group }), /owner/);
  assert.throws(() => call(b, 'transfer', { group, member: b.id }), /owner/);
  assert.throws(() => call(b, 'kick', { group, member: a.id }), /owner/);
  assert.throws(() => call(b, 'invite', { group, member: c.id }), /owner/);
  const payload = send(a, group), message = call(a, 'message', payload);
  assert.ok(!JSON.stringify(message).includes('secret group sentinel'));
  assert.equal(message.envelopes, undefined);
  const delivered = events.find(e => e.user === b.id && e.event === 'message' && e.data.id === message.id).data;
  assert.equal(crypto.decryptGroupMessage(delivered, b.id, b.identity, a.publicKey).text, 'secret group sentinel');
  assert.equal(crypto.decryptGroupMessage(message, a.id, a.identity, a.publicKey).text, 'secret group sentinel');
  assert.ok(!events.some(e => e.user === c.id && e.event === 'message'));
  assert.equal(call(a, 'message', payload).id, message.id);
  assert.equal(call(a, 'state', { group }, 'GET').members.find(m => m.id === a.id).messages, 2);
  assert.ok(call(b, 'state', { group }, 'GET').members.every(m => !Object.hasOwn(m, 'messages')));
  assert.throws(() => call(b, 'message-delete', { group, id: message.id }), /sender or room owner/);
  const reply = call(b, 'message', send(b, group, 'reply', message.id));
  call(a, 'message-delete', { group, id: message.id });
  const history = call(b, 'history', { group }, 'GET');
  assert.equal(history.find(m => m.id === reply.id).reply.removed, true);
  assert.equal(crypto.decryptGroupMessage(history.find(m => m.id === reply.id), b.id, b.identity, b.publicKey).text, 'reply');
  assert.equal(call(a, 'state', { group }, 'GET').members.find(m => m.id === a.id).messages, 2);
  call(a, 'update', { group, name: 'Open now', description: 'Changed', rules: 'New rules', access: 'open' });
  assert.equal(call(c, '', {}, 'GET')[0].name, 'Open now');
  call(c, 'join', { group });
  assert.deepEqual(call(c, 'history', { group }, 'GET'), []);
  assert.throws(() => call(a, 'leave', { group }), /Transfer/);
  const beforeKick = send(b, group);
  call(a, 'transfer', { group, member: b.id });
  assert.throws(() => call(a, 'kick', { group, member: c.id }), /owner/);
  call(b, 'kick', { group, member: c.id });
  assert.throws(() => call(b, 'message', beforeKick), /Membership changed/);
  assert.throws(() => call(c, 'join', { group }), /cannot rejoin/);
  assert.throws(() => call(c, 'history', { group }, 'GET'), /Join/);
  assert.throws(() => call(c, 'message', { group }), /Join/);
  const next = send(b, group); assert.equal(next.envelopes[c.id], undefined);
  const afterKick = call(b, 'message', next);
  assert.ok(!events.some(e => e.user === c.id && e.event === 'message' && e.data.id === afterKick.id));
  assert.throws(() => crypto.decryptGroupMessage(afterKick, c.id, c.identity, b.publicKey), /authenticated/);
  assert.throws(() => call(d, 'message-delete', { group, id: afterKick.id }), /Join/);
  call(b, 'delete', { group });
  assert.equal(store.bytes, 0); assert.equal(store.rooms.size, 0);
  assert.throws(() => call(a, 'history', { group }, 'GET'), /expired or was deleted/);
});

test('group encryption binds sender, recipient, room, message, reply and membership version', () => {
  const { users: [a,b,c], call, send } = setup();
  const group = call(a, 'create', { name: 'Group' }).id; call(b, 'join', { group });
  const payload = send(a, group), message = call(a, 'message', payload);
  const received = { ...message, encrypted: payload.envelopes[b.id] };
  for (const change of [{ group: 'different' }, { id: 'different' }, { sender: b.id }, { version: 999 }, { reply: { id: 'fake' } }]) {
    assert.throws(() => crypto.decryptGroupMessage({ ...received, ...change }, b.id, b.identity, a.publicKey), /metadata/);
  }
  assert.throws(() => crypto.decryptGroupMessage(received, c.id, b.identity, a.publicKey), /metadata/);
  assert.throws(() => crypto.decryptGroupMessage(received, b.id, b.identity, c.publicKey), /authenticated/);
  const bytes = crypto.unbase64(received.encrypted.ciphertext); bytes[0] ^= 1;
  assert.throws(() => crypto.decryptGroupMessage({ ...received, encrypted: { ...received.encrypted, ciphertext: crypto.base64(bytes) } }, b.id, b.identity, a.publicKey), /authenticated/);
  assert.notEqual(payload.envelopes[a.id].nonce, payload.envelopes[b.id].nonce);
});

test('temporary rooms expire, clean up removed users, and enforce limits and complete recipient sets', () => {
  const { store, users: [a,b,c], call, send, advance } = setup();
  const group = call(a, 'create', { name: 'Temporary' }).id;
  call(b, 'join', { group });
  const earlier = call(a, 'message', send(a, group));
  call(b, 'leave', { group }); call(b, 'join', { group });
  assert.deepEqual(call(b, 'history', { group }, 'GET'), []);
  assert.throws(() => call(b, 'message', send(b, group, 'quote prior membership', earlier.id)), /reply/);
  const missing = send(a, group); delete missing.envelopes[b.id];
  assert.throws(() => call(a, 'message', missing), /every current member/);
  const extra = send(a, group); extra.envelopes[c.id] = extra.envelopes[b.id];
  assert.throws(() => call(a, 'message', extra), /every current member/);
  call(a, 'message', send(a, group));
  store.removeUser(a.id);
  assert.equal(call(b, 'state', { group }, 'GET').owner, b.id);
  store.removeUser(b.id); assert.equal(store.rooms.size, 0); assert.equal(store.bytes, 0);
  const expires = call(c, 'create', { name: 'Expires' });
  advance(24 * 3600000);
  assert.throws(() => call(c, 'state', { group: expires.id }, 'GET'), /expired/);
  for (let i = 0; i < 3; i++) call(a, 'create', { name: `Room ${i}` });
  assert.throws(() => call(a, 'create', { name: 'Fourth' }), /Limit/);
  assert.throws(() => call(c, 'create', { name: '', rules: 'x'.repeat(2001) }), /40 characters/);
  assert.throws(() => call({ ...c, publicKey: undefined }, 'create', { name: 'Unsafe' }), /encryption/);
});
