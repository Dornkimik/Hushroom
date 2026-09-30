import { enterGuest, enterAccount, signOut } from './auth-browser-helper.mjs';
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';

const data = await mkdtemp(path.join(tmpdir(), 'silenza-feedback-browser-'));
const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['server.mjs'], { cwd: new URL('..', import.meta.url), env: { ...process.env, DATA_DIR: data, PORT: String(port), HOST: '127.0.0.1', ORIGIN: origin, ADMIN_USERNAME: 'host', ADMIN_PASSWORD: 'feedback-browser' }, stdio: ['ignore', 'pipe', 'pipe'] });
let browser;
try {
  await once(server.stdout, 'data');
  browser = await chromium.launch({ headless: true });
  const user = await browser.newPage(), admin = await browser.newPage();
  const errors = []; for (const page of [user, admin]) page.on('pageerror', error => errors.push(error.message));
  await user.goto(origin); await user.getByRole('button', { name: 'Feedback', exact: true }).click();
  assert.equal(await user.locator('#feedback-dialog').isVisible(), true);
  await user.getByLabel('Title', { exact: true }).fill('<img src=x onerror=alert(1)>');
  await user.getByLabel('Feedback', { exact: true }).fill('Please improve the room layout.\nThe close button should stay visible.');
  await user.route('**/api/feedback', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Please try again later.' }) }), { times: 1 });
  await user.getByRole('button', { name: 'Send feedback' }).click();
  await user.getByText('Please try again later.', { exact: true }).waitFor();
  assert.match(await user.locator('#feedback-text').inputValue(), /room layout/);
  await user.getByRole('button', { name: 'Send feedback' }).click();
  await user.getByText('Thank you! Your feedback has been sent to the admins.').waitFor();
  await user.getByRole('button', { name: 'Close feedback' }).click();
  await user.goto(`${origin}/chat/`); await user.getByRole('button', { name: 'Feedback', exact: true }).click();
  for (const width of [320,390,768,1440]) {
    await user.setViewportSize({ width, height: 700 });
    assert.equal(await user.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.equal(await user.getByRole('button', { name: 'Close feedback' }).isVisible(), true);
    assert.equal(await user.evaluate(() => { const dialog = document.getElementById('feedback-dialog'); return dialog.scrollWidth <= dialog.clientWidth; }), true);
    if (width === 390 && process.env.FEEDBACK_SCREENSHOT_DIR) await user.screenshot({ path: path.join(process.env.FEEDBACK_SCREENSHOT_DIR, 'feedback-mobile.png') });
  }
  if (process.env.FEEDBACK_SCREENSHOT_DIR) await user.screenshot({ path: path.join(process.env.FEEDBACK_SCREENSHOT_DIR, 'feedback-form.png') });
  await user.getByRole('button', { name: 'Close feedback' }).click();
  await enterAccount(admin, origin, 'feedback-browser');
  await admin.locator('#open-admin').click();
  await admin.locator('.feedback-entry').waitFor();
  assert.equal(await admin.locator('#feedback-count').textContent(), '(1 new)');
  assert.equal(await admin.locator('.feedback-entry img').count(), 0);
  await admin.locator('.feedback-entry summary').click();
  assert.match(await admin.locator('.feedback-text').textContent(), /room layout/);
  if (process.env.FEEDBACK_SCREENSHOT_DIR) await admin.screenshot({ path: path.join(process.env.FEEDBACK_SCREENSHOT_DIR, 'feedback-inbox.png') });
  await admin.getByRole('button', { name: 'Mark reviewed', exact: true }).click();
  await admin.getByText('(0 new)', { exact: true }).waitFor();
  await admin.locator('.feedback-entry summary').click();
  await admin.getByRole('button', { name: 'Mark as new', exact: true }).click();
  await admin.getByText('(1 new)', { exact: true }).waitFor();
  await admin.locator('.feedback-entry summary').click(); admin.on('dialog', dialog => dialog.accept());
  await admin.locator('.feedback-entry').getByRole('button', { name: 'Delete', exact: true }).click();
  await admin.getByText('No feedback yet.', { exact: true }).waitFor();
  await signOut(admin, origin);
  assert.deepEqual(errors, []);
  console.log('PASS: feedback from landing/chat, retry with draft retained, responsive form, safe admin rendering, review, delete and logout.');
} finally {
  if (browser) await browser.close();
  const stopped = once(server, 'exit'); server.kill(); await stopped;
  assert.equal(path.dirname(path.resolve(data)), path.resolve(tmpdir()));
  assert.ok(path.basename(data).startsWith('silenza-feedback-browser-'));
  await rm(data, { recursive: true, force: true });
}
