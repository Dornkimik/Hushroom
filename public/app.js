const $ = selector => document.querySelector(selector);
let me, rooms = [], people = [], adminBans = [], current, messages = [], stream, revision = 0, deleting, banning;
let replying, sending = false, suggestions = [], suggestionIndex = 0, completionStart = 0;
let encryptionClient, encryptionError = '', peerIdentity, pendingImage, imagePreparing = false, imageRevision = 0, verificationTarget;
const imageURLs = new Map(), imageLoads = new Map();
const conversations = new Map(), unread = new Map(), drafts = new Map();
const conversationKey = target => target ? `${target.peer ? 'peer' : 'room'}:${target.peer || target.room}` : '';
async function api(url, data) {
  const response = await fetch(`/api/${url}`, data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Could not connect. Try again.');
  return result;
}
function error(message = '') { $('#error').textContent = message; $('#error').hidden = !message; }
function element(tag, className, text) { const e = document.createElement(tag); e.className = className; if (text !== undefined) e.textContent = text; return e; }
function avatar(alias, own = false) { return element('span', `avatar${own ? ' me-avatar' : ''}`, alias.split(' ').slice(0,2).map(s => s[0]).join('')); }
function renderRooms() {
  $('#room-count').textContent = rooms.length;
  $('#rooms').replaceChildren(...rooms.map(room => {
    const button = element('button', `nav-room${current?.room === room.id ? ' active' : ''}`);
    button.append(element('span', 'hash', '#'), element('span', 'name', room.name), element('span', 'count', room.count || 0));
    button.setAttribute('aria-current', current?.room === room.id ? 'true' : 'false');
    button.onclick = () => select({ room: room.id }); return button;
  }));
  if (!rooms.length) $('#rooms').append(element('p', 'aside-hint', 'No rooms yet. The host can create one.'));
  renderAdminRooms();
}
function renderPeople() {
  $('#online-count').textContent = people.length;
  $('#people').replaceChildren(...people.map(person => {
    const own = person.id === me.id;
    const button = element('button', 'person'); button.disabled = own;
    button.append(avatar(person.alias, own), element('span', 'person-name', person.alias), element(own ? 'small' : 'span', own ? '' : 'person-arrow', own ? 'you' : '↗'));
    button.title = own ? 'This is you' : `Chat privately with ${person.alias}`;
    button.onclick = () => { conversations.set(person.id, person.alias); select({ peer: person.id }); }; return button;
  }));
}
function renderDMs() {
  $('#dm-hint').hidden = conversations.size > 0;
  $('#dms').replaceChildren(...[...conversations].map(([id, alias]) => {
    const button = element('button', `dm-room${current?.peer === id ? ' active' : ''}`);
    button.append(element('span', '', '↗'), element('span', 'name', alias));
    if (unread.get(id)) button.append(element('span', 'unread', unread.get(id)));
    button.onclick = () => select({ peer: id }); return button;
  }));
}
function updateHeading() {
  const privateChat = Boolean(current?.peer), room = rooms.find(r => r.id === current?.room);
  $('#room-title').textContent = privateChat ? conversations.get(current.peer) || 'Private conversation' : room?.name || 'A little quiet for now';
  $('#room-description').textContent = privateChat ? 'A conversation just between the two of you.' : room?.description || 'Choose a room or someone to talk to.';
  $('#room-symbol').textContent = privateChat ? '↗' : '#';
  $('#conversation-type').textContent = privateChat ? 'JUST BETWEEN YOU TWO' : 'COME AS YOU ARE';
  $('#room-badge').textContent = privateChat ? 'PRIVATE CHAT' : 'OPEN ROOM';
  $('#private-note').hidden = !privateChat;
  $('#message').placeholder = privateChat ? 'Say something, just to them…' : 'Leave a little thought…';
  updateComposerState();
  $('#welcome h2').textContent = privateChat ? 'A little more personal.' : 'Make yourself at home.';
  $('#welcome p').textContent = privateChat ? 'One conversation. Just the two of you.\nA simple hello is a good place to start.' : 'No introductions needed. A simple hello is a good place to start.';
}
function matches(message, target = current) { return target && (target.peer ? !message.room && ((message.sender === me.id && message.recipient === target.peer) || (message.sender === target.peer && message.recipient === me.id)) : message.room === target.room); }
async function select(target) {
  setReply(null); closeSuggestions(); toggleEmoji(false);
  if (conversationKey(target) !== conversationKey(current)) {
    if (current) drafts.set(conversationKey(current), $('#message').value);
    $('#message').value = drafts.get(conversationKey(target)) || ''; resizeComposer();
    clearPendingImage(); status('');
  }
  clearImageURLs(); peerIdentity = null;
  current = target; const version = ++revision; messages = []; error();
  if (target?.peer) unread.delete(target.peer);
  renderRooms(); renderDMs(); updateHeading(); renderMessages();
  if (!target) return;
  try {
    if (target.peer) {
      if (!encryptionClient) throw new Error(encryptionError || 'Private encryption is unavailable.');
      const person = await encryptionClient.peer(target.peer);
      if (version !== revision) return;
      peerIdentity = person; updateComposerState();
    }
    if (target.room) await api('join', target);
    const history = await Promise.all((await api(`history?${new URLSearchParams(target)}`)).map(decodePrivate));
    if (version !== revision) return;
    messages = [...new Map([...history, ...messages].map(m => [m.id, m])).values()].sort((a,b) => a.time.localeCompare(b.time)).slice(-100);
    renderMessages();
  } catch (e) { if (version === revision) { error(e.message); if (target.peer) { peerIdentity = null; updateComposerState(e.message); } } }
}
function renderMessages() {
  $('#messages').replaceChildren(...messages.map(message => {
    const own = message.sender === me.id;
    const row = element('article', 'chat-message'), content = element('div', 'message-content'), meta = element('div', 'message-meta');
    meta.append(element('span', 'message-name', message.alias));
    if (own) meta.append(element('span', 'you-tag', 'YOU'));
    meta.append(element('time', 'message-time', new Date(message.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })));
    row.id = `message-${message.id}`;
    if (message.mentions?.some(person => person.id === me.id)) row.classList.add('mentioned');
    const replyButton = element('button', 'message-reply', 'Reply');
    replyButton.type = 'button'; replyButton.disabled = Boolean(message.locked); replyButton.onclick = () => { setReply(message); $('#message').focus(); };
    meta.append(replyButton);
    if (own || me?.admin) {
      const remove = element('button', 'message-remove', own ? 'Delete' : 'Remove');
      remove.type = 'button'; remove.title = 'Remove this message for everyone';
      remove.onclick = async () => { remove.disabled = true; try { applyRemoval(await api(own ? 'message/delete' : 'admin/remove-message', { id: message.id })); } catch(e) { error(e.message); remove.disabled = false; } };
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
  $('#welcome').hidden = messages.length > 3;
  $('#chat-scroll').scrollTop = $('#chat-scroll').scrollHeight;
}
function applyRemoval(removed) {
  if (!matches(removed)) return;
  const { id } = removed;
  revokeImage(id); messages = messages.filter(message => message.id !== id);
  for (const message of messages) if (message.reply?.id === id) message.reply = { id, removed: true };
  if (replying?.id === id) setReply(null);
  renderMessages();
}
async function receive(message) {
  if (!message.room) {
    const peer = message.sender === me.id ? message.recipient : message.sender;
    if (!conversations.has(peer)) conversations.set(peer, people.find(p => p.id === peer)?.alias || message.alias);
    if (current?.peer !== peer && message.sender !== me.id) unread.set(peer, (unread.get(peer) || 0) + 1);
    renderDMs();
  }
  if (matches(message) && !messages.some(m => m.id === message.id)) {
    const version = revision;
    messages = [...messages, message.encrypted ? { ...message, text: 'Decrypting…', locked: true } : message].slice(-100); renderMessages();
    if (message.encrypted) {
      const decoded = await decodePrivate(message);
      if (version !== revision) return;
      messages = messages.map(m => m.id === message.id ? { ...decoded, reply: m.reply } : m); renderMessages();
    }
    for (const id of new Set([...imageURLs.keys(), ...imageLoads.keys()])) if (!messages.some(m => m.id === id)) revokeImage(id);
  }
}
function updateComposerState(problem) {
  const privateChat = Boolean(current?.peer), ready = Boolean(encryptionClient && peerIdentity?.id === current?.peer);
  $('#message').disabled = !current || (privateChat && !ready);
  $('#message').required = !pendingImage;
  $('.send-button').disabled = !current || sending || imagePreparing || (privateChat && !ready);
  $('#emoji-toggle').disabled = $('#message').disabled;
  $('#attach-image').hidden = !privateChat; $('#attach-image').disabled = !ready || sending || imagePreparing;
  $('#verify-identity').disabled = !ready;
  if (privateChat) $('#encryption-status').textContent = problem || (ready ? `End-to-end encrypted · ${peerIdentity.verified ? 'Identity verified' : 'Identity not verified'}` : encryptionError || 'Waiting for private encryption…');
}
async function decodePrivate(message) {
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
  const file = $('#image-input').files[0]; if (!file || !current?.peer) return;
  clearPendingImage(); const version = imageRevision;
  imagePreparing = true; updateComposerState(); error(); status('Preparing image locally…');
  try {
    const image = await HushImages.prepare(file);
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
      const plain = HushCrypto.decryptImage(bytes, message.image);
      // Only our raster format is rendered, never SVG/HTML or a server-provided MIME type.
      if (String.fromCharCode(...plain.subarray(0, 4)) !== 'RIFF' || String.fromCharCode(...plain.subarray(8, 12)) !== 'WEBP') throw new Error('Invalid private image.');
      if (version !== revision || controller.signal.aborted || !messages.some(m => m.id === message.id) || message.attachment.expiresAt <= Date.now()) throw new Error('Image no longer available.');
      const url = URL.createObjectURL(new Blob([plain], { type: 'image/webp' })); imageURLs.set(message.id, url); return url;
    })();
    imageLoads.set(message.id, { promise, controller });
  }
  imageLoads.get(message.id).promise.then(url => { if (version === revision) img.src = url; }).catch(e => { img.hidden = true; note.textContent = e.message; });
}
$('#verify-identity').onclick = async () => {
  if (!current?.peer || !encryptionClient) return;
  try {
    const person = await encryptionClient.peer(current.peer);
    verificationTarget = person;
    $('#verification-code').textContent = encryptionClient.code(person);
    $('#verification-detail').textContent = person.verified ? 'You previously marked this identity as verified.' : 'Until you compare this code, this identity is trusted on first use.';
    $('#verification-error').textContent = ''; $('#verify-dialog').showModal();
  } catch(e) { error(e.message); }
};
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
  { name: '/help', description: 'Show commands' }, { name: '/ban', description: 'Ban an anonymous session' },
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
    else if (target.peer) {
      if (!encryptionClient) throw new Error(encryptionError || 'Private encryption is unavailable.');
      const person = await encryptionClient.peer(target.peer);
      let attachment = null;
      if (image) {
        status('Encrypting image…');
        const encrypted = HushCrypto.encryptImage(new Uint8Array(await image.blob.arrayBuffer()));
        status('Uploading encrypted image…');
        const response = await fetch(`/api/attachments?peer=${encodeURIComponent(target.peer)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: encrypted.bytes });
        const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Could not upload image.');
        uploadId = result.id;
        attachment = { id: uploadId, key: encrypted.key, nonce: encrypted.nonce, type: image.type, width: image.width, height: image.height, size: image.size };
      }
      const id = crypto.randomUUID();
      const encrypted = encryptionClient.encrypt({ id, sender: me.id, recipient: target.peer, text: text.startsWith('//') ? text.slice(1) : text, replyTo: reply?.id || null, image: attachment }, person);
      await receive(await api('message', { peer: target.peer, id, encrypted, replyTo: reply?.id, attachmentId: uploadId }));
      uploadId = null; status('');
      if (pendingImage === image) clearPendingImage();
    } else {
      if (image) throw new Error('Images can only be sent in private chats.');
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
      const candidates = command?.[1] === 'unban' ? adminBans : [...new Map([...(me ? [me] : []), ...people, ...messages.map(m => ({ id: m.sender, alias: m.alias }))].map(p => [p.id, p])).values()];
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
$('#open-admin').onclick = () => { $('#admin-error').textContent = ''; $('#admin-dialog').showModal(); };
function setAdmin(admin) { me.admin = admin; $('#admin-login').hidden = admin; $('#admin-controls').hidden = !admin; }
async function refreshAdminState() {
  if (!me?.admin) return;
  try {
    const state = await api('admin/state');
    people = state.people; adminBans = state.bans;
    renderPeople(); renderAdminPeople(); renderAdminBans(); renderMessages();
  } catch(e) { $('#admin-error').textContent = e.message; }
}
function renderAdminPeople() {
  const list = $('#admin-people'); if (!list) return;
  list.replaceChildren(...people.map(person => {
    const row = element('div', 'admin-person'), button = element('button', 'danger-small', 'Ban');
    row.append(element('span', '', `${person.alias}${person.id === me?.id ? ' (you)' : ''}`), button);
    button.disabled = person.id === me?.id;
    button.onclick = () => { banning = person; $('#ban-description').textContent = `“${person.alias}” will be disconnected and this browser session will no longer be able to rejoin. Other anonymous sessions are unaffected.`; $('#ban-error').textContent = ''; $('#ban-dialog').showModal(); };
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
  if (!adminBans.length) list.append(element('p', 'admin-empty', 'No banned sessions.'));
}
$('#admin-login').onsubmit = async event => { event.preventDefault(); try { await api('admin/login', { password: $('#admin-password').value }); $('#admin-password').value = ''; setAdmin(true); $('#admin-error').textContent = ''; await refreshAdminState(); } catch(e) { $('#admin-error').textContent = e.message; } };
$('#admin-logout').onclick = async () => { try { await api('admin/logout', {}); setAdmin(false); renderMessages(); } catch(e) { $('#admin-error').textContent = e.message; } };
$('#create-room').onsubmit = async event => { event.preventDefault(); const button = $('#create-room button'); button.disabled = true; try { await api('admin/create', { name: $('#new-room').value, description: $('#new-description').value }); $('#create-room').reset(); $('#admin-error').textContent = ''; } catch(e) { $('#admin-error').textContent = e.message; } finally { button.disabled = false; } };
function renderAdminRooms() {
  $('#admin-rooms').replaceChildren(...rooms.map(room => { const row = element('div', 'admin-room'), button = element('button', 'delete-room', 'Remove'); row.append(element('span', '', room.name), button); button.onclick = () => { deleting = room.id; $('#delete-description').textContent = `“${room.name}” and its message history will be removed for everyone. This cannot be undone.`; $('#delete-error').textContent = ''; $('#delete-dialog').showModal(); }; return row; }));
}
$('#cancel-delete').onclick = () => $('#delete-dialog').close();
$('#confirm-delete').onclick = async () => { $('#confirm-delete').disabled = true; try { await api('admin/delete', { id: deleting }); $('#delete-dialog').close(); } catch(e) { $('#delete-error').textContent = e.message; } finally { $('#confirm-delete').disabled = false; } };
$('#cancel-ban').onclick = () => $('#ban-dialog').close();
$('#confirm-ban').onclick = async () => { $('#confirm-ban').disabled = true; try { await api('admin/ban', { id: banning.id }); $('#ban-dialog').close(); await refreshAdminState(); } catch(e) { $('#ban-error').textContent = e.message; } finally { $('#confirm-ban').disabled = false; } };
async function start() {
  try {
    const data = await api('session'); me = data.me; rooms = data.rooms; people = data.people;
    try { encryptionClient = await HushCrypto.createClient(me.id, api); } catch(e) { encryptionError = e.message; }
    for (const person of data.conversations || []) conversations.set(person.id, person.alias);
    $('#my-alias').textContent = me.alias; $('.me-avatar').textContent = me.alias.split(' ').slice(0,2).map(x => x[0]).join(''); setAdmin(me.admin); renderPeople(); renderAdminPeople();
    if (me.admin) await refreshAdminState();
    await select(rooms[0] ? { room: rooms[0].id } : null);
    stream = new EventSource('/api/events');
    stream.onopen = () => { $('#connection').textContent = 'Connected'; $('#connection').classList.add('live'); if (current) select(current); };
    stream.onerror = () => { $('#connection').textContent = 'Reconnecting…'; $('#connection').classList.remove('live'); };
    stream.addEventListener('identity-ready', event => { const { id } = JSON.parse(event.data); if (current?.peer === id && !peerIdentity) select(current); });
    stream.addEventListener('people', event => { people = JSON.parse(event.data); renderPeople(); renderAdminPeople(); });
    stream.addEventListener('rooms', event => { rooms = JSON.parse(event.data); if (current?.room && !rooms.some(r => r.id === current.room)) { select(rooms[0] ? { room: rooms[0].id } : null); error('That room was removed by the host.'); } else if (!current && rooms[0]) select({ room: rooms[0].id }); else { renderRooms(); updateHeading(); } });
    stream.addEventListener('message', event => receive(JSON.parse(event.data)));
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
start();
