import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';

const home = process.argv[2];
if (!home) throw new Error('시험 경로가 필요합니다.');
const remove = fs.promises.rm;
fs.promises.rm = async (...args: Parameters<typeof remove>) => {
  if (/\/[a-f0-9-]{36}\.json$/.test(String(args[0]))) {
    let events = 0;
    try { events = (JSON.parse(await fs.promises.readFile(join(home, 'state/rejected/summary.json'), 'utf8')) as { events: number }).events; }
    catch { /* 저장 순서가 틀린 변이도 부모의 assertion으로 바로 확인한다. */ }
    process.stdout.write(events >= 1 ? '요약 저장 확인\n' : '요약 없음\n');
    process.stdin.resume();
    await new Promise<void>(() => undefined);
  }
  return remove(...args);
};
syncBuiltinESMExports();
const { State } = await import('../../src/state/state.ts');
const state = await State.open(home, { now: () => Date.UTC(2026, 10, 26), rejectionLimits: { maxRecords: 1 } });
await state.close();
