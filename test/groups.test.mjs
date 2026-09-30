import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import nacl from 'tweetnacl';
import crypto from '../public/crypto.js';
import { Groups } from '../lib/groups.mjs';
import { Attachments } from '../lib/attachments.mjs';
import { Readable } from 'node:stream';

function setup() {
  let time = Date.now(); const events = [];
  const users = ['a', 'b', 'c', 'd'].map(alias => {
    const identity = nacl.box.keyPair(); return { id: randomUUID(), alias, identity, publicKey: crypto.base64(identity.publicKey), sent: [] };
  });
  const attachments = new Attachments({ now: () => time });
  const store = new Groups({ isAdmin: u => u.role === 'admin', attachments, now: () => time, emit: (u, event, data) => events.push({ user: u.id, event, data }), broadcast: () => {},
    safeUser: u => ({ id: u.id, alias: u.alias, displayAsAdmin: false }), findUser: id => users.find(u => u.id === id) });
  const call = (u, action, input = {}, method = 'POST') => store.handle(method, action, u, input);
  const send = (u, group, text = 'secret group sentinel', replyTo) => {
    const state = call(u, 'state', { group }, 'GET'), id = randomUUID();
    return { group, id, version: state.version, replyTo, envelopes: crypto.encryptGroupMessage({ id, group, version: state.version, sender: u.id, text, replyTo }, u.identity, state.members) };
  };
  return { store, attachments, users, events, call, send, advance: ms => { time += ms; } };
}

test('group images authenticate descriptors, isolate memberships and clean up with messages and rooms', async () => {
  const { store, attachments, users: [a,b,c], call, send, advance } = setup();
  const group = call(a, 'create', { name: 'Images' }).id; call(b, 'join', { group });
  const plain = new TextEncoder().encode('private group image bytes'), encrypted = crypto.encryptImage(plain);
  async function upload(room = group, peer = null) {
    const version = store.get(room).version;
    return attachments.upload(Readable.from([encrypted.bytes]), a.id, peer, peer ? {} : { group: room, version });
  }
  function payload(id, room = group) {
    const state = call(a, 'state', { group: room }, 'GET'), mid = randomUUID();
    const image = { id, key: encrypted.key, nonce: encrypted.nonce, type: 'image/webp', width: 1, height: 1, size: plain.length };
    return { id: mid, group: room, version: state.version, attachmentId: id,
      envelopes: crypto.encryptGroupMessage({ id: mid, group: room, version: state.version, sender: a.id, text: '', image }, a.identity, state.members) };
  }
  const first = await upload();
  assert.throws(() => attachments.get(first.id, b.id), /unavailable/);
  const imagePayload = payload(first.id), message = call(a, 'message', imagePayload);
  assert.equal(call(a, 'message', imagePayload).id, message.id);
  const received = call(b, 'history', { group }, 'GET')[0];
  const decoded = crypto.decryptGroupMessage(received, b.id, b.identity, a.publicKey);
  assert.equal(decoded.text, '');
  assert.deepEqual(crypto.decryptImage(attachments.get(first.id, b.id).bytes, decoded.image), plain);
  assert.throws(() => crypto.decryptGroupMessage({ ...received, attachment: { id: 'substituted' } }, b.id, b.identity, a.publicKey), /metadata/);
  assert.throws(() => crypto.decryptGroupMessage({ ...received, attachment: null }, b.id, b.identity, a.publicKey), /metadata/);
  assert.throws(() => attachments.get(first.id, c.id), /unavailable/);
  call(c, 'join', { group }); assert.throws(() => store.checkAttachment(attachments.items.get(first.id), c), /unavailable/);
  call(a, 'kick', { group, member: b.id }); assert.throws(() => store.checkAttachment(attachments.items.get(first.id), b), /unavailable/);
  call(a, 'message-delete', { group, id: message.id }); assert.equal(attachments.items.has(first.id), false);
  const otherRoom = call(a, 'create', { name: 'Other' }).id;
  const uploadOther = await upload(otherRoom);
  assert.throws(() => call(a, 'message', payload(uploadOther.id)), /Invalid image/);
  const dm = await upload(group, c.id);
  assert.throws(() => call(a, 'message', payload(dm.id)), /Invalid image/);
  const pending = await upload();
  assert.throws(() => attachments.claim(pending.id, a.id, null, randomUUID()), /Invalid/);
  call(c, 'leave', { group }); call(c, 'join', { group });
  assert.throws(() => call(a, 'message', payload(pending.id)), /membership changed/);
  const published = await upload(); const posted = call(a, 'message', payload(published.id));
  call(c, 'leave', { group }); call(c, 'join', { group });
  assert.throws(() => store.checkAttachment(attachments.items.get(published.id), c), /unavailable/);
  // Evicting a message also removes its encrypted image bytes.
  for (let i = 0; i < 100; i++) { advance(10001); call(a, 'message', send(a, group)); }
  assert.ok(!store.get(group).history.some(m => m.id === posted.id)); assert.equal(attachments.items.has(published.id), false);
  const finalUpload = await upload(); call(a, 'message', payload(finalUpload.id));
  call(a, 'delete', { group });
  assert.equal(attachments.items.has(finalUpload.id), false); assert.equal(attachments.items.has(pending.id), false);
  const expiring = await upload(otherRoom); call(a, 'message', payload(expiring.id, otherRoom));
  advance(86400000); assert.throws(() => attachments.get(expiring.id, a.id), /unavailable/);
});
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


test('admin room moderation preserves encryption boundaries and cleans up deleted rooms', async () => {
  const { store, attachments, users: [owner, admin], call, send, events, advance } = setup();
  const room = call(owner, 'create', { name: 'Private room', access: 'invite' });
  assert.throws(() => store.moderate('list', admin), /Unlock/);
  admin.role = 'admin';
  const message = call(owner, 'message', send(owner, room.id));
  const upload = await attachments.upload(Readable.from([new Uint8Array(32)]), owner.id, null, { group: room.id, version: room.version });
  assert.equal(store.moderate('list', admin)[0].id, room.id);
  for (const invalid of [{ name: '' }, { name: 'x'.repeat(41) }, { description: 'x'.repeat(121) }, { rules: 'x'.repeat(2001) }, { access: 'invalid' }]) {
    assert.throws(() => store.moderate('update', admin, { group: room.id, name: 'Valid', ...invalid }), /Use a name|Choose open/);
  }
  const changed = store.moderate('update', admin, { group: room.id, name: 'Updated', rules: 'Rules', access: 'invite' });
  assert.equal(changed.owner, owner.id); assert.equal(changed.version, room.version);
  assert.equal(changed.joined, false); assert.equal(changed.count, 1);
  assert.equal(changed.history, undefined); assert.equal(changed.members, undefined);
  assert.throws(() => call(admin, 'history', { group: room.id }, 'GET'), /Join/);
  assert.equal(call(owner, 'history', { group: room.id }, 'GET')[0].id, message.id);
  assert.ok(events.some(e => e.user === owner.id && e.event === 'group-state' && e.data.name === 'Updated'));
  advance(3600001);
  assert.equal(store.moderate('list', admin)[0].id, room.id);
  admin.role = 'member';
  assert.throws(() => store.moderate('update', admin, { group: room.id, name: 'Expired admin' }), /Unlock/);
  assert.throws(() => store.moderate('delete', admin, { group: room.id }), /Unlock/);
  admin.role = 'admin';
  store.moderate('delete', admin, { group: room.id });
  assert.equal(store.bytes, 0); assert.equal(attachments.items.has(upload.id), false);
  assert.ok(events.some(e => e.user === owner.id && e.event === 'group-removed'));
  assert.throws(() => store.get(room.id), /expired or was deleted/);
});


test('editing group messages preserves original audience, ownership, replies, counts and byte accounting', () => {
  const { store, users: [a,b,c], events, call, send, advance } = setup();
  const room = call(a, 'create', { name: 'Edit room' }), group = room.id;
  call(b, 'join', { group });
  const message = call(a, 'message', send(a, group, 'Before'));
  const edit = (text, editVersion = 1) => {
    const state = call(a, 'message-edit-state', { group, id: message.id }, 'GET');
    return { group, id: message.id, membershipVersion: state.membershipVersion, editVersion,
      envelopes: crypto.encryptGroupMessage({ id: message.id, group, version: message.version, sender: a.id, text, editVersion }, a.identity, state.members) };
  };
  assert.throws(() => call(b, 'message-edit-state', { group, id: message.id }, 'GET'), /Your message/);
  assert.throws(() => call(b, 'message-edit', edit('Stolen')), /Your message/);
  const stale = edit('Before join'); call(c, 'join', { group });
  assert.throws(() => call(a, 'message-edit', stale), /Membership changed/);
  const valid = edit('After edit');
  assert.deepEqual(Object.keys(valid.envelopes).sort(), [a.id,b.id].sort());
  assert.throws(() => call(a, 'message-edit', { ...valid, text: 'plaintext' }), /ciphertext/);
  assert.throws(() => call(a, 'message-edit', { ...valid, envelopes: { ...valid.envelopes, [c.id]: valid.envelopes[a.id] } }), /original recipients/);
  const updated = call(a, 'message-edit', valid);
  assert.equal(updated.time, message.time); assert.equal(updated.editVersion, 1); assert.ok(updated.editedAt);
  assert.equal(crypto.decryptGroupMessage(updated, a.id, a.identity, a.publicKey).text, 'After edit');
  assert.throws(() => crypto.decryptGroupMessage({ ...updated, editVersion: 0 }, a.id, a.identity, a.publicKey), /metadata/);
  assert.deepEqual(call(c, 'history', { group }, 'GET'), []);
  assert.ok(!events.some(e => e.user === c.id && e.event === 'message-edited'));
  assert.ok(events.some(e => e.user === b.id && e.event === 'message-edited'));
  assert.equal(call(a, 'state', { group }, 'GET').members.find(m => m.id === a.id).messages, 1);
  assert.throws(() => call(a, 'message-edit', valid), /message changed/);
  call(a, 'kick', { group, member: b.id });
  const afterKick = edit('After kick', 2); assert.deepEqual(Object.keys(afterKick.envelopes), [a.id]);
  call(a, 'message-edit', afterKick);
  assert.equal(store.bytes, store.get(group).bytes);
  assert.equal(store.bytes, store.get(group).history.reduce((sum,m) => sum + m.bytes, 0));
  call(a, 'message-delete', { group, id: message.id }); assert.equal(store.bytes, 0);
  assert.throws(() => call(a, 'message-edit', afterKick), /Your message/);
  advance(10001);
});
