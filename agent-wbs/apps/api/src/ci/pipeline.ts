import type { PoolClient } from '@awbs/db';
import { PlatformError } from '../platform/errors.ts';
import { deferChange } from '../changes/events.ts';

export interface PipelineDefinition {
  path: '.agentwbs/pipeline.yaml'; commit: string | null; status: 'ok' | 'error' | 'missing'; error: string | null; raw: string | null;
  stages: { stage: 'task' | 'int' | 'night' | 'deploy'; when: string; gate: string; steps: string[] }[] | null;
}
export interface PipelineObservation { baseSha: string; pipelineSha: string | null; definition: PipelineDefinition }

/** 같은 Runner의 별도 main 관측을 믿되, CI 실행 보고가 첫 관측을 덮어쓰지 못하게 한다. */
export async function observePipeline(client: Pick<PoolClient,'query'>, project: string, head: string, observation: PipelineObservation) {
  if (observation.baseSha !== head || observation.definition.commit !== head || observation.definition.status === 'ok' && (!observation.pipelineSha || observation.definition.raw === null || observation.definition.stages === null)) throw new PlatformError('VALIDATION_FAILED');
  if (observation.definition.status !== 'ok') return;
  // shortcut: 프로젝트 JSON에 첫 관측을 보관한다, 관측 이력이 커지면 별도 원장 표로 옮긴다.
  const saved = await client.query(`update projects set pipeline_observations=jsonb_set(pipeline_observations,array[$2],$3::jsonb)
    where id=$1 and not (pipeline_observations ? $2)`,[project,head,JSON.stringify(observation)]);
  if (saved.rowCount) deferChange(client,project,'ci',{ key:'pipeline' });
}

export async function pipelineDefinition(client: PoolClient, project: string, head: string) {
  const row = (await client.query<{ observation: PipelineObservation | null }>('select pipeline_observations->$2 observation from projects where id=$1',[project,head])).rows[0];
  return row?.observation?.definition ?? { path:'.agentwbs/pipeline.yaml',commit:head,status:'missing',error:null,raw:null,stages:null };
}

/** 사슬의 main 부모도 이 프로젝트에서 성공 관측한 커밋이어야 한다. */
export async function observedBases(client: PoolClient, project: string): Promise<string[]> {
  return (await client.query<{ sha: string }>(`select key sha from projects p,jsonb_each(p.pipeline_observations) o where p.id=$1 and o.value->'definition'->>'status'='ok'`,[project])).rows.map(r => r.sha);
}
