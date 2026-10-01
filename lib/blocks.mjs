import { readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';

export const userKey = user => user.accountId ? `account:${user.accountId}` : `guest:${user.id}`;
export class Blocks {
  constructor(directory) { this.file = path.join(directory, 'blocks.json'); this.accounts = {}; this.queue = Promise.resolve(); }
  async load() {
    try { this.accounts = JSON.parse(await readFile(this.file, 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  list(user) { return user.accountId ? this.accounts[user.accountId] || [] : user.blocks || []; }
  has(user, peer) { return this.list(user).some(item => item.key === userKey(peer)); }
  between(a, b) { return this.has(a, b) || this.has(b, a); }
  async update(user, key, alias, blocked) {
    const change = items => blocked ? [...items.filter(item => item.key !== key), { key, alias }] : items.filter(item => item.key !== key);
    if (!user.accountId) { user.blocks = change(this.list(user)); return; }
    const job = this.queue.then(async () => {
      const next = { ...this.accounts, [user.accountId]: change(this.list(user)) };
      await writeFile(`${this.file}.tmp`, JSON.stringify(next), { mode: 0o600 });
      await rename(`${this.file}.tmp`, this.file); this.accounts = next;
    });
    this.queue = job.catch(() => {}); await job;
  }
}
