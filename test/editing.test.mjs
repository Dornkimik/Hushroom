import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import nacl from 'tweetnacl';
import encryption from '../public/crypto.js';

test('own message edits enforce authorization, validation, encryption and conflict detection', async () => {
  const data = await mkdtemp(path.join(tmpdir(), 'silenzachat-test-'));
  const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening'); const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  let child; const streams = [];
  async function boot() {
    child = spawn(process.execPath, ['server.mjs'], { cwd: new URL('..', import.meta.url), env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: data, ADMIN_USERNAME: 'host', ADMIN_PASSWORD: 'integration-test-password', ORIGIN: origin }, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Server startup timed out')), 10000); child.stdout.once('data', () => { clearTimeout(timer); resolve(); }); child.once('error', reject); child.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited: ${code}`)); }); });
  }
  async function stop() { if (child && child.exitCode === null) { const exit = once(child, 'exit'); child.kill(); await exit; } }
  async function visitor() {
    const res = await fetch(`${origin}/api/session`);
    const user = { cookie: res.headers.get('set-cookie').split(';')[0], ...(await res.json()), identity: nacl.box.keyPair() };
    assert.equal((await request(user, 'identity', { publicKey: encryption.base64(user.identity.publicKey) })).status, 200);
    return user;
  }
  function privatePayload(user, peer, text, extra = {}) {
    const id = randomUUID();
    const encrypted = encryption.encryptMessage({ id, sender: user.me.id, recipient: peer.me.id, text, ...extra }, user.identity, encryption.base64(peer.identity.publicKey));
    return { id, peer: peer.me.id, encrypted, replyTo: extra.replyTo, attachmentId: extra.file?.id };
  }
  const decrypt = (message, user, peer) => encryption.decryptMessage(message, user.me.id, user.identity, encryption.base64(peer.identity.publicKey));
  async function request(user, route, body, source = origin) {
    const res = await fetch(`${origin}/api/${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { cookie: user.cookie, Origin: source, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (res.headers.get('set-cookie')) user.cookie = res.headers.get('set-cookie').split(';')[0];
    return { status: res.status, data: await res.json() };
  }
  async function events(user) {
    const controller = new AbortController(); streams.push(controller);
    const res = await fetch(`${origin}/api/events`, { headers: { Cookie: user.cookie }, signal: controller.signal });
    let buffer = ''; const messages = []; messages.removals = [];
    (async () => { try { for await (const chunk of res.body) { buffer += new TextDecoder().decode(chunk); let end; while ((end = buffer.indexOf('\n\n')) !== -1) { const part = buffer.slice(0, end); buffer = buffer.slice(end + 2); if (part.startsWith('event: message\n')) messages.push(JSON.parse(part.split('\ndata: ')[1])); if (part.startsWith('event: message-removed\n')) messages.removals.push(JSON.parse(part.split('\ndata: ')[1]).id); } } } catch {} })();
    return messages;
  }
  try {
    await boot();
    const [a,b,c] = await Promise.all([visitor(),visitor(),visitor()]);
    const room = a.rooms[0].id;
    const message = (await request(a, 'message', { room, text: 'Before' })).data;
    const reply = (await request(b, 'message', { room, text: 'Reply', replyTo: message.id })).data;
    const edit = { id: message.id, text: `After @${b.me.alias}`, editVersion: 1 };
    assert.equal((await request(b, 'message/edit', edit)).status, 404);
    await request(c, 'auth/login', { username: 'host', password: 'integration-test-password' });
    assert.equal((await request(c, 'message/edit', edit)).status, 404);
    for (const text of ['', '  ', 'x'.repeat(2001)]) assert.equal((await request(a, 'message/edit', { ...edit, text })).status, 400);
    assert.equal((await request(a, 'message/edit', { ...edit, room: 'different' })).status, 400);
    const updated = await request(a, 'message/edit', edit);
    assert.equal(updated.status, 200); assert.equal(updated.data.time, message.time); assert.ok(updated.data.editedAt);
    assert.equal(updated.data.mentions[0].id, b.me.id);
    assert.equal((await request(a, 'message/edit', edit)).status, 409);
    const history = (await request(b, `history?room=${room}`)).data;
    assert.equal(history.find(m => m.id === reply.id).reply.text, edit.text);
    const dm = (await request(a, 'message', privatePayload(a,b,'Secret before'))).data;
    const encrypted = encryption.encryptMessage({ id: dm.id, sender: a.me.id, recipient: b.me.id, text: 'Secret after', editVersion: 1 }, a.identity, encryption.base64(b.identity.publicKey));
    const privateEdit = { id: dm.id, editVersion: 1, encrypted };
    assert.equal((await request(b, 'message/edit', privateEdit)).status, 404);
    assert.equal((await request(a, 'message/edit', { ...privateEdit, text: 'leak' })).status, 400);
    assert.equal((await request(a, 'message/edit', { ...privateEdit, encrypted: {} })).status, 400);
    const editedDM = await request(a, 'message/edit', privateEdit); assert.equal(editedDM.status, 200);
    assert.equal(decrypt(editedDM.data, b, a).text, 'Secret after');
    assert.ok(!JSON.stringify(editedDM.data).includes('Secret after'));
    assert.throws(() => decrypt({ ...editedDM.data, editVersion: 0 }, b, a), /metadata/);
    assert.equal(decrypt((await request(b, `history?peer=${a.me.id}`)).data[0], b, a).text, 'Secret after');
    assert.deepEqual((await request(c, `history?peer=${a.me.id}`)).data, []);
    await request(a, 'message/delete', { id: message.id });
    assert.equal((await request(a, 'message/edit', { ...edit, editVersion: 2 })).status, 404);
  } finally {
    for (const controller of streams) controller.abort();
    await stop(); await rm(data, { recursive: true, force: true });
  }
});
