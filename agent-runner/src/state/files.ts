import { randomUUID } from 'node:crypto';
import { open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

export async function atomicWrite(directory: string, name: string, content: string | Uint8Array): Promise<void> {
  const temp = join(directory, `${randomUUID()}.tmp`);
  try {
    const file = await open(temp, 'wx', 0o600);
    try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
    await rename(temp, join(directory, name));
    const folder = await open(directory, 'r');
    try { await folder.sync(); } finally { await folder.close(); }
  } finally { await rm(temp, { force: true }); }
}
