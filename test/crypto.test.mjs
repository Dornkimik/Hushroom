import test from 'node:test';
import assert from 'node:assert/strict';
import nacl from 'tweetnacl';
import crypto from '../public/crypto.js';
import { Attachments, MAX_ATTACHMENT_BYTES } from '../lib/attachments.mjs';
import { Readable, PassThrough } from 'node:stream';

const key = person => crypto.base64(person.publicKey);
test('private messages authenticate both directions and reject tampering and metadata substitution', () => {
  const a = nacl.box.keyPair(), b = nacl.box.keyPair(), stranger = nacl.box.keyPair();
  const value = { id: 'message', sender: 'a', recipient: 'b', text: 'secret caption 👋', replyTo: null };
  const encrypted = crypto.encryptMessage(value, a, key(b));
  const message = { id: value.id, sender: 'a', recipient: 'b', room: null, encrypted, reply: null, attachment: null };
  assert.equal(crypto.decryptMessage(message, 'a', a, key(b)).text, value.text);
  assert.equal(crypto.decryptMessage(message, 'b', b, key(a)).text, value.text);
  assert.throws(() => crypto.decryptMessage(message, 'b', stranger, key(a)), /authenticated/);
  assert.throws(() => crypto.decryptMessage({ ...message, sender: 'b', recipient: 'a' }, 'b', b, key(a)), /metadata/);
  assert.throws(() => crypto.decryptMessage({ ...message, id: 'replayed' }, 'b', b, key(a)), /metadata/);
  assert.throws(() => crypto.decryptMessage({ ...message, reply: { id: 'forged' } }, 'b', b, key(a)), /metadata/);
  const bytes = crypto.unbase64(encrypted.ciphertext); bytes[0] ^= 1;
  assert.throws(() => crypto.decryptMessage({ ...message, encrypted: { ...encrypted, ciphertext: crypto.base64(bytes) } }, 'b', b, key(a)), /authenticated/);
  assert.notEqual(crypto.encryptMessage(value, a, key(b)).nonce, encrypted.nonce);
  assert.throws(() => crypto.publicKey(crypto.base64(new Uint8Array(32))), /identity/);
});

test('message ciphertexts are padded to 512-byte classes and padded messages still decrypt', () => {
  const a = nacl.box.keyPair(), b = nacl.box.keyPair();
  const size = text => crypto.unbase64(crypto.encryptMessage({ id: 'm', sender: 'a', recipient: 'b', text }, a, key(b)).ciphertext).length;
  assert.equal(size('hi'), size('a considerably longer private message that still fits in one block'));
  assert.equal((size('hi') - 16) % 512, 0);
  assert.ok(size('x'.repeat(1200)) > size('hi'));
  // Worst-case content (escaped control characters) stays within the server's ciphertext limit.
  assert.ok(size('\u0001'.repeat(2000)) <= 18000);
  const encrypted = crypto.encryptMessage({ id: 'm', sender: 'a', recipient: 'b', text: 'padded 👋' }, a, key(b));
  assert.equal(crypto.decryptMessage({ id: 'm', sender: 'a', recipient: 'b', room: null, encrypted, reply: null, attachment: null }, 'b', b, key(a)).text, 'padded 👋');
});

test('attachment keys are independent, and integrity failures never return plaintext', () => {
  const bytes = new TextEncoder().encode('attachment bytes');
  const first = crypto.encryptAttachment(bytes), second = crypto.encryptAttachment(bytes);
  assert.notEqual(first.key, second.key); assert.notEqual(first.nonce, second.nonce);
  assert.deepEqual(crypto.decryptAttachment(first.bytes, { ...first, size: bytes.length }), bytes);
  assert.throws(() => crypto.decryptAttachment(first.bytes, { ...second, size: bytes.length }), /authenticated/);
  first.bytes[0] ^= 1;
  assert.throws(() => crypto.decryptAttachment(first.bytes, { ...first, size: bytes.length }), /authenticated/);
});

test('valid group ciphertext cannot be relabelled as a private message', () => {
  const a = nacl.box.keyPair(), b = nacl.box.keyPair();
  const envelopes = crypto.encryptGroupMessage({ id: 'message', group: 'room', version: 1, sender: 'a', text: 'Only in this group' }, a,
    [{ id: 'a', publicKey: key(a) }, { id: 'b', publicKey: key(b) }]);
  const privateView = { id: 'message', sender: 'a', recipient: 'b', room: null, encrypted: envelopes.b, reply: null, attachment: null };
  assert.throws(() => crypto.decryptMessage(privateView, 'b', b, key(a)), /context/);
  const ordinary = { ...privateView, encrypted: crypto.encryptMessage({ id: 'message', sender: 'a', recipient: 'b', text: 'Private only' }, a, key(b)) };
  assert.equal(crypto.decryptMessage(ordinary, 'b', b, key(a)).text, 'Private only');
  assert.throws(() => crypto.decryptMessage({ ...ordinary, group: 'room' }, 'b', b, key(a)), /Invalid private/);
  const legacy = { v: 1, id: 'message', sender: 'a', recipient: 'b', text: 'Previously sent private message', replyTo: null, image: null };
  const nonce = nacl.randomBytes(24);
  const legacyBox = { v: 1, nonce: crypto.base64(nonce), ciphertext: crypto.base64(nacl.box(new TextEncoder().encode(JSON.stringify(legacy)), nonce, b.publicKey, a.secretKey)) };
  assert.equal(crypto.decryptMessage({ ...privateView, encrypted: legacyBox }, 'b', b, key(a)).text, legacy.text);
});

test('verification codes are symmetric and bind session IDs and keys', () => {
  const a = { id: 'a', publicKey: key(nacl.box.keyPair()) }, b = { id: 'b', publicKey: key(nacl.box.keyPair()) };
  assert.equal(crypto.verificationCode(a, b), crypto.verificationCode(b, a));
  assert.notEqual(crypto.verificationCode(a, b), crypto.verificationCode(a, { ...b, id: 'replacement' }));
  assert.notEqual(crypto.verificationCode(a, b), crypto.verificationCode(a, { ...b, publicKey: key(nacl.box.keyPair()) }));
  // With signing keys on both sides, the code also binds them.
  const signKey = () => crypto.base64(nacl.sign.keyPair().publicKey);
  const as = { ...a, signKey: signKey() }, bs = { ...b, signKey: signKey() };
  assert.equal(crypto.verificationCode(as, bs), crypto.verificationCode(bs, as));
  assert.notEqual(crypto.verificationCode(as, bs), crypto.verificationCode(a, b));
  assert.notEqual(crypto.verificationCode(as, bs), crypto.verificationCode(as, { ...bs, signKey: signKey() }));
  assert.equal(crypto.verificationCode(as, b), crypto.verificationCode(a, b));
});

test('attachment expiry, abandoned uploads, ownership and quotas', async () => {
  let time = 1000;
  const store = new Attachments({ now: () => time, ttl: 3600000, maxBytes: MAX_ATTACHMENT_BYTES * 2, perUser: MAX_ATTACHMENT_BYTES });
  const body = () => Readable.from([Buffer.alloc(64, 1)]);
  const first = await store.upload(body(), 'a', 'b');
  assert.throws(() => store.get(first.id, 'b'), /unavailable/);
  assert.throws(() => store.claim(first.id, 'a', 'c', 'msg'), /Invalid/);
  const attachment = store.claim(first.id, 'a', 'b', 'msg');
  assert.equal(store.get(first.id, 'b').bytes.length, 64);
  assert.throws(() => store.get(first.id, 'c'), /unavailable/);
  await assert.rejects(store.upload(body(), 'a', 'b'), /full/);
  time = attachment.expiresAt;
  assert.throws(() => store.get(first.id, 'a'), /unavailable/);
  const abandoned = await store.upload(body(), 'a', 'b'); time += 600000;
  assert.throws(() => store.get(abandoned.id, 'a'), /unavailable/);
  await assert.rejects(store.upload(Readable.from([Buffer.alloc(MAX_ATTACHMENT_BYTES + 1)]), 'a', 'b'), /16 MB/);
  assert.equal(store.reservations.size, 0);
  const removed = await store.upload(body(), 'a', 'b'); store.removeUser('b');
  assert.throws(() => store.get(removed.id, 'a'), /unavailable/);
});


test('simultaneous uploads reserve capacity before reading their bytes', async () => {
  const store = new Attachments({ maxBytes: MAX_ATTACHMENT_BYTES, perUser: MAX_ATTACHMENT_BYTES });
  const pending = new PassThrough();
  const uploading = store.upload(pending, 'a', 'b');
  await assert.rejects(store.upload(Readable.from([Buffer.alloc(64)]), 'c', 'd'), /full/);
  pending.end(Buffer.alloc(64)); await uploading;
  assert.equal(store.reservations.size, 0);
});
