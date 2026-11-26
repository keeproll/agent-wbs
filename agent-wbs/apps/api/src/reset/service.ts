import type { PoolClient } from '@awbs/db';
import { ProjectError } from '../project/errors.ts';
import { iso } from '../project/db.ts';
import { redactText } from '../platform/redact.ts';

export async function previewReset(db: PoolClient) {
  const p = (await db.query<{ name: string; repo_url: string; repo_owner: string; repo_name: string; base_commit: string | null }>('select * from projects')).rows[0];
  if (!p) throw new ProjectError('PROJECT_NOT_FOUND');
  const count = async (table: string, where = '') => (await db.query<{ n: number }>(`select count(*)::int n from ${table} ${where}`)).rows[0]?.n ?? 0;
  const counts = {
    tasks: await count('tasks'), running: await count('task_attempts', "where status='running'"),
    subagents: await count('attempt_subagents', "s join task_attempts a on a.id=s.attempt where a.status='running'"),
    attempts: await count('task_attempts'), verifications: await count('verifications'), evidence: await count('evidence'),
    proposals: await count('change_proposals'), messages: await count('messages'), history: await count('task_history'),
    reports: await count('reports'), baselines: await count('schedule_baselines'), inputs: await count('input_versions'),
  };
  const branches = (await db.query<{ branch: string }>(`select distinct branch from (
    select branch from task_attempts union select ref from ci_runs union select ref from design_snapshots
    union select payload->>'branch' from runner_jobs union select payload->>'ref' from runner_jobs
  ) refs where branch like 'agent/%' order by branch`)).rows.map((r) => r.branch);
  // shortcut: 작업 폴더 수는 기록된 브랜치 수다. Runner가 실제 폴더 목록을 보고하면 그 값으로 바꾼다.
  return { epoch: (await db.query<{ epoch: number }>('select epoch from system_state')).rows[0]?.epoch,
    projectName: p.name, counts, runner: { branches, worktrees: branches.length, mergedTasks: await count('tasks', "where status='done'") },
    repo: { url: p.repo_url, owner: p.repo_owner, name: p.repo_name, branch: 'main', baseCommit: p.base_commit } };
}

export async function resetProject(db: PoolClient, input: { epoch: number; confirmName: string; keepSettings: boolean }, actor: string) {
  try {
    return (await db.query<{ epoch: number }>('select public.reset_project($1,$2,$3,$4) as epoch', [input.epoch, input.confirmName, input.keepSettings, actor])).rows[0];
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'P0002') throw new ProjectError('PROJECT_NOT_FOUND');
    if (code === '22023') throw new ProjectError('VALIDATION_FAILED', { errors: [{ path: 'confirmName', rule: 'match', message: '프로젝트 이름을 정확히 입력하세요.' }] });
    throw error;
  }
}

export async function listResets(db: PoolClient) {
  return { items: (await db.query(`select epoch,${iso('at')} at,actor,deleted_task_count "deletedTaskCount",keep_settings "keepSettings",
    runner_cleanup_status "runnerCleanupStatus",${iso('finished_at')} "finishedAt" from reset_log order by epoch desc`)).rows };
}

export async function getCommands(db: PoolClient, epoch: number) {
  // 차단 중인 원격 명령은 원장에 남겨 둔다. 권한 복구 전에는 Runner가 쓰기 명령을 받지 않는다.
  const commands = (await db.query(`select id,kind,epoch,payload from runner_commands where status<>'done'
    and (not (payload ? 'baseCommit') or not exists(select from external_write_authority where state='blocked')) order by created_at,id`)).rows;
  return { currentEpoch: epoch, commands };
}

export interface CommandResult {
  status: 'done' | 'failed'; items: { name: string; ok: boolean; detail: string }[]; holds?: unknown[];
}
export async function reportCommandResult(db: PoolClient, id: string, epoch: number, result: CommandResult) {
  try { await db.query('select public.complete_cleanup($1,$2,$3,$4)', [id, epoch, result.status === 'done', JSON.stringify(result)]); }
  catch (error) {
    if ((error as { code?: string }).code === 'AW002') throw new ProjectError('VALIDATION_FAILED', { errors: [{ path: 'holds', rule: 'proof', message: '기록된 모든 실행의 종료 증거가 필요합니다.' }] });
    throw error;
  }
  for (const warning of result.items.filter((item) => item.name === 'warn:manual-reconcile' && !item.ok)) {
    await db.query(`insert into alerts(key,severity,target) values($1,'warn',$2) on conflict do nothing`,
      [`reset:${id}:manual-reconcile`, { commandId: id, epoch, message: redactText(warning.detail) }]);
  }
}
