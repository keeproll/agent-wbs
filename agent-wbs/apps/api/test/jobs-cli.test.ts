import type { Pool } from '@awbs/db';
import { expect, test } from 'vitest';
import { jobsCommand } from '../src/platform/jobs-cli.ts';
import { jobsTable, reissueJobs } from '../src/platform/jobs.ts';

const unusedPool = {} as Pool;
test.each([
  [], ['open', '--confirm'], ['reissue'], ['reissue', '--confirm'],
  ['reissue', '--through'], ['reissue', '--through', '--confirm'],
  ['reissue', '--through', '1', '--through', '2'],
  ['reissue', '--through', '1', '--confirm', '--dry-run'],
  ['reissue', '--through', '1', '--unknown'],
].map(args => ({ args })))('잘못된 관리 인수 $args는 DB에 접근하기 전에 거부한다', async ({ args }) => {
  await expect(jobsCommand(unusedPool, args, () => undefined)).rejects.toThrow();
});

test.each(['-1', '1.2', '1e3', '9223372036854775808', 'secret'])('잘못된 순번 %s는 DB에 접근하기 전에 거부한다', async cutoff => {
  await expect(reissueJobs(unusedPool, cutoff, true)).rejects.toThrow('--through');
});

test('빈 종류·지원하지 않는 종류는 거부한다', async () => {
  await expect(reissueJobs(unusedPool, '1', true, [])).rejects.toThrow('--kinds');
  await expect(reissueJobs(unusedPool, '1', true, ['attempt'])).rejects.toThrow('--kinds');
});

test('표는 비어 있어도 머리글을 출력하고 제어 문자는 칸 안에서 없앤다', () => {
  expect(jobsTable([])).toMatch(/^record\tid\tkind\tstate\tcontract\tcreated\towner\tuntil\tfence\tholds\n$/);
  const table = jobsTable([{ record: '1', id: 'id', kind: 'split', state: 'queued', contract: 1, created: 'now', owner: 'runner\tbad\nname', until: null, fence: 0, holds: '0' }]);
  expect(table.split('\n')).toHaveLength(3);
  expect(table).toContain('runner bad name\t-\t0\t0');
});
