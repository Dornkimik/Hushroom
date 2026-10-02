import test from 'node:test';
import assert from 'node:assert/strict';
import nacl from 'tweetnacl';
import attachments from '../public/attachments.js';
import crypto from '../public/crypto.js';

// Synthetic files with planted metadata. The sanitizers must remove every SECRET while keeping
// the bytes a decoder needs, without decoding or re-encoding any pixels or samples.
const SECRET = 'SECRET-LOCATION';
const bytes = (...parts) => new Uint8Array(Buffer.concat(parts.map(part => typeof part === 'string' ? Buffer.from(part, 'latin1') : Buffer.from(part))));
const u16 = n => [n >> 8, n & 255], u32 = n => [n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255];
const le16 = n => [n & 255, n >> 8], le32 = n => [n & 255, (n >> 8) & 255, (n >> 16) & 255, n >>> 24];
const has = (data, value) => Buffer.from(data).includes(typeof value === 'string' ? Buffer.from(value, 'latin1') : Buffer.from(value));
const cleaned = (data, declared) => {
  const result = attachments.clean(data, declared);
  // Sanitizing is idempotent and never changes the detected format.
  assert.deepEqual(attachments.clean(result.bytes, declared), { ...result, bytes: result.bytes });
  return result;
};

test('JPEG keeps decoding data and orientation, and drops EXIF, ICC, comments, thumbnails and trailers', () => {
  const segment = (marker, payload) => bytes([0xFF, marker], u16(payload.length + 2), payload);
  const tiff = bytes('MM', [0, 42], u32(8), u16(2), u16(0x0112), u16(3), u32(1), u16(6), [0, 0], u16(0x8825), u16(4), u32(1), u32(0), u32(0), SECRET);
  const decoding = [segment(0xDB, bytes([0], new Array(64).fill(1))), segment(0xC0, bytes([8], u16(2), u16(3), [1, 1, 0x11, 0])), segment(0xDA, bytes([1, 1, 0, 0, 63, 0])), bytes([0x12, 0xFF, 0x00, 0x34, 0xFF, 0xD0, 0x56])];
  const original = bytes([0xFF, 0xD8], segment(0xE0, bytes('JFIF\0', [1, 2, 0, 0, 1, 0, 1, 2, 2], new Array(12).fill(9))), segment(0xE1, bytes('Exif\0\0', tiff)),
    segment(0xE2, bytes('ICC_PROFILE\0', SECRET)), segment(0xED, bytes('Photoshop 3.0\0', SECRET)), segment(0xFE, bytes(SECRET)), ...decoding, [0xFF, 0xD9], SECRET);
  const result = cleaned(original);
  assert.deepEqual([result.kind, result.type], ['image', 'image/jpeg']);
  const orientation = bytes([0xFF, 0xE1, 0, 34], 'Exif\0\0', 'MM', [0, 42], u32(8), u16(1), u16(0x0112), u16(3), u32(1), u16(6), [0, 0], u32(0));
  assert.deepEqual(result.bytes, bytes([0xFF, 0xD8], segment(0xE0, bytes('JFIF\0', [1, 2, 0, 0, 1, 0, 1, 0, 0])), orientation, ...decoding, [0xFF, 0xD9]));
  assert.ok(!has(result.bytes, SECRET));
  assert.equal(attachments.matches(result.bytes, 'image/jpeg'), true);
  assert.equal(attachments.displayable(result.bytes, 'image/jpeg'), true);
  assert.throws(() => attachments.clean(bytes([0xFF, 0xD8, 0xFF, 0xE0, 0, 40, 1, 2])), /damaged/);
});

test('PNG and GIF keep only rendering chunks and blocks', () => {
  const chunk = (type, data = []) => bytes(u32(bytes(data).length), type, data, [1, 2, 3, 4]);
  const signature = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A], ihdr = chunk('IHDR', bytes(u32(2), u32(3), [8, 6, 0, 0, 0]));
  const idat = chunk('IDAT', [1, 2, 3]), iend = chunk('IEND');
  const png = bytes(signature, ihdr, chunk('tEXt', bytes('Comment\0', SECRET)), chunk('eXIf', SECRET), chunk('iCCP', SECRET), idat, chunk('tIME', [7, 230, 1, 1, 0, 0, 0]), iend, SECRET);
  const cleanPng = cleaned(png);
  assert.deepEqual(cleanPng.bytes, bytes(signature, ihdr, idat, iend));
  assert.equal(attachments.displayable(cleanPng.bytes, 'image/png'), true);
  assert.equal(attachments.displayable(bytes(signature, chunk('IHDR', bytes(u32(10000), u32(10000), [8, 6, 0, 0, 0]))), 'image/png'), false);

  const header = bytes('GIF89a', le16(2), le16(3), [0x80, 0, 0], [0, 0, 0, 255, 255, 255]);
  const loop = bytes([0x21, 0xFF, 11], 'NETSCAPE2.0', [3, 1, 0, 0, 0]), timing = bytes([0x21, 0xF9, 4, 0, 10, 0, 0, 0]);
  const frame = bytes([0x2C, 0, 0, 0, 0, 2, 0, 3, 0, 0, 2, 2, 0x4C, 1, 0]);
  const gif = bytes(header, [0x21, 0xFE, SECRET.length], SECRET, [0], [0x21, 0xFF, 11], 'XMP DataXMP', [SECRET.length], SECRET, [0], loop, timing, frame, [0x3B], SECRET);
  const cleanGif = cleaned(gif);
  assert.deepEqual(cleanGif.bytes, bytes(header, loop, timing, frame, [0x3B]));
  assert.deepEqual([cleanGif.kind, cleanGif.type], ['image', 'image/gif']);
});

test('RIFF formats drop metadata chunks and fix their headers', () => {
  const chunk = (id, data) => { const body = bytes(data); return bytes(id, le32(body.length), body, body.length & 1 ? [0] : []); };
  const riff = (form, ...chunks) => { const body = bytes(...chunks); return bytes('RIFF', le32(body.length + 4), form, body); };
  const vp8x = flags => chunk('VP8X', [flags, 0, 0, 0, 1, 0, 0, 2, 0, 0]), vp8l = chunk('VP8L', [0x2F, 1, 0, 0, 0]);
  const webp = cleaned(riff('WEBP', vp8x(0x2C | 0x10), chunk('ICCP', SECRET), vp8l, chunk('EXIF', SECRET), chunk('XMP ', SECRET)));
  assert.deepEqual(webp.bytes, riff('WEBP', vp8x(0x10), vp8l));
  assert.equal(attachments.displayable(webp.bytes, 'image/webp'), true);

  const fmt = chunk('fmt ', [1, 0, 1, 0, 0x44, 0xAC, 0, 0, 0x88, 0x58, 1, 0, 2, 0, 16, 0]), data = chunk('data', [1, 2, 3, 4]);
  const wav = cleaned(riff('WAVE', fmt, chunk('LIST', bytes('INFO', SECRET)), chunk('id3 ', SECRET), data));
  assert.deepEqual([wav.kind, wav.type], ['audio', 'audio/wav']);
  assert.deepEqual(wav.bytes, riff('WAVE', fmt, data));
});

test('MP4, MOV and M4A metadata boxes are blanked in place without moving media data', () => {
  const box = (type, ...payload) => { const body = bytes(...payload); return bytes(u32(body.length + 8), type, body); };
  const handler = box('hdlr', [0, 0, 0, 0], u32(0), 'vide', new Array(12).fill(0), 'Core Media Video', [0]);
  const moov = box('moov', box('mvhd', [0, 0, 0, 0], u32(0xDEADBEEF), u32(0xCAFEBABE), u32(1000), u32(5000), new Array(80).fill(0)),
    box('udta', box(String.fromCharCode(0xA9) + 'xyz', SECRET), box('cprt', SECRET)),
    box('trak', box('tkhd', [0, 0, 0, 1], u32(0xDEADBEEF), u32(0xCAFEBABE), new Array(72).fill(0)),
      box('mdia', box('mdhd', [1, 0, 0, 0], u32(0), u32(0xDEADBEEF), u32(0), u32(0xCAFEBABE), u32(1000), u32(0), u32(5000), [0, 0, 0, 0]), handler, box('minf', box('stbl'))),
      box('meta', [0, 0, 0, 0], box('ilst', SECRET))));
  const file = brand => bytes(box('ftyp', brand, u32(512), 'isommp42'), moov, box('uuid', new Array(16).fill(7), SECRET), box('mdat', 'MEDIA-SAMPLES'));
  const original = file('isom'), result = cleaned(original);
  assert.deepEqual([result.kind, result.type], ['video', 'video/mp4']);
  assert.equal(result.bytes.length, original.length);
  assert.equal(Buffer.from(result.bytes).indexOf('MEDIA-SAMPLES'), Buffer.from(original).indexOf('MEDIA-SAMPLES'));
  for (const value of [SECRET, 'Core Media', 'udta', 'meta', 'uuid', [0xDE, 0xAD, 0xBE, 0xEF], [0xCA, 0xFE, 0xBA, 0xBE]]) assert.ok(!has(result.bytes, value), value);
  assert.ok(has(result.bytes, u32(1000)) && has(result.bytes, 'vide'));
  assert.equal(original.length, file('isom').length); // The caller's bytes are not modified.
  assert.ok(has(original, SECRET));
  assert.equal(attachments.clean(file('qt  ')).type, 'video/quicktime');
  assert.deepEqual([attachments.clean(file('M4A ')).kind, attachments.clean(file('M4A ')).type], ['audio', 'audio/mp4']);
  assert.equal(attachments.clean(file('mp42'), 'audio/x-m4a').type, 'audio/mp4');
  // HEIF/AVIF images keep their EXIF in a different place; they are sent only as generic files.
  assert.equal(attachments.clean(file('heic')), null);
  assert.equal(attachments.matches(file('avif'), 'video/mp4'), false);
  assert.throws(() => attachments.clean(bytes(box('ftyp', 'isom'), u32(9999), 'moov')), /damaged/);
});

test('WebM metadata is voided in place, including live recordings with unknown sizes', () => {
  const size = n => n < 127 ? [0x80 | n] : [0x40 | (n >> 8), n & 255];
  const el = (id, ...payload) => { const body = bytes(...payload); return bytes(id, size(body.length), body); };
  const unknown = [0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF];
  const webm = (docType, trackType) => bytes(el([0x1A, 0x45, 0xDF, 0xA3], el([0x42, 0x82], docType)), [0x18, 0x53, 0x80, 0x67], unknown,
    el([0x15, 0x49, 0xA9, 0x66], el([0xBF], [1, 2, 3, 4]), el([0x2A, 0xD7, 0xB1], [0x0F, 0x42, 0x40]), el([0x7B, 0xA9], SECRET), el([0x4D, 0x80], 'Lavf ' + SECRET), el([0x57, 0x41], SECRET), el([0x44, 0x61], new Array(8).fill(9))),
    el([0x16, 0x54, 0xAE, 0x6B], el([0xAE], el([0xD7], [1]), el([0x83], [trackType]), el([0x53, 0x6E], SECRET), el([0x86], 'V_VP8'))),
    [0x1F, 0x43, 0xB6, 0x75], unknown, el([0xE7], [0]), el([0xA3], [0x81, 0, 0, 0x80], 'FRAME'),
    el([0x12, 0x54, 0xC3, 0x67], el([0x73, 0x73], el([0x67, 0xC8], el([0x45, 0xA3], 'TITLE'), el([0x44, 0x87], SECRET)))));
  const original = webm('webm', 1), result = cleaned(original);
  assert.deepEqual([result.kind, result.type], ['video', 'video/webm']);
  assert.equal(result.bytes.length, original.length);
  assert.ok(!has(result.bytes, SECRET) && !has(result.bytes, 'Lavf') && !has(result.bytes, 'TITLE') && !has(result.bytes, [0xBF, 0x84, 1, 2, 3, 4]));
  assert.ok(has(result.bytes, 'FRAME') && has(result.bytes, 'V_VP8') && has(result.bytes, [0x0F, 0x42, 0x40]));
  assert.equal(attachments.clean(webm('webm', 2)).type, 'audio/webm');
  assert.equal(attachments.clean(webm('matroska', 1)), null);
});

test('MP3 tags are removed from both ends', () => {
  const frames = bytes([0xFF, 0xFB, 0x90, 0x00], 'AUDIO-FRAMES');
  const id3 = bytes('ID3', [3, 0, 0], [0, 0, 0, SECRET.length], SECRET);
  const ape = bytes(SECRET, 'APETAGEX', le32(2000), le32(SECRET.length + 32), le32(1), le32(0), new Array(8).fill(0));
  const v1 = bytes('TAG', SECRET, new Array(128 - 3 - SECRET.length).fill(0));
  const result = cleaned(bytes(id3, frames, ape, v1), 'audio/mpeg');
  assert.deepEqual([result.kind, result.type], ['audio', 'audio/mpeg']);
  assert.deepEqual(result.bytes, frames);
});

test('unknown formats become generic files, and file names are made safe', () => {
  assert.equal(attachments.clean(bytes('%PDF-1.7 ', SECRET), 'application/pdf'), null);
  assert.equal(attachments.clean(bytes('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/svg+xml'), null);
  assert.equal(attachments.clean(bytes([0xFF, 0xFB, 0x90, 0x00]), 'application/octet-stream'), null);
  assert.equal(attachments.fileName('C:\\Users\\me\\report.pdf'), 'report.pdf');
  assert.equal(attachments.fileName('../../etc/passwd'), 'passwd');
  assert.equal(attachments.fileName(`invoice${String.fromCharCode(0x202E)}fdp.exe`), 'invoicefdp.exe');
  assert.equal(attachments.fileName(`${String.fromCharCode(7)}..`), 'file');
  assert.equal(attachments.fileName('x'.repeat(300)).length, 120);
  assert.equal(attachments.matches(bytes('<svg/>'), 'image/svg+xml'), false);
  assert.equal(attachments.matches(bytes([0xFF, 0xD8, 0xFF]), 'image/png'), false);
});

test('attachment descriptors are validated inside the authenticated message', () => {
  const a = nacl.box.keyPair(), b = nacl.box.keyPair(), peerKey = crypto.base64(b.publicKey);
  const encrypted = crypto.encryptAttachment(new Uint8Array(10)), base = { id: 'upload', key: encrypted.key, nonce: encrypted.nonce, size: 10 };
  const send = file => crypto.encryptMessage({ id: 'm', sender: 'a', recipient: 'b', text: '', file }, a, peerKey);
  const valid = [{ ...base, kind: 'video', type: 'video/webm' }, { ...base, kind: 'video', type: 'video/mp4', width: 1920, height: 1080 },
    { ...base, kind: 'image', type: 'image/gif', width: 2, height: 3 }, { ...base, kind: 'audio', type: 'audio/mpeg' },
    { ...base, kind: 'file', type: 'application/octet-stream', name: 'notes.txt' }];
  for (const file of valid) {
    const box = send(file), message = { id: 'm', sender: 'a', recipient: 'b', room: null, encrypted: box, reply: null, attachment: { id: 'upload' } };
    assert.deepEqual(crypto.decryptMessage(message, 'b', b, crypto.base64(a.publicKey)).file, file);
    assert.throws(() => crypto.decryptMessage({ ...message, attachment: { id: 'other' } }, 'b', b, crypto.base64(a.publicKey)), /metadata/);
  }
  const invalid = [{ ...base, kind: 'image', type: 'image/svg+xml', width: 1, height: 1 }, { ...base, kind: 'image', type: 'image/png' },
    { ...base, kind: 'video', type: 'text/html' }, { ...base, kind: 'file', type: 'text/html', name: 'a.html' },
    { ...base, kind: 'file', type: 'application/octet-stream' }, { ...base, kind: 'file', type: 'application/octet-stream', name: '../x' },
    { ...base, kind: 'file', type: 'application/octet-stream', name: `a${String.fromCharCode(0x202E)}txt.exe` },
    { ...base, kind: 'audio', type: 'audio/mpeg', name: 'song.mp3' }, { ...base, kind: 'audio', type: 'audio/wav', width: 1, height: 1 },
    { ...base, kind: 'constructor', type: 'video/mp4' }, { ...base, kind: 'video', type: 'video/mp4', extra: true }, { ...base, kind: 'video', type: 'video/mp4', size: 0 }];
  for (const file of invalid) assert.throws(() => send(file), /Invalid private attachment/, JSON.stringify(file));
  assert.throws(() => crypto.encryptMessage({ id: 'm', sender: 'a', recipient: 'b', text: '' }, a, peerKey), /Empty/);
});

test('attachment ciphertext reveals only a coarse size class and decrypts to the exact bytes', () => {
  for (const size of [1, 255, 256, 257, 1000, 65537, 1048577, 16 * 1024 * 1024 - 100]) {
    const padded = crypto.paddedSize(size), floor = Math.max(size, 256);
    assert.ok(padded >= floor && padded <= floor * 1.0625, `${size} -> ${padded}`);
  }
  assert.equal(crypto.encryptAttachment(new Uint8Array(1000)).bytes.length, crypto.encryptAttachment(new Uint8Array(1010)).bytes.length);
  const plain = Uint8Array.from({ length: 1000 }, (_, i) => i % 251), encrypted = crypto.encryptAttachment(plain);
  assert.equal(encrypted.bytes.length, crypto.paddedSize(1000) + 16);
  assert.deepEqual(crypto.decryptAttachment(encrypted.bytes, { ...encrypted, size: 1000 }), plain);
  assert.throws(() => crypto.decryptAttachment(encrypted.bytes, { ...encrypted, size: 2000 }), /size/);
});
