const $ = selector => document.querySelector(selector);
let me, rooms = [], people = [], adminBans = [], current, messages = [], stream, revision = 0, deleting, banning;
const conversations = new Map(), unread = new Map();
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
  $('#message').disabled = !current; $('.send-button').disabled = !current;
  $('#welcome h2').textContent = privateChat ? 'A little more personal.' : 'Make yourself at home.';
  $('#welcome p').textContent = privateChat ? 'One conversation. Just the two of you.\nA simple hello is a good place to start.' : 'No introductions needed. A simple hello is a good place to start.';
}
function matches(message, target = current) { return target && (target.peer ? !message.room && ((message.sender === me.id && message.recipient === target.peer) || (message.sender === target.peer && message.recipient === me.id)) : message.room === target.room); }
async function select(target) {
  current = target; const version = ++revision; messages = []; error();
  if (target?.peer) unread.delete(target.peer);
  renderRooms(); renderDMs(); updateHeading(); renderMessages();
  if (!target) return;
  try {
    if (target.room) await api('join', target);
    const history = await api(`history?${new URLSearchParams(target)}`);
    if (version !== revision) return;
    messages = [...new Map([...history, ...messages].map(m => [m.id, m])).values()].sort((a,b) => a.time.localeCompare(b.time)).slice(-100);
    renderMessages();
  } catch (e) { if (version === revision) error(e.message); }
}
function renderMessages() {
  $('#messages').replaceChildren(...messages.map(message => {
    const own = message.sender === me.id;
    const row = element('article', 'chat-message'), content = element('div', 'message-content'), meta = element('div', 'message-meta');
    meta.append(element('span', 'message-name', message.alias));
    if (own) meta.append(element('span', 'you-tag', 'YOU'));
    meta.append(element('time', 'message-time', new Date(message.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })));
    if (me?.admin) {
      const remove = element('button', 'message-remove', 'Remove');
      remove.type = 'button'; remove.title = 'Remove this message for everyone';
      remove.onclick = async () => { remove.disabled = true; try { await api('admin/remove-message', { id: message.id }); } catch(e) { $('#admin-error').textContent = e.message; remove.disabled = false; } };
      meta.append(remove);
    }
    content.append(meta, element('p', 'message-text', message.text)); row.append(avatar(message.alias, own), content); return row;
  }));
  $('#empty-chat').hidden = messages.length > 0 || !current;
  $('#welcome').hidden = messages.length > 3;
  $('#chat-scroll').scrollTop = $('#chat-scroll').scrollHeight;
}
function receive(message) {
  if (!message.room) {
    const peer = message.sender === me.id ? message.recipient : message.sender;
    if (!conversations.has(peer)) conversations.set(peer, people.find(p => p.id === peer)?.alias || message.alias);
    if (current?.peer !== peer && message.sender !== me.id) unread.set(peer, (unread.get(peer) || 0) + 1);
    renderDMs();
  }
  if (matches(message) && !messages.some(m => m.id === message.id)) { messages = [...messages, message].slice(-100); renderMessages(); }
}
$('#composer').onsubmit = async event => {
  event.preventDefault(); if (!current) return;
  const text = $('#message').value.trim(); if (!text) return;
  const target = { ...current }; $('.send-button').disabled = true;
  try { const result = await api('message', { ...target, text }); receive(result); if ($('#message').value.trim() === text) $('#message').value = ''; $('#message').style.height = ''; error(); }
  catch(e) { error(e.message); }
  finally { $('.send-button').disabled = !current; $('#message').focus(); }
};
$('#message').onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!$('.send-button').disabled) $('#composer').requestSubmit(); } };
$('#message').oninput = () => { $('#message').style.height = 'auto'; $('#message').style.height = `${Math.min($('#message').scrollHeight, 150)}px`; };
for (const close of document.querySelectorAll('.close-dialog')) close.onclick = () => close.closest('dialog').close();
$('#privacy-button').onclick = () => $('#privacy-dialog').showModal();
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
    for (const person of data.conversations || []) conversations.set(person.id, person.alias);
    $('#my-alias').textContent = me.alias; $('.me-avatar').textContent = me.alias.split(' ').slice(0,2).map(x => x[0]).join(''); setAdmin(me.admin); renderPeople(); renderAdminPeople();
    if (me.admin) await refreshAdminState();
    await select(rooms[0] ? { room: rooms[0].id } : null);
    stream = new EventSource('/api/events');
    stream.onopen = () => { $('#connection').textContent = 'Connected'; $('#connection').classList.add('live'); if (current) select(current); };
    stream.onerror = () => { $('#connection').textContent = 'Reconnecting…'; $('#connection').classList.remove('live'); };
    stream.addEventListener('people', event => { people = JSON.parse(event.data); renderPeople(); renderAdminPeople(); });
    stream.addEventListener('rooms', event => { rooms = JSON.parse(event.data); if (current?.room && !rooms.some(r => r.id === current.room)) { select(rooms[0] ? { room: rooms[0].id } : null); error('That room was removed by the host.'); } else if (!current && rooms[0]) select({ room: rooms[0].id }); else { renderRooms(); updateHeading(); } });
    stream.addEventListener('message', event => receive(JSON.parse(event.data)));
    stream.addEventListener('message-removed', event => { const { id } = JSON.parse(event.data); messages = messages.filter(message => message.id !== id); renderMessages(); });
    stream.addEventListener('moderation', () => { if (me.admin) refreshAdminState(); });
  } catch(e) { error(e.message); $('#connection').textContent = 'Could not connect'; }
}
start();
