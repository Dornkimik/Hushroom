import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';

test('anonymous public chat, private isolation, admin control and persistence', async () => {
  const data = await mkdtemp(path.join(tmpdir(), 'hushroom-test-'));
  const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening'); const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  let child; const streams = [];
  async function boot() {
    child = spawn(process.execPath, ['server.mjs'], { cwd: new URL('..', import.meta.url), env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: data, ADMIN_PASSWORD: 'integration-test-password', ORIGIN: origin }, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Server startup timed out')), 10000); child.stdout.once('data', () => { clearTimeout(timer); resolve(); }); child.once('error', reject); child.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited: ${code}`)); }); });
  }
  async function stop() { if (child && child.exitCode === null) { const exit = once(child, 'exit'); child.kill(); await exit; } }
  async function visitor() { const res = await fetch(`${origin}/api/session`); return { cookie: res.headers.get('set-cookie').split(';')[0], ...(await res.json()) }; }
  async function request(user, route, body, source = origin) {
    const res = await fetch(`${origin}/api/${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { cookie: user.cookie, Origin: source, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
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
    assert.notEqual(a.me.id, b.me.id); assert.equal(a.me.admin, false);
    const [ae,be,ce] = await Promise.all([events(a),events(b),events(c)]);
    const room = a.rooms[0].id;
    const pub = await request(a, 'message', { room, text: 'Hello, everyone!' }); assert.equal(pub.status, 200);
    const dm = await request(a, 'message', { peer: b.me.id, text: '<script>private</script>' }); assert.equal(dm.status, 200);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(ae.some(m => m.id === dm.data.id)); assert.ok(be.some(m => m.id === dm.data.id)); assert.ok(ce.some(m => m.id === pub.data.id)); assert.ok(!ce.some(m => m.id === dm.data.id));
    assert.equal((await request(b, `history?peer=${a.me.id}`)).data[0].text, '<script>private</script>');
    assert.deepEqual((await request(c, `history?peer=${a.me.id}`)).data, []);
    assert.equal((await request(a, 'message', { room, text: 'x'.repeat(2001) })).status, 400);
    assert.equal((await request(a, 'message', { room, text: 'forged' }, 'https://other.example')).status, 403);
    assert.equal((await request(c, 'admin/create', { name: 'Forbidden' })).status, 403);
    assert.equal((await request(c, 'admin/remove-message', { id: pub.data.id })).status, 403);
    assert.equal((await request(c, 'admin/ban', { id: b.me.id })).status, 403);
    assert.equal((await request(a, 'admin/login', { password: 'wrong' })).status, 403);
    assert.equal((await request(a, 'admin/login', { password: 'integration-test-password' })).status, 200);
    assert.equal((await request(a, 'admin/ban', { id: a.me.id })).status, 400);
    assert.equal((await request(a, 'admin/remove-message', { id: pub.data.id })).status, 200);
    await new Promise(resolve => setTimeout(resolve, 100)); assert.ok(ae.removals.includes(pub.data.id)); assert.ok(ce.removals.includes(pub.data.id));
    assert.deepEqual((await request(c, `history?room=${room}`)).data, []);
    assert.equal((await request(a, 'admin/ban', { id: c.me.id })).status, 200);
    assert.equal((await request(c, `history?room=${room}`)).status, 403);
    assert.equal((await request(c, 'session')).status, 403);
    assert.equal((await request(a, 'admin/state')).data.bans.some(ban => ban.id === c.me.id), true);
    assert.equal((await request(a, 'admin/unban', { id: c.me.id })).status, 200);
    const returned = await request(c, 'session'); assert.equal(returned.status, 200); assert.notEqual(returned.data.me.id, c.me.id);
    const creations = await Promise.all(['Reading room', 'Music room'].map(name => request(a, 'admin/create', { name, description: 'Come chat' })));
    assert.ok(creations.every(r => r.status === 200));
    assert.equal((await request(a, 'admin/create', { name: 'Reading room' })).status, 400);
    const remove = creations[0].data.id;
    assert.equal((await request(a, 'admin/delete', { id: remove })).status, 200);
    assert.equal((await request(a, 'message', { room: remove, text: 'gone' })).status, 404);
    assert.equal((await request(a, 'admin/logout', {})).status, 200);
    assert.equal((await request(a, 'admin/delete', { id: room })).status, 403);
    const d = await visitor();
    assert.equal((await request(a, 'admin/login', { password: 'integration-test-password' })).status, 200);
    assert.equal((await request(a, 'admin/ban', { id: d.me.id })).status, 200);
    for (const s of streams) s.abort(); await stop(); await boot();
    const fresh = await visitor(); assert.ok(fresh.rooms.some(r => r.name === 'Music room')); assert.ok(!fresh.rooms.some(r => r.name === 'Reading room'));
    assert.equal((await request(d, 'session')).status, 403);
    assert.deepEqual((await request(fresh, `history?room=${room}`)).data, []);
    assert.equal((await request(a, `history?room=${room}`)).status, 401);
  } finally { for (const s of streams) s.abort(); await stop(); await rm(data, { recursive: true, force: true }); }
});
