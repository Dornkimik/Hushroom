/* NaCl authenticated boxes; all plaintext and private keys stay in the browser. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('tweetnacl'));
  else root.SilenzaCrypto = factory(root.nacl);
})(globalThis, function (nacl) {
  'use strict';
  const activeClients = new Set();
  let cleanupChannel;
  function invalidateClients() {
    for (const dispose of [...activeClients]) dispose();
    globalThis.dispatchEvent?.(new Event('silenza-signed-out'));
  }
  function channel() {
    if (!cleanupChannel && typeof BroadcastChannel !== 'undefined') {
      cleanupChannel = new BroadcastChannel('silenzachat-key-lifecycle');
      cleanupChannel.onmessage = event => { if (event.data === 'signed-out') invalidateClients(); };
    }
    return cleanupChannel;
  }
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
    // Optional sender clock (ms since epoch), authenticated with the message so a relay cannot silently backdate it.
    if (value.sentAt !== undefined && (!Number.isSafeInteger(value.sentAt) || value.sentAt < 1e12 || value.sentAt > 1e13)) throw new Error('Invalid private message time.');
    return value;
  }
  // sentAt: omitted → now; null → leave out (for edits of legacy messages without a sender time).
  const withTime = (value, sentAt) => sentAt === null ? value : { ...value, sentAt: sentAt === undefined ? Date.now() : sentAt };
  function encryptMessage({ id, sender, recipient, text, replyTo = null, image = null, editVersion = 0, sentAt }, identity, peerKey) {
    const value = validateContent(withTime({ v: 1, kind: 'private', id, sender, recipient, text, replyTo, image, editVersion }, sentAt));
    const nonce = nacl.randomBytes(24);
    return { v: 1, nonce: base64(nonce), ciphertext: base64(nacl.box(encode(value), nonce, publicKey(peerKey), identity.secretKey)) };
  }
  function decryptMessage(message, ownId, identity, peerKey) {
    if (message.room || message.group || !message.encrypted || message.encrypted.v !== 1 ||
        (message.sender !== ownId && message.recipient !== ownId)) throw new Error('Invalid private message.');
    const bytes = nacl.box.open(unbase64(message.encrypted.ciphertext), unbase64(message.encrypted.nonce, 24), publicKey(peerKey), identity.secretKey);
    if (!bytes) throw new Error('This private message could not be authenticated.');
    const value = validateContent(decode(bytes));
    // Legacy private envelopes have no kind; group envelopes are never private messages.
    if ((value.kind !== undefined && value.kind !== 'private') || Object.hasOwn(value, 'group') || Object.hasOwn(value, 'version')) throw new Error('Private message context did not match.');
    if ((value.editVersion || 0) !== (message.editVersion || 0) || value.id !== message.id || value.sender !== message.sender || value.recipient !== message.recipient ||
        value.replyTo !== (message.reply?.id || null) || (value.image?.id || null) !== (message.attachment?.id || null)) throw new Error('Private message metadata did not match.');
    return { text: value.text, image: value.image, ...(value.sentAt !== undefined ? { sentAt: value.sentAt } : {}) };
  }
  function encryptImage(bytes) {
    const key = nacl.randomBytes(32), nonce = nacl.randomBytes(24);
    return { bytes: nacl.secretbox(bytes, nonce, key), key: base64(key), nonce: base64(nonce) };
  }
  function encryptGroupMessage({ id, group, version, sender, text, replyTo = null, image = null, editVersion = 0, sentAt }, identity, members) {
    if (typeof group !== 'string' || !Number.isInteger(version) || version < 1 || !members.some(p => p.id === sender)) throw new Error('Invalid room membership.');
    // Every member receives the same sender time, so a relay cannot reorder copies differently.
    const content = validateContent(withTime({ v: 1, text, replyTo, image, editVersion }, sentAt));
    return Object.fromEntries(members.map(person => {
      const value = { ...content, kind: 'group', id, group, version, sender, recipient: person.id };
      const nonce = nacl.randomBytes(24);
      return [person.id, { v: 1, nonce: base64(nonce), ciphertext: base64(nacl.box(encode(value), nonce, publicKey(person.publicKey), identity.secretKey)) }];
    }));
  }
  function decryptGroupMessage(message, ownId, identity, senderKey) {
    if (!message.group || message.room || message.recipient || message.encrypted?.v !== 1) throw new Error('Invalid encrypted room message.');
    const bytes = nacl.box.open(unbase64(message.encrypted.ciphertext), unbase64(message.encrypted.nonce, 24), publicKey(senderKey), identity.secretKey);
    if (!bytes) throw new Error('This room message could not be authenticated.');
    const value = validateContent(decode(bytes));
    if ((value.editVersion || 0) !== (message.editVersion || 0) || value.kind !== 'group' || value.id !== message.id || value.group !== message.group || value.version !== message.version ||
        value.sender !== message.sender || value.recipient !== ownId || value.replyTo !== (message.reply?.id || null) || (value.image?.id || null) !== (message.attachment?.id || null)) throw new Error('Room message metadata did not match.');
    return { text: value.text, image: value.image, ...(value.sentAt !== undefined ? { sentAt: value.sentAt } : {}) };
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
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => db.close();
        resolve(db);
      };
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
      const tx = db.transaction(name === 'peers' ? ['identities', 'peers'] : name, 'readwrite'), store = tx.objectStore(name), keys = store.getAllKeys();
      keys.onsuccess = () => {
        const existing = new Set(keys.result);
        for (const [key, value] of entries) if (!existing.has(key) || value?.revoked) {
          if (name === 'peers') {
            const owner = tx.objectStore('identities').get(String(key).split(':')[0]);
            owner.onsuccess = () => { if (!owner.result?.revoked) store.put(value, key); };
          } else store.put(value, key);
        }
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
  async function transaction(db, storeName, id, transform, ownerId) {
    return new Promise((resolve, reject) => {
      let tx;
      try { tx = db.transaction(ownerId ? ['identities', storeName] : storeName, 'readwrite'); }
      catch (e) {
        // Only a failure to start is safe to retry; never replay an aborted write.
        reject(Object.assign(new Error('Could not open local encryption storage.'), { cause: e, closedDatabase: e.name === 'InvalidStateError' }));
        return;
      }
      const owner = ownerId ? tx.objectStore('identities').get(ownerId) : null;
      const store = tx.objectStore(storeName), request = store.get(id);
      let result, failure;
      request.onsuccess = () => {
        try {
          if (owner && (!owner.result || owner.result.revoked)) throw new Error('This encryption identity has been signed out.');
          result = transform(request.result); store.put(result, id);
        }
        catch (e) { failure = e; tx.abort(); }
      };
      tx.oncomplete = () => resolve(result);
      tx.onabort = tx.onerror = () => reject(failure || new Error('Could not access your local encryption keys.'));
    });
  }
  async function clearLocalKeys() {
    invalidateClients(); channel()?.postMessage('signed-out');
    // Mark identities revoked instead of deleting their IDs: a pending migration
    // or another tab cannot recreate an old key after this transaction completes.
    const revokedIds = new Set();
    // Sweep the primary store again after legacy cleanup. Propagate every
    // revocation so a migration already in flight cannot restore legacy-only keys.
    for (const name of ['silenzachat-private-v1', 'silenzachat-legacy-private-v1', 'silenzachat-private-v1']) {
      const db = await openDatabase(name);
      try {
        await new Promise((resolve, reject) => {
          const tx = db.transaction(['identities', 'peers'], 'readwrite');
          const identities = tx.objectStore('identities');
          for (const id of revokedIds) identities.put({ revoked: true }, id);
          const cursor = identities.openCursor();
          cursor.onsuccess = () => { if (cursor.result) { revokedIds.add(cursor.result.key); cursor.result.update({ revoked: true }); cursor.result.continue(); } };
          tx.objectStore('peers').clear();
          tx.oncomplete = resolve;
          tx.onabort = tx.onerror = () => reject(new Error('Signed out, but local encryption keys could not be cleared. Clear this site’s browser data.'));
        });
      } finally { db.close(); }
    }
  }
  async function createClient(id, api) {
    if (!globalThis.isSecureContext) throw new Error('Private chats require HTTPS (or localhost).');
    let db = await openStore(), reopening, identity, disposed = false;
    function ensureActive() { if (disposed) throw new Error('This encryption identity has been signed out.'); }
    function dispose() { disposed = true; identity?.secretKey.fill(0); db.close(); activeClients.delete(dispose); }
    activeClients.add(dispose); channel();
    async function stored(storeName, key, transform) {
      ensureActive();
      const guarded = existing => { ensureActive(); return transform(existing); };
      const connection = db;
      try { return await transaction(connection, storeName, key, guarded, storeName === 'peers' ? id : undefined); }
      catch (e) {
        if (!e.closedDatabase) throw e;
        ensureActive();
        if (db === connection) {
          if (!reopening) reopening = (async () => {
            // Reopen the same database without rerunning migration or replacing keys.
            const replacement = await openDatabase(connection.name);
            try {
              if (identity) await transaction(replacement, 'identities', id, existing => {
                ensureActive();
                if (!existing || existing.revoked || base64(existing.publicKey) !== base64(identity.publicKey) || base64(existing.secretKey) !== base64(identity.secretKey)) {
                  throw new Error('Your local encryption identity is missing or changed. Reload the page to reconnect safely.');
                }
                return existing;
              });
              ensureActive(); db = replacement;
            } catch (error) { replacement.close(); throw error; }
          })().finally(() => { reopening = null; });
          await reopening;
        }
        return transaction(db, storeName, key, guarded, storeName === 'peers' ? id : undefined);
      }
    }
    try {
      identity = await stored('identities', id, existing => {
        if (existing?.revoked) throw new Error('This encryption identity has been signed out.');
        return existing || nacl.box.keyPair();
      });
    } catch (error) { dispose(); throw error; }
    const ownKey = base64(identity.publicKey);
    try { await api('identity', { publicKey: ownKey }); ensureActive(); }
    catch (error) { dispose(); throw error; }
    async function trust(remote) {
      publicKey(remote.publicKey);
      if (remote.id === id && remote.publicKey !== ownKey) throw new Error('Your encryption identity changed.');
      return stored('peers', `${id}:${remote.id}`, existing => {
        if (existing && existing.publicKey !== remote.publicKey) throw new Error('Encryption identity changed. Private chat is blocked.');
        return existing || { id: remote.id, publicKey: remote.publicKey, verified: false };
      });
    }
    async function peer(peerId) { return trust(await api(`identity?peer=${encodeURIComponent(peerId)}`)); }
    return {
      peer,
      dispose,
      encrypt: (data, person) => { ensureActive(); return encryptMessage(data, identity, person.publicKey); },
      decrypt: (message, person) => { ensureActive(); return decryptMessage(message, id, identity, person.publicKey); },
      encryptGroup: async (data, members) => {
        const trusted = await Promise.all(members.map(trust));
        ensureActive();
        return encryptGroupMessage(data, identity, trusted);
      },
      decryptGroup: async message => {
        const person = await trust({ id: message.sender, publicKey: message.senderKey });
        ensureActive();
        return decryptGroupMessage(message, id, identity, person.publicKey);
      },
      code: person => { ensureActive(); return verificationCode({ id, publicKey: ownKey }, person); },
      verify: async person => stored('peers', `${id}:${person.id}`, existing => {
        if (!existing || existing.publicKey !== person.publicKey) throw new Error('Encryption identity changed.');
        return { ...existing, verified: true };
      })
    };
  }
  return { base64, unbase64, publicKey, encryptMessage, decryptMessage, encryptGroupMessage, decryptGroupMessage, encryptImage, decryptImage, verificationCode, createClient, clearLocalKeys };
});
