import { randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';

const derive = promisify(scrypt);
const options = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
const invalid = (status, message) => { throw Object.assign(new Error(message), { status }); };
export class Accounts {
  constructor(directory) { this.file = path.join(directory, 'accounts.json'); this.items = []; this.queue = Promise.resolve(); this.busy = 0; }
  async load() {
    try { this.items = JSON.parse(await readFile(this.file, 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  async digest(password, salt) {
    if (this.busy >= 4) invalid(429, 'Sign-in is busy. Please try again shortly.');
    this.busy++;
    try { return await derive(password, salt, 64, options); } finally { this.busy--; }
  }
  validate(username, password) {
    if (typeof username !== 'string' || !/^[a-zA-Z0-9_]{3,24}$/.test(username)) invalid(400, 'Use 3–24 letters, numbers or underscores for your username.');
    if (typeof password !== 'string' || password.length < 15 || password.length > 128) invalid(400, 'Use a password between 15 and 128 characters.');
  }
  async create(username, password, role = 'member') {
    this.validate(username, password);
    const salt = randomBytes(16).toString('hex');
    const passwordHash = (await this.digest(password, salt)).toString('hex');
    const job = this.queue.then(async () => {
      if (this.items.some(a => a.username.toLowerCase() === username.toLowerCase())) invalid(409, 'That username is unavailable.');
      if (this.items.length >= 50000) invalid(503, 'Account registration is full.');
      const account = { id: randomUUID(), username, role, salt, passwordHash, algorithm: 'scrypt-N32768-r8-p3' };
      const next = [...this.items, account];
      await writeFile(`${this.file}.tmp`, JSON.stringify(next, null, 2), { mode: 0o600 });
      await rename(`${this.file}.tmp`, this.file); this.items = next;
      return account;
    });
    this.queue = job.catch(() => {}); return job;
  }
  async authenticate(username, password) {
    if (typeof username !== 'string' || username.length > 24 || typeof password !== 'string' || password.length > 128) invalid(403, 'Incorrect username or password.');
    const account = this.items.find(a => a.username.toLowerCase() === username.toLowerCase());
    const calculated = await this.digest(password, account?.salt || '00000000000000000000000000000000');
    if (!account || !timingSafeEqual(calculated, Buffer.from(account.passwordHash, 'hex'))) invalid(403, 'Incorrect username or password.');
    return account;
  }
  get(id) { return this.items.find(a => a.id === id); }
}
