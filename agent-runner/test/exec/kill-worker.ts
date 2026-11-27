import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Writable } from 'node:stream';
import { Launches, type LaunchJob } from '../../src/exec/launches.ts';
import { spawnWaiting } from '../../src/exec/process.ts';

const [home, boundary] = process.argv.slice(2);
if (!home || !boundary) throw new Error('시험 인자가 없습니다.');
const config = JSON.parse(process.argv[4] ?? '{}') as { identity?: { hostId: string; bootId: string }; job?: LaunchJob };
const launches = new Launches(home, config.identity ?? { hostId: 'host', bootId: 'boot' });
const record = await launches.create(config.job ?? { id: 'crash-job', fence: 3, epoch: 1 });
async function checkpoint(stage: string): Promise<void> {
  if (stage !== boundary) return;
  process.send?.({ stage, record });
  await new Promise(() => undefined);
}
await checkpoint('create');
const child = spawnWaiting(record, { file: process.execPath, args: ['-e', 'require("node:fs").writeFileSync(process.argv[1], "ran"); setInterval(()=>{},1000)', join(home, 'ran')], env: {}, cwd: home, stdin: '' });
child.on('error', () => undefined);
child.stdout?.resume(); child.stderr?.resume();
await once(child, 'spawn');
await checkpoint('spawn');
await launches.attach(record, child.pid ?? 0);
await checkpoint('record');
await writeFile(join(home, 'server-pgid'), String(record.pgid));
await checkpoint('process');
(child.stdio[3] as Writable).end('run\n');
child.stdin?.end();
await checkpoint('exec');
