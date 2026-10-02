/* Attachments are prepared locally without canvas. Known media formats have their metadata
   removed at the byte level (pixels and samples are never decoded or re-encoded), so the
   output does not depend on this browser's graphics stack. Everything is encrypted before upload. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SilenzaAttachments = factory();
})(globalThis, function () {
  'use strict';
  const MAX_PIXELS = 64000000;
  const invalid = format => { throw new Error(`This ${format} file is damaged or uses an unsupported layout.`); };
  const ascii = (b, at, n) => at + n <= b.length ? String.fromCharCode(...b.subarray(at, at + n)) : '';
  const u16 = (b, at) => (b[at] << 8) | b[at + 1];
  const u32 = (b, at) => b[at] * 16777216 + ((b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]);
  const le16 = (b, at) => b[at] | (b[at + 1] << 8);
  const le24 = (b, at) => b[at] | (b[at + 1] << 8) | (b[at + 2] << 16);
  const le32 = (b, at) => le24(b, at) + b[at + 3] * 16777216;
  function concat(parts) {
    const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
    let offset = 0;
    for (const part of parts) { out.set(part, offset); offset += part.length; }
    return out;
  }

  // JPEG: keep only the segments needed to decode. EXIF, XMP, ICC, IPTC, comments, thumbnails
  // and data appended after the image (motion photos, depth maps) are dropped. Orientation is
  // the only EXIF value kept, so phone photos still display upright.
  function exifOrientation(payload) {
    if (ascii(payload, 0, 6) !== 'Exif\0\0') return 1;
    const t = payload.subarray(6), little = ascii(t, 0, 2) === 'II';
    if (!little && ascii(t, 0, 2) !== 'MM') return 1;
    const r16 = at => little ? le16(t, at) : u16(t, at), r32 = at => little ? le32(t, at) : u32(t, at);
    if (t.length < 8 || r16(2) !== 42) return 1;
    const ifd = r32(4);
    if (ifd + 2 > t.length) return 1;
    for (let i = 0, count = r16(ifd); i < count && ifd + 14 + i * 12 <= t.length; i++) {
      const entry = ifd + 2 + i * 12;
      if (r16(entry) === 0x0112 && r16(entry + 2) === 3) { const value = r16(entry + 8); return value >= 1 && value <= 8 ? value : 1; }
    }
    return 1;
  }
  const orientationSegment = value => Uint8Array.of(0xFF, 0xE1, 0, 34, 0x45, 0x78, 0x69, 0x66, 0, 0, 0x4D, 0x4D, 0, 0x2A, 0, 0, 0, 8,
    0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, value, 0, 0, 0, 0, 0, 0);
  function jpeg(b) {
    let pos = 2, jfif = null, orientation = 1;
    const body = [];
    while (pos < b.length) {
      if (b[pos] !== 0xFF) invalid('JPEG');
      while (b[pos] === 0xFF) pos++;
      if (pos >= b.length) break;
      const marker = b[pos++];
      if (marker === 0xD9) break;
      if (marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { body.push(Uint8Array.of(0xFF, marker)); continue; }
      if (pos + 2 > b.length) invalid('JPEG');
      const length = u16(b, pos);
      if (length < 2 || pos + length > b.length) invalid('JPEG');
      const segment = b.subarray(pos - 2, pos + length), payload = b.subarray(pos + 2, pos + length);
      pos += length;
      if (marker === 0xE0) {
        // Keep the JFIF colour/density header, without its embedded thumbnail.
        if (!jfif && payload.length >= 14 && ascii(payload, 0, 5) === 'JFIF\0') jfif = concat([Uint8Array.of(0xFF, 0xE0, 0, 16), payload.subarray(0, 12), Uint8Array.of(0, 0)]);
      } else if (marker === 0xE1) {
        if (orientation === 1) orientation = exifOrientation(payload);
      } else if (marker === 0xEE) {
        // The Adobe segment only says how colour channels are stored; decoders need it.
        if (ascii(payload, 0, 5) === 'Adobe') body.push(segment);
      } else if (marker < 0xE0 || marker > 0xFE) {
        body.push(segment);
        if (marker === 0xDA) {
          // Entropy-coded scan data runs until the next marker that is not stuffing or a restart.
          let end = pos;
          while (end < b.length && !(b[end] === 0xFF && end + 1 < b.length && b[end + 1] !== 0 && (b[end + 1] < 0xD0 || b[end + 1] > 0xD7))) end++;
          body.push(b.subarray(pos, end)); pos = end;
        }
      }
    }
    if (!body.some(part => part[1] === 0xDA)) invalid('JPEG');
    return concat([Uint8Array.of(0xFF, 0xD8), ...(jfif ? [jfif] : []), ...(orientation > 1 ? [orientationSegment(orientation)] : []), ...body, Uint8Array.of(0xFF, 0xD9)]);
  }

  // PNG/APNG: allow-list of chunks that affect how pixels are drawn. Text, EXIF, ICC and
  // timestamp chunks are dropped, as is anything after IEND.
  const PNG_KEEP = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'sBIT', 'bKGD', 'cICP', 'mDCv', 'cLLi', 'acTL', 'fcTL', 'fdAT']);
  function png(b) {
    if (ascii(b, 12, 4) !== 'IHDR') invalid('PNG');
    const out = [b.subarray(0, 8)];
    let pos = 8;
    while (true) {
      if (pos + 12 > b.length) invalid('PNG');
      const type = ascii(b, pos + 4, 4), end = pos + 12 + u32(b, pos);
      if (end > b.length) invalid('PNG');
      if (PNG_KEEP.has(type)) out.push(b.subarray(pos, end));
      pos = end;
      if (type === 'IEND') return concat(out);
    }
  }

  // GIF: keep image data, frame timing and the looping extension. Comments, XMP and other
  // application extensions are dropped.
  function gif(b) {
    if (b.length < 13) invalid('GIF');
    let pos = 13 + (b[10] & 0x80 ? 3 * (2 << (b[10] & 7)) : 0);
    const out = [b.subarray(0, pos)];
    const subBlocks = at => {
      while (true) {
        if (at >= b.length) invalid('GIF');
        const size = b[at]; at += 1 + size;
        if (size === 0) return at;
      }
    };
    while (true) {
      if (pos >= b.length) invalid('GIF');
      if (b[pos] === 0x3B) break;
      if (b[pos] === 0x2C) {
        if (pos + 10 > b.length) invalid('GIF');
        const end = subBlocks(pos + 11 + (b[pos + 9] & 0x80 ? 3 * (2 << (b[pos + 9] & 7)) : 0));
        out.push(b.subarray(pos, end)); pos = end;
      } else if (b[pos] === 0x21) {
        const label = b[pos + 1], end = subBlocks(pos + 2);
        const looping = label === 0xFF && b[pos + 2] === 11 && ['NETSCAPE2.0', 'ANIMEXTS1.0'].includes(ascii(b, pos + 3, 11));
        if (label === 0xF9 || looping) out.push(b.subarray(pos, end));
        pos = end;
      } else invalid('GIF');
    }
    out.push(Uint8Array.of(0x3B));
    return concat(out);
  }

  // RIFF (WebP, WAV): rebuild the container from an allow-list of chunks.
  function riff(b, form, keep, format) {
    const end = Math.min(b.length, 8 + le32(b, 4)), chunks = [];
    let pos = 12;
    while (pos + 8 <= end) {
      const id = ascii(b, pos, 4), size = le32(b, pos + 4);
      if (pos + 8 + size > end) invalid(format);
      if (keep.has(id)) { chunks.push(b.slice(pos, pos + 8 + size)); if (size & 1) chunks.push(new Uint8Array(1)); }
      pos += 8 + size + (size & 1);
    }
    const body = concat(chunks), header = new Uint8Array(12);
    header.set(b.subarray(0, 4)); header.set(b.subarray(8, 12), 8);
    new DataView(header.buffer).setUint32(4, body.length + 4, true);
    return { out: concat([header, body]), chunks };
  }
  function webp(b) {
    const { out, chunks } = riff(b, 'WEBP', new Set(['VP8 ', 'VP8L', 'VP8X', 'ALPH', 'ANIM', 'ANMF']), 'WebP');
    if (!chunks.some(chunk => ['VP8 ', 'VP8L', 'ANMF'].includes(ascii(chunk, 0, 4)))) invalid('WebP');
    // Clear the ICC, EXIF and XMP flags of the extended header, since those chunks are gone.
    if (ascii(out, 12, 4) === 'VP8X') out[20] &= ~(0x20 | 0x08 | 0x04);
    return out;
  }
  function wav(b) {
    const { out, chunks } = riff(b, 'WAVE', new Set(['fmt ', 'data', 'fact']), 'WAV');
    if (!chunks.some(chunk => ascii(chunk, 0, 4) === 'data')) invalid('WAV');
    return out;
  }

  // MP4/MOV/M4A: metadata boxes are overwritten in place as zero-filled 'free' boxes, so no
  // sample offset changes. This removes location, camera, software and title data, and
  // creation/modification times are zeroed.
  const BOX_CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'edts', 'moof', 'traf', 'mvex']);
  const BOX_ERASE = new Set(['udta', 'meta', 'uuid', 'free', 'skip', 'Xtra', 'XMP_']);
  function isobmff(b) {
    const out = new Uint8Array(b);
    const walk = (start, end, depth) => {
      let pos = start;
      while (pos + 8 <= end) {
        let size = u32(out, pos), header = 8;
        const type = ascii(out, pos + 4, 4);
        if (size === 1) { if (pos + 16 > end) invalid('video'); size = u32(out, pos + 8) * 4294967296 + u32(out, pos + 12); header = 16; }
        else if (size === 0) size = end - pos;
        if (size < header || pos + size > end) invalid('video');
        const body = pos + header, boxEnd = pos + size;
        if (BOX_ERASE.has(type)) { out.set([0x66, 0x72, 0x65, 0x65], pos + 4); out.fill(0, body, boxEnd); }
        else if (BOX_CONTAINERS.has(type) && depth < 8) walk(body, boxEnd, depth + 1);
        else if (['mvhd', 'tkhd', 'mdhd'].includes(type)) { const n = out[body] === 1 ? 16 : 8; if (body + 4 + n <= boxEnd) out.fill(0, body + 4, body + 4 + n); }
        else if (type === 'hdlr' && boxEnd > body + 12) out.fill(0, body + 12, boxEnd); // vendor and handler name, e.g. "Core Media Video"
        pos = boxEnd;
      }
    };
    walk(0, out.length, 0);
    return out;
  }

  // WebM: metadata elements are overwritten in place with Void elements of the same length.
  const EBML_ERASE = new Set([0x7BA9, 0x4461, 0x4D80, 0x5741, 0x73A4, 0x536E, 0x1254C367, 0x1941A469, 0x1043A770]); // Title, DateUTC, MuxingApp, WritingApp, SegmentUUID, track Name, Tags, Attachments, Chapters
  const EBML_MASTERS = new Set([0x1A45DFA3, 0x18538067, 0x1549A966, 0x1654AE6B, 0xAE]); // EBML header, Segment, Info, Tracks, TrackEntry
  const EBML_TOP = new Set([0x114D9B74, 0x1549A966, 0x1654AE6B, 0x1F43B675, 0x1C53BB6B, 0x1043A770, 0x1941A469, 0x1254C367]);
  function vint(b, pos, id) {
    const first = b[pos];
    if (!first) invalid('WebM');
    const length = Math.clz32(first) - 23;
    if (length > (id ? 4 : 8) || pos + length > b.length) invalid('WebM');
    let value = id ? first : first & (0xFF >> length), unknown = !id && value === 0xFF >> length;
    for (let i = 1; i < length; i++) { value = value * 256 + b[pos + i]; if (b[pos + i] !== 0xFF) unknown = false; }
    return { value, length, unknown };
  }
  function voidElement(out, start, end) {
    const n = Math.min(8, end - start - 1);
    let size = end - start - 1 - n;
    out[start] = 0xEC;
    for (let i = n; i >= 1; i--) { out[start + i] = size % 256; size = Math.floor(size / 256); }
    out[start + 1] |= 0x80 >> (n - 1);
    out.fill(0, start + 1 + n, end);
  }
  function webm(b) {
    const out = new Uint8Array(b);
    let docType = '', video = false;
    const element = pos => {
      const id = vint(out, pos, true), size = vint(out, pos + id.length, false), body = pos + id.length + size.length;
      return { id: id.value, size, body, end: size.unknown ? null : body + size.value };
    };
    // A live-recorded Cluster may have unknown size: it ends where the next top-level element starts.
    const skipCluster = (pos, end) => {
      while (pos < end) {
        const child = element(pos);
        if (EBML_TOP.has(child.id)) return pos;
        if (child.end === null || child.end > end) invalid('WebM');
        pos = child.end;
      }
      return end;
    };
    const walk = (start, end) => {
      let pos = start, changed = false;
      const checksums = [];
      while (pos < end) {
        const el = element(pos);
        if (el.body > end) invalid('WebM');
        if (el.end === null) {
          if (el.id === 0x18538067) { changed = walk(el.body, end) || changed; pos = end; continue; }
          if (el.id === 0x1F43B675) { pos = skipCluster(el.body, end); continue; }
          invalid('WebM');
        }
        if (el.end > end) invalid('WebM');
        if (el.id === 0x4282) docType = ascii(out, el.body, el.end - el.body);
        if (el.id === 0x83 && el.end - el.body === 1 && out[el.body] === 1) video = true;
        if (EBML_ERASE.has(el.id)) { voidElement(out, pos, el.end); changed = true; }
        else if (el.id === 0xBF) checksums.push([pos, el.end]);
        else if (EBML_MASTERS.has(el.id)) changed = walk(el.body, el.end) || changed;
        pos = el.end;
      }
      // A CRC-32 element covering changed data would no longer match; remove it too.
      if (changed) for (const [from, to] of checksums) voidElement(out, from, to);
      return changed;
    };
    walk(0, out.length);
    return docType === 'webm' ? { bytes: out, video } : null;
  }

  // MP3: remove ID3v2 tags at the start and ID3v1/APE tags at the end.
  function mp3(b) {
    let start = 0, end = b.length;
    while (ascii(b, start, 3) === 'ID3') {
      if (start + 10 > b.length) invalid('MP3');
      start += 10 + (((b[start + 6] & 0x7F) << 21) | ((b[start + 7] & 0x7F) << 14) | ((b[start + 8] & 0x7F) << 7) | (b[start + 9] & 0x7F)) + (b[start + 5] & 0x10 ? 10 : 0);
    }
    for (let changed = true; changed;) {
      changed = false;
      if (end - start >= 128 && ascii(b, end - 128, 3) === 'TAG') { end -= 128; changed = true; }
      if (end - start >= 227 && ascii(b, end - 227, 4) === 'TAG+') { end -= 227; changed = true; }
      if (end - start >= 32 && ascii(b, end - 32, 8) === 'APETAGEX') {
        const total = le32(b, end - 20) + (b[end - 9] & 0x80 ? 32 : 0);
        if (total > end - start) invalid('MP3');
        end -= total; changed = true;
      }
    }
    if (start + 2 > end || b[start] !== 0xFF || (b[start + 1] & 0xE0) !== 0xE0) invalid('MP3');
    return b.slice(start, end);
  }

  const HEIF_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1', 'avif', 'avis']);
  const AUDIO_BRANDS = new Set(['M4A ', 'M4B ', 'M4P ']);
  const isRiff = (b, form) => ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === form;
  const isPng = b => b.length > 8 && [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A].every((value, i) => b[i] === value);
  const isMp3 = b => ascii(b, 0, 3) === 'ID3' || (b[0] === 0xFF && (b[1] & 0xE0) === 0xE0);
  // Detect the format from its bytes (never the file name or the browser's reported type) and
  // remove its metadata. Returns null for anything that is not a supported media format.
  function clean(b, declared = '') {
    if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return { kind: 'image', type: 'image/jpeg', bytes: jpeg(b) };
    if (isPng(b)) return { kind: 'image', type: 'image/png', bytes: png(b) };
    if (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a') return { kind: 'image', type: 'image/gif', bytes: gif(b) };
    if (isRiff(b, 'WEBP')) return { kind: 'image', type: 'image/webp', bytes: webp(b) };
    if (isRiff(b, 'WAVE')) return { kind: 'audio', type: 'audio/wav', bytes: wav(b) };
    if (ascii(b, 4, 4) === 'ftyp') {
      const brand = ascii(b, 8, 4);
      if (HEIF_BRANDS.has(brand)) return null;
      const audio = AUDIO_BRANDS.has(brand) || String(declared).startsWith('audio/');
      return { kind: audio ? 'audio' : 'video', type: audio ? 'audio/mp4' : brand === 'qt  ' ? 'video/quicktime' : 'video/mp4', bytes: isobmff(b) };
    }
    if (u32(b, 0) === 0x1A45DFA3) {
      const result = webm(b);
      return result && { kind: result.video ? 'video' : 'audio', type: result.video ? 'video/webm' : 'audio/webm', bytes: result.bytes };
    }
    if (['audio/mpeg', 'audio/mp3'].includes(declared) && isMp3(b)) return { kind: 'audio', type: 'audio/mpeg', bytes: mp3(b) };
    return null;
  }
  // Recipients check that decrypted bytes really are the declared, allow-listed format.
  function matches(b, type) {
    switch (type) {
      case 'image/jpeg': return b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF;
      case 'image/png': return isPng(b);
      case 'image/gif': return ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a';
      case 'image/webp': return isRiff(b, 'WEBP');
      case 'audio/wav': return isRiff(b, 'WAVE');
      case 'video/mp4': case 'video/quicktime': case 'audio/mp4': return ascii(b, 4, 4) === 'ftyp' && !HEIF_BRANDS.has(ascii(b, 8, 4));
      case 'video/webm': case 'audio/webm': return u32(b, 0) === 0x1A45DFA3;
      case 'audio/mpeg': return isMp3(b);
      case 'application/octet-stream': return true;
      default: return false;
    }
  }
  // Pixel count from the image header, so an oversized image is rejected before decoding.
  function pixels(b, type) {
    if (type === 'image/png') return u32(b, 16) * u32(b, 20);
    if (type === 'image/gif') return le16(b, 6) * le16(b, 8);
    if (type === 'image/webp') {
      const chunk = ascii(b, 12, 4);
      if (chunk === 'VP8X') return (1 + le24(b, 24)) * (1 + le24(b, 27));
      if (chunk === 'VP8 ') return (le16(b, 26) & 0x3FFF) * (le16(b, 28) & 0x3FFF);
      if (chunk === 'VP8L') return (1 + (((b[22] & 0x3F) << 8) | b[21])) * (1 + (((b[24] & 0xF) << 10) | (b[23] << 2) | ((b[22] & 0xC0) >> 6)));
      return 0;
    }
    if (type === 'image/jpeg') {
      for (let pos = 2; pos + 9 <= b.length && b[pos] === 0xFF;) {
        const marker = b[pos + 1];
        if (marker >= 0xC0 && marker <= 0xCF && ![0xC4, 0xC8, 0xCC].includes(marker)) return u16(b, pos + 5) * u16(b, pos + 7);
        if (marker === 0xDA) return 0;
        pos += 2 + u16(b, pos + 2);
      }
    }
    return 0;
  }
  const displayable = (b, type) => { const count = pixels(b, type); return count > 0 && count <= MAX_PIXELS; };
  function fileName(name) {
    const base = String(name || '').split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, 120).trim();
    return base && base !== '.' && base !== '..' ? base : 'file';
  }
  function measure(blob, kind) {
    return new Promise(resolve => {
      const url = URL.createObjectURL(blob), media = document.createElement(kind === 'image' ? 'img' : 'video');
      const done = size => {
        clearTimeout(timer); media.onload = media.onloadedmetadata = media.onerror = null;
        media.removeAttribute('src'); if (kind !== 'image') media.load();
        URL.revokeObjectURL(url); resolve(size);
      };
      const timer = setTimeout(() => done(null), 10000);
      if (kind === 'image') media.onload = () => done(media.naturalWidth ? { width: media.naturalWidth, height: media.naturalHeight } : null);
      else { media.preload = 'metadata'; media.muted = true; media.onloadedmetadata = () => done(media.videoWidth ? { width: media.videoWidth, height: media.videoHeight } : null); }
      media.onerror = () => done(null);
      media.src = url;
    });
  }
  // fits(bytes) tells whether the encrypted upload stays within the server's limit.
  async function prepare(file, fits) {
    if (!file.size) throw new Error('This file is empty.');
    const tooLarge = message => Object.assign(new Error(message), { tooLarge: true });
    if (!fits(Math.floor(file.size / 2))) throw tooLarge('This file is too large to attach.');
    const original = new Uint8Array(await file.arrayBuffer());
    const media = clean(original, file.type);
    const prepared = media || { kind: 'file', type: 'application/octet-stream', bytes: original, name: fileName(file.name) };
    if (!fits(prepared.bytes.length)) throw tooLarge(`This file is too large to attach${media ? ', even after removing its metadata' : ''}.`);
    if (prepared.kind === 'image' && !displayable(prepared.bytes, prepared.type)) throw new Error('Images can be at most 64 megapixels.');
    const blob = new Blob([prepared.bytes], { type: prepared.type === 'video/quicktime' ? 'video/mp4' : prepared.type });
    const dimensions = prepared.kind === 'image' || prepared.kind === 'video' ? await measure(blob, prepared.kind) : null;
    if (prepared.kind === 'image' && !dimensions) throw new Error('This browser could not read the image.');
    return { ...prepared, ...dimensions, size: prepared.bytes.length, blob };
  }
  return { clean, matches, displayable, fileName, prepare };
});
