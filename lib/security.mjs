import { BlockList, isIP } from 'node:net';
import { createHmac, randomBytes } from 'node:crypto';

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
// Cloudflare edge networks (https://www.cloudflare.com/ips/). Used only when
// TRUSTED_PROXY_PRESET=cloudflare, so CF-terminated traffic is attributed to the
// visitor rather than to a shared Cloudflare edge address.
export const CLOUDFLARE_NETWORKS = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18',
  '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
  '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
  '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32'
];
export function trustedProxyList(addresses = '', preset = '') {
  const presets = String(preset).split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
  for (const name of presets) if (name !== 'cloudflare') throw new Error('TRUSTED_PROXY_PRESET supports only "cloudflare".');
  return [addresses, ...(presets.includes('cloudflare') ? CLOUDFLARE_NETWORKS : [])].filter(Boolean).join(',');
}
// Concurrent sessions one network address may hold. Stops a single client from
// accumulating the shared guest capacity over time.
export const SESSIONS_PER_CLIENT = 30;
export function validateOrigin(value, production = false) {
  if (!value) {
    if (production) throw new Error('Production requires ORIGIN set to the exact public HTTPS origin.');
    return undefined;
  }
  let url;
  try { url = new URL(value); } catch { throw new Error('ORIGIN must be an exact HTTP or HTTPS origin, without a trailing slash.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== value) {
    throw new Error('ORIGIN must be an exact HTTP or HTTPS origin, without a trailing slash.');
  }
  if (production && url.protocol !== 'https:') throw new Error('Production requires an HTTPS ORIGIN.');
  return value;
}
function address(value) {
  if (typeof value !== 'string') return null;
  value = value.trim().toLowerCase();
  if (value.startsWith('::ffff:') && isIP(value.slice(7)) === 4) value = value.slice(7);
  const family = isIP(value);
  if (!family || value.includes('%')) return null;
  return family === 6 ? new URL(`http://[${value}]/`).hostname.slice(1, -1) : value;
}
// One IPv6 subscriber usually controls a whole /64, so limits count that prefix as one client.
function clientIdentity(ip) {
  if (isIP(ip) !== 6) return ip;
  const [head, tail = ''] = ip.split('::'), left = head ? head.split(':') : [], right = tail ? tail.split(':') : [];
  const groups = [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  return `${groups.slice(0, 4).map(g => parseInt(g, 16).toString(16)).join(':')}::/64`;
}

// Forwarding headers are accepted only from explicitly trusted network peers.
export class Security {
  // clientIpHeader: a single-address header set by the trusted ingress (e.g. Railway's
  // X-Real-IP). Read only from trusted peers; it replaces X-Forwarded-For parsing.
  constructor({ trustedProxies = '', clientIpHeader = '', now = Date.now } = {}) {
    if (clientIpHeader && !/^[a-z0-9-]{1,64}$/i.test(clientIpHeader)) throw new Error('CLIENT_IP_HEADER must be a header name such as X-Real-IP.');
    this.clientIpHeader = clientIpHeader.toLowerCase();
    this.now = now; this.limits = new Map(); this.secret = randomBytes(32); this.proxies = new BlockList();
    // Temporary, memory-only network bans. Keys are keyed HMACs that change on restart; never persisted.
    this.clientBans = new Map(); this.configured = false;
    for (const entry of trustedProxies.split(',').map(x => x.trim()).filter(Boolean)) {
      const [host, prefix, ...extra] = entry.split('/'), ip = address(host), family = isIP(ip || '');
      if (!ip || extra.length || (prefix !== undefined && (!/^\d+$/.test(prefix) || Number(prefix) > (family === 4 ? 32 : 128)))) {
        throw new Error('TRUSTED_PROXY_ADDRESSES must contain IP addresses or CIDR networks.');
      }
      this.configured = true;
      if (prefix === undefined) this.proxies.addAddress(ip, family === 4 ? 'ipv4' : 'ipv6');
      else this.proxies.addSubnet(ip, Number(prefix), family === 4 ? 'ipv4' : 'ipv6');
    }
  }
  trusted(ip) { return this.proxies.check(ip, isIP(ip) === 4 ? 'ipv4' : 'ipv6'); }
  client(req) {
    let ip = address(req.socket.remoteAddress);
    if (!ip) fail(503, 'Could not identify the connection.');
    if (this.trusted(ip) && this.clientIpHeader) {
      const value = address(req.headers[this.clientIpHeader]);
      if (!value) fail(503, 'The trusted proxy must supply a valid client address.');
      ip = value;
    } else if (this.trusted(ip)) {
      const header = req.headers['x-forwarded-for'];
      if (typeof header !== 'string' || header.length > 512) fail(503, 'The trusted proxy must supply a valid client address.');
      const chain = header.split(',').map(address);
      if (!chain.length || chain.length > 10 || chain.some(x => !x)) fail(400, 'Invalid forwarded address chain.');
      // Stop at the nearest untrusted hop; attacker-supplied leftmost entries
      // cannot override a genuine client appended by a trusted proxy.
      for (let i = chain.length - 1; i >= 0 && this.trusted(ip); i--) ip = chain[i];
    }
    return createHmac('sha256', this.secret).update(clientIdentity(ip)).digest('hex');
  }
  consume(buckets) {
    this.sweep();
    const updates = buckets.map(([key, maximum, window = 600000]) => {
      const current = this.limits.get(key) || { count: 0, reset: this.now() + window };
      if (current.count >= maximum) fail(429, 'Too many attempts. Try again in 10 minutes.');
      return [key, { ...current, count: current.count + 1 }];
    });
    if (this.limits.size + updates.filter(([key]) => !this.limits.has(key)).length > 50000) fail(429, 'The service is busy. Please try again shortly.');
    for (const [key, value] of updates) this.limits.set(key, value);
  }
  guest(client) { this.consume([[`guest:${client}`, 30], ['guest:global', 500]]); }
  auth(client, username) {
    const name = String(username).toLowerCase().slice(0, 24);
    this.consume([[`auth:${client}`, 100], [`auth:${client}:${name}`, 10], ['auth:global', 2000]]);
  }
  // Registration creates durable records, so it is limited per network address separately from sign-in.
  register(client) { this.consume([[`register:${client}`, 5, 3600000]]); }
  banClient(client, id, duration = 86400000) { this.clientBans.set(client, { id, expires: this.now() + duration }); }
  unbanClient(id) { for (const [client, ban] of this.clientBans) if (ban.id === id) this.clientBans.delete(client); }
  clientBanned(client) {
    const ban = this.clientBans.get(client);
    if (ban && ban.expires <= this.now()) this.clientBans.delete(client);
    return Boolean(ban && ban.expires > this.now());
  }
  authenticated(client, username) { this.limits.delete(`auth:${client}:${String(username).toLowerCase().slice(0, 24)}`); }
  sweep() {
    for (const [key, value] of this.limits) if (value.reset <= this.now()) this.limits.delete(key);
    for (const [key, value] of this.clientBans) if (value.expires <= this.now()) this.clientBans.delete(key);
  }
}

export function sessionCapacity(sessions, accountId, replacing, client) {
  const others = [...sessions.values()].filter(s => s !== replacing);
  if (client && others.filter(s => s.clientKey === client).length >= SESSIONS_PER_CLIENT) fail(429, 'Too many active sessions from this network. Close unused tabs or try again later.');
  if (others.length >= 5000 || (!accountId && others.filter(s => !s.accountId).length >= 4000)) fail(503, 'The chat is full. Try again shortly.');
  if (accountId && others.filter(s => s.accountId === accountId).length >= 10) fail(429, 'This account has too many active sessions. Sign out on another device.');
}
