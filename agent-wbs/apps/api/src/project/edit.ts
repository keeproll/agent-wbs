import type { PoolClient } from '@awbs/db';
import { recordReplan } from '../planning/schedule.ts';
import { lockGraph } from '../tasks/write.ts';
import { TaskError } from '../tasks/errors.ts';
import { changeEvent, LEAD, requireProject, sameTime } from './db.ts';
import { ProjectError } from './errors.ts';
import { projectState } from './read.ts';

export interface ProjectEdit { updatedAt: string; name: string; description: string; startDate: string; targetDate: string | null }

/** 프로젝트 편집·이력·일정은 같은 트랜잭션에 묶는다. 재계산이 실패하면 편집만 저장되는 일을 막는다. */
export async function updateProject(client: PoolClient, body: ProjectEdit) {
  const id = (await client.query<{ id: string }>('select id from projects')).rows[0]?.id;
  if (!id) throw new ProjectError('INVALID_TRANSITION');
  // 일정 재조정도 그래프 잠금을 쓴다. Task 수정과 잠금 순서를 맞춰 서로 기다리는 고리를 막는다.
  await lockGraph(client, id);
  const project = await requireProject(client);
  if (!(await sameTime(client, project.updated_at, body.updatedAt))) {
    throw new ProjectError('VERSION_CONFLICT', { details: { current: await projectState(client), changes: [] } });
  }
  const before = (await client.query<{ name: string; description: string; startDate: string; targetDate: string | null }>(
    `select name,description,to_char(start_date,'YYYY-MM-DD') "startDate",to_char(target_date,'YYYY-MM-DD') "targetDate" from projects where id=$1`, [id])).rows[0];
  if (!before) throw new ProjectError('INVALID_TRANSITION');
  const after = { name: body.name.trim(), description: body.description, startDate: body.startDate, targetDate: body.targetDate };
  await client.query('update projects set name=$2,description=$3,start_date=$4,target_date=$5 where id=$1', [id, after.name, after.description, after.startDate, after.targetDate]);
  await client.query(`insert into task_history(project_id,actor,kind,text,before,after,ref)
    values($1,$2,'프로젝트 수정','프로젝트 정보를 수정했습니다.',$3::jsonb,$4::jsonb,'{"kind":"project"}')`, [id, LEAD, JSON.stringify(before), JSON.stringify(after)]);
  if (project.phase === 'active' && (before.startDate !== after.startDate || before.targetDate !== after.targetDate)) {
    try { await recordReplan(client, id, { trigger: '프로젝트 날짜 변경', actor: LEAD, mode: 'drift' }); }
    catch (error) {
      if (error instanceof TaskError) throw new ProjectError(error.code, { details: error.details, errors: error.errors, message: error.message });
      throw error;
    }
  }
  await changeEvent(client, id, { kind: 'project' });
  return projectState(client);
}

/** 요청 번호만 올린다. inputCheckedAt은 Runner의 관측 보고가 채운다(P4645–4651). */
export async function checkInputs(client: PoolClient, body: { updatedAt: string }) {
  const project = await requireProject(client);
  if (!(await sameTime(client, project.updated_at, body.updatedAt))) {
    throw new ProjectError('VERSION_CONFLICT', { details: { current: { updatedAt: project.updated_at }, changes: [] } });
  }
  const result = (await client.query<{ n: number }>('update projects set input_check_request=input_check_request+1 where id=$1 returning input_check_request n', [project.id])).rows[0];
  await changeEvent(client, project.id, { kind: 'input_check' });
  return { inputCheckRequest: result?.n ?? 0 };
}
