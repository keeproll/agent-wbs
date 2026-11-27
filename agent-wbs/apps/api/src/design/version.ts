import { DRIFT_COMPAT } from '@awbs/db';
import { nextNumber, type Db } from '../project/db.ts';

/** 초기 분석 확정과 개별 결정·계약 갱신이 같은 버전 번호를 이어 쓴다. */
export async function recordDesignVersion(db: Db, projectId: string, input: { snapshot?: string; key: string; kind: string; compat: keyof typeof DRIFT_COMPAT; by: string; note: string }) {
  const v = await nextNumber(db, projectId, 'design', "select coalesce(max((resolution->>'v')::int),0) from design_versions");
  await db.query('insert into design_versions(project_id,item_key,kind,compat,status,snapshot,resolution) values($1,$2,$3,$4,\'done\',$5,$6::jsonb)',
    [projectId, input.key, input.kind, DRIFT_COMPAT[input.compat], input.snapshot ?? null, JSON.stringify({ v, by: input.by, note: input.note })]);
}
