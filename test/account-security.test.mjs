import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { Readable } from 'node:stream';
import { Attachments, MAX_ATTACHMENT_BYTES } from '../lib/attachments.mjs';

async function freePort() {
  const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve)); return port;
}
async function boot(env) {
  const child = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, HOST: '127.0.0.1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  await once(child.stdout, 'data'); return child;
}
async function stop(child) { if (child?.exitCode === null) { const ended = once(child, 'exit'); child.kill(); await ended; } }

test('accounts can change passwords, sign out other devices and delete themselves', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'silenza-account-security-'));
  const port = await freePort(), origin = `http://127.0.0.1:${port}`;
  const request = async (user, route, body) => {
    const response = await fetch(`${origin}/api/${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { Cookie: user.cookie || '', Origin: origin, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (response.headers.get('set-cookie')) user.cookie = response.headers.get('set-cookie').split(';')[0];
    return { status: response.status, data: await response.json() };
  };
  let child;
  try {
    child = await boot({ PORT: String(port), DATA_DIR: dir, ORIGIN: origin, ADMIN_USERNAME: 'host', ADMIN_PASSWORD: 'a long host password' });
    const a = {}, b = {}, guest = {};
    const password = 'a long test password', next = 'another long password';
    assert.equal((await request(a, 'auth/register', { username: 'Carol', password })).status, 200);
    assert.equal((await request(b, 'auth/login', { username: 'Carol', password })).status, 200);
    await request(guest, 'session');
    assert.equal((await request(guest, 'auth/password', { current: password, password: next })).status, 403);
    assert.equal((await request(guest, 'auth/logout-all', {})).status, 403);

    assert.equal((await request(a, 'auth/password', { current: 'wrong password here', password: next })).status, 403);
    assert.equal((await request(a, 'auth/password', { current: password, password: 'short' })).status, 400);
    const before = a.cookie;
    assert.equal((await request(a, 'auth/password', { current: password, password: next })).status, 200);
    assert.notEqual(a.cookie, before); // the session cookie is rotated
    assert.equal((await request(a, 'auth/status')).data.me.alias, 'Carol');
    assert.equal((await request(b, 'auth/status')).data.me, null); // other device signed out
    assert.equal((await request({}, 'auth/login', { username: 'Carol', password })).status, 403);
    assert.equal((await request(b, 'auth/login', { username: 'Carol', password: next })).status, 200);

    assert.equal((await request(a, 'auth/logout-all', {})).status, 200);
    assert.equal((await request(b, 'auth/status')).data.me, null);
    assert.equal((await request(a, 'auth/status')).data.me.alias, 'Carol');

    const admin = {};
    assert.equal((await request(admin, 'auth/login', { username: 'host', password: 'a long host password' })).status, 200);
    assert.equal((await request(admin, 'auth/delete', { password: 'a long host password' })).status, 400); // last admin stays

    assert.equal((await request(a, 'auth/delete', { password: 'wrong password here' })).status, 403);
    assert.equal((await request(a, 'auth/delete', { password: next })).status, 200);
    assert.equal((await request(a, 'auth/status')).data.me, null);
    assert.equal((await request({}, 'auth/login', { username: 'Carol', password: next })).status, 403);
    assert.equal((await request({}, 'auth/register', { username: 'Carol', password: next })).status, 200);
    if (process.platform !== 'win32') for (const file of ['accounts.json', 'rooms.json']) assert.equal((await stat(path.join(dir, file))).mode & 0o077, 0);
  } finally { await stop(child); await rm(dir, { recursive: true, force: true }); }
});

test('development mode rejects foreign Host headers (DNS rebinding)', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'silenza-dev-host-'));
  const port = await freePort();
  const raw = (pathname, headers, method = 'GET', body) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers }, res => { res.resume(); resolve(res); });
    req.on('error', reject); req.end(body);
  });
  let child;
  try {
    child = await boot({ PORT: String(port), DATA_DIR: dir, ORIGIN: '', NODE_ENV: '', RAILWAY_ENVIRONMENT_ID: '' });
    // A DNS-rebinding page would send its own host name and a matching Origin.
    assert.equal((await raw('/api/session', { Host: `evil.example:${port}`, Origin: `http://evil.example:${port}` })).statusCode, 403);
    const ok = await raw('/api/session', { Host: `localhost:${port}` });
    assert.equal(ok.statusCode, 200);
  } finally { await stop(child); await rm(dir, { recursive: true, force: true }); }
});

test('uploads reserve only their declared length and must match it', async () => {
  const attachments = new Attachments({ maxBytes: 1000, perUser: 1000, perClient: 1000 });
  const body = size => Readable.from([Buffer.alloc(size)]);
  await assert.rejects(attachments.upload(body(32), 'a', 'b', {}, 'c', 40), { status: 400 });
  await assert.rejects(attachments.upload(body(64), 'a', 'b', {}, 'c', 40), { status: 413 });
  await assert.rejects(attachments.upload(body(32), 'a', 'b', {}, 'c', MAX_ATTACHMENT_BYTES + 1), { status: 413 });
  // A slow upload that declared 400 bytes leaves the remaining capacity usable.
  let release; const slow = attachments.upload(Readable.from((async function* () { await new Promise(r => { release = r; }); yield Buffer.alloc(400); })()), 'a', 'b', {}, 'slow', 400);
  await new Promise(r => setImmediate(r));
  assert.ok((await attachments.upload(body(500), 'x', 'y', {}, 'other', 500)).id);
  await assert.rejects(attachments.upload(body(200), 'x', 'y', {}, 'other', 200), { status: 429 });
  release(); assert.ok((await slow).id);
});
