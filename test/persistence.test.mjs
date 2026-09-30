import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import net from 'node:net';

test('Railway volume keeps main rooms and deletions across deployments, including an empty list', async () => {
  const volume = await mkdtemp(path.join(tmpdir(), 'silenza-volume-'));
  const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  let child, cookie, warnings;
  async function boot(extra = {}) {
    warnings = '';
    child = spawn(process.execPath, ['server.mjs'], { cwd: new URL('..', import.meta.url),
      env: { ...process.env, DATA_DIR: '', RAILWAY_ENVIRONMENT_ID: 'test', RAILWAY_VOLUME_MOUNT_PATH: volume,
        PORT: String(port), HOST: '127.0.0.1', ORIGIN: origin, ADMIN_USERNAME: 'host', ADMIN_PASSWORD: 'persistent-test', ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stderr.on('data', chunk => { warnings += chunk; });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Startup timed out')), 10000);
      child.stdout.once('data', () => { clearTimeout(timer); resolve(); });
      child.once('error', e => { clearTimeout(timer); reject(e); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited: ${code}: ${warnings}`)); });
    });
    const res = await fetch(`${origin}/api/session`); cookie = res.headers.get('set-cookie').split(';')[0];
    return res.json();
  }
  async function stop() { if (child && child.exitCode === null) { const done = once(child, 'exit'); child.kill(); await done; } }
  async function post(route, body) {
    const res = await fetch(`${origin}/api/${route}`, { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (res.headers.get('set-cookie')) cookie = res.headers.get('set-cookie').split(';')[0];
    assert.equal(res.status, 200); return res.json();
  }
  const saved = () => readFile(path.join(volume, 'rooms.json'), 'utf8').then(JSON.parse);
  try {
    const first = await boot(); assert.equal(warnings, '');
    assert.equal((await saved()).length, 3);
    await post('auth/login', { username: 'host', password: 'persistent-test' });
    const created = await post('admin/create', { name: 'Permanent community', description: 'Survives deployment' });
    for (const room of first.rooms) await post('admin/delete', { id: room.id });
    await stop();
    const restarted = await boot();
    assert.deepEqual(restarted.rooms.map(({ count, preview, ...room }) => room), [created]);
    assert.deepEqual(await saved(), [created]);
    await post('auth/login', { username: 'host', password: 'persistent-test' });
    await post('admin/delete', { id: created.id });
    await stop();
    assert.deepEqual((await boot()).rooms, []); assert.deepEqual(await saved(), []);
    await stop();
    // Explicit DATA_DIR still wins and works in a subdirectory of the volume.
    const nested = path.join(volume, 'custom');
    assert.equal((await boot({ DATA_DIR: nested })).rooms.length, 3); assert.equal(warnings, '');
    assert.equal(JSON.parse(await readFile(path.join(nested, 'rooms.json'), 'utf8')).length, 3);
    assert.deepEqual(await saved(), []);
    await stop();
    // A plain directory without a Railway mount cannot promise deploy persistence.
    await boot({ DATA_DIR: nested, RAILWAY_VOLUME_MOUNT_PATH: '' });
    assert.match(warnings, /Persistent storage is not configured/);
  } finally { await stop(); await rm(volume, { recursive: true, force: true }); }
});
