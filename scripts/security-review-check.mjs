// Read-only review of application behavior against a disposable local server.
// Does not use the live site, .env, existing accounts, or existing chat data.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import nacl from 'tweetnacl';
import crypto from '../public/crypto.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const directory = await mkdtemp(path.join(tmpdir(), 'silenza-security-review-'));
const probe = net.createServer();
probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['server.mjs'], {
  cwd: root,
  env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DATA_DIR: directory,
    ORIGIN: origin, ADMIN_USERNAME: 'review_host', ADMIN_PASSWORD: 'local review password only', SECURE_COOKIES: 'false' },
  stdio: ['ignore', 'pipe', 'pipe']
});
const controllers = [];
async function request(user, route, input, forwarded) {
  const response = await fetch(`${origin}/api/${route}`, {
    method: input === undefined ? 'GET' : 'POST',
    headers: { Cookie: user.cookie || '', Origin: origin, 'Content-Type': 'application/json',
      ...(forwarded ? { 'X-Forwarded-For': forwarded, 'CF-Connecting-IP': forwarded } : {}) },
    ...(input === undefined ? {} : { body: JSON.stringify(input) })
  });
  const cookie = response.headers.get('set-cookie');
  if (cookie) user.cookie = cookie.split(';')[0];
  return { status: response.status, data: await response.json() };
}
async function guest() {
  const user = {};
  const response = await request(user, 'session'); assert.equal(response.status, 200);
  user.me = response.data.me; user.rooms = response.data.rooms; user.identity = nacl.box.keyPair();
  assert.equal((await request(user, 'identity', { publicKey: crypto.base64(user.identity.publicKey) })).status, 200);
  return user;
}
async function dm(sender, recipient, text) {
  const id = randomUUID();
  const encrypted = crypto.encryptMessage({ id, sender: sender.me.id, recipient: recipient.me.id, text },
    sender.identity, crypto.base64(recipient.identity.publicKey));
  const result = await request(sender, 'message', { id, peer: recipient.me.id, encrypted });
  assert.equal(result.status, 200); return result.data;
}
try {
  await Promise.race([
    once(child.stdout, 'data'),
    once(child, 'exit').then(([code]) => { throw new Error(`Review server exited: ${code}`); })
  ]);
  const host = {};
  assert.equal((await request(host, 'auth/login', { username: 'review_host', password: 'local review password only' })).status, 200);
  const [a, b] = await Promise.all([guest(), guest()]);
  const oldId = a.me.id, oldAlias = a.me.alias;
  const publicMessage = await request(a, 'message', { room: a.rooms[0].id, text: 'Local review guest message' });
  const outgoing = await dm(b, a, 'Local review retained ciphertext');
  const originalCookie = a.cookie;
  const registered = await request(a, 'auth/register', { username: 'ReviewMember', password: 'disposable review password' });
  assert.equal(registered.status, 200); a.me = registered.data;
  assert.notEqual(a.cookie, originalCookie);
  assert.equal(a.me.id, oldId);
  assert.equal((await request(b, `identity?peer=${oldId}`)).data.publicKey, crypto.base64(a.identity.publicKey));
  const controller = new AbortController(); controllers.push(controller);
  const stream = await fetch(`${origin}/api/events`, { headers: { Cookie: a.cookie }, signal: controller.signal });
  assert.equal(stream.status, 200);
  const observer = (await request(b, 'session')).data;
  assert.equal(observer.people.find(person => person.id === publicMessage.data.sender)?.alias, 'ReviewMember');
  console.log('CONFIRMED: upgrading a guest rotates its cookie but publicly links the old guest sender ID to the account username and retains its encryption key.');

  assert.equal((await request(host, 'admin/ban', { id: a.me.id })).status, 200);
  assert.equal((await request(b, `history?peer=${a.me.id}`)).status, 404);
  assert.equal((await request(b, 'message/delete', { id: outgoing.id })).status, 200);
  console.log('CONFIRMED: banning a participant leaves private ciphertext history in memory; the surviving sender can still delete its retained message.');

  const sessions = [];
  for (let i = 0; i < 16; i++) {
    const result = await request({}, 'session'); assert.equal(result.status, 200); sessions.push(result.data.me.id);
  }
  assert.equal(new Set(sessions).size, 16);
  console.log('CONFIRMED: 16 consecutive cookie-free requests create 16 independent guest sessions without a creation rate limit (bounded sample, no stress test).');

  let attempts = 0, status;
  do {
    const result = await request({}, 'auth/login', { username: `review_probe_${attempts}`, password: 'x'.repeat(129) }, `192.0.2.${attempts + 1}`);
    status = result.status; attempts++;
  } while (status !== 429 && attempts <= 102);
  assert.equal(status, 429);
  const unrelated = await request({}, 'auth/login', { username: 'review_host', password: 'local review password only' }, '198.51.100.2');
  assert.equal(unrelated.status, 429);
  console.log('CONFIRMED: requests with distinct forwarded client addresses share the socket-address throttle; an unrelated valid login is denied after exhaustion. Deployment impact depends on proxy topology.');
  console.log('PASS: four bounded security-review probes reproduced the reported behavior.');
} finally {
  for (const controller of controllers) controller.abort();
  if (child.exitCode === null) { const ended = once(child, 'exit'); child.kill(); await ended; }
  assert.equal(path.dirname(directory), tmpdir());
  await rm(directory, { recursive: true, force: true });
}
