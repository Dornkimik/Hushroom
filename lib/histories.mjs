const fail = () => { throw Object.assign(new Error('Private chat storage is full. Remove older messages or try again later.'), { status: 503 }); };

// Public histories retain their existing behavior. Private histories have byte,
// conversation and idle-expiry limits independent of participant session expiry.
export class Histories extends Map {
  // clientOf maps a participant ID to its network client key; one client cannot
  // consume more than perClientBytes of the shared private-history budget.
  constructor({ attachments, now = Date.now, maxBytes = 64 * 1024 * 1024, perUserBytes = 4 * 1024 * 1024,
    perUserConversations = 50, ttl = 86400000, clientOf = () => null, perClientBytes = 4 * 1024 * 1024 } = {}) {
    super(); Object.assign(this, { attachments, now, maxBytes, perUserBytes, perUserConversations, ttl, clientOf, perClientBytes });
    this.records = new Map(); this.users = new Map(); this.bytes = 0;
  }
  get(key) {
    const record = this.records.get(key);
    if (record && record.updated + this.ttl <= this.now()) this.delete(key);
    return super.get(key);
  }
  has(key) { return this.get(key) !== undefined; }
  check(key, messages) {
    if (!key.startsWith('dm:')) return null;
    this.get(key); // Apply idle expiry before accounting for a replacement.
    const previous = this.records.get(key), bytes = Buffer.byteLength(JSON.stringify(messages));
    const delta = bytes - (previous?.bytes || 0), ids = key.split(':').slice(1);
    if (this.bytes + delta > this.maxBytes) fail();
    for (const id of ids) {
      const usage = this.users.get(id) || { bytes: 0, conversations: 0 };
      if (usage.bytes + delta > this.perUserBytes || usage.conversations + (previous ? 0 : 1) > this.perUserConversations) fail();
    }
    // Attribute stored bytes to the sender's network client, so a client cannot
    // exhaust the shared pool and a recipient is not charged for what others send.
    const clients = {}, owners = new Map(ids.map(id => [id, this.clientOf(id)]));
    for (const message of messages) {
      const client = owners.get(message.sender);
      if (client) clients[client] = (clients[client] || 0) + Buffer.byteLength(JSON.stringify(message));
    }
    for (const [client, used] of Object.entries(clients)) {
      if (used <= (previous?.clients?.[client] || 0)) continue;
      let total = used;
      for (const [other, record] of this.records) if (other !== key) total += record.clients?.[client] || 0;
      if (total > this.perClientBytes) fail();
    }
    return { bytes, delta, ids, previous, clients };
  }
  set(key, messages) {
    if (key.startsWith('dm:') && !messages.length) { this.delete(key); return this; }
    const result = this.check(key, messages);
    if (result) {
      const retained = new Set(messages.map(m => m.attachment?.id));
      for (const old of super.get(key) || []) if (old.attachment && !retained.has(old.attachment.id)) this.attachments?.remove(old.attachment.id);
      const { bytes, delta, ids, previous, clients } = result;
      this.bytes += delta;
      for (const id of ids) {
        const usage = this.users.get(id) || { bytes: 0, conversations: 0 };
        this.users.set(id, { bytes: usage.bytes + delta, conversations: usage.conversations + (previous ? 0 : 1) });
      }
      this.records.set(key, { bytes, ids, clients, updated: this.now() });
    }
    return super.set(key, messages);
  }
  delete(key) {
    const record = this.records.get(key);
    if (record) {
      this.bytes -= record.bytes;
      for (const id of record.ids) {
        const usage = this.users.get(id);
        if (usage.conversations === 1) this.users.delete(id);
        else this.users.set(id, { bytes: usage.bytes - record.bytes, conversations: usage.conversations - 1 });
      }
      for (const message of super.get(key) || []) this.attachments?.remove(message.attachment?.id);
      this.records.delete(key);
    }
    return super.delete(key);
  }
  removeUser(id) { for (const [key, record] of this.records) if (record.ids.includes(id)) this.delete(key); }
  sweep(activeIds) {
    for (const [key, record] of this.records) if (record.updated + this.ttl <= this.now() || record.ids.some(id => !activeIds.has(id))) this.delete(key);
  }
  clear() { for (const key of this.keys()) this.delete(key); }
}
