import http from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

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
async function body(req) {
  let text = '';
  for await (const chunk of req) { text += chunk; if (Buffer.byteLength(text) > 8192) fail(413, 'That request is too large.'); }
  try { return JSON.parse(text); } catch { fail(400, 'Invalid request.'); }
}
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  const json = (data, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
  try {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/')) {
      const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
      if (req.method !== 'GET' || !files[url.pathname]) fail(404, 'Not found.');
      const [file, type] = files[url.pathname];
      res.writeHead(200, { 'Content-Type': type }); res.end(await readFile(path.join(root, 'public', file))); return;
    }
    const origin = process.env.ORIGIN || `http://${req.headers.host}`;
    if (req.headers.origin && req.headers.origin !== origin) fail(403, 'Request origin is not allowed.');
    if (req.method !== 'GET' && req.headers.origin !== origin) fail(403, 'Request origin is not allowed.');
    const token = req.headers.cookie?.split(';').map(x => x.trim()).find(x => x.startsWith('hush='))?.slice(5);
    let session = sessions.get(token);
    if (url.pathname === '/api/session' && req.method === 'GET') {
      if (!session) {
        if (sessions.size >= 5000) fail(503, 'The chat is full. Try again shortly.');
        const secret = randomBytes(32).toString('hex');
        session = { id: randomUUID(), alias: `${adjectives[Math.floor(Math.random()*adjectives.length)]} ${animals[Math.floor(Math.random()*animals.length)]} ${randomBytes(2).toString('hex')}`, streams: new Set(), room: rooms[0]?.id, seen: Date.now(), adminUntil: 0, sent: [] };
        sessions.set(secret, session);
        res.setHeader('Set-Cookie', `hush=${secret}; HttpOnly; SameSite=Strict; Path=/${process.env.SECURE_COOKIES === 'true' ? '; Secure' : ''}`);
      }
      session.seen = Date.now();
      const conversations = [...sessions.values()].filter(s => s.id !== session.id && histories.has(keyFor(session, null, s.id))).map(safeUser);
      json({ me: publicSession(session), rooms: roomList(), people: [...sessions.values()].filter(online).map(safeUser), conversations }); return;
    }
    if (!session) fail(401, 'Your anonymous session expired. Refresh to rejoin.');
    session.seen = Date.now();
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
    if (req.method !== 'POST') fail(404, 'Not found.');
    const input = await body(req);
    if (url.pathname === '/api/join') {
      if (!rooms.some(r => r.id === input.room)) fail(404, 'Room no longer exists.');
      session.room = input.room; publishRooms(); json({ ok: true }); return;
    }
    if (url.pathname === '/api/message') {
      session.sent = session.sent.filter(t => Date.now() - t < 10000);
      if (session.sent.length >= 8) fail(429, 'Take a breath. Try again in a few seconds.');
      const text = typeof input.text === 'string' ? input.text.trim() : '';
      if (!text || text.length > 2000) fail(400, 'Use between 1 and 2,000 characters.');
      const peer = input.peer && [...sessions.values()].find(s => s.id === input.peer);
      if (input.peer && (!peer || peer.id === session.id)) fail(404, 'That person is no longer available.');
      if (!input.peer && !rooms.some(r => r.id === input.room)) fail(404, 'Room no longer exists.');
      session.sent.push(Date.now());
      const message = { id: randomUUID(), sender: session.id, alias: session.alias, text, time: new Date().toISOString(), room: peer ? null : input.room, recipient: peer?.id || null };
      const key = keyFor(session, input.room, peer?.id);
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
    fail(404, 'Not found.');
  } catch (error) { if (!res.headersSent) json({ error: error.status ? error.message : 'Something went wrong. Please try again.' }, error.status || 500); else res.end(); }
});
setInterval(() => {
  for (const [token, s] of sessions) if (!online(s) && Date.now() - s.seen > 86400000) {
    sessions.delete(token); for (const key of histories.keys()) if (key.startsWith('dm:') && key.includes(s.id)) histories.delete(key);
  }
  for (const [ip, a] of attempts) if (Date.now() > a.reset) attempts.delete(ip);
}, 60000).unref();
server.listen(Number(process.env.PORT || 3000), process.env.HOST || '127.0.0.1', () => {
  console.log(`Hushroom is running at ${process.env.ORIGIN || `http://localhost:${process.env.PORT || 3000}`}`);
  if (!process.env.ADMIN_PASSWORD) console.log(`Temporary admin password: ${password}`);
});
