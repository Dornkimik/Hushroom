const $ = selector => document.querySelector(selector);
let me, rooms = [], people = [], adminBans = [], current, messages = [], stream, revision = 0, deleting, banning;
let editingMessage, editSaving = false, signingOut = false;
let replying, sending = false, suggestions = [], suggestionIndex = 0, completionStart = 0;
let encryptionClient, encryptionError = '', peerIdentity, pendingImage, imagePreparing = false, imageRevision = 0, verificationTarget;
const imageURLs = new Map(), imageLoads = new Map();
let blockedUsers = [], hiddenChats = new Set();
const isBlocked = id => blockedUsers.some(user => user.peers.includes(id));
const conversations = new Map(), unread = new Map(), drafts = new Map();
const conversationKey = target => target ? `${target.group ? 'group' : target.peer ? 'peer' : 'room'}:${target.group || target.peer || target.room}` : '';
async function api(url, data) {
  const response = await fetch(`/api/${url}`, data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Could not connect. Try again.');
  return result;
}
function error(message = '') { $('#error').textContent = message; $('#error').hidden = !message; }
function element(tag, className, text) { const e = document.createElement(tag); e.className = className; if (text !== undefined) e.textContent = text; return e; }
function username(alias, className, displayAsAdmin) {
  const name = element('span', `${className}${displayAsAdmin ? ' admin-name' : ''}`, alias);
  if (displayAsAdmin) name.append(element('small', 'admin-badge', 'ADMIN'));
  return name;
}
function avatar(alias, own = false) { return element('span', `avatar${own ? ' me-avatar' : ''}`, alias.split(' ').slice(0,2).map(s => s[0]).join('')); }
function renderRooms() {
  $('#room-count').textContent = rooms.filter(room => !room.adminOnly).length;
  const roomButton = room => {
    const button = element('button', `nav-room${current?.room === room.id ? ' active' : ''}`);
    const label = element('span', 'room-label'); label.append(element('span', 'name', room.name), element('small', 'room-preview', room.preview || room.description || 'No messages yet'));
    button.append(element('span', 'hash', '#'), label, element('span', 'count', room.count || 0));
    button.setAttribute('aria-current', current?.room === room.id ? 'true' : 'false');
    button.onclick = () => select({ room: room.id }); return button;
  };
  $('#announcements').replaceChildren(...rooms.filter(room => room.adminOnly).map(roomButton));
  $('#rooms').replaceChildren(...rooms.filter(room => !room.adminOnly).map(roomButton));
  if (!rooms.some(room => !room.adminOnly)) $('#rooms').append(element('p', 'aside-hint', 'No rooms yet. The host can create one.'));
  renderAdminRooms();
  renderGroups();
}
$('#block-private-user').onclick = () => { if (current?.peer) changeBlock({ id: current.peer }, true); };
async function changeBlock(person, blocked) {
  try {
    const prefs = await api('private/block', blocked ? { peer: person.id, blocked: true } : { key: person.key, blocked: false });
    applyPrivatePreferences(prefs);
  } catch (e) { error(e.message); $('#blocked-status').textContent = e.message; }
}
function applyPrivatePreferences(prefs) {
  blockedUsers = prefs.blocks || []; hiddenChats = new Set(prefs.hiddenChats || []);
  for (const id of conversations.keys()) if (hiddenChats.has(id) || isBlocked(id)) { conversations.delete(id); unread.delete(id); drafts.delete(`peer:${id}`); }
  if (current?.peer && (hiddenChats.has(current.peer) || isBlocked(current.peer))) select(rooms[0] ? { room: rooms[0].id } : null);
  renderPeople(); renderDMs(); renderBlockedUsers();
}
function renderBlockedUsers() {
  $('#blocked-users').replaceChildren(...blockedUsers.map(person => {
    const row = element('div', 'blocked-user'), button = element('button', 'text-button', 'Unblock');
    button.type = 'button'; button.setAttribute('aria-label', `Unblock ${person.alias}`);
    button.onclick = () => changeBlock(person, false);
    row.append(element('span', '', person.alias), button); return row;
  }));
  if (!blockedUsers.length) $('#blocked-users').append(element('p', 'aside-hint', 'No blocked users.'));
}
async function removePrivateChat(id) {
  try {
    await api('private/hide', { peer: id }); hiddenChats.add(id);
    conversations.delete(id); unread.delete(id); drafts.delete(`peer:${id}`);
    if (current?.peer === id) await select(rooms[0] ? { room: rooms[0].id } : null);
    renderDMs();
  } catch (e) { error(e.message); }
}
function renderPeople() {
  $('#online-count').textContent = people.length;
  $('#people').replaceChildren(...people.map(person => {
    const own = person.id === me.id, blocked = isBlocked(person.id);
    const row = element('div', 'person-row'), button = element('button', 'person'); button.disabled = own || blocked;
    button.append(avatar(person.alias, own), username(person.alias, 'person-name', person.displayAsAdmin), element(own || blocked ? 'small' : 'span', own || blocked ? '' : 'person-arrow', own ? 'you' : blocked ? 'blocked' : '↗'));
    button.title = own ? 'This is you' : blocked ? 'Unblock in settings to chat privately' : `Chat privately with ${person.alias}`;
    button.onclick = () => { hiddenChats.delete(person.id); conversations.set(person.id, person.alias); select({ peer: person.id }); api('private/show', { peer: person.id }).catch(e => error(e.message)); };
    row.append(button);
    if (!own && !blocked) {
      const block = element('button', 'person-block', 'Block'); block.type = 'button';
      block.setAttribute('aria-label', `Block ${person.alias}`); block.onclick = () => changeBlock(person, true); row.append(block);
    }
    return row;
  }));
}
function renderDMs() {
  $('#dm-hint').hidden = conversations.size > 0;
  $('#dms').replaceChildren(...[...conversations].map(([id, alias]) => {
    const row = element('div', 'dm-row');
    const button = element('button', `dm-room${current?.peer === id ? ' active' : ''}`);
    button.append(element('span', '', '↗'), username(alias, 'name', people.find(p => p.id === id)?.displayAsAdmin));
    if (unread.get(id)) button.append(element('span', 'unread', unread.get(id)));
    button.onclick = () => select({ peer: id });
    const remove = element('button', 'dm-remove', '×'); remove.type = 'button';
    remove.setAttribute('aria-label', `Remove private chat with ${alias}`);
    remove.title = 'Remove from sidebar. A new message will bring it back.';
    remove.onclick = () => removePrivateChat(id);
    row.append(button, remove); return row;
  }));
}
function updateHeading() {
  const privateChat = Boolean(current?.peer), groupChat = Boolean(current?.group), room = groupChat ? groupState || groupRooms.find(g => g.id === current.group) : rooms.find(r => r.id === current?.room);
  $('.app').classList.toggle('group-chat', groupChat);
  $('.app').classList.toggle('announcements-readonly', Boolean(room?.adminOnly && !me.admin));
  $('#room-title').textContent = privateChat ? conversations.get(current.peer) || 'Private conversation' : room?.name || 'A little quiet for now';
  $('#room-description').textContent = privateChat ? 'A conversation just between the two of you.' : room?.description || (groupChat ? '' : 'Choose a room or someone to talk to.');
  $('#room-description').hidden = groupChat && !room?.description;
  $('#room-symbol').textContent = privateChat ? '↗' : '#';
  $('#conversation-type').textContent = room?.adminOnly ? 'OFFICIAL COMMUNITY UPDATES' : groupChat ? `Temporary room · ${room?.access === 'invite' ? 'Invite only' : 'Open'}${room?.count ? ` · ${room.count} ${room.count === 1 ? 'member' : 'members'}` : ''}` : privateChat ? 'JUST BETWEEN YOU TWO' : 'COME AS YOU ARE';
  $('#announcement-note').hidden = !room?.adminOnly;
  $('#announcement-note').textContent = me.admin ? 'Only admins can post here. Announcements are saved until an admin removes them.' : 'Read-only: admins post updates here. Announcements are saved between restarts.';
  $('#room-badge').textContent = room?.adminOnly ? 'ANNOUNCEMENTS' : groupChat ? 'ENCRYPTED ROOM' : privateChat ? 'PRIVATE CHAT' : 'OPEN ROOM';
  $('#private-note').hidden = !privateChat && !groupChat;
  $('#block-private-user').hidden = !privateChat;
  $('#group-details').hidden = !groupChat;
  $('#group-details').disabled = !groupState;
  $('#room-rules').hidden = !groupChat || !room?.rules;
  $('#room-rules p').textContent = groupChat && room?.rules ? room.rules : '';
  $('#message').placeholder = room?.adminOnly ? (me.admin ? 'Write an announcement…' : 'Only admins can post announcements') : groupChat ? 'Message this room…' : privateChat ? 'Say something, just to them…' : 'Leave a little thought…';
  updateComposerState();
  $('#welcome h2').textContent = room?.adminOnly ? 'News from the admins.' : privateChat ? 'A little more personal.' : 'Make yourself at home.';
  $('#welcome p').textContent = room?.adminOnly ? 'Updates, changes, and important information for the community.' : privateChat ? 'One conversation. Just the two of you.\nA simple hello is a good place to start.' : 'Join a public room without an account or email. Choose someone online for an encrypted private chat.';
}
function matches(message, target = current) { return target && (target.group ? message.group === target.group : message.group ? false : target.peer ? !message.room && ((message.sender === me.id && message.recipient === target.peer) || (message.sender === target.peer && message.recipient === me.id)) : message.room === target.room); }
async function select(target) {
  $('#edit-message-dialog').close(); editingMessage = null;
  setReply(null); closeSuggestions(); toggleEmoji(false);
  if (conversationKey(target) !== conversationKey(current)) {
    if (current) drafts.set(conversationKey(current), $('#message').value);
    $('#message').value = drafts.get(conversationKey(target)) || ''; resizeComposer();
    clearPendingImage(); status('');
  }
  clearImageURLs(); peerIdentity = null; groupState = null;
  current = target; const version = ++revision; messages = []; error();
  $('#room-rules').open = false;
  if (target?.peer) unread.delete(target.peer);
  renderRooms(); renderDMs(); updateHeading(); renderMessages();
  if (!target) return;
  try {
    if (target.group) {
      if (!encryptionClient) throw new Error(encryptionError || 'Room encryption is unavailable.');
      const state = await api(`groups/state?group=${encodeURIComponent(target.group)}`);
      if (version !== revision) return;
      groupState = state; updateHeading();
    }
    if (target.peer) {
      if (!encryptionClient) throw new Error(encryptionError || 'Private encryption is unavailable.');
      const person = await encryptionClient.peer(target.peer);
      if (version !== revision) return;
      peerIdentity = person; updateComposerState();
    }
    if (target.room) await api('join', target);
    const history = await Promise.all((await api(`${target.group ? 'groups/history' : 'history'}?${new URLSearchParams(target)}`)).map(decodePrivate));
    if (version !== revision) return;
    messages = [...new Map([...history, ...messages].map(m => [m.id, m])).values()].sort((a,b) => a.time.localeCompare(b.time)).slice(rooms.find(r => r.id === target.room)?.persistent ? 0 : -100);
    renderMessages();
  } catch (e) { if (version === revision) { error(e.message); if (target.peer || target.group) { peerIdentity = null; groupState = null; updateComposerState(e.message); } } }
}
function renderMessages() {
  $('#messages').replaceChildren(...messages.map(message => {
    const own = message.sender === me.id;
    const row = element('article', 'chat-message'), content = element('div', 'message-content'), meta = element('div', 'message-meta');
    const displayAsAdmin = message.displayAsAdmin;
    meta.append(username(message.alias, 'message-name', displayAsAdmin));
    if (own) meta.append(element('span', 'you-tag', 'YOU'));
    meta.append(element('time', 'message-time', rooms.find(r => r.id === message.room)?.persistent ? new Date(message.time).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : new Date(message.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })));
    row.id = `message-${message.id}`;
    if (message.mentions?.some(person => person.id === me.id)) row.classList.add('mentioned');
    const replyButton = element('button', 'message-reply', 'Reply');
    replyButton.type = 'button'; replyButton.disabled = Boolean(message.locked) || (rooms.find(r => r.id === message.room)?.adminOnly && !me.admin); replyButton.onclick = () => { setReply(message); $('#message').focus(); };
    meta.append(replyButton);
    if (message.editedAt) meta.append(element('span', 'message-time', '(edited)'));
    if ((own || (me.admin && rooms.find(r => r.id === message.room)?.adminOnly)) && !message.locked) {
      const edit = element('button', 'message-reply', 'Edit'); edit.type = 'button';
      edit.onclick = () => {
        if (editSaving) return;
        editingMessage = { ...message };
        $('#edit-message-text').value = message.text;
        $('#edit-message-text').required = !message.image;
        $('#edit-message-error').textContent = '';
        $('#edit-message-dialog').showModal(); $('#edit-message-text').focus();
      };
      meta.append(edit);
    }
    if (own || (message.group ? groupState?.owner === me.id : me?.admin)) {
      const remove = element('button', 'message-remove', own ? 'Delete' : 'Remove');
      remove.type = 'button'; remove.title = 'Remove this message for everyone';
      remove.onclick = async () => { remove.disabled = true; try { applyRemoval(await api(message.group ? 'groups/message-delete' : own ? 'message/delete' : 'admin/remove-message', { id: message.id, ...(message.group ? { group: message.group } : {}) })); } catch(e) { error(e.message); remove.disabled = false; } };
      meta.append(remove);
    }
    content.append(meta);
    if (message.reply && !message.locked) {
      const original = message.encrypted ? messages.find(m => m.id === message.reply.id && !m.locked) : message.reply;
      const quote = element('button', 'reply-quote', message.reply.removed ? 'Original message removed' : original ? `${original.alias}: ${original.text || 'Image'}` : 'Original message unavailable');
      quote.type = 'button'; quote.disabled = message.reply.removed;
      quote.onclick = () => { const original = document.getElementById(`message-${message.reply.id}`); if (original) { original.scrollIntoView({ block: 'center' }); original.tabIndex = -1; original.focus({ preventScroll: true }); } else error('The original message is no longer in the recent history.'); };
      content.append(quote);
    }
    const body = element('p', 'message-text'); let offset = 0;
    for (const mention of message.mentions || []) {
      body.append(document.createTextNode(message.text.slice(offset, mention.start)), element('mark', 'mention', message.text.slice(mention.start, mention.end)));
      offset = mention.end;
    }
    body.append(document.createTextNode(message.text.slice(offset))); content.append(body);
    if (message.image && !message.locked) renderPrivateImage(message, content);
    row.append(avatar(message.alias, own), content); return row;
  }));
  $('#empty-chat').hidden = messages.length > 0 || !current;
  $('#empty-chat').textContent = current?.group ? 'No messages yet. Start the conversation below.' : 'It’s quiet in here. Be the first to say hello.';
  $('#welcome').hidden = Boolean(current?.group) || messages.length > 3;
  $('.day-divider').hidden = Boolean(current?.group) && messages.length === 0;
  $('#chat-scroll').scrollTop = $('#chat-scroll').scrollHeight;
}
function applyRemoval(removed) {
  if (!matches(removed)) return;
  const { id } = removed;
  if (editingMessage?.id === id) { $('#edit-message-dialog').close(); editingMessage = null; }
  revokeImage(id); messages = messages.filter(message => message.id !== id);
  for (const message of messages) if (message.reply?.id === id) message.reply = { id, removed: true };
  if (replying?.id === id) setReply(null);
  renderMessages();
}
async function receive(message) {
  if (!message.room && !message.group) {
    const peer = message.sender === me.id ? message.recipient : message.sender;
    if (isBlocked(peer)) return;
    hiddenChats.delete(peer);
  }
  notifyMessage(message);
  if (!message.room && !message.group) {
    const peer = message.sender === me.id ? message.recipient : message.sender;
    if (!conversations.has(peer)) conversations.set(peer, people.find(p => p.id === peer)?.alias || message.alias);
    if (current?.peer !== peer && message.sender !== me.id) unread.set(peer, (unread.get(peer) || 0) + 1);
    renderDMs();
  }
  if (matches(message) && !messages.some(m => m.id === message.id)) {
    const version = revision;
    messages = [...messages, message.encrypted ? { ...message, text: 'Decrypting…', locked: true } : message].slice(rooms.find(r => r.id === message.room)?.persistent ? 0 : -100); renderMessages();
    if (message.encrypted) {
      const decoded = await decodePrivate(message);
      if (version !== revision) return;
      messages = messages.map(m => m.id === message.id && (m.editVersion || 0) === (message.editVersion || 0) ? { ...decoded, reply: m.reply } : m); renderMessages();
    }
    for (const id of new Set([...imageURLs.keys(), ...imageLoads.keys()])) if (!messages.some(m => m.id === id)) revokeImage(id);
  }
}
async function applyEdit(message) {
  if (!matches(message)) return;
  const existing = messages.find(m => m.id === message.id);
  if (!existing || (existing.editVersion || 0) >= message.editVersion) return;
  const version = revision;
  // Reserve the version before decrypting so a slower event cannot overwrite a newer edit.
  messages = messages.map(m => m.id === message.id ? { ...message, text: 'Decrypting…', locked: true, reply: m.reply } : m);
  const decoded = await decodePrivate(message);
  if (version !== revision) return;
  messages = messages.map(m => m.id === message.id && m.editVersion === message.editVersion ? { ...decoded, reply: m.reply } : m);
  const latest = messages.find(m => m.id === message.id);
  if (!latest || latest.editVersion !== message.editVersion) return;
  if (message.room) for (const reply of messages) if (reply.reply?.id === message.id) reply.reply.text = message.text.slice(0, 200);
  if (replying?.id === message.id) setReply(latest);
  const scroll = $('#chat-scroll'), top = scroll.scrollTop, atBottom = scroll.scrollHeight - top - scroll.clientHeight < 60;
  renderMessages(); if (!atBottom) scroll.scrollTop = top;
}
$('#cancel-edit-message').onclick = () => $('#edit-message-dialog').close();
$('#edit-message-form').onsubmit = async event => {
  event.preventDefault(); if (!editingMessage || editSaving) return;
  const message = editingMessage, text = $('#edit-message-text').value.trim();
  const button = event.currentTarget.querySelector('button[type="submit"]');
  editSaving = true; button.disabled = true; $('#edit-message-error').textContent = '';
  try {
    if ((!text && !message.image) || text.length > 2000) throw new Error('Use between 1 and 2,000 characters, or keep an attached image.');
    const editVersion = (message.editVersion || 0) + 1;
    let result;
    if (message.group) {
      const state = await api(`groups/message-edit-state?${new URLSearchParams({ group: message.group, id: message.id })}`);
      const envelopes = await encryptionClient.encryptGroup({ id: message.id, group: message.group, version: message.version, sender: me.id, text,
        replyTo: message.reply?.id || null, image: message.image || null, editVersion }, state.members);
      result = await api('groups/message-edit', { group: message.group, id: message.id, membershipVersion: state.membershipVersion, editVersion, envelopes });
    } else if (message.encrypted) {
      const person = await encryptionClient.peer(message.recipient);
      const encrypted = encryptionClient.encrypt({ id: message.id, sender: me.id, recipient: message.recipient, text,
        replyTo: message.reply?.id || null, image: message.image || null, editVersion }, person);
      result = await api('message/edit', { id: message.id, editVersion, encrypted });
    } else result = await api('message/edit', { id: message.id, editVersion, text });
    await applyEdit(result);
    if (editingMessage === message) { $('#edit-message-dialog').close(); editingMessage = null; }
  } catch(e) { if (editingMessage === message) $('#edit-message-error').textContent = e.message; }
  finally { editSaving = false; button.disabled = false; }
};
function updateComposerState(problem) {
  const privateChat = Boolean(current?.peer), ready = Boolean(encryptionClient && peerIdentity?.id === current?.peer);
  const groupChat = Boolean(current?.group), groupReady = Boolean(encryptionClient && groupState?.id === current?.group && groupState?.joined);
  $('#message').disabled = !current || (rooms.find(r => r.id === current?.room)?.adminOnly && !me.admin) || (privateChat && !ready) || (groupChat && !groupReady);
  $('#message').required = !pendingImage;
  $('.send-button').disabled = $('#message').disabled || sending || imagePreparing;
  $('#emoji-toggle').disabled = $('#message').disabled;
  $('#attach-image').hidden = !privateChat && !groupChat; $('#attach-image').disabled = !(groupChat ? groupReady : ready) || sending || imagePreparing;
  $('#verify-identity').disabled = !ready;
  $('#verify-identity').hidden = groupChat;
  if (groupChat) $('#encryption-status').textContent = problem || (groupReady ? 'End-to-end encrypted · Verify members in Room details' : encryptionError || 'Preparing room encryption…');
  if (privateChat) $('#encryption-status').textContent = problem || (ready ? `End-to-end encrypted · ${peerIdentity.verified ? 'Identity verified' : 'Identity not verified'}` : encryptionError || 'Waiting for private encryption…');
}
async function decodePrivate(message) {
  if (message.group) {
    try {
      if (!encryptionClient) throw new Error(encryptionError || 'Room encryption is unavailable.');
      const plain = await encryptionClient.decryptGroup(message), mentions = [];
      for (const user of groupState?.members || []) {
        const tag = `@${user.alias}`; let start = plain.text.indexOf(tag);
        while (start !== -1) {
          const end = start + tag.length;
          if ((!start || /\s/.test(plain.text[start - 1])) && (end === plain.text.length || /[\s.,!?;:()]/.test(plain.text[end]))) mentions.push({ id: user.id, start, end });
          start = plain.text.indexOf(tag, end);
        }
      }
      return { ...message, ...plain, mentions: mentions.sort((a, b) => a.start - b.start) };
    } catch(e) { return { ...message, text: e.message, locked: true }; }
  }
  if (message.room) return message;
  try {
    if (!encryptionClient) throw new Error(encryptionError || 'Private encryption is unavailable.');
    const id = message.sender === me.id ? message.recipient : message.sender;
    const person = peerIdentity?.id === id ? peerIdentity : await encryptionClient.peer(id);
    const plain = encryptionClient.decrypt(message, person);
    const mentions = [];
    for (const user of [me, { id, alias: conversations.get(id) || people.find(p => p.id === id)?.alias }]) {
      if (!user.alias) continue;
      const tag = `@${user.alias}`; let start = plain.text.indexOf(tag);
      while (start !== -1) {
        const end = start + tag.length;
        if ((!start || /\s/.test(plain.text[start - 1])) && (end === plain.text.length || /[\s.,!?;:()]/.test(plain.text[end]))) mentions.push({ id: user.id, start, end });
        start = plain.text.indexOf(tag, end);
      }
    }
    return { ...message, ...plain, mentions: mentions.sort((a, b) => a.start - b.start) };
  } catch(e) { return { ...message, text: e.message, locked: true }; }
}
function revokeImage(id) {
  if (imageURLs.has(id)) URL.revokeObjectURL(imageURLs.get(id)); imageURLs.delete(id);
  imageLoads.get(id)?.controller.abort(); imageLoads.delete(id);
}
function clearImageURLs() { for (const id of new Set([...imageURLs.keys(), ...imageLoads.keys()])) revokeImage(id); }
function clearPendingImage() {
  imageRevision++; imagePreparing = false;
  if (pendingImage?.url) URL.revokeObjectURL(pendingImage.url);
  pendingImage = null; $('#image-preview').hidden = true; $('#image-preview img').removeAttribute('src'); $('#image-input').value = ''; $('#message').required = true;
}
$('#attach-image').onclick = () => $('#image-input').click();
$('#cancel-image').onclick = () => { clearPendingImage(); updateComposerState(); };
$('#image-input').onchange = async () => {
  const file = $('#image-input').files[0]; if (!file || (!current?.peer && !current?.group)) return;
  clearPendingImage(); const version = imageRevision;
  imagePreparing = true; updateComposerState(); error(); status('Preparing image locally…');
  try {
    const image = await SilenzaImages.prepare(file);
    if (version !== imageRevision) return;
    pendingImage = { ...image, url: URL.createObjectURL(image.blob) };
    $('#image-preview img').src = pendingImage.url;
    $('#image-preview span').textContent = 'Encrypted before upload · expires within 24 hours'; $('#image-preview').hidden = false;
  } catch(e) { if (version === imageRevision) error(e.message); }
  finally { if (version === imageRevision) { imagePreparing = false; status(''); updateComposerState(); } }
};
function renderPrivateImage(message, content) {
  const note = element('p', 'image-note'); content.append(note);
  if (message.imageExpired || message.attachment.expiresAt <= Date.now()) { note.textContent = 'Image expired'; return; }
  const img = element('img', 'private-image'); img.alt = 'Private image'; img.width = message.image.width; img.height = message.image.height;
  content.append(img);
  note.textContent = `Encrypted image · expires ${new Date(message.attachment.expiresAt).toLocaleString()}`;
  if (imageURLs.has(message.id)) { img.src = imageURLs.get(message.id); return; }
  const version = revision;
  if (!imageLoads.has(message.id)) {
    const controller = new AbortController();
    const promise = (async () => {
      const response = await fetch(`/api/attachments/${encodeURIComponent(message.image.id)}`, { signal: controller.signal, cache: 'no-store' });
      if (!response.ok) throw new Error('Image expired or unavailable.');
      const bytes = new Uint8Array(await response.arrayBuffer());
      const plain = SilenzaCrypto.decryptImage(bytes, message.image);
      // Only our raster format is rendered, never SVG/HTML or a server-provided MIME type.
      if (String.fromCharCode(...plain.subarray(0, 4)) !== 'RIFF' || String.fromCharCode(...plain.subarray(8, 12)) !== 'WEBP') throw new Error('Invalid private image.');
      if (version !== revision || controller.signal.aborted || !messages.some(m => m.id === message.id) || message.attachment.expiresAt <= Date.now()) throw new Error('Image no longer available.');
      const url = URL.createObjectURL(new Blob([plain], { type: 'image/webp' })); imageURLs.set(message.id, url); return url;
    })();
    imageLoads.set(message.id, { promise, controller });
  }
  imageLoads.get(message.id).promise.then(url => { if (version === revision) img.src = url; }).catch(e => { img.hidden = true; note.textContent = e.message; });
}
async function uploadEncryptedImage(image, target) {
  status('Encrypting image…');
  const encrypted = SilenzaCrypto.encryptImage(new Uint8Array(await image.blob.arrayBuffer()));
  status('Uploading encrypted image…');
  const response = await fetch(`/api/attachments?${new URLSearchParams(target)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: encrypted.bytes });
  const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Could not upload image.');
  return { id: result.id, key: encrypted.key, nonce: encrypted.nonce, type: image.type, width: image.width, height: image.height, size: image.size };
}
async function showVerification(id) {
  if (!id || !encryptionClient) return;
  try {
    const person = await encryptionClient.peer(id);
    verificationTarget = person;
    $('#verification-code').textContent = encryptionClient.code(person);
    $('#verification-detail').textContent = person.verified ? 'You previously marked this identity as verified.' : 'Until you compare this code, this identity is trusted on first use.';
    $('#verification-error').textContent = ''; $('#verify-dialog').showModal();
  } catch(e) { error(e.message); }
}
$('#verify-identity').onclick = () => showVerification(current?.peer);
$('#confirm-verification').onclick = async () => {
  try {
    const fresh = await encryptionClient.peer(verificationTarget.id);
    if (fresh.publicKey !== verificationTarget.publicKey) throw new Error('Encryption identity changed.');
    const verified = await encryptionClient.verify(fresh);
    if (current?.peer === verified.id) { peerIdentity = verified; updateComposerState(); }
    $('#verify-dialog').close();
  } catch(e) { $('#verification-error').textContent = e.message; }
};
function setReply(message) {
  replying = message; $('#reply-preview').hidden = !message;
  $('#reply-preview span').textContent = message ? `Replying to ${message.alias}: ${message.text.slice(0, 120)}` : '';
}
$('#cancel-reply').onclick = () => { setReply(null); $('#message').focus(); };
function status(text) { $('#command-status').textContent = text; $('#command-status').hidden = !text; }
const commands = [
  { name: '/help', description: 'Show commands' }, { name: '/ban', description: 'Ban an account or guest' },
  { name: '/unban', description: 'Restore a banned session' }, { name: '/remove', description: 'Remove the message you are replying to' }
];
async function runCommand(text, reply) {
  const [, command, argument = ''] = text.match(/^(\/\S+)(?:\s+([\s\S]*))?$/);
  if (command === '/help') { status('/ban @Full Alias · /unban @Full Alias · /remove (select Reply first). Unlock Room management to moderate. Use // to send text starting with /.'); return; }
  if (!commands.some(c => c.name === command)) throw new Error('Unknown command. Type /help to see available commands.');
  if (!me.admin) throw new Error('Unlock Room management before using admin commands.');
  if (command === '/remove') {
    if (!reply || argument) throw new Error('Select Reply on a message, then send /remove.');
    await api('admin/remove-message', { id: reply.id }); status('Message removed.'); return;
  }
  if (!argument) throw new Error(`Usage: ${command} @Full Alias`);
  const state = await api('admin/state');
  const query = argument.replace(/^@/, '').trim().toLowerCase();
  const found = (command === '/ban' ? state.people : state.bans).filter(p => p.id === query || p.alias.toLowerCase() === query);
  if (found.length !== 1) throw new Error('Choose one exact alias from autocomplete, or use a session ID.');
  await api(`admin/${command.slice(1)}`, { id: found[0].id });
  status(`${found[0].alias} ${command === '/ban' ? 'banned' : 'unbanned'}.`);
  await refreshAdminState();
}
$('#composer').onsubmit = async event => {
  event.preventDefault(); if (!current || sending) return;
  const draft = $('#message').value, text = draft.trim(); if ((!text && !pendingImage) || imagePreparing) return;
  const target = { ...current }, version = revision, reply = replying, image = pendingImage; sending = true; $('.send-button').disabled = true; error(); status('');
  closeSuggestions(); toggleEmoji(false);
  let uploadId;
  try {
    if (image && text.startsWith('/') && !text.startsWith('//')) throw new Error('Send the image separately from a command.');
    if (text.startsWith('/') && !text.startsWith('//')) await runCommand(text, reply);
    else if (target.group) {
      if (!encryptionClient) throw new Error(encryptionError || 'Room encryption is unavailable.');
      const state = await api(`groups/state?group=${encodeURIComponent(target.group)}`);
      const attachment = image ? await uploadEncryptedImage(image, { group: state.id, version: state.version }) : null;
      uploadId = attachment?.id;
      const id = crypto.randomUUID();
      const envelopes = await encryptionClient.encryptGroup({ id, group: state.id, version: state.version, sender: me.id,
        text: text.startsWith('//') ? text.slice(1) : text, replyTo: reply?.id || null, image: attachment }, state.members);
      await receive(await api('groups/message', { group: state.id, version: state.version, id, envelopes, replyTo: reply?.id, attachmentId: uploadId }));
      uploadId = null; status('');
      if (pendingImage === image) clearPendingImage();
    } else if (target.peer) {
      if (!encryptionClient) throw new Error(encryptionError || 'Private encryption is unavailable.');
      const person = await encryptionClient.peer(target.peer);
      const attachment = image ? await uploadEncryptedImage(image, { peer: target.peer }) : null;
      uploadId = attachment?.id;
      const id = crypto.randomUUID();
      const encrypted = encryptionClient.encrypt({ id, sender: me.id, recipient: target.peer, text: text.startsWith('//') ? text.slice(1) : text, replyTo: reply?.id || null, image: attachment }, person);
      await receive(await api('message', { peer: target.peer, id, encrypted, replyTo: reply?.id, attachmentId: uploadId }));
      uploadId = null; status('');
      if (pendingImage === image) clearPendingImage();
    } else {
      if (image) throw new Error('Images can only be sent in encrypted conversations.');
      await receive(await api('message', { ...target, text: text.startsWith('//') ? text.slice(1) : text, replyTo: reply?.id }));
    }
    if (drafts.get(conversationKey(target)) === draft) drafts.delete(conversationKey(target));
    if (version === revision && $('#message').value === draft) { $('#message').value = ''; $('#message').style.height = ''; if (replying === reply) setReply(null); }
  } catch(e) { error(e.message); status(''); if (uploadId) fetch(`/api/attachments/${encodeURIComponent(uploadId)}`, { method: 'DELETE' }).catch(() => {}); }
  finally { sending = false; updateComposerState(); $('#message').focus(); }
};
function closeSuggestions() { suggestions = []; $('#suggestions').hidden = true; $('#message').removeAttribute('aria-activedescendant'); }
function renderSuggestions() {
  $('#suggestions').hidden = !suggestions.length;
  $('#suggestions').replaceChildren(...suggestions.map((item, index) => {
    const button = element('button', index === suggestionIndex ? 'selected' : '', item.label);
    button.type = 'button'; button.id = `suggestion-${index}`; button.setAttribute('role', 'option'); button.setAttribute('aria-selected', String(index === suggestionIndex));
    button.onmousedown = event => event.preventDefault(); button.onclick = () => chooseSuggestion(index); return button;
  }));
  if (suggestions.length) $('#message').setAttribute('aria-activedescendant', `suggestion-${suggestionIndex}`);
  else $('#message').removeAttribute('aria-activedescendant');
}
function updateSuggestions() {
  const input = $('#message'), before = input.value.slice(0, input.selectionStart);
  suggestions = []; suggestionIndex = 0;
  if (/^\/[^\s]*$/.test(before)) {
    completionStart = 0; suggestions = commands.filter(c => c.name.startsWith(before)).map(c => ({ label: `${c.name} — ${c.description}`, value: `${c.name} ` }));
  } else {
    const command = before.match(/^\/(ban|unban)\s+(@?)(.*)$/), mention = before.match(/(?:^|\s)@([^@\n]*)$/);
    if (command || mention) {
      const query = (command ? command[3] : mention[1]).toLowerCase();
      completionStart = command ? before.indexOf(' ') + 1 : before.lastIndexOf('@');
      const candidates = command?.[1] === 'unban' ? adminBans : current?.group && !command ? groupState?.members || [] : [...new Map([...(me ? [me] : []), ...people, ...messages.map(m => ({ id: m.sender, alias: m.alias }))].map(p => [p.id, p])).values()];
      suggestions = candidates.filter(p => (!current?.peer || command || p.id === me.id || p.id === current.peer) && p.alias.toLowerCase().includes(query) && (!command || p.id !== me.id)).slice(0, 8).map(p => ({ label: p.alias, value: `@${p.alias} ` }));
    }
  }
  renderSuggestions();
}
function insertText(value, start = $('#message').selectionStart, end = $('#message').selectionEnd) {
  const input = $('#message');
  if (input.value.length - (end - start) + value.length > input.maxLength) { error('Use at most 2,000 characters.'); return; }
  input.setRangeText(value, start, end, 'end'); input.focus(); resizeComposer();
}
function chooseSuggestion(index) { const item = suggestions[index]; if (item) insertText(item.value, completionStart, $('#message').selectionStart); closeSuggestions(); }
function resizeComposer() { $('#message').style.height = 'auto'; $('#message').style.height = `${Math.min($('#message').scrollHeight, 150)}px`; }
$('#message').onkeydown = event => {
  if (event.isComposing) return;
  if (event.key === 'Escape') { closeSuggestions(); toggleEmoji(false); return; }
  if (suggestions.length && ['ArrowDown', 'ArrowUp', 'Enter', 'Tab'].includes(event.key) && !event.shiftKey) {
    event.preventDefault();
    if (event.key === 'Enter' || event.key === 'Tab') chooseSuggestion(suggestionIndex);
    else { suggestionIndex = (suggestionIndex + (event.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length; renderSuggestions(); }
    return;
  }
  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); if (!sending) $('#composer').requestSubmit(); }
};
$('#message').oninput = () => { resizeComposer(); updateSuggestions(); };
$('#message').onclick = updateSuggestions;
$('#message').onkeyup = event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) updateSuggestions(); };
const emojis = [['😀','grinning happy'],['😄','smile happy'],['😂','laugh tears joy'],['🥹','touched tears'],['😊','smile blush'],['😍','love heart eyes'],['😎','cool sunglasses'],['🤔','thinking'],['😢','sad cry'],['😭','cry sob'],['😴','sleep tired'],['🙃','upside down'],['🥳','party celebration'],['😅','sweat smile'],['❤️','red heart love'],['💚','green heart'],['💔','broken heart'],['👍','thumbs up yes'],['👎','thumbs down no'],['👋','wave hello'],['🙌','hooray raised hands'],['👏','clap applause'],['🙏','thanks pray'],['🤝','handshake'],['✨','sparkles'],['🔥','fire'],['🎉','party celebration'],['💯','hundred'],['👀','eyes look'],['☕','coffee'],['🍕','pizza'],['🌙','moon night'],['🌻','sunflower'],['🐱','cat'],['🐶','dog'],['🦊','fox']];
let emojiSelection = [0, 0];
function toggleEmoji(open) {
  $('#emoji-picker').hidden = !open; $('#emoji-toggle').setAttribute('aria-expanded', String(open));
  if (open) { emojiSelection = [$('#message').selectionStart, $('#message').selectionEnd]; closeSuggestions(); $('#emoji-search').value = ''; renderEmoji(); $('#emoji-search').focus(); }
}
function renderEmoji() {
  const query = $('#emoji-search').value.toLowerCase().trim();
  const buttons = emojis.filter(([emoji, name]) => name.includes(query) || emoji === query).map(([emoji, name]) => {
    const button = element('button', '', emoji); button.type = 'button'; button.title = name; button.setAttribute('aria-label', name);
    button.onclick = () => { insertText(emoji, ...emojiSelection); toggleEmoji(false); }; return button;
  });
  $('#emoji-grid').replaceChildren(...buttons);
  if (!buttons.length) $('#emoji-grid').append(element('p', '', 'No emoji found.'));
}
$('#emoji-toggle').onclick = () => toggleEmoji($('#emoji-picker').hidden);
$('#emoji-search').oninput = renderEmoji;
$('#emoji-picker').onkeydown = event => { if (event.key === 'Escape') { toggleEmoji(false); $('#emoji-toggle').focus(); } };
document.addEventListener('click', event => { if (!event.target.closest('.composer-wrap')) { closeSuggestions(); toggleEmoji(false); } });
for (const close of document.querySelectorAll('.close-dialog')) close.onclick = () => close.closest('dialog').close();
$('#privacy-button').onclick = $('#faq-button').onclick = () => $('#privacy-dialog').showModal();
$('#open-admin').onclick = () => { $('#admin-error').textContent = ''; $('#admin-dialog').showModal(); refreshFeedback(); refreshAdminState(); };
let feedbackRequest = 0;
async function refreshFeedback() {
  if (!me?.admin) return;
  const request = ++feedbackRequest;
  $('#feedback-inbox-status').textContent = 'Loading feedback…';
  try {
    const items = await api('admin/feedback');
    if (!me?.admin || request !== feedbackRequest) return;
    $('#feedback-count').textContent = `(${items.filter(item => !item.reviewed).length} new)`;
    $('#feedback-inbox-status').textContent = items.length ? '' : 'No feedback yet.';
    $('#admin-feedback').replaceChildren(...items.map(item => {
      const entry = element('details', 'feedback-entry'), summary = element('summary', '', item.title);
      summary.append(element('span', 'feedback-state', item.reviewed ? 'Reviewed' : 'New'));
      const date = element('time', 'feedback-date', new Date(item.createdAt).toLocaleString()); date.dateTime = item.createdAt;
      const actions = element('div', 'feedback-actions');
      for (const [action, label] of [['update', item.reviewed ? 'Mark as new' : 'Mark reviewed'], ['delete', 'Delete']]) {
        const button = element('button', action === 'delete' ? 'danger-small' : 'text-button', label); button.type = 'button';
        button.onclick = async () => {
          if (action === 'delete' && !confirm('Delete this feedback permanently?')) return;
          button.disabled = true;
          try { await api(`admin/feedback/${action}`, { id: item.id, reviewed: !item.reviewed }); await refreshFeedback(); }
          catch (e) { $('#feedback-inbox-status').textContent = e.message; button.disabled = false; }
        };
        actions.append(button);
      }
      entry.append(summary, date, element('p', 'feedback-text', item.text), actions); return entry;
    }));
  } catch (e) { if (me?.admin && request === feedbackRequest) $('#feedback-inbox-status').textContent = e.message; }
}
$('#refresh-feedback').onclick = refreshFeedback;
function setAdmin(admin) {
  me.admin = admin; $('#open-admin').hidden = !admin;
  if (!admin) me.displayAsAdmin = false;
  $('#admin-login').hidden = admin; $('#admin-controls').hidden = !admin;
  $('#display-as-admin').checked = Boolean(me.displayAsAdmin);
  $('#my-alias').replaceChildren(username(me.alias, '', me.displayAsAdmin));
  if (admin) refreshFeedback();
  else { adminStateRequest++; adminGroups = []; renderAdminGroups(); $('#moderate-group-dialog').close(); feedbackRequest++; $('#admin-feedback').replaceChildren(); $('#feedback-count').textContent = ''; $('#feedback-inbox-status').textContent = ''; }
}
function updateAppearance(person) {
  people = people.map(p => p.id === person.id ? { ...p, ...person } : p);
  renderPeople(); renderDMs();
}
function updateSession(session) { Object.assign(me, session); updateComposerState(); $('#identity-kind').textContent = me.account ? 'Persistent account' : 'Guest identity'; setAdmin(me.admin); updateAppearance(me); renderMessages(); }
$('#display-as-admin').onchange = async event => {
  const toggle = event.target; toggle.disabled = true;
  try { updateSession(await api('admin/appearance', { displayAsAdmin: toggle.checked })); $('#admin-error').textContent = ''; }
  catch(e) { toggle.checked = Boolean(me.displayAsAdmin); $('#admin-error').textContent = e.message; }
  finally { toggle.disabled = false; }
};
let adminStateRequest = 0;
async function refreshAdminState() {
  if (!me?.admin) return;
  try {
    const request = ++adminStateRequest;
    const state = await api('admin/state');
    if (!me?.admin || request !== adminStateRequest) return;
    adminGroups = state.groups || []; renderAdminGroups();
    people = state.people; adminBans = state.bans;
    renderPeople(); renderAdminPeople(); renderAdminBans(); renderMessages();
  } catch(e) { $('#admin-error').textContent = e.message; }
}
function renderAdminPeople() {
  const list = $('#admin-people'); if (!list) return;
  list.replaceChildren(...people.map(person => {
    const row = element('div', 'admin-person'), button = element('button', 'danger-small', 'Ban');
    row.append(username(`${person.alias}${person.id === me?.id ? ' (you)' : ''}`, '', person.displayAsAdmin), button);
    button.disabled = person.id === me?.id;
    button.onclick = () => { banning = person; $('#ban-description').textContent = `“${person.alias}” will be disconnected. An account ban blocks all sessions and future logins for that account. A guest ban blocks this browser session.`; $('#ban-error').textContent = ''; $('#ban-dialog').showModal(); };
    return row;
  }));
  if (!people.length) list.append(element('p', 'admin-empty', 'No one is online.'));
}
function renderAdminBans() {
  const list = $('#admin-bans'); if (!list) return;
  list.replaceChildren(...adminBans.map(ban => {
    const row = element('div', 'admin-person'), button = element('button', 'text-button', 'Unban');
    row.append(element('span', '', ban.alias), button);
    button.onclick = async () => { button.disabled = true; try { await api('admin/unban', { id: ban.id }); await refreshAdminState(); } catch(e) { $('#admin-error').textContent = e.message; button.disabled = false; } };
    return row;
  }));
  if (!adminBans.length) list.append(element('p', 'admin-empty', 'No banned users.'));
}
$('#create-room').onsubmit = async event => { event.preventDefault(); const button = $('#create-room button'); button.disabled = true; try { await api('admin/create', { name: $('#new-room').value, description: $('#new-description').value }); $('#create-room').reset(); $('#admin-error').textContent = ''; } catch(e) { $('#admin-error').textContent = e.message; } finally { button.disabled = false; } };
function renderAdminRooms() {
  $('#admin-rooms').replaceChildren(...rooms.filter(room => !room.adminOnly).map(room => { const row = element('div', 'admin-room'), button = element('button', 'delete-room', 'Remove'); row.append(element('span', '', room.name), button); button.onclick = () => { deleting = { id: room.id, group: false }; $('#delete-description').textContent = `“${room.name}” and its message history will be removed for everyone. This cannot be undone.`; $('#delete-error').textContent = ''; $('#delete-dialog').showModal(); }; return row; }));
}
$('#cancel-delete').onclick = () => $('#delete-dialog').close();
$('#confirm-delete').onclick = async () => { $('#confirm-delete').disabled = true; try { await api(deleting.group ? 'admin/groups/delete' : 'admin/delete', deleting.group ? { group: deleting.id } : { id: deleting.id }); await refreshAdminState(); $('#delete-dialog').close(); } catch(e) { $('#delete-error').textContent = e.message; } finally { $('#confirm-delete').disabled = false; } };
$('#cancel-ban').onclick = () => $('#ban-dialog').close();
$('#confirm-ban').onclick = async () => { $('#confirm-ban').disabled = true; try { await api('admin/ban', { id: banning.id }); $('#ban-dialog').close(); await refreshAdminState(); } catch(e) { $('#ban-error').textContent = e.message; } finally { $('#confirm-ban').disabled = false; } };
async function start() {
  try {
    const auth = await api('auth/status');
    if (!auth.me) { location.replace('/#entry'); return; }
    const data = await api('session'); me = data.me; rooms = data.rooms; people = data.people; blockedUsers = data.blocks || []; hiddenChats = new Set(data.hiddenChats || []); renderBlockedUsers(); groupRooms = data.groups || [];
    $('#identity-kind').textContent = me.account ? 'Persistent account' : 'Guest identity';
    try { encryptionClient = await SilenzaCrypto.createClient(me.id, api); } catch(e) { encryptionError = e.message; }
    for (const person of data.conversations || []) conversations.set(person.id, person.alias);
    $('#my-alias').textContent = me.alias; $('.me-avatar').textContent = me.alias.split(' ').slice(0,2).map(x => x[0]).join(''); setAdmin(me.admin); renderPeople(); renderAdminPeople();
    if (me.admin) await refreshAdminState();
    await select(rooms[0] ? { room: rooms[0].id } : null);
    stream = new EventSource('/api/events');
    stream.onopen = () => { $('#connection').textContent = 'Connected'; $('#connection').classList.add('live'); if (current) select(current); };
    stream.onerror = async () => { if (signingOut) return; $('#connection').textContent = 'Reconnecting…'; $('#connection').classList.remove('live'); try { const auth = await api('auth/status'); if (!signingOut && (!auth.me || auth.me.id !== me.id)) { stream.close(); location.replace('/#entry'); } } catch {} };
    stream.addEventListener('private-preferences', event => applyPrivatePreferences(JSON.parse(event.data)));
    stream.addEventListener('identity-ready', event => { const { id } = JSON.parse(event.data); if (current?.peer === id && !peerIdentity) select(current); });
    stream.addEventListener('session', event => updateSession(JSON.parse(event.data)));
    stream.addEventListener('groups-changed', () => { refreshGroups(); refreshAdminState(); });
    stream.addEventListener('group-state', event => groupStateChanged(JSON.parse(event.data)));
    stream.addEventListener('group-removed', event => {
      const removed = JSON.parse(event.data); drafts.delete(`group:${removed.group}`);
      if (current?.group === removed.group) closeCurrentGroup(removed.reason);
      if (groupPanel?.id === removed.group) { $('#group-dialog').close(); groupPanel = null; }
      refreshGroups();
    });
    stream.addEventListener('appearance', event => updateAppearance(JSON.parse(event.data)));
    stream.addEventListener('people', event => { people = JSON.parse(event.data); api('private/preferences').then(applyPrivatePreferences).catch(() => {}); for (const person of people) updateAppearance(person); renderPeople(); renderDMs(); renderAdminPeople(); });
    stream.addEventListener('rooms', event => { rooms = JSON.parse(event.data); if (current?.room && !rooms.some(r => r.id === current.room)) { select(rooms[0] ? { room: rooms[0].id } : null); error('That room was removed by the host.'); } else if (!current && rooms[0]) select({ room: rooms[0].id }); else { renderRooms(); updateHeading(); } });
    stream.addEventListener('message', event => receive(JSON.parse(event.data)));
    stream.addEventListener('message-edited', event => applyEdit(JSON.parse(event.data)));
    stream.addEventListener('message-removed', event => applyRemoval(JSON.parse(event.data)));
    stream.addEventListener('moderation', () => { if (me.admin) refreshAdminState(); });
    setInterval(() => {
      let changed = false;
      for (const message of messages) if (message.image && message.attachment?.expiresAt <= Date.now() && !message.imageExpired) {
        message.imageExpired = true; revokeImage(message.id); changed = true;
      }
      if (changed) renderMessages();
    }, 10000);
  } catch(e) { error(e.message); $('#connection').textContent = 'Could not connect'; }
}
let soundSettings = { private: false, groups: false, rooms: false }, audioContext, lastSound = 0;
try { const saved = JSON.parse(localStorage.getItem('silenza-sounds')); for (const key of Object.keys(soundSettings)) soundSettings[key] = saved?.[key] === true; } catch {}
async function playSound() {
  const Audio = window.AudioContext || window.webkitAudioContext;
  if (!Audio) throw new Error('Audio notifications are unavailable in this browser.');
  audioContext ||= new Audio();
  await audioContext.resume();
  if (audioContext.state !== 'running') throw new Error('Use Test sound to enable audio in this tab.');
  const oscillator = audioContext.createOscillator(), volume = audioContext.createGain(), now = audioContext.currentTime;
  oscillator.type = 'sine'; oscillator.frequency.setValueAtTime(660, now);
  volume.gain.setValueAtTime(0, now); volume.gain.linearRampToValueAtTime(0.08, now + 0.02); volume.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
  oscillator.connect(volume); volume.connect(audioContext.destination); oscillator.start(now); oscillator.stop(now + 0.25);
  oscillator.onended = () => { oscillator.disconnect(); volume.disconnect(); };
}
function notifyMessage(message) {
  const kind = message.group ? 'groups' : message.room ? 'rooms' : 'private';
  if (message.sender === me.id || !soundSettings[kind] || Date.now() - lastSound < 800) return;
  lastSound = Date.now();
  playSound().catch(e => { $('#sound-status').textContent = e.message; });
}
$('#open-settings').onclick = () => $('#settings-dialog').showModal();
for (const key of Object.keys(soundSettings)) {
  const input = $(`#sound-${key}`); input.checked = soundSettings[key];
  input.onchange = () => {
    soundSettings[key] = input.checked;
    try { localStorage.setItem('silenza-sounds', JSON.stringify(soundSettings)); } catch { $('#sound-status').textContent = 'This browser could not save your sound preferences.'; }
    if (input.checked) playSound().catch(e => { $('#sound-status').textContent = e.message; });
  };
}
$('#test-sound').onclick = () => playSound().then(() => { $('#sound-status').textContent = 'Sound is enabled in this tab.'; }).catch(e => { $('#sound-status').textContent = e.message; });
$('#account-signout').onclick = async () => {
  signingOut = true;
  try { await api('auth/logout', {}); stream?.close(); location.assign('/#entry'); }
  catch (e) { signingOut = false; $('#sound-status').textContent = e.message; }
};
setupGroups();
start();
