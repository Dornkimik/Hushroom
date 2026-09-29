import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { auditImages } from './image-privacy-audit.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
const data = await mkdtemp(path.join(tmpdir(), 'silenzachat-browser-'));
const probe = net.createServer(); probe.listen(0,'127.0.0.1'); await once(probe,'listening'); const port = probe.address().port; await new Promise(r=>probe.close(r));
const origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath,['server.mjs'],{cwd:root,env:{...process.env,DATA_DIR:data,PORT:String(port),HOST:'127.0.0.1',ORIGIN:origin,ADMIN_PASSWORD:'browser-test-only'},stdio:['ignore','pipe','pipe']});
let browser; const errors=[];
try {
  await once(server.stdout,'data');
  browser = await chromium.launch({executablePath:process.env.CHROMIUM_PATH || undefined,headless:true,args:['--no-sandbox']});
  const [ac,bc,cc] = await Promise.all([browser.newContext({ reducedMotion: 'reduce' }),browser.newContext({ reducedMotion: 'reduce' }),browser.newContext({ reducedMotion: 'reduce' })]);
  const [a,b,c] = await Promise.all([ac.newPage(),bc.newPage(),cc.newPage()]);
  await ac.addInitScript(() => {
    localStorage.setItem('silenzachat-legacy-theme', 'light');
    const nativeFetch = window.fetch.bind(window);
    const ready = new Promise((resolve, reject) => {
      const request = indexedDB.open('silenzachat-legacy-private-v1', 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('identities');
        request.result.createObjectStore('peers');
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result, tx = db.transaction('identities', 'readwrite');
        tx.objectStore('identities').put({ migrationSentinel: 'preserved' }, 'migration-probe');
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
    });
    window.fetch = (...args) => ready.then(() => nativeFetch(...args));
  });
  const sent=[];
  for(const page of [a,b,c]) { page.on('pageerror',e=>errors.push(e.message)); page.on('request',r=>{if(r.url().endsWith('/api/message') && r.method()==='POST') sent.push(r.postDataJSON());}); }
  const landing = await browser.newPage();
  await landing.goto(origin);
  assert.match(await landing.locator('h1').textContent(), /Anonymous chat with no registration/);
  await landing.getByRole('link', { name: 'Connect to chat' }).first().click();
  await landing.waitForURL(`${origin}/chat/`);
  await landing.close();
  await Promise.all([a.goto(`${origin}/chat/`),b.goto(`${origin}/chat/`),c.goto(`${origin}/chat/`)]);
  assert.equal(await a.locator('html').getAttribute('data-theme'), 'light');
  assert.equal(await a.evaluate(() => localStorage.getItem('silenzachat-theme')), 'light');
  assert.equal(await a.evaluate(() => localStorage.getItem('silenzachat-legacy-theme')), null);
  await a.selectOption('#theme-select', 'dark');
  const migratedKeys = await a.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('silenzachat-private-v1');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction('identities'), get = tx.objectStore('identities').get('migration-probe');
      get.onsuccess = () => { db.close(); resolve(get.result?.migrationSentinel); };
      get.onerror = () => reject(get.error);
    };
  }));
  assert.equal(migratedKeys, 'preserved');
  for(const page of [a,b,c]) await page.waitForFunction(()=>document.querySelector('#connection').textContent==='Connected');
  const aliasA=await a.locator('#my-alias').textContent(), aliasB=await b.locator('#my-alias').textContent();
  await a.locator('#people .person').filter({hasText:aliasB}).click();
  await a.waitForFunction(()=>document.querySelector('#encryption-status').textContent.includes('End-to-end encrypted'));
  await a.locator('#message').fill('private sentinel caption'); await a.locator('.send-button').click();
  await b.locator('#dms .dm-room').filter({hasText:aliasA}).click();
  await b.getByText('private sentinel caption',{exact:true}).waitFor();
  assert.equal(sent[0].text,undefined); assert.ok(sent[0].encrypted); assert.ok(!JSON.stringify(sent[0]).includes('private sentinel caption'));
  // Reload and another tab reuse the local identity.
  await b.reload(); await b.locator('#dms .dm-room').filter({hasText:aliasA}).click(); await b.getByText('private sentinel caption',{exact:true}).waitFor();
  const tab=await ac.newPage(); await tab.goto(`${origin}/chat/`); await tab.locator('#dms .dm-room').filter({hasText:aliasB}).click(); await tab.getByText('private sentinel caption',{exact:true}).waitFor(); await tab.close();
  await a.locator('#verify-identity').click(); await b.locator('#verify-identity').click();
  await a.locator('#verify-dialog').waitFor({state:'visible'}); await b.locator('#verify-dialog').waitFor({state:'visible'});
  assert.equal(await a.locator('#verification-code').textContent(),await b.locator('#verification-code').textContent());
  await a.locator('#confirm-verification').click(); await b.locator('#confirm-verification').click();
  assert.match(await a.locator('#encryption-status').textContent(),/Identity verified/);
  // Encrypt a locally generated raster image. The original filename must never leave the browser.
  const imageAudit = await auditImages(a);
  const image=await a.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=160;canvas.height=100;const ctx=canvas.getContext('2d');ctx.fillStyle='#326b50';ctx.fillRect(0,0,160,100);return canvas.toDataURL('image/png').split(',')[1];});
  await imageAudit.assertFailsClosed(Buffer.from(image, 'base64'));
  await a.locator('#image-input').setInputFiles({name:'private-filename.png',mimeType:'image/png',buffer:Buffer.from(image,'base64')});
  await a.locator('#image-preview').waitFor({state:'visible'});
  await a.locator('#message').fill('secret image caption'); await a.locator('.send-button').click();
  await b.waitForFunction(()=>{const img=document.querySelector('.private-image');return img?.complete && img.naturalWidth===160;});
  assert.ok(!JSON.stringify(sent).includes('secret image caption')); assert.ok(!JSON.stringify(sent).includes('private-filename'));
  const imageMessage=sent.find(m=>m.attachmentId); assert.ok(imageMessage);
  const unauthorized=await c.request.get(`${origin}/api/attachments/${imageMessage.attachmentId}`); assert.equal(unauthorized.status(),404);
  // Private reply content is also ciphertext.
  await b.locator('.chat-message').filter({hasText:'secret image caption'}).getByRole('button',{name:'Reply',exact:true}).click();
  await b.locator('#message').fill('secret reply'); await b.locator('.send-button').click();
  await a.getByText('secret reply',{exact:true}).waitFor();
  assert.ok(!JSON.stringify(sent).includes('secret reply'));
  await a.screenshot({path:path.join(data, 'private-desktop.png'),fullPage:true});
  await b.setViewportSize({width:390,height:844}); await b.screenshot({path:path.join(data, 'private-mobile.png'),fullPage:true});
  // An attachment can be sent with no caption (the textarea is not required).
  await a.locator('#image-input').setInputFiles({name:'image-only.png',mimeType:'image/png',buffer:Buffer.from(image,'base64')});
  await a.locator('#image-preview').waitFor({state:'visible'}); assert.equal(await a.locator('#message').inputValue(), '');
  await a.locator('.send-button').click();
  await b.waitForFunction(()=>[...document.querySelectorAll('.private-image')].filter(img=>img.complete && img.naturalWidth===160).length===2);
  // Senders can delete their own images; recipients cannot. Replies and active previews are cleared.
  const imageRow = `#message-${imageMessage.id}`;
  assert.equal(await b.locator(imageRow).getByRole('button', {name:'Delete',exact:true}).count(), 0);
  await b.locator(imageRow).getByRole('button', {name:'Reply',exact:true}).click();
  await a.locator(imageRow).getByRole('button', {name:'Delete',exact:true}).click();
  await a.locator(imageRow).waitFor({state:'detached'}); await b.locator(imageRow).waitFor({state:'detached'});
  await b.locator('#reply-preview').waitFor({state:'hidden'});
  await b.getByText('Original message removed', {exact:true}).waitFor();
  assert.equal((await b.request.get(`${origin}/api/attachments/${imageMessage.attachmentId}`)).status(), 404);
  // Ordinary public-room messages have the same Delete action.
  await c.locator('#message').fill('public message to delete'); await c.locator('.send-button').click();
  const publicRow = c.locator('.chat-message').filter({hasText:'public message to delete'});
  await publicRow.getByRole('button', {name:'Delete',exact:true}).click(); await publicRow.waitFor({state:'detached'});
  // Private drafts must not appear in public room composers.
  await a.locator('#message').fill('unsent private draft');
  await a.locator('#rooms .nav-room').first().click(); assert.equal(await a.locator('#message').inputValue(), '');
  await a.locator('#dms .dm-room').filter({hasText:aliasB}).click();
  await a.waitForFunction(()=>document.querySelector('#message').disabled===false);
  assert.equal(await a.locator('#message').inputValue(), 'unsent private draft'); await a.locator('#message').fill('');
  // Offline recipients can decrypt later without either browser uploading a private key.
  await b.close(); await a.locator('#message').fill('delivered while offline'); await a.locator('.send-button').click();
  await a.getByText('delivered while offline', {exact:true}).waitFor();
  const returned=await bc.newPage(); returned.on('pageerror',e=>errors.push(e.message)); await returned.goto(`${origin}/chat/`);
  await returned.locator('#dms .dm-room').filter({hasText:aliasA}).click(); await returned.getByText('delivered while offline',{exact:true}).waitFor();
  assert.match(await returned.locator('#encryption-status').textContent(), /Identity verified/);
  // Only authenticated admins can opt into the visible identity, shared across tabs.
  await a.locator('#rooms .nav-room').first().click();
  await a.locator('#message').fill('message before admin display'); await a.locator('.send-button').click();
  const earlierName = c.locator('.chat-message').filter({hasText:'message before admin display'}).locator('.message-name');
  await earlierName.waitFor(); assert.equal(await earlierName.getAttribute('class'), 'message-name');
  await a.locator('#dms .dm-room').filter({hasText:aliasB}).click();
  assert.equal(await c.locator('#display-as-admin').isVisible(), false);
  await a.locator('#open-admin').click();
  await a.locator('#admin-password').fill('browser-test-only');
  await a.locator('#admin-login button').click();
  await a.locator('#display-as-admin').waitFor({state:'visible'});
  assert.equal(await a.locator('#display-as-admin').isChecked(), false);
  await a.locator('#display-as-admin').check();
  await c.locator('#people .admin-name').filter({hasText:aliasA}).waitFor();
  await earlierName.locator('.admin-badge').waitFor();
  assert.equal(await earlierName.evaluate(el => getComputedStyle(el).color), 'rgb(239, 143, 150)');
  const earlierOwnName = a.locator('.chat-message').filter({hasText:'delivered while offline'}).locator('.message-name');
  await earlierOwnName.locator('.admin-badge').waitFor();
  assert.equal(await earlierOwnName.evaluate(el => getComputedStyle(el).color), 'rgb(239, 143, 150)');
  await c.reload(); await earlierName.locator('.admin-badge').waitFor();
  const adminTab = await ac.newPage(); await adminTab.goto(`${origin}/chat/`);
  await adminTab.waitForFunction(()=>document.querySelector('#display-as-admin').checked);
  await a.locator('#admin-dialog .close-dialog').click();
  await a.locator('#message').fill('visible admin private message'); await a.locator('.send-button').click();
  const privateAdmin = returned.locator('.chat-message').filter({hasText:'visible admin private message'});
  await privateAdmin.locator('.message-name.admin-name').waitFor();
  await a.locator('#rooms .nav-room').first().click();
  await a.locator('#message').fill('visible admin public message'); await a.locator('.send-button').click();
  const adminName = c.locator('.chat-message').filter({hasText:'visible admin public message'}).locator('.message-name');
  await adminName.locator('.admin-badge').waitFor();
  assert.equal(await adminName.evaluate(el => getComputedStyle(el).fontWeight), '800');
  assert.equal(await adminName.evaluate(el => getComputedStyle(el).color), 'rgb(239, 143, 150)');
  await c.selectOption('#theme-select', 'light');
  assert.equal(await adminName.evaluate(el => getComputedStyle(el).color), 'rgb(169, 45, 66)');
  await c.selectOption('#theme-select', 'dark');
  await a.locator('#open-admin').click(); await a.locator('#display-as-admin').uncheck();
  await c.locator('#people .admin-name').filter({hasText:aliasA}).waitFor({state:'detached'});
  await adminTab.waitForFunction(()=>!document.querySelector('#display-as-admin').checked);
  await a.locator('#admin-dialog .close-dialog').click();
  await a.locator('#message').fill('ordinary admin public message'); await a.locator('.send-button').click();
  const ordinaryName = c.locator('.chat-message').filter({hasText:'ordinary admin public message'}).locator('.message-name');
  await ordinaryName.waitFor(); assert.equal(await ordinaryName.getAttribute('class'), 'message-name');
  assert.equal(await adminName.locator('.admin-badge').count(), 0);
  assert.equal(await earlierName.locator('.admin-badge').count(), 0);
  await privateAdmin.locator('.admin-badge').waitFor({state:'detached'});
  await a.locator('#open-admin').click(); await a.locator('#display-as-admin').check();
  await ordinaryName.locator('.admin-badge').waitFor();
  await a.locator('#admin-logout').click();
  await adminTab.waitForFunction(()=>document.querySelector('#admin-controls').hidden && !document.querySelector('#display-as-admin').checked);
  await c.locator('#people .admin-name').filter({hasText:aliasA}).waitFor({state:'detached'});
  await ordinaryName.locator('.admin-badge').waitFor({state:'detached'});
  await c.reload(); await earlierName.waitFor();
  assert.equal(await earlierName.getAttribute('class'), 'message-name');
  await a.locator('#admin-dialog .close-dialog').click(); await adminTab.close();
  // A substituted public key must block the conversation instead of silently trusting it.
  const substitute=await c.evaluate(()=>btoa(String.fromCharCode(...nacl.box.keyPair().publicKey)));
  await a.route('**/api/identity?peer=*',async route=>{ const response=await route.fetch(); const data=await response.json(); await route.fulfill({json:{...data,publicKey:substitute}}); });
  await a.locator('#rooms .nav-room').first().click(); await a.locator('#dms .dm-room').filter({hasText:aliasB}).click();
  await a.waitForFunction(()=>document.querySelector('#error').textContent.includes('Encryption identity changed'));
  assert.equal(await a.locator('#message').isDisabled(),true);
  // Losing a local key does not silently replace the registered key.
  await returned.evaluate(async()=>{await new Promise((resolve,reject)=>{const r=indexedDB.open('silenzachat-private-v1');r.onsuccess=()=>{const tx=r.result.transaction('identities','readwrite');tx.objectStore('identities').clear();tx.oncomplete=resolve;tx.onerror=reject;};});});
  await returned.reload(); await returned.locator('#dms .dm-room').filter({hasText:aliasA}).click();
  await returned.waitForFunction(()=>document.querySelector('#error').textContent.includes('local encryption key does not match'));
  assert.equal(await returned.locator('#message').isDisabled(),true);
  assert.deepEqual(errors,[]);
  const auditedImages = await imageAudit.verify(Buffer.from(image, 'base64'), 'private-filename.png');
  console.log(`PASS: ${auditedImages} private image uploads contain exact ciphertext; server returns unchanged ciphertext; no image plaintext or secret keys in captured requests`);
  console.log('PASS: private text, encrypted image, replies, third-party isolation, reload, shared-tab keys, matching verification codes, offline delivery, key-change/key-loss blocking, private draft isolation, owner deletion and attachment cleanup, desktop/mobile rendering');
} finally {
  await browser?.close(); server.kill(); await once(server,'exit'); await rm(data,{recursive:true,force:true});
}
