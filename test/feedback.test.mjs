import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';

test('feedback validation, admin isolation, throttling, review and durable deletion', async () => {
  const data = await mkdtemp(path.join(tmpdir(), 'silenza-feedback-'));
  const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  let child;
  async function boot() {
    child = spawn(process.execPath, ['server.mjs'], { cwd: new URL('..', import.meta.url), env: { ...process.env, DATA_DIR: data, PORT: String(port), HOST: '127.0.0.1', ORIGIN: origin, ADMIN_PASSWORD: 'feedback-test' }, stdio: ['ignore', 'pipe', 'pipe'] });
    await once(child.stdout, 'data');
  }
  async function stop() { if (child && child.exitCode === null) { const ended = once(child, 'exit'); child.kill(); await ended; } }
  async function visitor() { return (await fetch(`${origin}/api/session`)).headers.get('set-cookie').split(';')[0]; }
  async function request(cookie, route, body, source = origin) {
    const response = await fetch(`${origin}/api/${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { Cookie: cookie, Origin: source, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() };
  }
  try {
    await boot();
    const user = await visitor(), admin = await visitor();
    assert.equal((await request('', 'feedback', { title: 'Title', text: 'Text' })).status, 401);
    assert.equal((await request(user, 'admin/feedback')).status, 403);
    assert.equal((await request(user, 'feedback', { title: 'Title', text: 'Text' }, 'https://other.example')).status, 403);
    for (const input of [{}, { title: ' ', text: 'Text' }, { title: 'Title', text: ' ' }, { title: 123, text: 'Text' }, { title: 'x'.repeat(121), text: 'Text' }, { title: 'Title', text: 'x'.repeat(5001) }]) {
      assert.equal((await request(user, 'feedback', input)).status, 400);
    }
    const content = { title: '  <img src=x onerror=alert(1)>  ', text: '  First line\nSecond line  ' };
    assert.equal((await request(user, 'feedback', content)).status, 201);
    assert.equal((await request(admin, 'admin/login', { password: 'feedback-test' })).status, 200);
    const inbox = (await request(admin, 'admin/feedback')).data;
    assert.equal(inbox.length, 1); assert.equal(inbox[0].title, content.title.trim()); assert.equal(inbox[0].text, content.text.trim());
    assert.equal(inbox[0].reviewed, false); assert.ok(inbox[0].createdAt);
    assert.deepEqual(Object.keys(inbox[0]).sort(), ['createdAt', 'id', 'reviewed', 'text', 'title']);
    const id = inbox[0].id;
    assert.equal((await request(user, 'admin/feedback/update', { id, reviewed: true })).status, 403);
    assert.equal((await request(user, 'admin/feedback/delete', { id })).status, 403);
    assert.equal((await request(admin, 'admin/feedback/update', { id, reviewed: 'yes' })).status, 400);
    assert.equal((await request(admin, 'admin/feedback/update', { id, reviewed: true })).status, 200);
    const results = await Promise.all(Array.from({ length: 5 }, () => request(user, 'feedback', { title: 'Another idea', text: 'Details' })));
    assert.equal(results.filter(result => result.status === 201).length, 2);
    assert.equal(results.filter(result => result.status === 429).length, 3);
    await stop(); await boot();
    const nextAdmin = await visitor(); await request(nextAdmin, 'admin/login', { password: 'feedback-test' });
    const saved = (await request(nextAdmin, 'admin/feedback')).data;
    assert.equal(saved.length, 3); assert.equal(saved.find(item => item.id === id).reviewed, true);
    assert.equal((await request(nextAdmin, 'admin/feedback/delete', { id })).status, 200);
    assert.equal((await request(nextAdmin, 'admin/feedback/delete', { id })).status, 404);
    await request(nextAdmin, 'admin/logout', {});
    assert.equal((await request(nextAdmin, 'admin/feedback')).status, 403);
    await stop(); await boot();
    const finalAdmin = await visitor(); await request(finalAdmin, 'admin/login', { password: 'feedback-test' });
    assert.equal((await request(finalAdmin, 'admin/feedback')).data.some(item => item.id === id), false);
  } finally {
    await stop();
    assert.equal(path.dirname(path.resolve(data)), path.resolve(tmpdir()));
    assert.ok(path.basename(data).startsWith('silenza-feedback-'));
    await rm(data, { recursive: true, force: true });
  }
});
