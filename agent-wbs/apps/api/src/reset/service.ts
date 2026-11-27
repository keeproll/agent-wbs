import { COMMAND_PAYLOAD_SQL, type PoolClient } from '@awbs/db';
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
    projectName: p.name, counts,
    sending: { mail: await count('mail_outbox', "where state='sending'"), notify: await count('notify_outbox', "where state='sending'") },
    runner: { branches, worktrees: branches.length, worktreesEstimated: true, mergedTasks: await count('tasks', "where status='done'") },
    repo: { url: p.repo_url, owner: p.repo_owner, name: p.repo_name, branch: 'main', baseCommit: p.base_commit } };
}

/** 사람이 대조해야 하는 PR 참조 경고(전역). 초기화가 경고 표를 비워도 처리 전이면 남긴다. */
const MANUAL_RECONCILE = 'reset:%:manual-reconcile';

export async function resetProject(db: PoolClient, input: { epoch: number; confirmName: string; keepSettings: boolean }, actor: string) {
  try {
    // M2-04 리뷰 P3-7: Runner는 한 번 알린 PR 참조를 다시 알리지 않는다. 처리 전 경고가 초기화로 사라지면 대조할 근거를 잃으므로
    // 같은 트랜잭션에서 미해결 경고를 읽어 두었다가 초기화 뒤 다시 넣는다(처리된 경고는 다른 경고처럼 지운다).
    const keep = (await db.query<{ key: string; severity: string; target: unknown; created_at: Date }>(
      'select key,severity,target,created_at from alerts where project_id is null and resolved_at is null and key like $1 order by created_at', [MANUAL_RECONCILE])).rows;
    const result = (await db.query<{ epoch: number }>('select public.reset_project($1,$2,$3,$4) as epoch', [input.epoch, input.confirmName, input.keepSettings, actor])).rows[0];
    for (const alert of keep) {
      await db.query('insert into alerts(key,severity,target,created_at) values($1,$2,$3,$4) on conflict do nothing', [alert.key, alert.severity, alert.target, alert.created_at]);
    }
    return result;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'P0002') throw new ProjectError('PROJECT_NOT_FOUND');
    if (code === '22023') throw new ProjectError('VALIDATION_FAILED', { errors: [{ path: 'confirmName', rule: 'match', message: '프로젝트 이름을 정확히 입력하세요.' }] });
    throw error;
  }
}

export async function listResets(db: PoolClient) {
  return { items: (await db.query(`select r.epoch,${iso('r.at')} at,r.actor,deleted_task_count "deletedTaskCount",keep_settings "keepSettings",
    runner_cleanup_status "runnerCleanupStatus",${iso('finished_at')} "finishedAt",
    case when runner_cleanup_status not in ('pending','running') then null
      when exists(select from runner_commands c where c.epoch=r.epoch-1 and c.status<>'done' and c.payload ? 'baseCommit')
        and exists(select from external_write_authority where state='blocked') then 'external_write_blocked'
      else 'runner' end "cleanupWaitReason"
    from reset_log r order by r.epoch desc`)).rows };
}

export async function getCommands(db: PoolClient, epoch: number) {
  // 차단 중인 원격 명령은 원장에 남겨 둔다. 권한 복구 전에는 Runner가 쓰기 명령을 받지 않는다.
  const commands = (await db.query(`select id,kind,epoch,${COMMAND_PAYLOAD_SQL} as payload from runner_commands where status<>'done'
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
