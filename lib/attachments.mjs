import { randomUUID } from 'node:crypto';
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024 + 16;
const error = (status, message) => Object.assign(new Error(message), { status });
// IPv6 client keys look like "<client>.<network>"; the network part groups a whole /48.
const network = client => client && String(client).includes('.') ? String(client).split('.')[1] : null;

// Ephemeral, bounded ciphertext only. No files, plaintext metadata or keys on disk.
export class Attachments {
  constructor({ ttl = 86400000, now = Date.now, maxBytes = 128 * 1024 * 1024, perUser = 20 * 1024 * 1024, perClient = 12 * 1024 * 1024 } = {}) {
    this.ttl = ttl; this.now = now; this.maxBytes = maxBytes; this.perUser = perUser; this.perClient = perClient;
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
  // client is the uploader's network key; it bounds one address's share of the shared pool.
  // declared: the request's Content-Length when known, so a pending upload reserves only
  // what it announced instead of the 4 MB maximum.
  async upload(stream, owner, peer, groupContext = {}, client = null, declared = null) {
    this.sweep();
    if (declared !== null && (!Number.isSafeInteger(declared) || declared < 17 || declared > MAX_IMAGE_BYTES)) throw error(declared > MAX_IMAGE_BYTES ? 413 : 400, 'Encrypted images must be no larger than 4 MB.');
    const reserve = declared ?? MAX_IMAGE_BYTES;
    const used = [...this.items.values()], pending = [...this.reservations.values()];
    const sum = (items, match) => items.filter(match).reduce((n, x) => n + (x.bytes?.length ?? x.size), 0);
    const total = sum(used, () => true) + sum(pending, () => true);
    const own = sum(used, x => x.owner === owner) + sum(pending, x => x.owner === owner);
    const fromClient = client ? sum(used, x => x.client === client) + sum(pending, x => x.client === client) : 0;
    const fromNetwork = network(client) ? sum(used, x => network(x.client) === network(client)) + sum(pending, x => network(x.client) === network(client)) : 0;
    if (client && (fromClient + reserve > this.perClient || (network(client) && fromNetwork + reserve > this.perClient * 3))) throw error(429, 'Too many images are stored from this network. Try again after older images expire.');
    if (total + reserve > this.maxBytes || own + reserve > this.perUser) throw error(429, 'Image storage is full. Try again after older images expire.');
    const id = randomUUID(); this.reservations.set(id, { owner, client, size: reserve });
    try {
      const chunks = []; let size = 0;
      for await (const chunk of stream) {
        size += chunk.length;
        if (size > reserve) throw error(413, 'Encrypted images must be no larger than 4 MB.');
        chunks.push(chunk);
      }
      if (size < 17 || (declared !== null && size !== declared)) throw error(400, 'Invalid encrypted image.');
      const createdAt = this.now();
      this.items.set(id, { owner, peer, client, ...groupContext, bytes: Buffer.concat(chunks), createdAt, expiresAt: createdAt + Math.min(this.ttl, 600000), message: null });
      return { id };
    } finally { this.reservations.delete(id); }
  }
}
