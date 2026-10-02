import { randomUUID } from 'node:crypto';

const TTL = 24 * 60 * 60 * 1000;
const MAX_ROOMS = 1000, ROOMS_PER_CLIENT = 6, MAX_BYTES = 64 * 1024 * 1024, BYTES_PER_CLIENT = 6 * 1024 * 1024;
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
// IPv6 client keys look like "<client>.<network>"; the network part groups a whole /48.
const network = client => client && String(client).includes('.') ? String(client).split('.')[1] : null;
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
function validBox(box) {
  if (!box || box.v !== 1 || Object.keys(box).some(k => !['v', 'nonce', 'ciphertext'].includes(k))) return false;
  return [['nonce', 24, 24], ['ciphertext', 17, 18000]].every(([key, min, max]) => {
    const value = box[key];
    if (typeof value !== 'string' || value.length > 24000) return false;
    const bytes = Buffer.from(value, 'base64');
    return bytes.length >= min && bytes.length <= max && bytes.toString('base64') === value;
  });
}
function details(input) {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const description = typeof input.description === 'string' ? input.description.trim() : '';
  const rules = typeof input.rules === 'string' ? input.rules.trim() : '';
  if (!name || name.length > 40 || description.length > 120 || rules.length > 2000) fail(400, 'Use a name up to 40 characters, description up to 120, and rules up to 2,000.');
  const access = input.access ?? 'open';
  if (!['open', 'invite'].includes(access)) fail(400, 'Choose open or invite-only access.');
  return { name, description, rules, access };
}

// Temporary room metadata and ciphertext only. Identity secret keys never enter this class.
export class Groups {
  constructor({ isAdmin = () => false, emit, broadcast, safeUser, findUser, attachments, now = Date.now }) {
    Object.assign(this, { isAdmin, emit, broadcast, safeUser, findUser, attachments, now });
    this.rooms = new Map(); this.bytes = 0;
    // Sender network keys stay server-side: a WeakMap is never serialized into messages.
    this.clients = new WeakMap();
  }
  clientBytes(client) {
    let used = 0;
    for (const group of this.rooms.values()) for (const message of group.history) if (this.clients.get(message) === client) used += message.bytes;
    return used;
  }
  networkBytes(client) {
    const wide = network(client); if (!wide) return 0;
    let used = 0;
    for (const group of this.rooms.values()) for (const message of group.history) if (network(this.clients.get(message)) === wide) used += message.bytes;
    return used;
  }
  overClientBudget(client, delta) {
    return Boolean(client) && (this.clientBytes(client) + delta > BYTES_PER_CLIENT || (network(client) && this.networkBytes(client) + delta > BYTES_PER_CLIENT * 4));
  }
  summary(group, user) {
    return { id: group.id, name: group.name, description: group.description, rules: group.rules,
      owner: group.owner, count: group.members.size, version: group.version, access: group.access, invited: group.invited.has(user.id),
      joined: group.members.has(user.id), blocked: group.kicked.has(user.id), expiresAt: group.updated + TTL };
  }
  list(user) { this.sweep(); return [...this.rooms.values()].filter(g => g.access === 'open' || g.members.has(user.id) || g.invited.has(user.id)).map(g => this.summary(g, user)); }
  moderate(action, user, input = {}) {
    if (!this.isAdmin(user)) fail(403, 'Unlock admin controls first.');
    if (action === 'list') {
      this.sweep();
      return [...this.rooms.values()].map(group => this.summary(group, user));
    }
    const group = this.get(input.group);
    if (action === 'delete') { this.remove(group); return { ok: true }; }
    if (action !== 'update') fail(404, 'Not found.');
    if (Object.hasOwn(input, 'access') && input.access !== group.access) fail(403, 'Only the room owner can change access.');
    Object.assign(group, details({ ...input, access: group.access }));
    group.updated = this.now(); this.changed(group);
    return this.summary(group, user);
  }
  get(id) {
    const group = this.rooms.get(id);
    if (!group || this.now() >= group.updated + TTL) { if (group) this.remove(group); fail(404, 'This temporary room has expired or was deleted.'); }
    return group;
  }
  member(group, user) { if (!group.members.has(user.id)) fail(403, 'Join this room first.'); }
  checkAttachment(item, user) {
    const group = this.rooms.get(item.group), member = group?.members.get(user.id);
    if (!group || group.updated + TTL <= this.now() || !member || member.joinedVersion > item.version) fail(404, 'Image expired or unavailable.');
  }
  owner(group, user) { this.member(group, user); if (group.owner !== user.id) fail(403, 'Only the room owner can do that.'); }
  state(group, user) {
    this.member(group, user);
    return { ...this.summary(group, user), members: [...group.members.values()].map(({ user: member, joinedAt, messages }) => ({
      ...this.safeUser(member), publicKey: member.publicKey, joinedAt,
      ...(group.owner === user.id ? { messages } : {})
    })) };
  }
  changed(group) {
    for (const { user } of group.members.values()) this.emit(user, 'group-state', this.state(group, user));
    this.broadcast('groups-changed', {});
  }
  remove(group) {
    this.attachments?.removeGroup(group.id);
    this.bytes -= group.bytes; this.rooms.delete(group.id);
    for (const { user } of group.members.values()) this.emit(user, 'group-removed', { group: group.id, reason: 'This temporary room was deleted or expired.' });
    this.broadcast('groups-changed', {});
  }
  removeMember(group, id, reason) {
    const member = group.members.get(id); if (!member) return;
    group.members.delete(id); group.version++; group.updated = this.now();
    this.emit(member.user, 'group-removed', { group: group.id, reason });
    if (!group.members.size) { this.remove(group); return; }
    if (group.owner === id) group.owner = group.members.keys().next().value;
    this.changed(group);
  }
  removeUser(id) { for (const group of this.rooms.values()) { group.invited.delete(id); group.kicked.delete(id); this.removeMember(group, id, 'Your session is no longer a member of this room.'); } }
  sweep() { for (const group of this.rooms.values()) if (this.now() >= group.updated + TTL) this.remove(group); }
  viewMessage(message, user) {
    const { envelopes, bytes, ...metadata } = message;
    return { ...metadata, encrypted: envelopes[user.id] };
  }
  editMembers(group, message) {
    return [...group.members.values()].filter(member => member.joinedVersion <= message.version && Object.hasOwn(message.envelopes, member.user.id));
  }
  ownMessage(group, user, id) {
    this.member(group, user);
    const message = group.history.find(m => m.id === id && m.sender === user.id && m.version >= group.members.get(user.id).joinedVersion);
    if (!message) fail(404, 'Your message is no longer available to edit.');
    return message;
  }
  edit(group, user, input) {
    const message = this.ownMessage(group, user, input.id);
    if (Object.keys(input).some(k => !['group', 'id', 'membershipVersion', 'editVersion', 'envelopes'].includes(k))) fail(400, 'Room edits must contain ciphertext only.');
    if (input.membershipVersion !== group.version) fail(409, 'Membership changed. Try editing again.');
    if (input.editVersion !== (message.editVersion || 0) + 1) fail(409, 'This message changed. Reopen the editor and try again.');
    const members = this.editMembers(group, message);
    if (!input.envelopes || Array.isArray(input.envelopes) || typeof input.envelopes !== 'object' ||
        Object.keys(input.envelopes).length !== members.length || members.some(m => !validBox(input.envelopes[m.user.id]))) fail(400, 'Encrypt for the original recipients who are still members.');
    user.sent = user.sent.filter(t => this.now() - t < 10000);
    if (user.sent.length >= 8) fail(429, 'Take a breath. Try again in a few seconds.');
    const next = { ...message, envelopes: input.envelopes, editVersion: input.editVersion, editedAt: new Date(this.now()).toISOString() };
    delete next.bytes; next.bytes = Buffer.byteLength(JSON.stringify(next));
    const delta = next.bytes - message.bytes;
    if (group.bytes + delta > 4 * 1024 * 1024 || this.bytes + delta > MAX_BYTES) fail(503, 'Temporary chat storage is full. Try again later.');
    if (delta > 0 && this.overClientBudget(user.clientKey, delta)) fail(429, 'Too much temporary room data is stored from this network. Try again later.');
    Object.assign(message, next); group.bytes += delta; this.bytes += delta; group.updated = this.now(); user.sent.push(this.now());
    for (const { user: member } of members) this.emit(member, 'message-edited', this.viewMessage(message, member));
    return this.viewMessage(message, user);
  }
  handle(method, action, user, input) {
    if (method === 'GET' && action === '') return this.list(user);
    if (method === 'POST' && action === 'create') {
      if (!user.publicKey) fail(409, 'Enable encryption before creating a room.');
      this.sweep();
      if ([...this.rooms.values()].filter(g => g.members.has(user.id)).length >= 20) fail(400, 'You can join up to 20 temporary rooms.');
      if (this.rooms.size >= MAX_ROOMS || [...this.rooms.values()].filter(g => g.owner === user.id).length >= 3) fail(400, `Limit reached: three owned rooms per person and ${MAX_ROOMS} temporary rooms total.`);
      const ownerKeys = [...this.rooms.values()].map(g => g.members.get(g.owner)?.user.clientKey);
      if (user.clientKey && (ownerKeys.filter(key => key === user.clientKey).length >= ROOMS_PER_CLIENT ||
          (network(user.clientKey) && ownerKeys.filter(key => network(key) === network(user.clientKey)).length >= ROOMS_PER_CLIENT * 4))) fail(429, 'Too many temporary rooms are owned from this network.');
      const group = { ...details(input), id: randomUUID(), owner: user.id, version: 1,
        members: new Map([[user.id, { user, joinedAt: this.now(), joinedVersion: 1, messages: 0 }]]), kicked: new Set(), invited: new Set(), history: [], bytes: 0, updated: this.now() };
      this.rooms.set(group.id, group); this.changed(group); return this.state(group, user);
    }
    const group = this.get(input.group);
    if (method === 'GET' && action === 'message-edit-state') {
      const message = this.ownMessage(group, user, input.id);
      return { membershipVersion: group.version, members: this.editMembers(group, message).map(({ user: member }) => ({ id: member.id, publicKey: member.publicKey })) };
    }
    if (method === 'GET' && action === 'state') return this.state(group, user);
    if (method === 'GET' && action === 'history') {
      this.member(group, user);
      return group.history.filter(m => m.version >= group.members.get(user.id).joinedVersion && Object.hasOwn(m.envelopes, user.id)).map(m => this.viewMessage(m, user));
    }
    if (method !== 'POST') fail(404, 'Not found.');
    if (action === 'join') {
      if (group.kicked.has(user.id)) fail(403, 'The owner removed you from this room. You cannot rejoin with this session.');
      if (group.access === 'invite' && !group.members.has(user.id) && !group.invited.has(user.id)) fail(403, 'This room requires an invitation from its owner.');
      if (!user.publicKey) fail(409, 'Enable encryption before joining a room.');
      if (!group.members.has(user.id)) {
        if (group.members.size >= 20) fail(400, 'This room is full (20 members).');
        if ([...this.rooms.values()].filter(g => g.members.has(user.id)).length >= 20) fail(400, 'You can join up to 20 temporary rooms.');
        group.version++;
        group.members.set(user.id, { user, joinedAt: this.now(), joinedVersion: group.version, messages: 0 }); group.invited.delete(user.id); group.updated = this.now(); this.changed(group);
      }
      return this.state(group, user);
    }
    this.member(group, user);
    if (action === 'message-edit') return this.edit(group, user, input);
    if (action === 'message') return this.send(group, user, input);
    if (action === 'message-delete') {
      const message = group.history.find(m => m.id === input.id);
      if (!message || (message.sender !== user.id && group.owner !== user.id)) fail(403, 'Only the sender or room owner can remove this message.');
      group.history = group.history.filter(m => m !== message); group.bytes -= message.bytes; this.bytes -= message.bytes;
      this.attachments?.remove(message.attachment?.id);
      for (const m of group.history) if (m.reply?.id === message.id) m.reply = { id: message.id, removed: true };
      for (const { user: member } of group.members.values()) this.emit(member, 'message-removed', { id: message.id, group: group.id });
      return { id: message.id, group: group.id };
    }
    if (action === 'leave') {
      if (group.owner === user.id && group.members.size > 1) fail(400, 'Transfer ownership before leaving, or delete the room.');
      this.removeMember(group, user.id, 'You left the room.'); return { ok: true };
    }
    this.owner(group, user);
    if (action === 'invite') {
      const invited = this.findUser(input.member);
      if (!invited?.publicKey || group.members.has(input.member) || group.kicked.has(input.member)) fail(400, 'Choose an available person who is not already a member or removed.');
      if (group.invited.size >= 20) fail(400, 'This room already has 20 pending invitations.');
      group.invited.add(input.member); group.updated = this.now(); this.changed(group); return { ok: true };
    }
    if (action === 'delete') { this.remove(group); return { ok: true }; }
    if (action === 'update') Object.assign(group, details(input));
    else if (action === 'kick' || action === 'transfer') {
      if (input.member === user.id || !group.members.has(input.member)) fail(400, 'Choose another current member.');
      if (action === 'kick') {
        group.kicked.add(input.member); this.removeMember(group, input.member, 'The owner removed you from this room.'); return this.state(group, user);
      }
      if ([...this.rooms.values()].filter(g => g.owner === input.member).length >= 3) fail(400, 'That member already owns three rooms.');
      group.owner = input.member;
    } else fail(404, 'Not found.');
    group.updated = this.now(); this.changed(group); return this.state(group, user);
  }
  send(group, user, input) {
    if (Object.keys(input).some(k => !['group', 'id', 'version', 'envelopes', 'replyTo', 'attachmentId'].includes(k))) fail(400, 'Group messages must contain ciphertext only.');
    if (!uuid(input.id) || !input.envelopes || typeof input.envelopes !== 'object' || Array.isArray(input.envelopes)) fail(400, 'Invalid encrypted group message.');
    const prior = group.history.find(m => m.id === input.id);
    if (prior) {
      if (prior.sender !== user.id || prior.version !== input.version || JSON.stringify(prior.envelopes) !== JSON.stringify(input.envelopes) || (prior.reply?.id || null) !== (input.replyTo || null) || (prior.attachment?.id || null) !== (input.attachmentId || null)) fail(409, 'Message ID already used.');
      return this.viewMessage(prior, user);
    }
    if (input.version !== group.version) fail(409, 'Membership changed. Send again to encrypt for the current members.');
    const recipients = Object.keys(input.envelopes);
    if (recipients.length !== group.members.size || recipients.some(id => !group.members.has(id) || !validBox(input.envelopes[id]))) fail(400, 'Encrypt separately for every current member, including yourself.');
    const original = input.replyTo == null ? null : group.history.find(m => m.id === input.replyTo && m.version >= group.members.get(user.id).joinedVersion && Object.hasOwn(m.envelopes, user.id));
    if (input.replyTo != null && !original) fail(400, 'That reply is unavailable.');
    user.sent = user.sent.filter(t => this.now() - t < 10000);
    if (user.sent.length >= 8) fail(429, 'Take a breath. Try again in a few seconds.');
    const upload = input.attachmentId == null ? null : this.attachments.groupItem(input.attachmentId, user.id, group.id, group.version);
    const attachment = upload ? { id: input.attachmentId, expiresAt: upload.createdAt + this.attachments.ttl } : null;
    const message = { id: input.id, group: group.id, version: group.version, sender: user.id, senderKey: user.publicKey,
      alias: user.alias, displayAsAdmin: this.safeUser(user).displayAsAdmin, time: new Date(this.now()).toISOString(),
      reply: original ? { id: original.id } : null, attachment, envelopes: input.envelopes };
    message.bytes = Buffer.byteLength(JSON.stringify(message));
    if (this.bytes + message.bytes > MAX_BYTES) fail(503, 'Temporary chat storage is full. Try again later.');
    if (this.overClientBudget(user.clientKey, message.bytes)) fail(429, 'Too much temporary room data is stored from this network. Try again later.');
    if (attachment) this.attachments.claimGroup(attachment.id, user.id, group.id, group.version, input.id, recipients);
    if (user.clientKey) this.clients.set(message, user.clientKey);
    group.history.push(message); group.bytes += message.bytes; this.bytes += message.bytes;
    while (group.history.length > 100 || group.bytes > 4 * 1024 * 1024) { const old = group.history.shift(); group.bytes -= old.bytes; this.bytes -= old.bytes; this.attachments?.remove(old.attachment?.id); }
    user.sent.push(this.now()); group.members.get(user.id).messages++; group.updated = this.now();
    for (const { user: member } of group.members.values()) this.emit(member, 'message', this.viewMessage(message, member));
    const owner = group.members.get(group.owner).user; this.emit(owner, 'group-state', this.state(group, owner));
    return this.viewMessage(message, user);
  }
}
