import type { PoolClient } from '@awbs/db';
import { DRIFT_COMPAT, fromDb } from '@awbs/db';
import type { DesignItemInput, DesignSnapshotInput } from '@awbs/shared/api';
import { ApiError, isUuid } from '../changes/http.ts';
import { iso } from '../project/db.ts';
import { decisions } from '../project/read.ts';
export { decisions } from '../project/read.ts';

export interface SnapshotContent {
  hash: string;
  sequence?: number;
  itemKeys: string[];
  edges?: NonNullable<DesignSnapshotInput['edges']>;
  reported?: Pick<DesignSnapshotInput, 'edges' | 'components' | 'links' | 'ownership'>;
  components: DesignSnapshotInput['components'];
  links: DesignSnapshotInput['links'];
  ownership: DesignSnapshotInput['ownership'];
}
export interface SnapshotRow { id: string; project_id: string; commit: string; ref: string; parse_status: string; content: SnapshotContent }
export type StoredItem = DesignItemInput & { sourceCommit: string };
export interface ItemRow { id: string; item_key: string; kind: string; content: StoredItem; path: string; format: string; parse_status: string; file_content: { raw?: string; sourceCommit: string } }

export async function projectExists(db: PoolClient, id: string, lock = false) {
  if (!isUuid(id) || !(await db.query(`select 1 from projects where id=$1${lock ? ' for no key update' : ''}`, [id])).rowCount) throw new ApiError('PROJECT_NOT_FOUND');
}

export async function latestSnapshot(db: PoolClient, projectId: string, ref = 'main'): Promise<SnapshotRow | undefined> {
  return (await db.query<SnapshotRow>("select * from design_snapshots where project_id=$1 and ref=$2 order by coalesce((content->>'sequence')::bigint,0) desc,created_at desc,id desc limit 1", [projectId, ref])).rows[0];
}

export async function snapshotItems(db: PoolClient, snapshot?: SnapshotRow): Promise<ItemRow[]> {
  if (!snapshot) return [];
  return (await db.query<ItemRow>(`select i.id,i.item_key,i.kind,i.content,f.path,f.format,f.parse_status,f.content file_content
    from design_items i join design_files f on f.id=i.file where i.snapshot=$1 and i.item_key=any($2::text[]) order by i.item_key`, [snapshot.id, snapshot.content.itemKeys ?? []])).rows;
}

export async function drifts(db: PoolClient, projectId: string, ref = 'main') {
  const rows = (await db.query<{ id: string; item_key: string; kind: string; compat: string; status: string; resolution: Record<string, unknown>; updated_at: string; job_state: string | null }>(
    `select d.*,${iso('d.updated_at')} updated_at,j.state::text job_state from design_drifts d left join runner_jobs j on j.id::text=d.resolution->>'jobId'
      where d.project_id=$1 and coalesce(d.resolution->>'ref','main')=$2 order by d.created_at,d.id`, [projectId, ref])).rows;
  return rows.map(row => ({ id: row.id, displayKey: String(row.resolution.displayKey), itemKey: row.item_key, kind: row.kind, where: String(row.resolution.where ?? ''), text: String(row.resolution.text ?? ''),
    taskKey: row.resolution.taskKey ?? null, compat: fromDb(DRIFT_COMPAT, row.compat), status: row.status, updatedAt: row.updated_at,
    resolution: { ...row.resolution, ...(row.job_state ? { jobStatus: row.job_state === 'queued' ? 'queued' : ['leased', 'started', 'reconcile'].includes(row.job_state) ? 'running' : row.job_state === 'done' ? 'done' : 'failed' } : {}) } }));
}

export async function overview(db: PoolClient, projectId: string, ref = 'main') {
  const snapshot = await latestSnapshot(db, projectId, ref);
  const decs = await decisions(db, projectId);
  const diffs = await drifts(db, projectId, ref);
  const versions = (await db.query<{ resolution: { v: number; by: string; note: string }; compat: string; at: string }>(
    `select resolution,compat,${iso('created_at')} at from design_versions where project_id=$1 order by (resolution->>'v')::int desc nulls last,created_at desc`, [projectId])).rows;
  const files = snapshot ? (await db.query<{ path: string; format: string; parse_status: string; error: string | null; content: { kind: string; raw?: string; sourceCommit?: string }; item_count: number }>(
    `select f.*,(select count(*)::int from design_items i where i.file=f.id and i.item_key=any($2::text[])) item_count from design_files f where snapshot=$1 order by path`, [snapshot.id, snapshot.content.itemKeys ?? []])).rows : [];
  return { version: versions[0]?.resolution?.v ?? null, decisions: decs.length, pending: decs.filter(d => ['pending', 'change'].includes(d.status)).length,
    drifts: diffs.filter(d => d.status === 'open').length, driftItems: diffs, components: snapshot?.content.components ?? [], links: snapshot?.content.links ?? [],
    files: files.map(file => ({ path: file.path, kind: file.content.kind, format: file.format, status: file.parse_status, commit: snapshot?.commit ?? null, itemCount: file.item_count, error: file.error, raw: file.content.raw ?? null, sourceCommit: file.content.sourceCommit ?? null })),
    versions: versions.filter(v => v.resolution?.v).map(v => ({ v: v.resolution.v, at: v.at, by: v.resolution.by, note: v.resolution.note, breaking: v.compat === '깨짐' })) };
}

const INTERFACES = new Set(['REST', 'WebSocket', 'SSE', 'Kafka']);
export const itemView = (row: ItemRow, ref: string) => ({ key: row.item_key, name: row.content.name ?? row.item_key, description: row.content.description ?? null, taskKey: row.content.taskKey ?? null,
  status: row.parse_status === 'error' ? 'error' : ref === 'main' ? 'ok' : 'draft', ...(INTERFACES.has(row.kind) ? { kind: row.kind } : { store: row.kind }) });

export async function items(db: PoolClient, projectId: string, ref: string, category: 'interface' | 'data', filter?: string, key?: string) {
  const snapshot = await latestSnapshot(db, projectId, ref);
  const rows = (await snapshotItems(db, snapshot)).filter(row => (INTERFACES.has(row.kind) === (category === 'interface')) && (!filter || row.kind === filter));
  if (key === undefined) return { items: rows.map(row => itemView(row, ref)) };
  const row = rows.find(row => row.item_key === key);
  if (!row) throw new ApiError('NOT_FOUND');
  const content: Record<string, unknown> = { ...row.content.content };
  const related = snapshot?.content.edges ? snapshot.content.edges.filter(edge => edge.from === row.item_key || edge.to === row.item_key)
    .map(edge => edge.from === row.item_key ? edge.to : edge.from).filter(key => snapshot.content.itemKeys.includes(key))
    : (await db.query<{ item_key: string }>(`select i.item_key from design_edges e join design_items i on i.id=case when e.from_item=$1 then e.to_item else e.from_item end
    join design_snapshots s on s.id=i.snapshot where (e.from_item=$1 or e.to_item=$1)
    and i.item_key=any(array(select jsonb_array_elements_text(s.content->'itemKeys'))) order by i.item_key`, [row.id])).rows.map(item => item.item_key);
  if (content.type === 'REST') content.tables = [...new Set([...(content.tables as string[]), ...related.filter(key => key.startsWith('postgres:'))])];
  if (content.type === 'postgres') content.usedBy = [...new Set([...(content.usedBy as string[]), ...related.filter(key => /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) /.test(key))])];
  return { ...itemView(row, ref), source: { path: row.path, format: row.format, commit: row.content.sourceCommit,
    status: row.parse_status, raw: row.file_content.raw ?? null }, content: Object.keys(content).length ? content : null };
}
