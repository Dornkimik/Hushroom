import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import nacl from 'tweetnacl';
import encryption from '../public/crypto.js';
import { Blocks, userKey } from '../lib/blocks.mjs';

test('account blocks persist and serialize; guest blocks stay with their session', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'silenza-blocks-'));
  try {
    const blocks = new Blocks(dir); await blocks.load();
    const a = { id: 'a', accountId: 'alice' }, b = { id: 'b', accountId: 'bob' }, c = { id: 'c' };
    await Promise.all([blocks.update(a, userKey(b), 'Bob', true), blocks.update(a, userKey(c), 'Guest', true)]);
    const reloaded = new Blocks(dir); await reloaded.load();
    assert.equal(reloaded.between({ id: 'new-a', accountId: 'alice' }, { id: 'new-b', accountId: 'bob' }), true);
    assert.equal(reloaded.has(a, c), true);
    await reloaded.update(c, userKey(b), 'Bob', true);
    assert.equal(reloaded.has(c, b), true);
    assert.equal(reloaded.has({ id: 'other-guest' }, b), false);
    await reloaded.update(a, userKey(b), 'Bob', false);
    assert.equal(reloaded.has(a, b), false);
    assert.equal(reloaded.has(a, c), true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('private blocking covers account sessions, messages, edits and uploads; sidebar removal is personal and reversible', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'silenza-private-controls-'));
  const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  let child;
  async function boot() {
    child = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dir, ORIGIN: origin }, stdio: ['ignore', 'pipe', 'pipe'] });
    await once(child.stdout, 'data');
  }
  async function stop() { if (child?.exitCode === null) { const ended = once(child, 'exit'); child.kill(); await ended; } }
  async function request(user, route, body) {
    const response = await fetch(`${origin}/api/${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { Cookie: user.cookie || '', Origin: origin, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (response.headers.get('set-cookie')) user.cookie = response.headers.get('set-cookie').split(';')[0];
    return { status: response.status, data: await response.json() };
  }
  async function identity(user) {
    user.identity = nacl.box.keyPair();
    assert.equal((await request(user, 'identity', { publicKey: encryption.base64(user.identity.publicKey) })).status, 200);
  }
  function payload(a, b) {
    const id = randomUUID(); return { id, peer: b.me.id, encrypted: encryption.encryptMessage({ id, sender: a.me.id, recipient: b.me.id, text: 'Hello privately' }, a.identity, encryption.base64(b.identity.publicKey)) };
  }
  const a = {}, b = {}, b2 = {}, c = {};
  try {
    await boot();
    a.me = (await request(a, 'auth/register', { username: 'Alice', password: 'a long test password' })).data;
    b.me = (await request(b, 'auth/register', { username: 'Bobby', password: 'a long test password' })).data;
    b2.me = (await request(b2, 'auth/login', { username: 'Bobby', password: 'a long test password' })).data;
    c.me = (await request(c, 'session')).data.me;
    await Promise.all([a, b, b2, c].map(identity));
    const first = await request(b, 'message', payload(b, a)); assert.equal(first.status, 200);
    assert.equal((await request(a, 'private/hide', { peer: randomUUID() })).status, 200); // A stale chat can still be removed after its peer disappears.
    assert.equal((await request(a, 'private/hide', { peer: 'invalid' })).status, 400);
    assert.equal((await request(a, 'private/hide', { peer: b.me.id })).status, 200);
    assert.equal((await request(a, 'session')).data.conversations.length, 0);
    assert.equal((await request(b, 'session')).data.conversations.length, 1);
    assert.equal((await request(a, `history?peer=${b.me.id}`)).data.length, 1);
    await request(a, 'private/show', { peer: b.me.id });
    assert.equal((await request(a, 'session')).data.conversations.length, 1);
    await request(a, 'private/hide', { peer: b.me.id });
    assert.equal((await request(b, 'message', payload(b, a))).status, 200);
    assert.equal((await request(a, 'session')).data.conversations.length, 1);
    assert.equal((await request(a, 'private/block', { peer: a.me.id, blocked: true })).status, 400);
    const blocked = await request(a, 'private/block', { peer: b.me.id, blocked: true }); assert.equal(blocked.status, 200);
    assert.deepEqual(new Set(blocked.data.blocks[0].peers), new Set([b.me.id, b2.me.id]));
    assert.equal((await request(a, 'session')).data.conversations.length, 0);
    for (const peer of [b, b2]) {
      assert.equal((await request(peer, 'message', payload(peer, a))).status, 403);
      assert.equal((await request(a, 'message', payload(a, peer))).status, 403);
      assert.equal((await request(peer, `identity?peer=${a.me.id}`)).status, 403);
      const upload = await fetch(`${origin}/api/attachments?peer=${a.me.id}`, { method: 'POST', headers: { Cookie: peer.cookie, Origin: origin, 'Content-Type': 'application/octet-stream' }, body: Buffer.alloc(32) });
      assert.equal(upload.status, 403);
    }
    assert.equal((await request(b, 'message/edit', { id: first.data.id, editVersion: 1, encrypted: payload(b, a).encrypted })).status, 403);
    assert.equal((await request(c, 'message', payload(c, a))).status, 200);
    const room = (await request(a, 'session')).data.rooms[0].id;
    assert.equal((await request(b, 'message', { room, text: 'Shared rooms remain shared' })).status, 200);
    await request(a, 'auth/logout', {});
    a.me = (await request(a, 'auth/login', { username: 'Alice', password: 'a long test password' })).data; await identity(a);
    assert.equal((await request(b2, 'message', payload(b2, a))).status, 403);
    await stop(); await boot();
    a.me = (await request(a, 'auth/login', { username: 'Alice', password: 'a long test password' })).data;
    b.me = (await request(b, 'auth/login', { username: 'Bobby', password: 'a long test password' })).data;
    await Promise.all([identity(a), identity(b)]);
    assert.equal((await request(b, 'message', payload(b, a))).status, 403);
    const prefs = (await request(a, 'private/preferences')).data;
    assert.equal((await request(a, 'private/block', { key: prefs.blocks[0].key, blocked: false })).status, 200);
    assert.equal((await request(b, 'message', payload(b, a))).status, 200);
    assert.equal((await request(b, 'private/block', { key: prefs.blocks[0].key, blocked: false })).status, 404);
  } finally { await stop(); await rm(dir, { recursive: true, force: true }); }
});
