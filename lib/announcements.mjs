import { readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';

export const announcementRoom = Object.freeze({
  id: 'announcements', name: 'Announcements',
  description: 'Official updates and changes from the admins. Announcements are kept between restarts.',
  adminOnly: true, persistent: true
});

export class Announcements {
  constructor(directory) {
    this.file = path.join(directory, 'announcements.json');
    this.messages = []; this.queue = Promise.resolve();
  }
  async load() {
    try { this.messages = JSON.parse(await readFile(this.file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  update(transform) {
    const job = this.queue.then(async () => {
      // Mutations become visible only after the complete file is replaced.
      const next = structuredClone(this.messages);
      const result = transform(next);
      await writeFile(`${this.file}.tmp`, JSON.stringify(next, null, 2));
      await rename(`${this.file}.tmp`, this.file);
      this.messages = next;
      return result;
    });
    this.queue = job.catch(() => {});
    return job;
  }
}
