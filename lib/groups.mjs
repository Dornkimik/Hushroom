import { randomBytes, randomUUID } from 'node:crypto';

const HOUR = 60 * 60 * 1000;
const MAX_ROOMS = 1000, ROOMS_PER_CLIENT = 6, MAX_BYTES = 64 * 1024 * 1024, BYTES_PER_CLIENT = 6 * 1024 * 1024, MAX_LINKS = 10;
// Owner-chosen room settings. Lifetimes are hours of inactivity, disappearing messages are minutes.
const CHOICES = { slowMode: [0, 5, 10, 30, 60, 300], lifetime: [1, 6, 24], disappear: [0, 5, 60, 360] };
const DEFAULTS = { slowMode: 0, lifetime: 24, disappear: 0, limit: 20, locked: false, readOnly: false };
const MUTE_MINUTES = [5, 60, 1440, 0], LINK_HOURS = [1, 6, 24], LINK_USES = [1, 5, 20, 0];
const RANK = { member: 0, moderator: 1, owner: 2 };
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
// IPv6 client keys look like "<client>.<network>"; the network part groups a whole /48.
const network = client => client && String(client).includes('.') ? String(client).split('.')[1] : null;
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const ttl = group => group.lifetime * HOUR;
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
// Missing settings keep their current value, so older clients cannot reset them by omission.
function settings(input, base = DEFAULTS) {
  const result = Object.fromEntries(Object.keys(DEFAULTS).map(key => [key, Object.hasOwn(input, key) ? input[key] : base[key]]));
  for (const [key, allowed] of Object.entries(CHOICES)) if (!allowed.includes(result[key])) fail(400, 'Choose one of the listed room settings.');
  if (!Number.isInteger(result.limit) || result.limit < 2 || result.limit > 20) fail(400, 'Choose a member limit between 2 and 20.');
  if (typeof result.locked !== 'boolean' || typeof result.readOnly !== 'boolean') fail(400, 'Invalid room setting.');
  return result;
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
  expired(group) { return this.now() >= group.updated + ttl(group); }
  role(group, id) { return group.owner === id ? 'owner' : group.moderators.has(id) ? 'moderator' : 'member'; }
  // Returns the mute end time (null = until unmuted), or undefined when the person can post.
  mutedUntil(group, id) {
    if (!group.mutes.has(id)) return undefined;
    const until = group.mutes.get(id);
    if (until !== null && until <= this.now()) { group.mutes.delete(id); return undefined; }
    return until;
  }
  activeLinks(group) {
    for (const [token, link] of group.links) if (link.expiresAt <= this.now()) group.links.delete(token);
    return group.links;
  }
  summary(group, user) {
    return { id: group.id, name: group.name, description: group.description, rules: group.rules,
      owner: group.owner, count: group.members.size, version: group.version, access: group.access, invited: group.invited.has(user.id),
      joined: group.members.has(user.id), blocked: group.banned.has(user.id), expiresAt: group.updated + ttl(group),
      limit: group.limit, locked: group.locked, readOnly: group.readOnly, slowMode: group.slowMode, lifetime: group.lifetime, disappear: group.disappear };
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
    if (!group || this.expired(group)) { if (group) this.remove(group); fail(404, 'This temporary room has expired or was deleted.'); }
    return group;
  }
  member(group, user) { if (!group.members.has(user.id)) fail(403, 'Join this room first.'); }
  checkAttachment(item, user) {
    const group = this.rooms.get(item.group), member = group?.members.get(user.id);
    if (!group || this.expired(group) || !member || member.joinedVersion > item.version) fail(404, 'Attachment expired or unavailable.');
  }
  owner(group, user) { this.member(group, user); if (group.owner !== user.id) fail(403, 'Only the room owner can do that.'); }
  staff(group, user) { this.member(group, user); if (this.role(group, user.id) === 'member') fail(403, 'Only the room owner or a moderator can do that.'); }
  // Moderators act on regular members only; the owner acts on everyone else.
  target(group, user, id) {
    if (id === user.id || !group.members.has(id)) fail(400, 'Choose another current member.');
    if (RANK[this.role(group, user.id)] <= RANK[this.role(group, id)]) fail(403, 'Moderators can only manage regular members.');
    return group.members.get(id);
  }
  state(group, user) {
    this.member(group, user);
    const staff = this.role(group, user.id) !== 'member';
    return { ...this.summary(group, user), moderators: [...group.moderators],
      members: [...group.members.values()].map(({ user: member, joinedAt, messages }) => {
        const until = this.mutedUntil(group, member.id);
        return { ...this.safeUser(member), publicKey: member.publicKey, joinedAt, role: this.role(group, member.id),
          muted: until !== undefined, mutedUntil: until ?? null, ...(staff ? { messages } : {}) };
      }),
      ...(staff ? {
        banned: [...group.banned].map(([id, { alias, at }]) => ({ id, alias, at })),
        links: [...this.activeLinks(group)].map(([token, { expiresAt, uses, maxUses }]) => ({ token, expiresAt, uses, maxUses }))
      } : {}) };
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
    group.members.delete(id); group.moderators.delete(id); group.version++; group.updated = this.now();
    this.emit(member.user, 'group-removed', { group: group.id, reason });
    if (!group.members.size) { this.remove(group); return; }
    // A departing owner hands the room to a moderator first, then to the longest-standing member.
    if (group.owner === id) {
      group.owner = group.moderators.values().next().value ?? group.members.keys().next().value;
      group.moderators.delete(group.owner);
    }
    this.changed(group);
  }
  removeUser(id) {
    for (const group of this.rooms.values()) {
      group.invited.delete(id); group.banned.delete(id); group.mutes.delete(id);
      this.removeMember(group, id, 'Your session is no longer a member of this room.');
    }
  }
  dropMessage(group, message) {
    group.history = group.history.filter(m => m !== message); group.bytes -= message.bytes; this.bytes -= message.bytes;
    this.attachments?.remove(message.attachment?.id);
    for (const m of group.history) if (m.reply?.id === message.id) m.reply = { id: message.id, removed: true };
    for (const { user: member } of group.members.values()) this.emit(member, 'message-removed', { id: message.id, group: group.id });
  }
  // Disappearing messages are removed for everyone once they reach the room's age limit.
  expireMessages(group) {
    if (!group.disappear) return;
    const cutoff = this.now() - group.disappear * 60000;
    for (const message of group.history.filter(m => Date.parse(m.time) <= cutoff)) this.dropMessage(group, message);
  }
  sweep() {
    for (const group of this.rooms.values()) {
      if (this.expired(group)) this.remove(group);
      else this.expireMessages(group);
    }
  }
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
  notMuted(group, user) {
    const until = this.mutedUntil(group, user.id);
    if (until === null) fail(403, 'You are muted in this room until a moderator unmutes you.');
    if (until !== undefined) fail(403, `You are muted in this room for ${Math.ceil((until - this.now()) / 60000)} more minute(s).`);
  }
  canPost(group, user) {
    this.notMuted(group, user);
    if (this.role(group, user.id) !== 'member') return;
    if (group.readOnly) fail(403, 'Only the owner and moderators can post in this room right now.');
    const wait = (group.members.get(user.id).lastSent ?? -Infinity) + group.slowMode * 1000 - this.now();
    if (group.slowMode && wait > 0) fail(429, `Slow mode is on. You can send again in ${Math.ceil(wait / 1000)} second(s).`);
  }
  link(group, token) {
    const link = typeof token === 'string' ? this.activeLinks(group).get(token) : undefined;
    if (!link) fail(403, 'This invite link is invalid or has expired.');
    return link;
  }
  edit(group, user, input) {
    const message = this.ownMessage(group, user, input.id);
    if (Object.keys(input).some(k => !['group', 'id', 'membershipVersion', 'editVersion', 'envelopes'].includes(k))) fail(400, 'Room edits must contain ciphertext only.');
    this.notMuted(group, user);
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
      const group = { ...details(input), ...settings(input), id: randomUUID(), owner: user.id, version: 1,
        members: new Map([[user.id, { user, joinedAt: this.now(), joinedVersion: 1, messages: 0 }]]),
        moderators: new Set(), banned: new Map(), mutes: new Map(), links: new Map(), invited: new Set(), history: [], bytes: 0, updated: this.now() };
      this.rooms.set(group.id, group); this.changed(group); return this.state(group, user);
    }
    const group = this.get(input.group);
    if (method === 'GET' && action === 'invite-preview') {
      if (group.banned.has(user.id)) fail(403, 'You were banned from this room.');
      if (group.access === 'invite' && !group.members.has(user.id) && !group.invited.has(user.id)) this.link(group, input.invite);
      const { id, name, description, rules, count, limit, access, locked, joined } = this.summary(group, user);
      return { id, name, description, rules, count, limit, access, locked, joined };
    }
    if (method === 'GET' && action === 'message-edit-state') {
      const message = this.ownMessage(group, user, input.id);
      return { membershipVersion: group.version, members: this.editMembers(group, message).map(({ user: member }) => ({ id: member.id, publicKey: member.publicKey })) };
    }
    if (method === 'GET' && action === 'state') return this.state(group, user);
    if (method === 'GET' && action === 'history') {
      this.member(group, user); this.expireMessages(group);
      return group.history.filter(m => m.version >= group.members.get(user.id).joinedVersion && Object.hasOwn(m.envelopes, user.id)).map(m => this.viewMessage(m, user));
    }
    if (method !== 'POST') fail(404, 'Not found.');
    if (action === 'join') {
      if (group.banned.has(user.id)) fail(403, 'You were banned from this room. You cannot rejoin with this session.');
      if (!group.members.has(user.id)) {
        const link = group.access === 'invite' && !group.invited.has(user.id) ? (input.invite == null ? fail(403, 'This room requires an invitation from its owner.') : this.link(group, input.invite)) : null;
        if (!user.publicKey) fail(409, 'Enable encryption before joining a room.');
        if (group.locked) fail(403, 'This room is locked. No new members can join right now.');
        if (group.members.size >= group.limit) fail(400, `This room is full (${group.limit} members).`);
        if ([...this.rooms.values()].filter(g => g.members.has(user.id)).length >= 20) fail(400, 'You can join up to 20 temporary rooms.');
        if (link && ++link.uses >= link.maxUses && link.maxUses) group.links.delete(input.invite);
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
      if (!message || (message.sender !== user.id && RANK[this.role(group, user.id)] <= RANK[this.role(group, message.sender)])) fail(403, 'Only the sender, the room owner or a moderator can remove this message.');
      this.dropMessage(group, message);
      return { id: message.id, group: group.id };
    }
    if (action === 'leave') {
      if (group.owner === user.id && group.members.size > 1) fail(400, 'Transfer ownership before leaving, or delete the room.');
      this.removeMember(group, user.id, 'You left the room.'); return { ok: true };
    }
    if (['invite', 'kick', 'ban', 'unban', 'mute', 'unmute', 'link-create', 'link-revoke'].includes(action)) this.staff(group, user);
    else this.owner(group, user);
    if (action === 'invite') {
      const invited = this.findUser(input.member);
      if (!invited?.publicKey || group.members.has(input.member) || group.banned.has(input.member)) fail(400, 'Choose an available person who is not already a member or banned.');
      if (group.invited.size >= 20) fail(400, 'This room already has 20 pending invitations.');
      group.invited.add(input.member); group.updated = this.now(); this.changed(group); return { ok: true };
    }
    if (action === 'delete') { this.remove(group); return { ok: true }; }
    if (action === 'kick' || action === 'ban') {
      const { user: removed } = this.target(group, user, input.member);
      if (action === 'ban') group.banned.set(removed.id, { alias: removed.alias, at: new Date(this.now()).toISOString() });
      group.invited.delete(removed.id);
      this.removeMember(group, removed.id, action === 'ban' ? 'You were banned from this room.' : 'A room moderator removed you from this room.');
      return this.state(group, user);
    }
    if (action === 'unban') {
      if (!group.banned.delete(input.member)) fail(400, 'That person is not banned from this room.');
    } else if (action === 'mute') {
      this.target(group, user, input.member);
      if (!MUTE_MINUTES.includes(input.minutes)) fail(400, 'Choose a listed mute duration.');
      group.mutes.set(input.member, input.minutes ? this.now() + input.minutes * 60000 : null);
    } else if (action === 'unmute') {
      this.target(group, user, input.member); group.mutes.delete(input.member);
    } else if (action === 'link-create') {
      if (!LINK_HOURS.includes(input.hours) || !LINK_USES.includes(input.uses)) fail(400, 'Choose a listed link duration and use limit.');
      if (this.activeLinks(group).size >= MAX_LINKS) fail(400, `Revoke an invite link first. Rooms can have up to ${MAX_LINKS} active links.`);
      group.links.set(randomBytes(18).toString('base64url'), { expiresAt: this.now() + input.hours * HOUR, uses: 0, maxUses: input.uses, by: user.id });
    } else if (action === 'link-revoke') {
      if (!group.links.delete(input.token)) fail(400, 'That invite link no longer exists.');
    } else if (action === 'update') {
      Object.assign(group, details(input), settings(input, group));
      this.expireMessages(group);
    } else if (action === 'promote' || action === 'demote') {
      this.target(group, user, input.member);
      if (action === 'promote') group.moderators.add(input.member); else group.moderators.delete(input.member);
    } else if (action === 'transfer') {
      this.target(group, user, input.member);
      if ([...this.rooms.values()].filter(g => g.owner === input.member).length >= 3) fail(400, 'That member already owns three rooms.');
      group.owner = input.member; group.moderators.delete(input.member);
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
    this.canPost(group, user);
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
    const member = group.members.get(user.id);
    user.sent.push(this.now()); member.messages++; member.lastSent = this.now(); group.updated = this.now();
    for (const { user: recipient } of group.members.values()) this.emit(recipient, 'message', this.viewMessage(message, recipient));
    // Message counts are visible to the owner and moderators.
    for (const { user: staff } of group.members.values()) if (this.role(group, staff.id) !== 'member') this.emit(staff, 'group-state', this.state(group, staff));
    return this.viewMessage(message, user);
  }
}
