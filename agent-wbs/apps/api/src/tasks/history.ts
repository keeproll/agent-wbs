import type { PoolClient } from '@awbs/db';

export const LEAD = '팀장';
export const SYSTEM = '시스템';

export interface HistoryInput {
  projectId: string; taskId: string; kind: string; text: string; before?: unknown; after?: unknown; ref?: Record<string, unknown>; actor?: string;
}
const json = (value: unknown) => (value === undefined || value === null ? null : JSON.stringify(value));

/**
 * 추가 전용 이력(G§9.1-3). 시각은 잠금을 얻은 뒤의 실제 시각이되, DB 시계가 뒤로 가도
 * 같은 Task의 현재 버전(updated_at)보다 늦게 둔다. 버전은 갱신 트리거가 단조 증가시키므로
 * 다른 트랜잭션의 이력끼리도 순서가 유지되고, 충돌 창의 「그 뒤 변경」 목록이 이 순서를 믿는다.
 * 이력과 변경 이벤트는 업무 변경과 같은 트랜잭션에 기록한다(data-model §4).
 */
export async function record(client: PoolClient, input: HistoryInput): Promise<void> {
  await client.query(
    `insert into task_history(project_id,at,actor,task,kind,text,before,after,ref)
     values($1,greatest(clock_timestamp(),(select updated_at+interval '1 microsecond' from tasks where id=$3)),$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb)`,
    [input.projectId, input.actor ?? LEAD, input.taskId, input.kind, input.text, json(input.before), json(input.after), json(input.ref)],
  );
}
