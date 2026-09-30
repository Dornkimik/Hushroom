import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { Announcements } from '../lib/announcements.mjs';

test('announcement storage serializes writes and does not publish a failed save', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'silenza-announcement-store-'));
  try {
    const store = new Announcements(dir); await store.load();
    await Promise.all(Array.from({ length: 105 }, (_, id) => store.update(items => items.push({ id, text: 'Update' }))));
    assert.equal(store.messages.length, 105);
    const loaded = new Announcements(dir); await loaded.load();
    assert.deepEqual(loaded.messages, store.messages);
    await mkdir(`${store.file}.tmp`);
    await assert.rejects(store.update(items => { items[0].text = 'Must not be published'; }));
    assert.equal(store.messages[0].text, 'Update');
    assert.equal(JSON.parse(await readFile(store.file, 'utf8'))[0].text, 'Update');
  } finally { assert.equal(path.dirname(dir), tmpdir()); await rm(dir, { recursive: true, force: true }); }
});

test('announcements are admin-only, editable after restart, and durable through edits and deletion', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'silenza-announcement-api-'));
  const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  let child;
  async function boot() {
    child = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, DATA_DIR: dir, PORT: String(port), HOST: '127.0.0.1', ORIGIN: origin, ADMIN_USERNAME: 'host', ADMIN_PASSWORD: 'announcements test password' }, stdio: ['ignore', 'pipe', 'pipe'] });
    await once(child.stdout, 'data');
  }
  async function stop() { if (child?.exitCode === null) { const done = once(child, 'exit'); child.kill(); await done; } }
  async function request(user, route, input) {
    const response = await fetch(`${origin}/api/${route}`, { method: input === undefined ? 'GET' : 'POST', headers: { Cookie: user.cookie || '', Origin: origin, 'Content-Type': 'application/json' }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    if (response.headers.get('set-cookie')) user.cookie = response.headers.get('set-cookie').split(';')[0];
    return { status: response.status, data: await response.json() };
  }
  const login = user => request(user, 'auth/login', { username: 'host', password: 'announcements test password' });
  const history = user => request(user, 'history?room=announcements');
  const admin = {}, guest = {}, member = {};
  try {
    await boot();
    const initial = (await request(guest, 'session')).data;
    assert.equal(initial.rooms.find(r => r.id === 'announcements').adminOnly, true);
    await request(member, 'auth/register', { username: 'Member', password: 'ordinary user password' });
    for (const user of [guest, member]) assert.equal((await request(user, 'message', { room: 'announcements', text: 'Unauthorized', admin: true })).status, 403);
    assert.equal((await request(guest, 'join', { room: 'announcements' })).status, 200);
    await login(admin);
    assert.equal((await request(admin, 'admin/delete', { id: 'announcements' })).status, 403);
    assert.equal((await request(admin, 'message', { room: 'announcements', text: ' ' })).status, 400);
    const posted = await request(admin, 'message', { room: 'announcements', text: 'Release one' });
    assert.equal(posted.status, 200); assert.equal(posted.data.displayAsAdmin, true);
    const id = posted.data.id;
    const reply = (await request(admin, 'message', { room: 'announcements', text: 'Follow-up', replyTo: id })).data;
    await request(admin, 'message', { room: initial.rooms[0].id, text: 'Temporary public message' });
    for (const user of [guest, member]) {
      assert.equal((await request(user, 'message/edit', { id, text: 'Tampered', editVersion: 1 })).status, 403);
      assert.equal((await request(user, 'message/delete', { id })).status, 403);
      assert.equal((await request(user, 'admin/remove-message', { id })).status, 403);
    }
    assert.equal((await history(guest)).data[0].text, 'Release one');
    await stop(); await boot();
    await request(guest, 'session'); await login(admin);
    assert.equal((await history(guest)).data[0].id, id);
    assert.equal((await request(guest, `history?room=${initial.rooms[0].id}`)).data.length, 0);
    const edits = await Promise.all(['Release two', 'Competing update'].map(text => request(admin, 'message/edit', { id, text, editVersion: 1 })));
    assert.deepEqual(edits.map(r => r.status).sort(), [200, 409]);
    const text = edits.find(r => r.status === 200).data.text;
    assert.equal((await history(guest)).data.find(m => m.id === reply.id).reply.text, text);
    await stop(); await boot(); await request(guest, 'session'); await login(admin);
    assert.equal((await history(guest)).data[0].text, text);
    assert.equal((await request(admin, 'admin/remove-message', { id })).status, 200);
    await stop(); await boot(); await request(guest, 'session');
    const remaining = (await history(guest)).data;
    assert.equal(remaining.length, 1); assert.equal(remaining[0].reply.removed, true);
    // Existing installations with an intentionally empty room list also get updates.
    await stop(); await writeFile(path.join(dir, 'rooms.json'), '[]'); await boot();
    assert.deepEqual((await request(guest, 'session')).data.rooms.map(r => r.id), ['announcements']);
    assert.equal((await history(guest)).data[0].id, reply.id);
  } finally { await stop(); assert.equal(path.dirname(dir), tmpdir()); await rm(dir, { recursive: true, force: true }); }
});
