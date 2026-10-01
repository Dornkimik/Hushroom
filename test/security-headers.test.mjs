import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';

test('HTTPS origins send HSTS on static/API/error responses and secure cookies', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'silenza-headers-'));
  const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const local = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DATA_DIR: directory,
    ORIGIN: 'https://chat.example.test', TRUSTED_PROXY_ADDRESSES: '', ADMIN_USERNAME: '', ADMIN_PASSWORD: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await once(child.stdout, 'data');
    for (const route of ['/', '/crypto.js', '/missing', '/api/auth/status', '/api/session']) {
      const response = await fetch(local + route);
      assert.equal(response.headers.get('strict-transport-security'), 'max-age=31536000');
      if (route === '/api/session') {
        assert.equal(response.status, 200); assert.match(response.headers.get('set-cookie'), /; Secure/);
        assert.equal(response.headers.get('cache-control'), 'no-store');
      }
      await response.body.cancel();
    }
  } finally {
    const ended = once(child, 'exit'); child.kill(); await ended;
    assert.equal(path.dirname(directory), tmpdir()); await rm(directory, { recursive: true, force: true });
  }
});
