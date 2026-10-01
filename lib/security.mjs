import { BlockList, isIP } from 'node:net';
import { createHmac, randomBytes } from 'node:crypto';

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
function address(value) {
  if (typeof value !== 'string') return null;
  value = value.trim().toLowerCase();
  if (value.startsWith('::ffff:') && isIP(value.slice(7)) === 4) value = value.slice(7);
  const family = isIP(value);
  if (!family || value.includes('%')) return null;
  return family === 6 ? new URL(`http://[${value}]/`).hostname.slice(1, -1) : value;
}

// Forwarding headers are accepted only from explicitly trusted network peers.
export class Security {
  constructor({ trustedProxies = '', now = Date.now } = {}) {
    this.now = now; this.limits = new Map(); this.secret = randomBytes(32); this.proxies = new BlockList();
    for (const entry of trustedProxies.split(',').map(x => x.trim()).filter(Boolean)) {
      const [host, prefix, ...extra] = entry.split('/'), ip = address(host), family = isIP(ip || '');
      if (!ip || extra.length || (prefix !== undefined && (!/^\d+$/.test(prefix) || Number(prefix) > (family === 4 ? 32 : 128)))) {
        throw new Error('TRUSTED_PROXY_ADDRESSES must contain IP addresses or CIDR networks.');
      }
      if (prefix === undefined) this.proxies.addAddress(ip, family === 4 ? 'ipv4' : 'ipv6');
      else this.proxies.addSubnet(ip, Number(prefix), family === 4 ? 'ipv4' : 'ipv6');
    }
  }
  trusted(ip) { return this.proxies.check(ip, isIP(ip) === 4 ? 'ipv4' : 'ipv6'); }
  client(req) {
    let ip = address(req.socket.remoteAddress);
    if (!ip) fail(503, 'Could not identify the connection.');
    if (this.trusted(ip)) {
      const header = req.headers['x-forwarded-for'];
      if (typeof header !== 'string' || header.length > 512) fail(503, 'The trusted proxy must supply a valid client address.');
      const chain = header.split(',').map(address);
      if (!chain.length || chain.length > 10 || chain.some(x => !x)) fail(400, 'Invalid forwarded address chain.');
      // Stop at the nearest untrusted hop; attacker-supplied leftmost entries
      // cannot override a genuine client appended by a trusted proxy.
      for (let i = chain.length - 1; i >= 0 && this.trusted(ip); i--) ip = chain[i];
    }
    return createHmac('sha256', this.secret).update(ip).digest('hex');
  }
  consume(buckets) {
    this.sweep();
    const updates = buckets.map(([key, maximum, window = 600000]) => {
      const current = this.limits.get(key) || { count: 0, reset: this.now() + window };
      if (current.count >= maximum) fail(429, 'Too many attempts. Try again in 10 minutes.');
      return [key, { ...current, count: current.count + 1 }];
    });
    if (this.limits.size + updates.filter(([key]) => !this.limits.has(key)).length > 10000) fail(429, 'The service is busy. Please try again shortly.');
    for (const [key, value] of updates) this.limits.set(key, value);
  }
  guest(client) { this.consume([[`guest:${client}`, 30], ['guest:global', 500]]); }
  auth(client, username) {
    const name = String(username).toLowerCase().slice(0, 24);
    this.consume([[`auth:${client}`, 100], [`auth:${client}:${name}`, 10], ['auth:global', 2000]]);
  }
  authenticated(client, username) { this.limits.delete(`auth:${client}:${String(username).toLowerCase().slice(0, 24)}`); }
  sweep() { for (const [key, value] of this.limits) if (value.reset <= this.now()) this.limits.delete(key); }
}

export function sessionCapacity(sessions, accountId, replacing) {
  const others = [...sessions.values()].filter(s => s !== replacing);
  if (others.length >= 5000 || (!accountId && others.filter(s => !s.accountId).length >= 4000)) fail(503, 'The chat is full. Try again shortly.');
  if (accountId && others.filter(s => s.accountId === accountId).length >= 10) fail(429, 'This account has too many active sessions. Sign out on another device.');
}
