import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import { enterGuest, enterAccount } from './auth-browser-helper.mjs';

const dir = await mkdtemp(path.join(tmpdir(), 'silenza-announcements-browser-'));
const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, DATA_DIR: dir, PORT: String(port), HOST: '127.0.0.1', ORIGIN: origin, ADMIN_USERNAME: 'host', ADMIN_PASSWORD: 'announcements test password' }, stdio: ['ignore', 'pipe', 'pipe'] });
let browser;
try {
  await once(server.stdout, 'data');
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined });
  const admin = await browser.newPage(), guest = await browser.newPage(), errors = [];
  for (const page of [admin, guest]) page.on('pageerror', e => errors.push(e.message));
  await enterAccount(admin, origin, 'announcements test password'); await enterGuest(guest, origin);
  for (const page of [admin, guest]) {
    await page.locator('#announcements .nav-room').click();
    await page.waitForFunction(() => document.querySelector('#room-title').textContent === 'Announcements');
    assert.equal(await page.locator('#rooms').getByText('Announcements', { exact: true }).count(), 0);
    assert.equal(await page.locator('#groups').getByText('Announcements', { exact: true }).count(), 0);
    assert.equal(await page.locator('#room-count').textContent(), '3');
  }
  assert.equal(await guest.locator('#message').isDisabled(), true);
  assert.equal(await guest.locator('.send-button').isDisabled(), true);
  assert.equal(await guest.locator('#emoji-toggle').isDisabled(), true);
  assert.match(await guest.locator('#announcement-note').textContent(), /Read-only/);
  assert.equal(await admin.locator('#message').isDisabled(), false);
  await admin.locator('#message').fill('Welcome! Community updates will appear here.'); await admin.locator('.send-button').click();
  const message = guest.locator('#messages .chat-message').first();
  await message.getByText('Welcome! Community updates will appear here.', { exact: true }).waitFor();
  assert.equal(await message.getByRole('button', { name: 'Reply', exact: true }).isDisabled(), true);
  assert.equal(await message.getByRole('button', { name: 'Edit', exact: true }).count(), 0);
  await message.locator('.admin-badge').waitFor();
  // A fresh account session can still manage earlier announcements.
  await admin.locator('#open-settings').click(); await admin.locator('#account-signout').click(); await admin.waitForURL(origin + '/#entry');
  await enterAccount(admin, origin, 'announcements test password');
  await admin.locator('#announcements .nav-room').click();
  await admin.locator('#messages').getByRole('button', { name: 'Edit', exact: true }).click();
  await admin.locator('#edit-message-text').fill('Update: announcements now survive restarts.');
  await admin.locator('#edit-message-form button[type="submit"]').click();
  await message.getByText('Update: announcements now survive restarts.', { exact: true }).waitFor();
  await guest.reload(); await guest.locator('#announcements .nav-room').click();
  await guest.locator('#messages').getByText('Update: announcements now survive restarts.', { exact: true }).waitFor();
  if (process.env.ANNOUNCEMENTS_SCREENSHOT_DIR) await guest.screenshot({ animations: 'disabled', path: path.join(process.env.ANNOUNCEMENTS_SCREENSHOT_DIR, 'announcements-desktop.png') });
  await guest.setViewportSize({ width: 390, height: 844 });
  assert.equal(await guest.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  if (process.env.ANNOUNCEMENTS_SCREENSHOT_DIR) await guest.screenshot({ animations: 'disabled', path: path.join(process.env.ANNOUNCEMENTS_SCREENSHOT_DIR, 'announcements-mobile.png'), fullPage: true });
  await admin.locator('#messages').getByRole('button', { name: 'Remove', exact: true }).click();
  await guest.locator('#messages .chat-message').waitFor({ state: 'detached' });
  await guest.locator('#rooms .nav-room').first().click();
  assert.equal(await guest.locator('#message').isDisabled(), false);
  assert.deepEqual(errors, []);
  console.log('PASS: separate announcements section, read-only visitors, admin posting and edits across logins, live updates, deletion and mobile layout');
} finally {
  await browser?.close(); const ended = once(server, 'exit'); server.kill(); await ended;
  assert.equal(path.dirname(dir), tmpdir()); await rm(dir, { recursive: true, force: true });
}
