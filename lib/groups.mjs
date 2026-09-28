import { randomUUID } from 'node:crypto';

const TTL = 24 * 60 * 60 * 1000;
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
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
  constructor({ emit, broadcast, safeUser, findUser, now = Date.now }) {
    Object.assign(this, { emit, broadcast, safeUser, findUser, now });
    this.rooms = new Map(); this.bytes = 0;
  }
  summary(group, user) {
    return { id: group.id, name: group.name, description: group.description, rules: group.rules,
      owner: group.owner, count: group.members.size, version: group.version, access: group.access, invited: group.invited.has(user.id),
      joined: group.members.has(user.id), blocked: group.kicked.has(user.id), expiresAt: group.updated + TTL };
  }
  list(user) { this.sweep(); return [...this.rooms.values()].filter(g => g.access === 'open' || g.members.has(user.id) || g.invited.has(user.id)).map(g => this.summary(g, user)); }
  get(id) {
    const group = this.rooms.get(id);
    if (!group || this.now() >= group.updated + TTL) { if (group) this.remove(group); fail(404, 'This temporary room has expired or was deleted.'); }
    return group;
  }
  member(group, user) { if (!group.members.has(user.id)) fail(403, 'Join this room first.'); }
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
    const sender = this.findUser(message.sender);
    return { ...metadata, displayAsAdmin: sender ? this.safeUser(sender).displayAsAdmin : false, encrypted: envelopes[user.id] };
  }
  handle(method, action, user, input) {
    if (method === 'GET' && action === '') return this.list(user);
    if (method === 'POST' && action === 'create') {
      if (!user.publicKey) fail(409, 'Enable encryption before creating a room.');
      this.sweep();
      if ([...this.rooms.values()].filter(g => g.members.has(user.id)).length >= 20) fail(400, 'You can join up to 20 temporary rooms.');
      if (this.rooms.size >= 100 || [...this.rooms.values()].filter(g => g.owner === user.id).length >= 3) fail(400, 'Limit reached: three owned rooms per person and 100 temporary rooms total.');
      const group = { ...details(input), id: randomUUID(), owner: user.id, version: 1,
        members: new Map([[user.id, { user, joinedAt: this.now(), joinedVersion: 1, messages: 0 }]]), kicked: new Set(), invited: new Set(), history: [], bytes: 0, updated: this.now() };
      this.rooms.set(group.id, group); this.changed(group); return this.state(group, user);
    }
    const group = this.get(input.group);
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
    if (action === 'message') return this.send(group, user, input);
    if (action === 'message-delete') {
      const message = group.history.find(m => m.id === input.id);
      if (!message || (message.sender !== user.id && group.owner !== user.id)) fail(403, 'Only the sender or room owner can remove this message.');
      group.history = group.history.filter(m => m !== message); group.bytes -= message.bytes; this.bytes -= message.bytes;
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
    if (Object.keys(input).some(k => !['group', 'id', 'version', 'envelopes', 'replyTo'].includes(k))) fail(400, 'Group messages must contain ciphertext only.');
    if (!uuid(input.id) || !input.envelopes || typeof input.envelopes !== 'object' || Array.isArray(input.envelopes)) fail(400, 'Invalid encrypted group message.');
    const prior = group.history.find(m => m.id === input.id);
    if (prior) {
      if (prior.sender !== user.id || prior.version !== input.version || JSON.stringify(prior.envelopes) !== JSON.stringify(input.envelopes) || (prior.reply?.id || null) !== (input.replyTo || null)) fail(409, 'Message ID already used.');
      return this.viewMessage(prior, user);
    }
    if (input.version !== group.version) fail(409, 'Membership changed. Send again to encrypt for the current members.');
    const recipients = Object.keys(input.envelopes);
    if (recipients.length !== group.members.size || recipients.some(id => !group.members.has(id) || !validBox(input.envelopes[id]))) fail(400, 'Encrypt separately for every current member, including yourself.');
    const original = input.replyTo == null ? null : group.history.find(m => m.id === input.replyTo && m.version >= group.members.get(user.id).joinedVersion && Object.hasOwn(m.envelopes, user.id));
    if (input.replyTo != null && !original) fail(400, 'That reply is unavailable.');
    user.sent = user.sent.filter(t => this.now() - t < 10000);
    if (user.sent.length >= 8) fail(429, 'Take a breath. Try again in a few seconds.');
    const message = { id: input.id, group: group.id, version: group.version, sender: user.id, senderKey: user.publicKey,
      alias: user.alias, displayAsAdmin: this.safeUser(user).displayAsAdmin, time: new Date(this.now()).toISOString(),
      reply: original ? { id: original.id } : null, envelopes: input.envelopes };
    message.bytes = Buffer.byteLength(JSON.stringify(message));
    if (this.bytes + message.bytes > 32 * 1024 * 1024) fail(503, 'Temporary chat storage is full. Try again later.');
    group.history.push(message); group.bytes += message.bytes; this.bytes += message.bytes;
    while (group.history.length > 100 || group.bytes > 4 * 1024 * 1024) { const old = group.history.shift(); group.bytes -= old.bytes; this.bytes -= old.bytes; }
    user.sent.push(this.now()); group.members.get(user.id).messages++; group.updated = this.now();
    for (const { user: member } of group.members.values()) this.emit(member, 'message', this.viewMessage(message, member));
    const owner = group.members.get(group.owner).user; this.emit(owner, 'group-state', this.state(group, owner));
    return this.viewMessage(message, user);
  }
}
