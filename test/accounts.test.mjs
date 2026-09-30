import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { Accounts } from '../lib/accounts.mjs';

test('account hashes persist, salts differ, and concurrent case-insensitive registration is atomic', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'silenza-accounts-unit-'));
  try {
    const accounts = new Accounts(dir); await accounts.load();
    const results = await Promise.allSettled(['Alice', 'alice'].map(name => accounts.create(name, 'a sufficiently long password')));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    await accounts.create('Bobby', 'a sufficiently long password');
    assert.notEqual(accounts.items[0].salt, accounts.items[1].salt);
    assert.notEqual(accounts.items[0].passwordHash, accounts.items[1].passwordHash);
    const disk = await readFile(path.join(dir, 'accounts.json'), 'utf8');
    assert.ok(!disk.includes('a sufficiently long password'));
    const reloaded = new Accounts(dir); await reloaded.load();
    assert.equal((await reloaded.authenticate('ALICE', 'a sufficiently long password')).role, 'member');
    await assert.rejects(reloaded.authenticate('Alice', 'wrong password'), /Incorrect username or password/);
    await assert.rejects(reloaded.authenticate('Nobody', 'wrong password'), /Incorrect username or password/);
    await assert.rejects(reloaded.create('invalid name', 'a sufficiently long password'), /username/);
    await assert.rejects(reloaded.create('Valid', 'short'), /password/);
  } finally { assert.equal(path.dirname(dir), tmpdir()); await rm(dir, { recursive: true, force: true }); }
});

test('account login, rotation, roles, bans, immutable badges, previews and logout', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'silenza-accounts-api-'));
  const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(r => probe.close(r));
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, DATA_DIR: dir, PORT: String(port), HOST: '127.0.0.1', ORIGIN: origin, ADMIN_USERNAME: 'host', ADMIN_PASSWORD: 'host password for tests' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const host = {}, member = {}, guest = {};
  async function request(user, route, body, source = origin) {
    const res = await fetch(`${origin}/api/${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { Cookie: user.cookie || '', Origin: source, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const cookie = res.headers.get('set-cookie'); if (cookie) user.cookie = cookie.split(';')[0];
    return { status: res.status, data: await res.json(), cookie };
  }
  try {
    await once(child.stdout, 'data');
    assert.equal((await request(guest, 'auth/status')).data.me, null);
    const session = (await request(guest, 'session')).data;
    assert.equal(session.me.account, false);
    const room = session.rooms[0].id;
    assert.equal((await request(guest, 'admin/login', { password: 'host password for tests' })).status, 403);
    assert.equal((await request(host, 'auth/login', { username: 'host', password: 'host password for tests' }, 'https://evil.example')).status, 403);
    const login = await request(host, 'auth/login', { username: 'host', password: 'host password for tests' });
    assert.equal(login.data.admin, true); assert.match(login.cookie, /HttpOnly; SameSite=Strict/);
    const registered = await request(member, 'auth/register', { username: 'Alice', password: 'a sufficiently long password', role: 'admin', admin: true });
    assert.equal(registered.data.admin, false); assert.equal(registered.data.alias, 'Alice');
    assert.equal((await request(member, 'admin/create', { name: 'Forged' })).status, 403);
    const oldCookie = member.cookie;
    await request(member, 'auth/login', { username: 'ALICE', password: 'a sufficiently long password' });
    assert.notEqual(member.cookie, oldCookie);
    assert.equal((await request({ cookie: oldCookie }, 'history?room=' + room)).status, 401);
    await request(host, 'admin/appearance', { displayAsAdmin: true });
    const message = (await request(host, 'message', { room, text: 'Public preview' })).data;
    await request(host, 'admin/appearance', { displayAsAdmin: false });
    assert.equal((await request(guest, 'history?room=' + room)).data[0].displayAsAdmin, true);
    assert.equal((await request(guest, 'session')).data.rooms[0].preview, 'Public preview');
    await request(host, 'message/edit', { id: message.id, text: 'Edited preview', editVersion: 1 });
    assert.equal((await request(guest, 'session')).data.rooms[0].preview, 'Edited preview');
    assert.equal((await request(guest, 'history?room=' + room)).data[0].displayAsAdmin, true);
    await request(host, 'message/delete', { id: message.id });
    assert.equal((await request(guest, 'session')).data.rooms[0].preview, '');
    await request(host, 'admin/ban', { id: registered.data.id });
    assert.equal((await request({}, 'auth/login', { username: 'Alice', password: 'a sufficiently long password' })).status, 403);
    await request(host, 'admin/unban', { id: registered.data.id });
    assert.equal((await request({}, 'auth/login', { username: 'Alice', password: 'a sufficiently long password' })).status, 200);
    const token = host.cookie;
    await request(host, 'auth/logout', {});
    assert.equal((await request({ cookie: token }, 'admin/state')).status, 401);
    assert.equal((await request(host, 'auth/status')).data.me, null);
    for (let i = 0; i < 10; i++) await request({}, 'auth/login', { username: 'NoSuchUser', password: 'incorrect password' });
    assert.equal((await request({}, 'auth/login', { username: 'NoSuchUser', password: 'incorrect password' })).status, 429);
  } finally {
    const ended = once(child, 'exit'); child.kill(); await ended;
    assert.equal(path.dirname(dir), tmpdir()); await rm(dir, { recursive: true, force: true });
  }
});
