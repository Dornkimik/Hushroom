import { randomUUID } from 'node:crypto';
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024 + 16;
const error = (status, message) => Object.assign(new Error(message), { status });

// Ephemeral, bounded ciphertext only. No files, plaintext metadata or keys on disk.
export class Attachments {
  constructor({ ttl = 86400000, now = Date.now, maxBytes = 128 * 1024 * 1024, perUser = 20 * 1024 * 1024 } = {}) {
    this.ttl = ttl; this.now = now; this.maxBytes = maxBytes; this.perUser = perUser;
    this.items = new Map(); this.reservations = new Map();
  }
  sweep() { for (const [id, item] of this.items) if (item.expiresAt <= this.now()) this.items.delete(id); }
  remove(id) { this.items.delete(id); }
  removeGroup(group) { for (const [id, item] of this.items) if (item.group === group) this.items.delete(id); }
  removeUser(id) { for (const [key, item] of this.items) if (item.owner === id || item.peer === id) this.items.delete(key); }
  get(id, user) {
    this.sweep(); const item = this.items.get(id);
    if (!item || (item.owner !== user && (!item.message || (item.group ? !item.recipients.has(user) : item.peer !== user)))) throw error(404, 'Image expired or unavailable.');
    return item;
  }
  claim(id, owner, peer, message) {
    const item = this.get(id, owner);
    if (item.group || item.owner !== owner || item.peer !== peer || item.message) throw error(400, 'Invalid image attachment.');
    item.message = message; item.expiresAt = item.createdAt + this.ttl;
    return { id, expiresAt: item.expiresAt };
  }
  groupItem(id, owner, group, version) {
    const item = this.get(id, owner);
    if (item.owner !== owner || item.group !== group || item.version !== version || item.message) throw error(400, 'Invalid image attachment or room membership changed. Attach the image again.');
    return item;
  }
  claimGroup(id, owner, group, version, message, recipients) {
    const item = this.groupItem(id, owner, group, version);
    item.message = message; item.recipients = new Set(recipients); item.expiresAt = item.createdAt + this.ttl;
    return { id, expiresAt: item.expiresAt };
  }
  async upload(stream, owner, peer, groupContext = {}) {
    this.sweep();
    const used = [...this.items.values()], pending = [...this.reservations.values()];
    const total = used.reduce((n, x) => n + x.bytes.length, 0) + pending.length * MAX_IMAGE_BYTES;
    const own = used.filter(x => x.owner === owner).reduce((n, x) => n + x.bytes.length, 0) + pending.filter(x => x === owner).length * MAX_IMAGE_BYTES;
    if (total + MAX_IMAGE_BYTES > this.maxBytes || own + MAX_IMAGE_BYTES > this.perUser) throw error(429, 'Image storage is full. Try again after older images expire.');
    const id = randomUUID(); this.reservations.set(id, owner);
    try {
      const chunks = []; let size = 0;
      for await (const chunk of stream) {
        size += chunk.length;
        if (size > MAX_IMAGE_BYTES) throw error(413, 'Encrypted images must be no larger than 4 MB.');
        chunks.push(chunk);
      }
      if (size < 17) throw error(400, 'Invalid encrypted image.');
      const createdAt = this.now();
      this.items.set(id, { owner, peer, ...groupContext, bytes: Buffer.concat(chunks), createdAt, expiresAt: createdAt + Math.min(this.ttl, 600000), message: null });
      return { id };
    } finally { this.reservations.delete(id); }
  }
}
