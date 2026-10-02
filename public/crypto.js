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
  const FILE_TYPES = { image: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'], video: ['video/mp4', 'video/quicktime', 'video/webm'],
    audio: ['audio/mpeg', 'audio/mp4', 'audio/webm', 'audio/wav'], file: ['application/octet-stream'] };
  const FILE_KEYS = ['id', 'kind', 'type', 'size', 'key', 'nonce', 'width', 'height', 'name'];
  const unsafeName = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069\\/]/;
  const dimension = value => Number.isInteger(value) && value >= 1 && value <= 65535;
  function validateFile(file) {
    if (file === null) return;
    if (!file || typeof file !== 'object' || Object.keys(file).some(key => !FILE_KEYS.includes(key)) || typeof file.id !== 'string' || file.id.length > 64 ||
        !Object.hasOwn(FILE_TYPES, file.kind) || !FILE_TYPES[file.kind].includes(file.type) ||
        !Number.isSafeInteger(file.size) || file.size < 1 || file.size > 64 * 1024 * 1024) throw new Error('Invalid private attachment.');
    const sized = file.width != null || file.height != null;
    if ((file.kind === 'image' && !sized) || (sized && (!['image', 'video'].includes(file.kind) || !dimension(file.width) || !dimension(file.height)))) throw new Error('Invalid private attachment.');
    // Only generic files carry a name, and it must be safe to show and use as a download name.
    if (file.kind === 'file' ? typeof file.name !== 'string' || !file.name.trim() || file.name.length > 120 || unsafeName.test(file.name) || ['.', '..'].includes(file.name)
      : file.name != null) throw new Error('Invalid private attachment.');
    unbase64(file.key, 32); unbase64(file.nonce, 24);
  }
  // Messages from before generic attachments carry "image": null instead of "file".
  function fileOf(value) {
    if (Object.hasOwn(value, 'file') && !Object.hasOwn(value, 'image')) return value.file;
    if (!Object.hasOwn(value, 'file') && value.image === null) return null;
    throw new Error('Invalid private message.');
  }
  function validateContent(value) {
    if (!value || value.v !== 1 || typeof value.text !== 'string' || value.text.length > 2000 ||
        (value.replyTo !== null && typeof value.replyTo !== 'string')) throw new Error('Invalid private message.');
    const file = fileOf(value);
    validateFile(file);
    if (!value.text.trim() && !file) throw new Error('Empty private message.');
    // Optional sender clock (ms since epoch), authenticated with the message so a relay cannot silently backdate it.
    if (value.sentAt !== undefined && (!Number.isSafeInteger(value.sentAt) || value.sentAt < 1e12 || value.sentAt > 1e13)) throw new Error('Invalid private message time.');
    return value;
  }
  // sentAt: omitted → now; null → leave out (for edits of legacy messages without a sender time).
  const withTime = (value, sentAt) => sentAt === null ? value : { ...value, sentAt: sentAt === undefined ? Date.now() : sentAt };
  function encryptMessage({ id, sender, recipient, text, replyTo = null, file = null, editVersion = 0, sentAt }, identity, peerKey) {
    const value = validateContent(withTime({ v: 1, kind: 'private', id, sender, recipient, text, replyTo, file, editVersion }, sentAt));
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
        value.replyTo !== (message.reply?.id || null) || (fileOf(value)?.id || null) !== (message.attachment?.id || null)) throw new Error('Private message metadata did not match.');
    return { text: value.text, file: fileOf(value), ...(value.sentAt !== undefined ? { sentAt: value.sentAt } : {}) };
  }
  // Padmé padding: an encrypted attachment's size reveals only a coarse size class
  // (at most about 12% overhead) instead of the exact length of the file.
  function paddedSize(length) {
    const n = Math.max(length, 256);
    let e = 0, s = 1;
    while (2 ** (e + 1) <= n) e++;
    while (2 ** s <= e) s++;
    const step = 2 ** (e - s);
    return Math.ceil(n / step) * step;
  }
  function encryptAttachment(bytes) {
    const key = nacl.randomBytes(32), nonce = nacl.randomBytes(24), padded = new Uint8Array(paddedSize(bytes.length));
    padded.set(bytes);
    return { bytes: nacl.secretbox(padded, nonce, key), key: base64(key), nonce: base64(nonce) };
  }
  // Signing keys are derived from the box secret key, so existing identities need no new storage.
  const signingKeys = identity => nacl.sign.keyPair.fromSeed(nacl.hash(new Uint8Array([...new TextEncoder().encode('silenzachat-sign-v1'), ...identity.secretKey])).subarray(0, 32));
  function signKeyOf(text) { return unbase64(text, 32); }
  // Canonical bytes an author signs so that room history can be re-shared with later members
  // without letting the member who re-shares it change its content or author.
  function historyRecord(group, id, sender, { text, replyTo, file, editVersion, sentAt }) {
    const canonicalFile = file ? Object.fromEntries(FILE_KEYS.filter(key => Object.hasOwn(file, key)).map(key => [key, file[key]])) : null;
    return encode(['silenzachat-room-history-v1', group, id, sender, editVersion || 0, text, replyTo, canonicalFile, sentAt ?? null]);
  }
  function verifyHistory(group, id, sender, content, signature, senderSignKey) {
    if (typeof senderSignKey !== 'string') throw new Error('The author of this shared message has no signing key.');
    if (!nacl.sign.detached.verify(historyRecord(group, id, sender, content), unbase64(signature, 64), signKeyOf(senderSignKey))) throw new Error('This shared room message could not be verified.');
  }
  function encryptGroupMessage({ id, group, version, sender, text, replyTo = null, file = null, editVersion = 0, sentAt, shareable = false }, identity, members, signing) {
    if (typeof group !== 'string' || !Number.isInteger(version) || version < 1 || !members.some(p => p.id === sender)) throw new Error('Invalid room membership.');
    // Every member receives the same sender time, so a relay cannot reorder copies differently.
    const content = validateContent(withTime({ v: 1, text, replyTo, file, editVersion }, sentAt));
    if (shareable && !signing) throw new Error('Room history sharing needs a signing key.');
    const history = shareable ? { history: base64(nacl.sign.detached(historyRecord(group, id, sender, content), signing.secretKey)) } : {};
    return Object.fromEntries(members.map(person => {
      const value = { ...content, ...history, kind: 'group', id, group, version, sender, recipient: person.id };
      const nonce = nacl.randomBytes(24);
      return [person.id, { v: 1, nonce: base64(nonce), ciphertext: base64(nacl.box(encode(value), nonce, publicKey(person.publicKey), identity.secretKey)) }];
    }));
  }
  function contentOf(value) { return { text: value.text, file: fileOf(value), ...(value.sentAt !== undefined ? { sentAt: value.sentAt } : {}) }; }
  function decryptGroupMessage(message, ownId, identity, senderKey, senderSignKey) {
    if (!message.group || message.room || message.recipient || message.encrypted?.v !== 1) throw new Error('Invalid encrypted room message.');
    const bytes = nacl.box.open(unbase64(message.encrypted.ciphertext), unbase64(message.encrypted.nonce, 24), publicKey(senderKey), identity.secretKey);
    if (!bytes) throw new Error('This room message could not be authenticated.');
    const value = validateContent(decode(bytes));
    if ((value.editVersion || 0) !== (message.editVersion || 0) || value.kind !== 'group' || value.id !== message.id || value.group !== message.group || value.version !== message.version ||
        value.sender !== message.sender || value.recipient !== ownId || value.replyTo !== (message.reply?.id || null) || (fileOf(value)?.id || null) !== (message.attachment?.id || null) ||
        Object.hasOwn(value, 'history') !== Boolean(message.shareable)) throw new Error('Room message metadata did not match.');
    // Check the signature now, so a member never re-shares a message that later members would reject.
    if (message.shareable) verifyHistory(message.group, message.id, message.sender, value, value.history, senderSignKey);
    return { ...contentOf(value), ...(message.shareable ? { history: value.history } : {}) };
  }
  // A member re-encrypts a shareable message, with the author's signature, for a later member.
  function encryptGroupShare(message, content, signature, sharer, identity, recipient) {
    const value = { ...validateContent({ v: 1, text: content.text, replyTo: message.reply?.id || null, file: content.file, editVersion: message.editVersion || 0, ...(content.sentAt !== undefined ? { sentAt: content.sentAt } : {}) }),
      kind: 'group-share', id: message.id, group: message.group, sender: message.sender, sharer, recipient: recipient.id, history: signature };
    const nonce = nacl.randomBytes(24);
    return { v: 1, nonce: base64(nonce), ciphertext: base64(nacl.box(encode(value), nonce, publicKey(recipient.publicKey), identity.secretKey)) };
  }
  // The sharer's box only provides confidentiality; authorship comes from the author's signature.
  function decryptGroupShare(message, ownId, identity, sharerKey, senderSignKey) {
    const shared = message.shared;
    if (!message.group || message.room || message.recipient || message.encrypted || !message.shareable || shared?.encrypted?.v !== 1 || typeof shared.by !== 'string') throw new Error('Invalid shared room message.');
    const bytes = nacl.box.open(unbase64(shared.encrypted.ciphertext), unbase64(shared.encrypted.nonce, 24), publicKey(sharerKey), identity.secretKey);
    if (!bytes) throw new Error('This shared room message could not be authenticated.');
    const value = validateContent(decode(bytes));
    if ((value.editVersion || 0) !== (message.editVersion || 0) || value.kind !== 'group-share' || value.id !== message.id || value.group !== message.group || value.sender !== message.sender ||
        value.sharer !== shared.by || value.recipient !== ownId || value.replyTo !== (message.reply?.id || null) || (fileOf(value)?.id || null) !== (message.attachment?.id || null)) throw new Error('Shared room message metadata did not match.');
    verifyHistory(message.group, message.id, message.sender, value, value.history, senderSignKey);
    return { ...contentOf(value), history: value.history };
  }
  function decryptAttachment(bytes, file) {
    if (bytes.length !== paddedSize(file.size) + 16) throw new Error('Invalid encrypted attachment size.');
    const plain = nacl.secretbox.open(bytes, unbase64(file.nonce, 24), unbase64(file.key, 32));
    if (!plain) throw new Error('This attachment could not be authenticated.');
    return plain.subarray(0, file.size);
  }
  function verificationCode(a, b) {
    publicKey(a.publicKey); publicKey(b.publicKey);
    // When both people have signing keys, the code covers them too, so a substituted signing key is caught.
    const signed = Boolean(a.signKey && b.signKey);
    if (signed) { signKeyOf(a.signKey); signKeyOf(b.signKey); }
    const pair = [a, b].map(p => signed ? [p.id, p.publicKey, p.signKey] : [p.id, p.publicKey]).sort((x, y) => x[0].localeCompare(y[0]));
    return Array.from(nacl.hash(encode([signed ? 'silenzachat-identity-v2' : 'silenzachat-identity-v1', pair])).subarray(0, 32), b => b.toString(16).padStart(2, '0')).join('').match(/.{4}/g).join(' ');
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
    let db = await openStore(), reopening, identity, signing, disposed = false;
    function ensureActive() { if (disposed) throw new Error('This encryption identity has been signed out.'); }
    function dispose() { disposed = true; identity?.secretKey.fill(0); signing?.secretKey.fill(0); db.close(); activeClients.delete(dispose); }
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
    signing = signingKeys(identity);
    const ownSignKey = base64(signing.publicKey);
    try { await api('identity', { publicKey: ownKey, signKey: ownSignKey }); ensureActive(); }
    catch (error) { dispose(); throw error; }
    // Signing keys are pinned with the encryption key. A peer first seen without one gets it pinned
    // on first sight, and a previously verified peer must be verified again to cover it.
    async function trust(remote) {
      publicKey(remote.publicKey);
      const signKey = remote.signKey ?? null;
      if (signKey !== null) signKeyOf(signKey);
      if (remote.id === id && (remote.publicKey !== ownKey || (signKey !== null && signKey !== ownSignKey))) throw new Error('Your encryption identity changed.');
      return stored('peers', `${id}:${remote.id}`, existing => {
        if (existing && existing.publicKey !== remote.publicKey) throw new Error('Encryption identity changed. Private chat is blocked.');
        if (existing?.signKey && signKey !== null && existing.signKey !== signKey) throw new Error('Encryption identity changed. Private chat is blocked.');
        if (!existing) return { id: remote.id, publicKey: remote.publicKey, ...(signKey ? { signKey } : {}), verified: false };
        return existing.signKey || !signKey ? existing : { ...existing, signKey, verified: false };
      });
    }
    async function decryptGroup(message) {
      const author = await trust({ id: message.sender, publicKey: message.senderKey, signKey: message.senderSignKey });
      if (message.shared) {
        const sharer = await trust({ id: message.shared.by, publicKey: message.shared.sharerKey });
        ensureActive();
        return { ...decryptGroupShare(message, id, identity, sharer.publicKey, author.signKey), sharedBy: sharer.id };
      }
      ensureActive();
      return decryptGroupMessage(message, id, identity, author.publicKey, author.signKey);
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
        return encryptGroupMessage(data, identity, trusted, signing);
      },
      decryptGroup,
      // Decrypts a shareable message this member can read and re-encrypts it for each later member.
      shareGroup: async (message, recipients) => {
        const plain = await decryptGroup(message);
        const trusted = await Promise.all(recipients.map(trust));
        ensureActive();
        return Object.fromEntries(trusted.map(person => [person.id, encryptGroupShare(message, plain, plain.history, id, identity, person)]));
      },
      code: person => { ensureActive(); return verificationCode({ id, publicKey: ownKey, signKey: ownSignKey }, person); },
      verify: async person => stored('peers', `${id}:${person.id}`, existing => {
        if (!existing || existing.publicKey !== person.publicKey || (existing.signKey || null) !== (person.signKey || null)) throw new Error('Encryption identity changed.');
        return { ...existing, verified: true };
      })
    };
  }
  return { base64, unbase64, publicKey, signingKeys, encryptMessage, decryptMessage, encryptGroupMessage, decryptGroupMessage, encryptGroupShare, decryptGroupShare, paddedSize, encryptAttachment, decryptAttachment, verificationCode, createClient, clearLocalKeys };
});
