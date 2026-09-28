import http from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import nacl from 'tweetnacl';
import { Attachments } from './lib/attachments.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || path.join(root, 'data');
await mkdir(dataDir, { recursive: true });
let rooms;
try { rooms = JSON.parse(await readFile(path.join(dataDir, 'rooms.json'), 'utf8')); }
catch (e) { if (e.code !== 'ENOENT') throw e; rooms = [
  { id: 'the-living-room', name: 'The living room', description: 'A little company. A good conversation.' },
  { id: 'after-hours', name: 'After hours', description: 'For night owls and wandering thoughts.' },
  { id: 'creative-corner', name: 'Creative corner', description: 'Ideas, works in progress, and happy accidents.' }
]; }
let bans;
try { bans = new Map(JSON.parse(await readFile(path.join(dataDir, 'bans.json'), 'utf8')).map(ban => [ban.key, ban])); }
catch (e) { if (e.code !== 'ENOENT') throw e; bans = new Map(); }
const attachmentTTL = Number(process.env.ATTACHMENT_TTL_SECONDS || 86400) * 1000;
if (!Number.isFinite(attachmentTTL) || attachmentTTL < 1000 || attachmentTTL > 86400000) throw new Error('ATTACHMENT_TTL_SECONDS must be between 1 and 86400.');
const attachments = new Attachments({ ttl: attachmentTTL });
const sessions = new Map(), histories = new Map(), attempts = new Map();
const password = process.env.ADMIN_PASSWORD || randomBytes(18).toString('base64url');
const hash = value => createHash('sha256').update(value).digest();
const adjectives = ['Velvet', 'Quiet', 'Cosmic', 'Silver', 'Mellow', 'Amber', 'Lunar'];
const animals = ['Fox', 'Otter', 'Owl', 'Panda', 'Moth', 'Lynx', 'Finch'];
const online = s => s.streams.size > 0;
const safeUser = s => ({ id: s.id, alias: s.alias, online: online(s) });
const emit = (s, event, data) => { for (const stream of s.streams) {
  if (stream.writableLength > 256000) { stream.destroy(); continue; }
  stream.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
} };
const broadcast = (event, data) => { for (const s of sessions.values()) emit(s, event, data); };
const presence = () => broadcast('people', [...sessions.values()].filter(online).map(safeUser));
const roomList = () => rooms.map(r => ({ ...r, count: [...sessions.values()].filter(s => online(s) && s.room === r.id).length }));
const publishRooms = () => broadcast('rooms', roomList());
const publicSession = s => ({ ...safeUser(s), admin: s.adminUntil > Date.now() });
const keyFor = (s, room, peer) => peer ? `dm:${[s.id, peer].sort().join(':')}` : `room:${room}`;
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
function fail(status, message) { throw Object.assign(new Error(message), { status }); }
function base64Bytes(value, length, maximum = length) {
  if (typeof value !== 'string' || value.length > 24000) return null;
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value || (length !== null ? bytes.length !== length : bytes.length < 17 || bytes.length > maximum)) return null;
  return bytes;
}
async function body(req) {
  let text = '';
  for await (const chunk of req) { text += chunk; if (Buffer.byteLength(text) > 32768) fail(413, 'That request is too large.'); }
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
      const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/crypto.js': ['crypto.js', 'text/javascript'], '/private.js': ['private.js', 'text/javascript'], '/vendor/nacl.js': ['../node_modules/tweetnacl/nacl-fast.min.js', 'text/javascript'], '/theme.js': ['theme.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
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
    if (url.pathname === '/api/session' && req.method === 'GET') {
      if (!session) {
        if (sessions.size >= 5000) fail(503, 'The chat is full. Try again shortly.');
        const secret = randomBytes(32).toString('hex');
        session = { id: randomUUID(), alias: `${adjectives[Math.floor(Math.random()*adjectives.length)]} ${animals[Math.floor(Math.random()*animals.length)]} ${randomBytes(2).toString('hex')}`, streams: new Set(), room: rooms[0]?.id, seen: Date.now(), adminUntil: 0, sent: [] };
        sessions.set(secret, session);
        res.setHeader('Set-Cookie', `silenza=${secret}; HttpOnly; SameSite=Strict; Path=/${process.env.SECURE_COOKIES === 'true' ? '; Secure' : ''}`);
      }
      session.seen = Date.now();
      const conversations = [...sessions.values()].filter(s => s.id !== session.id && histories.has(keyFor(session, null, s.id))).map(safeUser);
      json({ me: publicSession(session), rooms: roomList(), people: [...sessions.values()].filter(online).map(safeUser), conversations }); return;
    }
    if (!session) fail(401, 'Your anonymous session expired. Refresh to rejoin.');
    session.seen = Date.now();
    if (url.pathname === '/api/identity' && req.method === 'GET') {
      const peer = [...sessions.values()].find(s => s.id === url.searchParams.get('peer'));
      if (!peer?.publicKey) fail(409, 'This person has not enabled private encryption yet. They need to open or refresh SilenzaChat.');
      json({ id: peer.id, publicKey: peer.publicKey }); return;
    }
    if (url.pathname === '/api/attachments' && req.method === 'POST') {
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
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': item.bytes.length, 'Cache-Control': 'no-store', 'Content-Disposition': 'attachment' }); res.end(item.bytes); return;
      }
      if (req.method === 'DELETE' && item.owner === session.id && !item.message) { attachments.remove(id); json({ ok: true }); return; }
      fail(403, 'That image cannot be removed here.');
    }
    if (url.pathname === '/api/events' && req.method === 'GET') {
      if (session.streams.size >= 6) fail(429, 'Too many open tabs.');
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(': connected\n\n'); session.streams.add(res); presence(); publishRooms();
      const timer = setInterval(() => { session.seen = Date.now(); res.write(': heartbeat\n\n'); }, 20000);
      res.on('close', () => { clearInterval(timer); session.streams.delete(res); presence(); publishRooms(); }); return;
    }
    if (url.pathname === '/api/history' && req.method === 'GET') {
      const peer = url.searchParams.get('peer'), room = url.searchParams.get('room');
      if (peer ? ![...sessions.values()].some(s => s.id === peer) : !rooms.some(r => r.id === room)) fail(404, 'Conversation is no longer available.');
      json(histories.get(keyFor(session, room, peer)) || []); return;
    }
    if (url.pathname === '/api/admin/state' && req.method === 'GET') {
      if (session.adminUntil <= Date.now()) fail(403, 'Unlock admin controls first.');
      json({ people: [...sessions.values()].filter(online).map(safeUser), bans: [...bans.values()].map(({ id, alias, bannedAt }) => ({ id, alias, bannedAt })) }); return;
    }
    if (req.method !== 'POST') fail(404, 'Not found.');
    const input = await body(req);
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
          time: new Date().toISOString(), encrypted: box, reply: original ? { id: original.id } : null, attachment };
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
      const mentions = [];
      const candidates = [...sessions.values()].filter(s => !peer || s.id === session.id || s.id === peer.id);
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
      session.sent.push(Date.now());
      const message = { id: randomUUID(), sender: session.id, alias: session.alias, text, time: new Date().toISOString(), room: peer ? null : input.room, recipient: peer?.id || null, mentions,
        reply: original ? { id: original.id, alias: original.alias, text: original.text.slice(0, 200) } : null };
      histories.set(key, [...(histories.get(key) || []), message].slice(-100));
      if (peer) { emit(session, 'message', message); emit(peer, 'message', message); }
      else broadcast('message', message);
      json(message); return;
    }
    if (url.pathname === '/api/admin/login') {
      const address = req.socket.remoteAddress;
      const limit = attempts.get(address) || { count: 0, reset: Date.now() + 600000 };
      if (Date.now() > limit.reset) { limit.count = 0; limit.reset = Date.now() + 600000; }
      if (limit.count >= 5) fail(429, 'Too many attempts. Try again in 10 minutes.');
      limit.count++; attempts.set(address, limit);
      if (typeof input.password !== 'string' || !timingSafeEqual(hash(input.password), hash(password))) fail(403, 'Incorrect admin password.');
      attempts.delete(address); session.adminUntil = Date.now() + 3600000; json({ ok: true }); return;
    }
    if (url.pathname === '/api/admin/logout') { session.adminUntil = 0; json({ ok: true }); return; }
    if (url.pathname.startsWith('/api/admin/') && session.adminUntil <= Date.now()) fail(403, 'Unlock admin controls first.');
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
      if (target[1].id === session.id) fail(400, 'You cannot ban your own session.');
      const [targetToken, person] = target;
      const key = hash(targetToken).toString('hex');
      bans.set(key, { key, id: person.id, alias: person.alias, bannedAt: new Date().toISOString() });
      try { await saveBans(); } catch (error) { bans.delete(key); throw error; }
      for (const stream of person.streams) stream.end();
      sessions.delete(targetToken); attachments.removeUser(person.id); presence(); publishRooms(); broadcast('moderation', {});
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
      if (found.room) broadcast('message-removed', removed);
      else for (const s of sessions.values()) if (s.id === found.sender || s.id === found.recipient) emit(s, 'message-removed', removed);
      json(removed); return;
    }
    fail(404, 'Not found.');
  } catch (error) { if (!res.headersSent) json({ error: error.status ? error.message : 'Something went wrong. Please try again.' }, error.status || 500); else res.end(); }
});
setInterval(() => {
  for (const [token, s] of sessions) if (!online(s) && Date.now() - s.seen > 86400000) {
    sessions.delete(token); attachments.removeUser(s.id); for (const key of histories.keys()) if (key.startsWith('dm:') && key.includes(s.id)) histories.delete(key);
  }
  attachments.sweep();
  for (const [ip, a] of attempts) if (Date.now() > a.reset) attempts.delete(ip);
}, 60000).unref();
server.listen(Number(process.env.PORT || 3000), process.env.HOST || '127.0.0.1', () => {
  console.log(`SilenzaChat is running at ${process.env.ORIGIN || `http://localhost:${process.env.PORT || 3000}`}`);
  if (!process.env.ADMIN_PASSWORD) console.log(`Temporary admin password: ${password}`);
});
