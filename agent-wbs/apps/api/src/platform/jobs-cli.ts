import type { Pool } from '@awbs/db';
import { JobsError, jobsTable, openJobs, reissueJobs, REISSUE_KINDS } from './jobs.ts';

export async function jobsCommand(pool: Pool, args: string[], write: (text: string) => void): Promise<void> {
  const [command, ...flags] = args;
  if (command === 'open' && !flags.length) {
    const view = await openJobs(pool);
    write(jobsTable(view.jobs));
    write(`재발급 상한 --through ${view.through} / 열린 실행 보유 ${String(view.holds)}개\n`);
    return;
  }
  if (command !== 'reissue') throw new JobsError('명령: jobs open | jobs reissue --through <순번> [--kinds input_diff,split,estimate,planning,bootstrap] [--dry-run | --confirm]');
  let through: string | undefined;
  let kinds = REISSUE_KINDS;
  let mode: string | undefined;
  const seen = new Set<string>();
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i] ?? '';
    if (seen.has(flag)) throw new JobsError('같은 옵션을 두 번 지정할 수 없습니다.');
    seen.add(flag);
    if (flag === '--through' || flag === '--kinds') {
      const value = flags[++i];
      if (!value || value.startsWith('--')) throw new JobsError('옵션 값이 필요합니다.');
      if (flag === '--through') through = value;
      else kinds = value.split(',');
    } else if ((flag === '--confirm' || flag === '--dry-run') && !mode) mode = flag;
    else throw new JobsError('알 수 없거나 함께 쓸 수 없는 jobs 옵션입니다.');
  }
  if (!through) throw new JobsError('jobs open에서 확인한 --through <순번>이 필요합니다. 재실행할 때 같은 값을 쓰세요.');
  const view = await openJobs(pool);
  write(jobsTable(view.jobs));
  const results = await reissueJobs(pool, through, mode === '--confirm', kinds);
  write(`${mode === '--confirm' ? '재발급 완료' : '미리보기 (변경 없음)'}: ${String(results.length)}개\n`);
  for (const row of results) write(`${row.old}\t${row.next ?? '재발급 예정'}\n`);
  write('선택한 종류·순번 밖의 job은 jobs open에서 확인하세요.\n');
}
