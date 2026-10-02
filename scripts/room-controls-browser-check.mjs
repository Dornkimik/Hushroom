import { enterGuest } from './auth-browser-helper.mjs';
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('..', import.meta.url));
const data = await mkdtemp(path.join(tmpdir(), 'silenzachat-room-controls-'));
const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['server.mjs'], { cwd: root, env: { ...process.env, DATA_DIR: data, PORT: String(port), HOST: '127.0.0.1', ORIGIN: origin, ADMIN_USERNAME: 'host', ADMIN_PASSWORD: 'room-controls-browser-test' }, stdio: ['ignore', 'pipe', 'pipe'] });
let browser; const errors = [];
const api = (page, route, body) => page.evaluate(async ({ route, body }) => {
  const response = await fetch(`/api/${route}`, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, data: await response.json() };
}, { route, body });
const send = async (page, text) => { await page.locator('#message').fill(text); await page.locator('.send-button').click(); await page.getByText(text, { exact: true }).waitFor(); };
const memberRow = (page, alias) => page.locator('#group-members .group-member').filter({ hasText: alias });
const ready = page => page.waitForFunction(() => document.querySelector('#room-title').textContent === 'Control room' && !document.querySelector('#message').disabled);
try {
  await once(server.stdout, 'data');
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, headless: true });
  const contexts = await Promise.all([1, 2, 3, 4].map(() => browser.newContext()));
  const [a, b, c, d] = await Promise.all(contexts.map(context => context.newPage()));
  for (const page of [a, b, c, d]) { page.on('pageerror', e => errors.push(e.message)); page.on('dialog', dialog => dialog.accept()); }
  await Promise.all([a, b, c].map(page => enterGuest(page, origin)));
  for (const page of [a, b, c]) await page.waitForFunction(() => document.querySelector('#connection').textContent === 'Connected');
  const [, ub, uc] = await Promise.all([a, b, c].map(async page => (await api(page, 'session')).data.me));

  // Owner creates an invite-only room with settings.
  await a.locator('#create-group').click(); await a.locator('#group-name').fill('Control room');
  await a.selectOption('#group-access', 'invite'); await a.selectOption('#group-slow-mode', '30'); await a.locator('#group-limit').fill('5');
  await a.locator('#group-save').click(); await ready(a);
  assert.match(await a.locator('#conversation-type').textContent(), /Slow mode 30s/);
  const group = (await api(a, 'groups')).data[0].id;
  assert.equal((await api(a, `groups/state?group=${group}`)).data.limit, 5);

  // A single-use invite link admits one person.
  await a.locator('#group-details').click();
  await a.selectOption('#group-link-uses', '1'); await a.locator('#group-link-form button').click();
  const link = await a.locator('#group-links input').inputValue();
  assert.match(link, new RegExp(`/chat/#invite=${group}\\.`));
  await b.goto(link); await b.locator('#group-join').filter({ hasText: 'Join with invite link' }).waitFor();
  assert.equal(await b.locator('#group-name').inputValue(), 'Control room');
  await b.locator('#group-join').click(); await ready(b);
  assert.equal(new URL(b.url()).hash, '');
  await c.goto(link); await c.locator('#error').filter({ hasText: /invalid or has expired/ }).waitFor();
  await a.locator('#group-links').filter({ hasText: 'No active invite links.' }).waitFor();

  // A reusable link survives the sign-in redirect for a new visitor.
  await a.selectOption('#group-link-uses', '0'); await a.locator('#group-link-form button').click();
  const reusable = await a.locator('#group-links input').first().inputValue();
  await d.goto(reusable); await d.waitForURL(`${origin}/#entry`);
  await d.locator('#guest-enter').click(); await d.waitForURL(`${origin}/chat/`);
  await d.locator('#group-join').filter({ hasText: 'Join with invite link' }).waitFor();
  await d.locator('#group-join').click(); await ready(d);
  await c.goto(reusable); await c.locator('#group-join').click(); await ready(c);

  // Moderators get management controls for regular members only.
  await memberRow(a, ub.alias).getByRole('button', { name: 'Make moderator' }).click();
  await memberRow(a, ub.alias).filter({ hasText: 'Moderator' }).waitFor();
  await b.locator('#group-details').click(); await b.locator('#group-links-section').waitFor();
  assert.equal(await b.locator('#group-save').isVisible(), false);
  assert.equal(await memberRow(b, uc.alias).getByRole('button', { name: 'Ban' }).count(), 1);
  assert.equal(await b.locator('#group-members .group-member').first().getByRole('button', { name: 'Ban' }).count(), 0);

  // Mute disables the composer for the muted member.
  await memberRow(b, uc.alias).locator('select').selectOption('5');
  await c.waitForFunction(() => document.querySelector('#message').disabled && document.querySelector('#encryption-status').textContent.includes('muted'));
  await memberRow(b, uc.alias).getByRole('button', { name: 'Unmute' }).click();
  await c.waitForFunction(() => !document.querySelector('#message').disabled);

  // Slow mode applies to members but not to moderators.
  await send(c, 'member first message');
  await c.locator('#message').fill('member too fast'); await c.locator('.send-button').click();
  await c.locator('#error').filter({ hasText: /Slow mode is on/ }).waitFor();
  await b.locator('#group-dialog .close-dialog').click();
  await send(b, 'moderator one'); await send(b, 'moderator two');

  // Moderators remove member messages and ban; the owner unbans.
  await b.locator('.chat-message').filter({ hasText: 'member first message' }).getByRole('button', { name: 'Remove' }).click();
  await a.locator('.chat-message').filter({ hasText: 'member first message' }).waitFor({ state: 'detached' });
  assert.equal(await b.locator('.chat-message').filter({ hasText: 'moderator one' }).getByRole('button', { name: 'Delete' }).count(), 1);
  await b.locator('#group-details').click(); await memberRow(b, uc.alias).getByRole('button', { name: 'Ban' }).click();
  await c.waitForFunction(() => document.querySelector('#room-title').textContent !== 'Control room');
  assert.equal((await api(c, 'groups/join', { group })).status, 403);
  await a.locator('#group-banned-section').filter({ hasText: uc.alias }).waitFor();
  await a.locator('#group-banned .group-member').getByRole('button', { name: 'Unban' }).click();
  await a.locator('#group-banned-section').waitFor({ state: 'hidden' });

  // Staff-only posting and locking.
  await a.locator('#group-read-only').check(); await a.locator('#group-locked').check(); await a.locator('#group-save').click();
  await d.waitForFunction(() => document.querySelector('#message').disabled && document.querySelector('#encryption-status').textContent.includes('owner and moderators'));
  await c.goto(reusable); await c.locator('#group-join').click();
  await c.locator('#group-error').filter({ hasText: /locked/ }).waitFor();

  // History sharing: later members read messages sent while it is on, and nothing from before.
  await a.locator('#group-read-only').uncheck(); await a.locator('#group-locked').uncheck(); await a.locator('#group-share-history').check(); await a.locator('#group-save').click();
  await a.locator('#group-dialog .close-dialog').click();
  await a.locator('#encryption-status').filter({ hasText: 'New members can read messages sent now' }).waitFor();
  assert.match(await a.locator('#conversation-type').textContent(), /History shared with new members/);
  await d.locator('#command-status').filter({ hasText: 'History sharing is on' }).waitFor();
  await send(a, 'shared history sentinel');
  await c.locator('#group-dialog .close-dialog').click();
  await c.goto(reusable); await c.locator('#group-join').click(); await ready(c);
  await c.locator('.chat-message').filter({ hasText: 'shared history sentinel' }).filter({ hasText: '(earlier message)' }).waitFor();
  assert.equal(await c.getByText('moderator one', { exact: true }).count(), 0);
  await c.reload(); await c.locator('#groups .group-room').click(); await ready(c);
  await c.locator('.chat-message').filter({ hasText: 'shared history sentinel' }).waitFor();
  await send(c, 'newcomer reply'); await a.getByText('newcomer reply', { exact: true }).waitFor();

  // The longer dialog still fits a phone screen without horizontal scrolling.
  await a.locator('#group-details').click(); await a.locator('#group-save').waitFor();
  await a.setViewportSize({ width: 375, height: 812 });
  assert.equal(await a.evaluate(() => document.querySelector('#group-dialog').scrollWidth <= document.querySelector('#group-dialog').clientWidth), true);
  assert.equal(await a.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  console.log('PASS: room settings, invite links (single-use, reusable, across sign-in), moderators, mute, slow mode, message removal, ban/unban, staff-only posting, lock, history sharing, phone layout');
} finally {
  await browser?.close(); server.kill(); await rm(data, { recursive: true, force: true });
}
