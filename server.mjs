import http from 'node:http';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import nacl from 'tweetnacl';
import { Attachments } from './lib/attachments.mjs';
import { Groups } from './lib/groups.mjs';
import { Accounts } from './lib/accounts.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(root, 'data'));
if (process.env.RAILWAY_ENVIRONMENT_ID) {
  const mount = process.env.RAILWAY_VOLUME_MOUNT_PATH;
  const relative = mount ? path.relative(path.resolve(mount), dataDir) : null;
  if (relative === null || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    console.warn('Persistent storage is not configured: attach a Railway volume and unset DATA_DIR, or set DATA_DIR inside its mount path. Main rooms, bans, and feedback may be lost on redeploy.');
  }
}
await mkdir(dataDir, { recursive: true });
let rooms;
try { rooms = JSON.parse(await readFile(path.join(dataDir, 'rooms.json'), 'utf8')); }
catch (e) { if (e.code !== 'ENOENT') throw e; rooms = [
  { id: 'the-living-room', name: 'The living room', description: 'A little company. A good conversation.' },
  { id: 'after-hours', name: 'After hours', description: 'For night owls and wandering thoughts.' },
  { id: 'creative-corner', name: 'Creative corner', description: 'Ideas, works in progress, and happy accidents.' }
];
  // Seed once, then preserve the saved list, including an intentionally empty list.
  await writeFile(path.join(dataDir, 'rooms.tmp'), JSON.stringify(rooms, null, 2));
  await rename(path.join(dataDir, 'rooms.tmp'), path.join(dataDir, 'rooms.json'));
}
let bans;
try { bans = new Map(JSON.parse(await readFile(path.join(dataDir, 'bans.json'), 'utf8')).map(ban => [ban.key, ban])); }
catch (e) { if (e.code !== 'ENOENT') throw e; bans = new Map(); }
let feedback;
try { feedback = JSON.parse(await readFile(path.join(dataDir, 'feedback.json'), 'utf8')); }
catch (e) { if (e.code !== 'ENOENT') throw e; feedback = []; }
const attachmentTTL = Number(process.env.ATTACHMENT_TTL_SECONDS || 86400) * 1000;
if (!Number.isFinite(attachmentTTL) || attachmentTTL < 1000 || attachmentTTL > 86400000) throw new Error('ATTACHMENT_TTL_SECONDS must be between 1 and 86400.');
const attachments = new Attachments({ ttl: attachmentTTL });
const sessions = new Map(), histories = new Map(), attempts = new Map();
const accounts = new Accounts(dataDir);
await accounts.load();
// Bootstrap only a new installation. Never promote an existing user by name.
if (process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD && !accounts.items.length) {
  await accounts.create(process.env.ADMIN_USERNAME, process.env.ADMIN_PASSWORD, 'admin');
}
const isAdmin = s => accounts.get(s.accountId)?.role === 'admin';
const hash = value => createHash('sha256').update(value).digest();
const adjectives = ['Velvet', 'Quiet', 'Cosmic', 'Silver', 'Mellow', 'Amber', 'Lunar'];
const animals = ['Fox', 'Otter', 'Owl', 'Panda', 'Moth', 'Lynx', 'Finch'];
const online = s => s.streams.size > 0;
const displaysAsAdmin = s => s.displayAsAdmin === true && isAdmin(s);
const safeUser = s => ({ id: s.id, alias: s.alias, online: online(s), displayAsAdmin: displaysAsAdmin(s) });
const emit = (s, event, data) => { for (const stream of s.streams) {
  if (stream.writableLength > 256000) { stream.destroy(); continue; }
  stream.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
} };
const broadcast = (event, data) => { for (const s of sessions.values()) emit(s, event, data); };
const presenceKey = s => s.accountId || s.id;
function onlinePeople(viewer) {
  const people = new Map();
  for (const session of sessions.values()) {
    if (!online(session)) continue;
    const key = presenceKey(session);
    // Keep one reachable session per account, preferring the viewer's own
    // session so every device correctly labels its single entry as "you".
    if (!people.has(key) || session.id === viewer.id) people.set(key, session);
  }
  return [...people.values()].map(safeUser);
}
const presence = () => { for (const session of sessions.values()) if (online(session)) emit(session, 'people', onlinePeople(session)); };
const roomList = () => rooms.map(r => ({ ...r, preview: (histories.get(`room:${r.id}`) || []).at(-1)?.text?.slice(0, 100) || '', count: new Set([...sessions.values()].filter(s => online(s) && s.room === r.id).map(presenceKey)).size }));
const publishRooms = () => broadcast('rooms', roomList());
const publicSession = s => ({ ...safeUser(s), admin: isAdmin(s), account: Boolean(s.accountId) });
const publishAppearance = s => { emit(s, 'session', publicSession(s)); broadcast('appearance', safeUser(s)); presence(); };
const groups = new Groups({ isAdmin, emit, broadcast, safeUser, attachments, findUser: id => [...sessions.values()].find(s => s.id === id) });
const keyFor = (s, room, peer) => peer ? `dm:${[s.id, peer].sort().join(':')}` : `room:${room}`;
function publicMentions(text) {
  const mentions = [];
  const candidates = [...sessions.values()];
  for (const person of candidates) {
    const tag = `@${person.alias}`;
    let start = text.indexOf(tag);
    while (start !== -1) {
      const end = start + tag.length;
      if ((start === 0 || /\s/.test(text[start - 1])) && (end === text.length || /[\s.,!?;:()]/.test(text[end]))) mentions.push({ id: person.id, alias: person.alias, start, end });
      start = text.indexOf(tag, end);
    }
  }
  mentions.sort((a, b) => a.start - b.start);
  return mentions;
}
let saveQueue = Promise.resolve();
function saveBans() {
  const job = saveQueue.then(async () => {
    await writeFile(path.join(dataDir, 'bans.tmp'), JSON.stringify([...bans.values()], null, 2));
    await rename(path.join(dataDir, 'bans.tmp'), path.join(dataDir, 'bans.json'));
  });
  saveQueue = job.catch(() => {});
  return job;
}
function saveRooms(transform) {
  const job = saveQueue.then(async () => {
    const next = transform(rooms);
    await writeFile(path.join(dataDir, 'rooms.tmp'), JSON.stringify(next, null, 2));
    await rename(path.join(dataDir, 'rooms.tmp'), path.join(dataDir, 'rooms.json'));
    rooms = next;
  });
  saveQueue = job.catch(() => {});
  return job;
}
function saveFeedback(transform) {
  const job = saveQueue.then(async () => {
    const next = transform(feedback);
    await writeFile(path.join(dataDir, 'feedback.tmp'), JSON.stringify(next, null, 2));
    await rename(path.join(dataDir, 'feedback.tmp'), path.join(dataDir, 'feedback.json'));
    feedback = next;
  });
  saveQueue = job.catch(() => {});
  return job;
}
function fail(status, message) { throw Object.assign(new Error(message), { status }); }
function base64Bytes(value, length, maximum = length) {
  if (typeof value !== 'string' || value.length > 24000) return null;
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value || (length !== null ? bytes.length !== length : bytes.length < 17 || bytes.length > maximum)) return null;
  return bytes;
}
async function body(req, maximum = 32768) {
  let text = '';
  for await (const chunk of req) { text += chunk; if (Buffer.byteLength(text) > maximum) fail(413, 'That request is too large.'); }
  try { const parsed = JSON.parse(text); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail(400, 'Invalid request.'); return parsed; } catch { fail(400, 'Invalid request.'); }
}
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  const json = (data, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
  try {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/')) {
      const files = { '/': ['about.html', 'text/html'], '/chat/': ['index.html', 'text/html'], '/robots.txt': ['robots.txt', 'text/plain'], '/sitemap.xml': ['sitemap.xml', 'application/xml'], '/about.css': ['about.css', 'text/css'], '/feedback.js': ['feedback.js', 'text/javascript'], '/auth.js': ['auth.js', 'text/javascript'], '/app.js': ['app.js', 'text/javascript'], '/groups.js': ['groups.js', 'text/javascript'], '/crypto.js': ['crypto.js', 'text/javascript'], '/private.js': ['private.js', 'text/javascript'], '/vendor/nacl.js': ['../node_modules/tweetnacl/nacl-fast.min.js', 'text/javascript'], '/theme.js': ['theme.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
      if (req.method === 'GET' && ['/about', '/about/', '/chat'].includes(url.pathname)) { res.writeHead(301, { Location: url.pathname === '/chat' ? '/chat/' : '/' }); res.end(); return; }
      if (req.method !== 'GET' || !files[url.pathname]) fail(404, 'Not found.');
      const [file, type] = files[url.pathname];
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' }); res.end(await readFile(path.join(root, 'public', file))); return;
    }
    const origin = process.env.ORIGIN || `http://${req.headers.host}`;
    if (req.headers.origin && req.headers.origin !== origin) fail(403, 'Request origin is not allowed.');
    if (req.method !== 'GET' && req.headers.origin !== origin) fail(403, 'Request origin is not allowed.');
    const token = req.headers.cookie?.split(';').map(x => x.trim()).find(x => x.startsWith('silenza='))?.slice(8);
    if (token && bans.has(hash(token).toString('hex'))) fail(403, 'This anonymous session has been banned.');
    let session = sessions.get(token);
    const cookie = secret => res.setHeader('Set-Cookie', `silenza=${secret}; HttpOnly; SameSite=Strict; Path=/${process.env.SECURE_COOKIES === 'true' || origin.startsWith('https:') ? '; Secure' : ''}`);
    if (url.pathname === '/api/auth/status' && req.method === 'GET') { json({ me: session ? publicSession(session) : null }); return; }
    if (['/api/auth/login', '/api/auth/register'].includes(url.pathname) && req.method === 'POST') {
      const input = await body(req, 4096);
      const address = req.socket.remoteAddress;
      const keys = [`ip:${address}`, `user:${String(input.username).toLowerCase().slice(0, 24)}`];
      for (const key of keys) {
        let limit = attempts.get(key);
        if (!limit || limit.reset <= Date.now()) limit = { count: 0, reset: Date.now() + 600000 };
        if (!attempts.has(key) && attempts.size >= 10000) fail(429, 'Sign-in is busy. Please try again shortly.');
        if (limit.count >= (key.startsWith('ip:') ? 100 : 10)) fail(429, 'Too many attempts. Try again in 10 minutes.');
        limit.count++; attempts.set(key, limit);
      }
      if (sessions.size >= 5000) fail(503, 'The chat is full.');
      if (session?.accountId && url.pathname.endsWith('/register')) fail(409, 'Sign out before creating another account.');
      const account = url.pathname.endsWith('/register') ? await accounts.create(input.username, input.password) : await accounts.authenticate(input.username, input.password);
      if ([...bans.values()].some(ban => ban.accountId === account.id)) fail(403, 'This account is banned.');
      if (session && sessions.get(token) !== session) fail(401, 'Your session changed. Please try again.');
      if (session?.accountId && session.accountId !== account.id) fail(409, 'Sign out before switching accounts.');
      if (!session) session = { id: randomUUID(), streams: new Set(), room: rooms[0]?.id, seen: Date.now(), sent: [] };
      attempts.delete(keys[1]);
      session.seen = Date.now();
      session.accountId = account.id; session.alias = account.username; session.displayAsAdmin = false;
      sessions.delete(token);
      const secret = randomBytes(32).toString('hex'); sessions.set(secret, session); cookie(secret);
      publishAppearance(session);
      for (const stream of session.streams) stream.end();
      json(publicSession(session)); return;
    }
    if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
      if (session) {
        sessions.delete(token); groups.removeUser(session.id); attachments.removeUser(session.id);
        for (const key of histories.keys()) if (key.startsWith('dm:') && key.includes(session.id)) histories.delete(key);
        for (const stream of session.streams) stream.end();
        presence(); publishRooms();
      }
      res.setHeader('Set-Cookie', 'silenza=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
      json({ ok: true }); return;
    }
    if (url.pathname === '/api/session' && req.method === 'GET') {
      if (!session) {
        if (sessions.size >= 5000) fail(503, 'The chat is full. Try again shortly.');
        const secret = randomBytes(32).toString('hex');
        session = { id: randomUUID(), alias: `${adjectives[Math.floor(Math.random()*adjectives.length)]} ${animals[Math.floor(Math.random()*animals.length)]} ${randomBytes(2).toString('hex')}`, streams: new Set(), room: rooms[0]?.id, seen: Date.now(), sent: [] };
        sessions.set(secret, session);
        cookie(secret);
      }
      session.seen = Date.now();
      const conversations = [...sessions.values()].filter(s => s.id !== session.id && histories.has(keyFor(session, null, s.id))).map(safeUser);
      json({ me: publicSession(session), rooms: roomList(), groups: groups.list(session), people: onlinePeople(session), conversations }); return;
    }
    if (!session) fail(401, 'Your anonymous session expired. Refresh to rejoin.');
    session.seen = Date.now();
    if (url.pathname === '/api/groups' || url.pathname.startsWith('/api/groups/')) {
      const action = url.pathname.slice('/api/groups'.length).replace(/^\//, '');
      const input = req.method === 'POST' ? await body(req, ['message', 'message-edit'].includes(action) ? 512000 : 32768) : Object.fromEntries(url.searchParams);
      // Recheck after reading the request, since a ban may occur during a slow upload.
      if (sessions.get(token) !== session) fail(403, 'This session is no longer available.');
      json(groups.handle(req.method, action, session, input)); return;
    }
    if (url.pathname === '/api/identity' && req.method === 'GET') {
      const peer = [...sessions.values()].find(s => s.id === url.searchParams.get('peer'));
      if (!peer?.publicKey) fail(409, 'This person has not enabled private encryption yet. They need to open or refresh SilenzaChat.');
      json({ id: peer.id, publicKey: peer.publicKey }); return;
    }
    if (url.pathname === '/api/attachments' && req.method === 'POST') {
      if (url.searchParams.has('group')) {
        const group = groups.get(url.searchParams.get('group')), version = Number(url.searchParams.get('version'));
        groups.member(group, session);
        if (!session.publicKey || version !== group.version) fail(409, 'Room membership changed. Try sending again.');
        if (req.headers['content-type'] !== 'application/octet-stream') fail(415, 'Upload encrypted image bytes only.');
        const uploaded = await attachments.upload(req, session.id, null, { group: group.id, version });
        if (sessions.get(token) !== session || groups.rooms.get(group.id) !== group || group.updated + 86400000 <= Date.now() || !group.members.has(session.id) || group.version !== version) {
          attachments.remove(uploaded.id); fail(409, 'Room membership changed during upload. Try sending again.');
        }
        json(uploaded); return;
      }
      const peer = [...sessions.values()].find(s => s.id === url.searchParams.get('peer'));
      if (!peer || peer.id === session.id) fail(404, 'That person is no longer available.');
      if (!session.publicKey || !peer.publicKey) fail(409, 'Both people need encryption identities before uploading.');
      if (req.headers['content-type'] !== 'application/octet-stream') fail(415, 'Upload encrypted image bytes only.');
      const uploaded = await attachments.upload(req, session.id, peer.id);
      // A ban or session expiry may have happened while reading the upload.
      if (sessions.get(token) !== session || ![...sessions.values()].includes(peer)) { attachments.remove(uploaded.id); fail(403, 'This private session is no longer available.'); }
      json(uploaded); return;
    }
    if (url.pathname.startsWith('/api/attachments/')) {
      const id = url.pathname.slice('/api/attachments/'.length), item = attachments.get(id, session.id);
      if (item.group && req.method === 'GET') groups.checkAttachment(item, session);
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': item.bytes.length, 'Cache-Control': 'no-store', 'Content-Disposition': 'attachment' }); res.end(item.bytes); return;
      }
      if (req.method === 'DELETE' && item.owner === session.id && !item.message) { attachments.remove(id); json({ ok: true }); return; }
      fail(403, 'That image cannot be removed here.');
    }
    if (url.pathname === '/api/events' && req.method === 'GET') {
      if (session.streams.size >= 6) fail(429, 'Too many open tabs.');
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(': connected\n\n'); session.streams.add(res); presence(); publishRooms(); emit(session, 'groups-changed', {});
      const timer = setInterval(() => { session.seen = Date.now(); res.write(': heartbeat\n\n'); }, 20000);
      res.on('close', () => { clearInterval(timer); session.streams.delete(res); presence(); publishRooms(); }); return;
    }
    if (url.pathname === '/api/history' && req.method === 'GET') {
      const peer = url.searchParams.get('peer'), room = url.searchParams.get('room');
      if (peer ? ![...sessions.values()].some(s => s.id === peer) : !rooms.some(r => r.id === room)) fail(404, 'Conversation is no longer available.');
      json(histories.get(keyFor(session, room, peer)) || []); return;
    }
    if (url.pathname === '/api/admin/feedback' && req.method === 'GET') {
      if (!isAdmin(session)) fail(403, 'Unlock admin controls first.');
      json(feedback); return;
    }
    if (url.pathname === '/api/admin/state' && req.method === 'GET') {
      if (!isAdmin(session)) fail(403, 'Unlock admin controls first.');
      json({ people: onlinePeople(session), bans: [...bans.values()].map(({ id, alias, bannedAt }) => ({ id, alias, bannedAt })), groups: groups.moderate('list', session) }); return;
    }
    if (req.method !== 'POST') fail(404, 'Not found.');
    const input = await body(req);
    if (sessions.get(token) !== session) fail(401, 'Your session has ended.');
    if (url.pathname === '/api/feedback') {
      if (sessions.get(token) !== session) fail(403, 'This session is no longer available.');
      const title = typeof input.title === 'string' ? input.title.trim() : '';
      const text = typeof input.text === 'string' ? input.text.trim() : '';
      if (!title || title.length > 120 || !text || text.length > 5000) fail(400, 'Add a title (up to 120 characters) and feedback (up to 5,000 characters).');
      session.feedbackSent = (session.feedbackSent || []).filter(time => Date.now() - time < 600000);
      if (session.feedbackSent.length >= 3) fail(429, 'You have sent several messages. Please wait 10 minutes before sending more feedback.');
      const attempt = Date.now(); session.feedbackSent.push(attempt);
      const item = { id: randomUUID(), title, text, createdAt: new Date().toISOString(), reviewed: false };
      try {
        await saveFeedback(items => {
          if (items.length >= 1000) fail(503, 'The feedback inbox is full. Please try again later.');
          return [item, ...items];
        });
      } catch (e) { session.feedbackSent.splice(session.feedbackSent.indexOf(attempt), 1); throw e; }
      json({ ok: true }, 201); return;
    }
    if (url.pathname === '/api/identity') {
      const bytes = base64Bytes(input.publicKey, 32);
      if (!bytes || nacl.scalarMult(new Uint8Array(32).fill(42), bytes).every(x => x === 0)) fail(400, 'Invalid public encryption key.');
      if (session.publicKey && session.publicKey !== input.publicKey) fail(409, 'Your local encryption key does not match this session. Start a new browser session to chat privately.');
      const first = !session.publicKey; session.publicKey = input.publicKey;
      if (first) broadcast('identity-ready', { id: session.id });
      json({ ok: true }); return;
    }
    if (url.pathname === '/api/join') {
      if (!rooms.some(r => r.id === input.room)) fail(404, 'Room no longer exists.');
      session.room = input.room; publishRooms(); json({ ok: true }); return;
    }
    if (url.pathname === '/api/message/edit') {
      if (sessions.get(token) !== session) fail(403, 'This session is no longer available.');
      let message, history;
      for (const items of histories.values()) {
        const found = items.find(m => m.id === input.id && m.sender === session.id);
        if (found) { message = found; history = items; break; }
      }
      if (!message) fail(404, 'Your message is no longer available to edit.');
      if (input.editVersion !== (message.editVersion || 0) + 1) fail(409, 'This message changed. Reopen the editor and try again.');
      session.sent = session.sent.filter(t => Date.now() - t < 10000);
      if (session.sent.length >= 8) fail(429, 'Take a breath. Try again in a few seconds.');
      if (message.encrypted) {
        if (Object.keys(input).some(k => !['id', 'editVersion', 'encrypted'].includes(k))) fail(400, 'Private edits must contain ciphertext only.');
        const box = input.encrypted;
        if (!box || box.v !== 1 || Object.keys(box).some(k => !['v', 'nonce', 'ciphertext'].includes(k)) ||
            !base64Bytes(box.nonce, 24) || !base64Bytes(box.ciphertext, null, 18000)) fail(400, 'Invalid encrypted private message.');
        message.encrypted = box;
      } else {
        if (Object.keys(input).some(k => !['id', 'editVersion', 'text'].includes(k))) fail(400, 'Invalid message edit.');
        const text = typeof input.text === 'string' ? input.text.trim() : '';
        if (!text || text.length > 2000) fail(400, 'Use between 1 and 2,000 characters.');
        message.text = text; message.mentions = publicMentions(text);
        for (const reply of history) if (reply.reply?.id === message.id) reply.reply.text = text.slice(0, 200);
      }
      message.editVersion = input.editVersion; message.editedAt = new Date().toISOString();
      session.sent.push(Date.now());
      if (message.room) { broadcast('message-edited', message); publishRooms(); }
      else for (const person of sessions.values()) if ([message.sender, message.recipient].includes(person.id)) emit(person, 'message-edited', message);
      json(message); return;
    }
    if (url.pathname === '/api/message') {
      session.sent = session.sent.filter(t => Date.now() - t < 10000);
      if (session.sent.length >= 8) fail(429, 'Take a breath. Try again in a few seconds.');
      if (input.peer) {
        const peer = [...sessions.values()].find(s => s.id === input.peer);
        if (!peer || peer.id === session.id) fail(404, 'That person is no longer available.');
        if (!session.publicKey || !peer.publicKey) fail(409, 'Private encryption is not ready.');
        if (Object.keys(input).some(key => !['peer', 'id', 'encrypted', 'replyTo', 'attachmentId'].includes(key))) fail(400, 'Private messages must contain ciphertext only.');
        const box = input.encrypted;
        if (!box || box.v !== 1 || Object.keys(box).some(k => !['v', 'nonce', 'ciphertext'].includes(k)) ||
            !base64Bytes(box.nonce, 24) || !base64Bytes(box.ciphertext, null, 18000) ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input.id || '')) fail(400, 'Invalid encrypted private message.');
        const key = keyFor(session, null, peer.id), history = histories.get(key) || [];
        const duplicate = history.find(m => m.id === input.id);
        if (duplicate) {
          if (duplicate.sender !== session.id || JSON.stringify(duplicate.encrypted) !== JSON.stringify(box) || (duplicate.reply?.id || null) !== (input.replyTo || null) || (duplicate.attachment?.id || null) !== (input.attachmentId || null)) fail(409, 'Message ID already used.');
          json(duplicate); return;
        }
        const original = input.replyTo == null ? null : history.find(m => m.id === input.replyTo);
        if (input.replyTo != null && !original) fail(400, 'That reply is no longer available in this conversation.');
        const attachment = input.attachmentId == null ? null : attachments.claim(input.attachmentId, session.id, peer.id, input.id);
        const message = { id: input.id, sender: session.id, alias: session.alias, recipient: peer.id, room: null,
          time: new Date().toISOString(), displayAsAdmin: displaysAsAdmin(session), encrypted: box, reply: original ? { id: original.id } : null, attachment };
        session.sent.push(Date.now());
        if (history.length >= 100) attachments.remove(history[0].attachment?.id);
        histories.set(key, [...history, message].slice(-100));
        emit(session, 'message', message); emit(peer, 'message', message); json(message); return;
      }
      if (input.encrypted || input.attachmentId) fail(400, 'Encrypted attachments belong in private conversations.');
      const text = typeof input.text === 'string' ? input.text.trim() : '';
      if (!text || text.length > 2000) fail(400, 'Use between 1 and 2,000 characters.');
      const peer = input.peer && [...sessions.values()].find(s => s.id === input.peer);
      if (input.peer && (!peer || peer.id === session.id)) fail(404, 'That person is no longer available.');
      if (!input.peer && !rooms.some(r => r.id === input.room)) fail(404, 'Room no longer exists.');
      const key = keyFor(session, input.room, peer?.id);
      const original = input.replyTo == null ? null : (histories.get(key) || []).find(m => m.id === input.replyTo);
      if (input.replyTo != null && !original) fail(400, 'That reply is no longer available in this conversation.');
      const mentions = publicMentions(text);
      session.sent.push(Date.now());
      const message = { id: randomUUID(), sender: session.id, alias: session.alias, displayAsAdmin: displaysAsAdmin(session), text, time: new Date().toISOString(), room: peer ? null : input.room, recipient: peer?.id || null, mentions,
        reply: original ? { id: original.id, alias: original.alias, text: original.text.slice(0, 200) } : null };
      histories.set(key, [...(histories.get(key) || []), message].slice(-100));
      if (peer) { emit(session, 'message', message); emit(peer, 'message', message); }
      else { broadcast('message', message); publishRooms(); }
      json(message); return;
    }
    if (url.pathname.startsWith('/api/admin/') && !isAdmin(session)) fail(403, 'Unlock admin controls first.');
    if (url.pathname === '/api/admin/groups/update' || url.pathname === '/api/admin/groups/delete') {
      json(groups.moderate(url.pathname.split('/').pop(), session, input)); return;
    }
    if (url.pathname === '/api/admin/feedback/update' || url.pathname === '/api/admin/feedback/delete') {
      const removing = url.pathname.endsWith('/delete');
      if (!removing && typeof input.reviewed !== 'boolean') fail(400, 'Choose a feedback status.');
      await saveFeedback(items => {
        if (!items.some(item => item.id === input.id)) fail(404, 'Feedback no longer exists.');
        return removing ? items.filter(item => item.id !== input.id) : items.map(item => item.id === input.id ? { ...item, reviewed: input.reviewed } : item);
      });
      json({ ok: true }); return;
    }
    if (url.pathname === '/api/admin/appearance') {
      if (typeof input.displayAsAdmin !== 'boolean') fail(400, 'Choose whether to display as admin.');
      session.displayAsAdmin = input.displayAsAdmin;
      publishAppearance(session); json(publicSession(session)); return;
    }
    if (url.pathname === '/api/admin/create') {
      const name = typeof input.name === 'string' ? input.name.trim() : '';
      const description = typeof input.description === 'string' ? input.description.trim() : '';
      if (!name || name.length > 40 || description.length > 120) fail(400, 'Room names must be 1–40 characters; descriptions up to 120.');
      const room = { id: randomUUID(), name, description };
      await saveRooms(existing => {
        if (existing.length >= 30) fail(400, 'Maximum of 30 rooms reached.');
        if (existing.some(r => r.name.toLowerCase() === name.toLowerCase())) fail(400, 'That room name is already in use.');
        return [...existing, room];
      }); publishRooms(); json(room); return;
    }
    if (url.pathname === '/api/admin/delete') {
      await saveRooms(existing => {
        if (!existing.some(r => r.id === input.id)) fail(404, 'Room no longer exists.');
        return existing.filter(r => r.id !== input.id);
      }); histories.delete(`room:${input.id}`);
      for (const s of sessions.values()) if (s.room === input.id) s.room = rooms[0]?.id;
      publishRooms(); json({ ok: true }); return;
    }
    if (url.pathname === '/api/admin/ban') {
      const target = [...sessions.entries()].find(([, s]) => s.id === input.id);
      if (!target) fail(404, 'That person is no longer available.');
      if (target[1].id === session.id || (session.accountId && target[1].accountId === session.accountId)) fail(400, 'You cannot ban your own session.');
      const [targetToken, person] = target;
      const key = hash(targetToken).toString('hex');
      bans.set(key, { key, id: person.id, alias: person.alias, accountId: person.accountId, bannedAt: new Date().toISOString() });
      try { await saveBans(); } catch (error) { bans.delete(key); throw error; }
      for (const stream of person.streams) stream.end();
      for (const [secret, s] of sessions) if (secret === targetToken || (person.accountId && s.accountId === person.accountId)) {
        sessions.delete(secret); groups.removeUser(s.id); attachments.removeUser(s.id); for (const stream of s.streams) stream.end();
      } presence(); publishRooms(); broadcast('moderation', {});
      json({ ok: true }); return;
    }
    if (url.pathname === '/api/admin/unban') {
      const entries = [...bans.entries()].filter(([, ban]) => ban.id === input.id);
      if (!entries.length) fail(404, 'That ban no longer exists.');
      for (const [key] of entries) bans.delete(key);
      try { await saveBans(); } catch (error) { for (const [key, ban] of entries) bans.set(key, ban); throw error; }
      broadcast('moderation', {});
      json({ ok: true }); return;
    }
    if (url.pathname === '/api/message/delete' || url.pathname === '/api/admin/remove-message') {
      const adminRemoval = url.pathname === '/api/admin/remove-message';
      let found, conversation;
      for (const [key, history] of histories) {
        const message = history.find(m => m.id === input.id && (adminRemoval || m.sender === session.id));
        if (message) { found = message; conversation = key; break; }
      }
      if (!found) fail(404, 'That message is unavailable or does not belong to you.');
      attachments.remove(found.attachment?.id);
      const remaining = histories.get(conversation).filter(message => message.id !== found.id);
      for (const message of remaining) if (message.reply?.id === found.id) message.reply = { id: found.id, removed: true };
      histories.set(conversation, remaining);
      const removed = { id: found.id, room: found.room, sender: found.sender, recipient: found.recipient };
      if (found.room) { broadcast('message-removed', removed); publishRooms(); }
      else for (const s of sessions.values()) if (s.id === found.sender || s.id === found.recipient) emit(s, 'message-removed', removed);
      json(removed); return;
    }
    fail(404, 'Not found.');
  } catch (error) { if (!res.headersSent) json({ error: error.status ? error.message : 'Something went wrong. Please try again.' }, error.status || 500); else res.end(); }
});
setInterval(() => {

  for (const [token, s] of sessions) if (!online(s) && Date.now() - s.seen > 86400000) {
    sessions.delete(token); groups.removeUser(s.id); attachments.removeUser(s.id); for (const key of histories.keys()) if (key.startsWith('dm:') && key.includes(s.id)) histories.delete(key);
  }
  attachments.sweep();
  groups.sweep();
  for (const [ip, a] of attempts) if (Date.now() > a.reset) attempts.delete(ip);
}, 60000).unref();
server.listen(Number(process.env.PORT || 3000), process.env.HOST || '127.0.0.1', () => {
  console.log(`SilenzaChat is running at ${process.env.ORIGIN || `http://localhost:${process.env.PORT || 3000}`}`);
});
