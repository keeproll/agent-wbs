import type { PoolClient } from '@awbs/db';
import { PlatformError } from '../platform/errors.ts';
import { deferChange } from '../changes/events.ts';

export interface PipelineDefinition {
  serviceConfig?: { path:string;commit:string;status:'ok'|'missing'|'error';raw:string|null;error:string|null };
  path: '.agentwbs/pipeline.yaml'; commit: string | null; status: 'ok' | 'error' | 'missing'; error: string | null; raw: string | null;
  stages: { stage: 'task' | 'int' | 'night' | 'deploy'; when: string; gate: string; steps: string[] }[] | null;
}
export interface PipelineObservation { baseSha: string; pipelineSha: string | null; definition: PipelineDefinition }

/** 같은 Runner의 별도 main 관측을 믿되, CI 실행 보고가 첫 관측을 덮어쓰지 못하게 한다. */
export async function observePipeline(client: Pick<PoolClient,'query'>, project: string, head: string, observation: PipelineObservation) {
  if (observation.baseSha !== head || observation.definition.commit !== head || observation.definition.status === 'ok' && (!observation.pipelineSha || observation.definition.raw === null || observation.definition.stages === null)) throw new PlatformError('VALIDATION_FAILED');
  if (observation.definition.serviceConfig && (observation.definition.serviceConfig.commit !== head || observation.definition.serviceConfig.status === 'ok' && observation.definition.serviceConfig.raw === null)) throw new PlatformError('VALIDATION_FAILED');
  if (observation.definition.status !== 'ok') return;
  // shortcut: 프로젝트 JSON에 첫 관측을 보관한다, 관측 이력이 커지면 별도 원장 표로 옮긴다.
  const saved = await client.query(`update projects set pipeline_observations=jsonb_set(pipeline_observations,array[$2],$3::jsonb)
    where id=$1 and (not (pipeline_observations ? $2) or pipeline_observations->$2->'definition'->>'status' is distinct from 'ok')`,[project,head,JSON.stringify(observation)]);
  let changed = Boolean(saved.rowCount);
  if (!changed && observation.definition.serviceConfig) {
    // 구형 Runner의 빈 선택 칸만 보충한다. 같은 main의 첫 정의와 첫 서비스 구성은 고정한다.
    const enriched = await client.query(`update projects set pipeline_observations=jsonb_set(pipeline_observations,array[$2,'definition','serviceConfig'],$4::jsonb)
      where id=$1 and pipeline_observations->$2->>'pipelineSha'=$3 and pipeline_observations->$2->'definition'->'serviceConfig' is null`,
    [project,head,observation.pipelineSha,JSON.stringify(observation.definition.serviceConfig)]);
    changed = Boolean(enriched.rowCount);
  }
  if (changed) deferChange(client,project,'ci',{ key:'pipeline' });
}

export async function pipelineDefinition(client: PoolClient, project: string, head: string): Promise<PipelineDefinition> {
  const row = (await client.query<{ observation: PipelineObservation | null }>('select pipeline_observations->$2 observation from projects where id=$1',[project,head])).rows[0];
  return row?.observation?.definition ?? { path:'.agentwbs/pipeline.yaml',commit:head,status:'missing',error:null,raw:null,stages:null };
}

/** 수용한 main 원장의 조상→자손 순서다. 원장과 이어지지 않는 관측은 증거로 쓰지 않는다. */
export async function observedBases(client: PoolClient, project: string): Promise<string[]> {
  return (await client.query<{ sha: string }>(`with recursive history(sha,seq,path) as (
    select commit_sha,0::bigint,array[commit_sha] from input_versions where project_id=$1 and v=1
    union all
    select c.sha,(c.files->>'seq')::bigint,h.path||c.sha from history h join input_change_commits c
      on c.project_id=$1 and c.files->>'base'=h.sha where (c.files->>'seq')::bigint>h.seq and not c.sha=any(h.path)
  ) select o.key sha from projects p,jsonb_each(p.pipeline_observations) o,history h
    where p.id=$1 and o.key=h.sha and o.value->'definition'->>'status'='ok' order by h.seq`,[project])).rows.map(r => r.sha);
}
