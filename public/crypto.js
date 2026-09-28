/* NaCl authenticated boxes; all plaintext and private keys stay in the browser. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('tweetnacl'));
  else root.SilenzaCrypto = factory(root.nacl);
})(globalThis, function (nacl) {
  'use strict';
  const encode = value => new TextEncoder().encode(JSON.stringify(value));
  const decode = bytes => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  function base64(bytes) {
    let text = '';
    for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return btoa(text);
  }
  function unbase64(text, size) {
    if (typeof text !== 'string' || text.length > 24000) throw new Error('Invalid encrypted data.');
    const bytes = Uint8Array.from(atob(text), c => c.charCodeAt(0));
    if (base64(bytes) !== text || (size !== undefined && bytes.length !== size)) throw new Error('Invalid encrypted data.');
    return bytes;
  }
  function publicKey(text) {
    const bytes = unbase64(text, 32);
    // Reject low-order points before deriving a shared key (TweetNaCl itself accepts them).
    const probe = nacl.scalarMult(new Uint8Array(32).fill(42), bytes);
    if (probe.every(value => value === 0)) throw new Error('Invalid encryption identity.');
    return bytes;
  }
  function validateContent(value) {
    if (!value || value.v !== 1 || typeof value.text !== 'string' || value.text.length > 2000 ||
        (value.replyTo !== null && typeof value.replyTo !== 'string')) throw new Error('Invalid private message.');
    const image = value.image;
    if (image !== null) {
      if (!image || typeof image.id !== 'string' || image.type !== 'image/webp' ||
          !Number.isInteger(image.width) || image.width < 1 || image.width > 2048 ||
          !Number.isInteger(image.height) || image.height < 1 || image.height > 2048 ||
          !Number.isInteger(image.size) || image.size < 1 || image.size > 4 * 1024 * 1024) throw new Error('Invalid private image.');
      unbase64(image.key, 32); unbase64(image.nonce, 24);
    }
    if (!value.text.trim() && !image) throw new Error('Empty private message.');
    return value;
  }
  function encryptMessage({ id, sender, recipient, text, replyTo = null, image = null }, identity, peerKey) {
    const value = validateContent({ v: 1, id, sender, recipient, text, replyTo, image });
    const nonce = nacl.randomBytes(24);
    return { v: 1, nonce: base64(nonce), ciphertext: base64(nacl.box(encode(value), nonce, publicKey(peerKey), identity.secretKey)) };
  }
  function decryptMessage(message, ownId, identity, peerKey) {
    if (message.room || !message.encrypted || message.encrypted.v !== 1 ||
        (message.sender !== ownId && message.recipient !== ownId)) throw new Error('Invalid private message.');
    const bytes = nacl.box.open(unbase64(message.encrypted.ciphertext), unbase64(message.encrypted.nonce, 24), publicKey(peerKey), identity.secretKey);
    if (!bytes) throw new Error('This private message could not be authenticated.');
    const value = validateContent(decode(bytes));
    if (value.id !== message.id || value.sender !== message.sender || value.recipient !== message.recipient ||
        value.replyTo !== (message.reply?.id || null) || (value.image?.id || null) !== (message.attachment?.id || null)) throw new Error('Private message metadata did not match.');
    return { text: value.text, image: value.image };
  }
  function encryptImage(bytes) {
    const key = nacl.randomBytes(32), nonce = nacl.randomBytes(24);
    return { bytes: nacl.secretbox(bytes, nonce, key), key: base64(key), nonce: base64(nonce) };
  }
  function decryptImage(bytes, image) {
    if (bytes.length !== image.size + 16) throw new Error('Invalid encrypted image size.');
    const plain = nacl.secretbox.open(bytes, unbase64(image.nonce, 24), unbase64(image.key, 32));
    if (!plain) throw new Error('This image could not be authenticated.');
    return plain;
  }
  function verificationCode(a, b) {
    publicKey(a.publicKey); publicKey(b.publicKey);
    const pair = [a, b].map(p => [p.id, p.publicKey]).sort((x, y) => x[0].localeCompare(y[0]));
    return Array.from(nacl.hash(encode(['silenzachat-identity-v1', pair])).subarray(0, 32), b => b.toString(16).padStart(2, '0')).join('').match(/.{4}/g).join(' ');
  }
  function openDatabase(name) {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains('identities')) request.result.createObjectStore('identities');
        if (!request.result.objectStoreNames.contains('peers')) request.result.createObjectStore('peers');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error('Private chats need browser storage for encryption keys.'));
    });
  }
  function readEntries(db, name) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(name, 'readonly'), store = tx.objectStore(name);
      const keys = store.getAllKeys(), values = store.getAll();
      tx.oncomplete = () => resolve(keys.result.map((key, index) => [key, values.result[index]]));
      tx.onabort = tx.onerror = () => reject(new Error('Could not migrate local encryption keys.'));
    });
  }
  function copyMissingEntries(db, name, entries) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(name, 'readwrite'), store = tx.objectStore(name), keys = store.getAllKeys();
      keys.onsuccess = () => {
        const existing = new Set(keys.result);
        for (const [key, value] of entries) if (!existing.has(key)) store.put(value, key);
      };
      tx.oncomplete = resolve;
      tx.onabort = tx.onerror = () => reject(new Error('Could not migrate local encryption keys.'));
    });
  }
  async function openStore() {
    const db = await openDatabase('silenzachat-private-v1');
    let legacy;
    try {
      legacy = await openDatabase('silenzachat-legacy-private-v1');
      for (const name of ['identities', 'peers']) await copyMissingEntries(db, name, await readEntries(legacy, name));
      legacy.close();
      indexedDB.deleteDatabase('silenzachat-legacy-private-v1');
      return db;
    } catch {
      db.close();
      legacy?.close();
      return openDatabase('silenzachat-legacy-private-v1');
    }
  }
  // Read/write happen in one transaction, so simultaneous tabs cannot generate different identities.
  async function transaction(db, storeName, id, transform) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite'), store = tx.objectStore(storeName), request = store.get(id);
      let result, failure;
      request.onsuccess = () => {
        try { result = transform(request.result); store.put(result, id); }
        catch (e) { failure = e; tx.abort(); }
      };
      tx.oncomplete = () => resolve(result);
      tx.onabort = tx.onerror = () => reject(failure || new Error('Could not access your local encryption keys.'));
    });
  }
  async function createClient(id, api) {
    if (!globalThis.isSecureContext) throw new Error('Private chats require HTTPS (or localhost).');
    const db = await openStore();
    const identity = await transaction(db, 'identities', id, existing => existing || nacl.box.keyPair());
    const ownKey = base64(identity.publicKey);
    await api('identity', { publicKey: ownKey });
    async function peer(peerId) {
      const remote = await api(`identity?peer=${encodeURIComponent(peerId)}`);
      publicKey(remote.publicKey);
      return transaction(db, 'peers', `${id}:${peerId}`, existing => {
        if (existing && existing.publicKey !== remote.publicKey) throw new Error('Encryption identity changed. Private chat is blocked.');
        return existing || { id: peerId, publicKey: remote.publicKey, verified: false };
      });
    }
    return {
      peer,
      encrypt: (data, person) => encryptMessage(data, identity, person.publicKey),
      decrypt: (message, person) => decryptMessage(message, id, identity, person.publicKey),
      code: person => verificationCode({ id, publicKey: ownKey }, person),
      verify: async person => transaction(db, 'peers', `${id}:${person.id}`, existing => {
        if (!existing || existing.publicKey !== person.publicKey) throw new Error('Encryption identity changed.');
        return { ...existing, verified: true };
      })
    };
  }
  return { base64, unbase64, publicKey, encryptMessage, decryptMessage, encryptImage, decryptImage, verificationCode, createClient };
});
