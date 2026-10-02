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
  // Per-user budgets count only what that user sent, so nobody can fill another
  // person's quota (or conversation slots) by messaging them.
  check(key, messages) {
    if (!key.startsWith('dm:')) return null;
    this.get(key); // Apply idle expiry before accounting for a replacement.
    const previous = this.records.get(key), bytes = Buffer.byteLength(JSON.stringify(messages));
    const delta = bytes - (previous?.bytes || 0), ids = key.split(':').slice(1);
    if (delta > 0 && this.bytes + delta > this.maxBytes) fail();
    const senders = Object.fromEntries(ids.map(id => [id, 0])), clients = {}, owners = new Map(ids.map(id => [id, this.clientOf(id)]));
    for (const message of messages) {
      const size = Buffer.byteLength(JSON.stringify(message));
      if (Object.hasOwn(senders, message.sender)) senders[message.sender] += size;
      const client = owners.get(message.sender);
      if (client) clients[client] = (clients[client] || 0) + size;
    }
    for (const id of ids) {
      const usage = this.users.get(id) || { bytes: 0, conversations: 0 }, before = previous?.senders?.[id] || 0, after = senders[id];
      if (after > before && usage.bytes - before + after > this.perUserBytes) fail();
      if (!before && after && usage.conversations + 1 > this.perUserConversations) fail();
    }
    // Attribute stored bytes to the sender's network client (and its wider network), so a
    // client cannot exhaust the shared pool and a recipient is not charged for what others send.
    const network = client => client && client.includes('.') ? client.split('.')[1] : null;
    for (const [client, used] of Object.entries(clients)) {
      if (used <= (previous?.clients?.[client] || 0)) continue;
      let total = used, wide = used;
      for (const [other, record] of this.records) for (const [owner, amount] of Object.entries(record.clients || {})) {
        if (other !== key && owner === client) total += amount;
        if (network(client) && network(owner) === network(client) && (other !== key || owner !== client)) wide += amount;
      }
      if (total > this.perClientBytes || (network(client) && wide > this.perClientBytes * 4)) fail();
    }
    return { bytes, delta, ids, previous, clients, senders };
  }
  account(ids, senders, sign) {
    for (const id of ids) {
      const amount = senders?.[id] || 0; if (!amount) continue;
      const usage = this.users.get(id) || { bytes: 0, conversations: 0 };
      const next = { bytes: usage.bytes + sign * amount, conversations: usage.conversations + sign };
      if (next.conversations <= 0) this.users.delete(id); else this.users.set(id, next);
    }
  }
  set(key, messages) {
    if (key.startsWith('dm:') && !messages.length) { this.delete(key); return this; }
    const result = this.check(key, messages);
    if (result) {
      const retained = new Set(messages.map(m => m.attachment?.id));
      for (const old of super.get(key) || []) if (old.attachment && !retained.has(old.attachment.id)) this.attachments?.remove(old.attachment.id);
      const { bytes, delta, ids, previous, clients, senders } = result;
      this.bytes += delta;
      this.account(ids, previous?.senders, -1); this.account(ids, senders, 1);
      this.records.set(key, { bytes, ids, clients, senders, updated: this.now() });
    }
    return super.set(key, messages);
  }
  delete(key) {
    const record = this.records.get(key);
    if (record) {
      this.bytes -= record.bytes;
      this.account(record.ids, record.senders, -1);
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
