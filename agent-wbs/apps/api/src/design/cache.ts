import { createHash } from 'node:crypto';
import type { PoolClient } from '@awbs/db';
import type { DesignItemInput, DesignShapeInput, DesignSnapshotInput } from '@awbs/shared/api';
import { ApiError, invalid } from '../changes/http.ts';
import { snapshotItems, type SnapshotRow } from './read.ts';

/** RFC 8785: 숫자·문자열 표기는 JSON.stringify, 객체 키는 UTF-16 순서다. 잘못된 Unicode는 해시하지 않는다. */
export function designJson(value: unknown): string {
  if (typeof value === 'string' && !value.isWellFormed() || typeof value === 'number' && !Number.isFinite(value) || value === undefined) {
    throw invalid([{ path: '', rule: 'jcs', message: 'JCS(같은 JSON을 같은 글자로 만드는 규칙)로 표현할 수 없는 값입니다.' }]);
  }
  if (Array.isArray(value)) return `[${value.map(designJson).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${designJson(key)}:${designJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function ordered<T>(values: readonly T[], keys: (value: T) => string[]): T[] {
  return [...values].sort((a, b) => {
    const left = [...keys(a), designJson(a)], right = [...keys(b), designJson(b)];
    for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return String(left[i]) < String(right[i]) ? -1 : 1;
    return 0;
  });
}
const shape = (value?: DesignShapeInput | null) => value ? { fields: ordered(value.fields, field => [field.path]) } : null;
export const normalizedItem = (item: DesignItemInput | null) => {
  if (!item) return null;
  const content: Record<string, unknown> = { ...item.content };
  const key = item.kind === 'REST' ? 'tables' : item.kind === 'postgres' ? 'usedBy' : 'decisionKeys';
  if (Array.isArray(content[key])) content[key] = [...content[key]].sort();
  return {
    itemKey: item.itemKey, kind: item.kind, path: item.path, name: item.name ?? null, description: item.description ?? null, taskKey: item.taskKey ?? null,
    content, contract: shape(item.contract), extracted: shape(item.extracted),
  };
};
export const designHash = (value: unknown) => createHash('sha256').update(designJson(value)).digest('hex');

interface File { path: string; kind: string; format: string; status: string; error?: string | null; raw?: string | null }
type Report = Omit<DesignSnapshotInput, 'jobId' | 'fence' | 'files' | 'drifts'> & { files: File[] };
export function normalizedSnapshot(body: Report) {
  return {
    commit: body.commit, ref: body.ref,
    files: ordered(body.files.map(file => ({ ...file, status: file.status === 'error' ? 'error' : body.ref === 'main' ? file.status : 'draft', error: file.error ?? null, raw: file.raw ?? null })), file => [file.path]),
    items: ordered(body.items.map(item => ({ ...normalizedItem(item) })), item => [item.itemKey ?? '']),
    edges: ordered(body.edges ?? [], edge => [edge.from, edge.to, edge.kind]),
    ownership: ordered(body.ownership ?? [], owner => [owner.data, owner.source, owner.copy, owner.sync, owner.lag]),
    components: ordered(body.components ?? [], component => [component.id]),
    links: ordered(body.links ?? [], link => [link.from, link.to, link.via, link.contractPath ?? '']),
  };
}

/** 같은 커밋의 대조 결과만 올린다. 파일 읽기 재시도도 이미 대조한 다른 파일은 바꾸지 못한다. */
export async function checkCachedSnapshot(db: PoolClient, cached: SnapshotRow, body: DesignSnapshotInput): Promise<boolean> {
  const rows = await snapshotItems(db, cached);
  const files = (await db.query<{ path: string; format: string; parse_status: string; error: string | null; content: { kind: string; raw?: string; reported?: { kind: string; raw?: string } } }>('select path,format,parse_status,error,content from design_files where snapshot=$1', [cached.id])).rows;
  const edges = cached.content.reported?.edges ?? (await db.query<{ from: string; to: string; kind: string }>(`select a.item_key "from",b.item_key "to",e.kind from design_edges e
    join design_items a on a.id=e.from_item join design_items b on b.id=e.to_item where e.snapshot=$1
    and a.item_key=any($2::text[]) and b.item_key=any($2::text[])`, [cached.id, cached.content.itemKeys ?? []])).rows;
  const metadata = cached.content.reported ?? cached.content;
  const before = normalizedSnapshot({ components: metadata.components ?? [], links: metadata.links ?? [], ownership: metadata.ownership ?? [], edges, commit: cached.commit, ref: cached.ref,
    items: rows.filter(row => row.parse_status !== 'error').map(row => row.content), files: files.map(file => ({ path: file.path, kind: (file.content.reported ?? file.content).kind, format: file.format, status: file.parse_status, error: file.error, raw: (file.content.reported ?? file.content).raw ?? null })) });
  const after = normalizedSnapshot(body);
  if (designJson(before) === designJson(after)) return true;
  const recovered = new Set(files.filter(file => file.parse_status === 'error' && body.files.some(next => next.path === file.path && next.status !== 'error')).map(file => file.path));
  const recoveredKeys = new Set([...rows.filter(row => recovered.has(row.path)).map(row => row.item_key), ...body.items.filter(item => recovered.has(item.path)).map(item => item.itemKey)]);
  const conflicts: { itemKey: string; serverState: 'checked' | 'unchecked'; serverContentHash: string; commit: string; ref: string }[] = [];
  let upgraded = false;
  const incoming = new Map(body.items.map(item => [item.itemKey, item]));
  for (const row of rows) {
    if (row.parse_status === 'error') continue;
    const next = incoming.get(row.item_key) ?? null, old = row.content;
    const oldItem = normalizedItem(old), nextItem = normalizedItem(next);
    if (designJson(oldItem) === designJson(nextItem)) continue;
    const checked = Boolean(old.contract && old.extracted);
    if (next && !checked && next.contract && next.extracted
      && designJson({ ...oldItem, contract: null, extracted: null }) === designJson({ ...nextItem, contract: null, extracted: null })
      && (!old.contract || designJson(shape(old.contract)) === designJson(shape(next.contract)))
      && (!old.extracted || designJson(shape(old.extracted)) === designJson(shape(next.extracted)))) upgraded = true;
    else conflicts.push({ itemKey: row.item_key, serverState: checked ? 'checked' : 'unchecked', serverContentHash: designHash(oldItem), commit: cached.commit, ref: cached.ref });
  }
  // M6 통합(M6-05 리뷰2 P3-1): 항목을 하나도 못 낸 정상 파일은 파일 전체가 unchecked(`file:<path>`)다.
  // 같은 커밋에서 그 파일의 항목을 대조해 보내면, 대조된(contract·extracted가 모두 있는) 새 항목만 upgrade로 받는다.
  // 왜: Q-b는 「대조 못 함 → 대조함」을 같은 커밋에서 허용한다. 파일 단위 unchecked도 「대조 못 함」이다. 대조 못 한 새 항목은 정보가 늘지 않으므로 계속 막는다.
  const emptyFiles = new Set(files.filter(file => file.parse_status !== 'error' && !rows.some(row => row.path === file.path)).map(file => file.path));
  const filledKeys = new Set<string>();
  for (const item of body.items) if (!rows.some(row => row.item_key === item.itemKey) && !recovered.has(item.path)) {
    if (emptyFiles.has(item.path) && item.contract && item.extracted) { upgraded = true; filledKeys.add(item.itemKey); continue; }
    conflicts.push({ itemKey: item.itemKey, serverState: 'unchecked', serverContentHash: designHash(null), commit: cached.commit, ref: cached.ref });
  }
  const stableEdges = (edges: typeof before.edges) => edges.filter(edge => ![edge.from, edge.to].some(key => recoveredKeys.has(key) || filledKeys.has(key)));
  const stable = { ...before, items: [], edges: stableEdges(before.edges), files: before.files.map(file => recovered.has(file.path) ? after.files.find(next => next.path === file.path) : file) };
  if (conflicts.length || !upgraded && !recovered.size || designJson(stable) !== designJson({ ...after, items: [], edges: stableEdges(after.edges) })) {
    throw new ApiError('VERSION_CONFLICT', { conflicts: conflicts.sort((a, b) => a.itemKey < b.itemKey ? -1 : a.itemKey > b.itemKey ? 1 : 0) }, [], '같은 커밋은 대조하지 못한 결과를 대조된 결과로 올릴 때만 바꿀 수 있습니다.');
  }
  return false;
}
