import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { basename, join } from 'node:path';

const [home, phase] = process.argv.slice(2);
if (!home || !['before', 'after'].includes(phase ?? '')) throw new Error('시험 경로와 종료 시점이 필요합니다.');
const rename = fs.rename;
fs.rename = async (from, to) => {
  if (typeof from === 'string' && typeof to === 'string' && basename(to) === 'current' && from.includes('/codex/')) {
    if (phase === 'before') process.kill(process.pid, 'SIGKILL');
    await rename(from, to);
    process.kill(process.pid, 'SIGKILL');
  }
  await rename(from, to);
};
syncBuiltinESMExports();

const { CliUpdater } = await import('../../src/cli-update/manager.ts');
const updater = new CliUpdater({
  home, owner: { hostId: 'pc-now', bootId: 'boot-now', runnerId: 'runner-now' },
  activity: async () => [], profiles: () => [], verified: () => [], report: async () => undefined,
  registry: {
    latest: async (agent) => agent === 'Codex' ? '0.173.0' : '2.1.333',
    install: async (agent, version, directory) => {
      await fs.mkdir(join(directory, 'bin'), { recursive: true });
      await fs.writeFile(join(directory, 'bin', agent.toLowerCase()), version);
    },
    probe: async (_agent, version, bin) => {
      if (await fs.readFile(bin, 'utf8') !== version) throw new Error('버전 불일치');
    },
  },
});
await updater.recover();
await updater.check();
await updater.applyPending();
throw new Error('예상한 강제 종료가 발생하지 않았습니다.');
