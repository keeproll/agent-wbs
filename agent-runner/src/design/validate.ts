import { Ajv2020 } from 'ajv/dist/2020.js';
import { DESIGN_SNAPSHOT_SCHEMA } from '../api/generated/client.ts';
import { record } from './shape.ts';

const check = new Ajv2020({ strict: false, allErrors: true }).compile(DESIGN_SNAPSHOT_SCHEMA);
export interface DesignProblem { path: string; rule: string; message: string }

/** 실행 코드 공유 없이 생성에 쓴 OpenAPI 요청 스키마로 검사한다. */
export function designSnapshotProblems(value: unknown): DesignProblem[] {
  if (Buffer.byteLength(JSON.stringify(value)) > 1048576) return [{ path: '', rule: 'maxBytes', message: '설계 보고는 UTF-8 JSON 1 MiB 이하여야 합니다.' }];
  if (!check(value)) return (check.errors ?? []).map(e => ({ path: e.instancePath, rule: e.keyword, message: e.message ?? '계약 위반' }));
  const body = record(value), files = body.files as { path: string; status: string; error?: string }[], items = body.items as { itemKey: string; path: string; contract?: { fields: { path: string }[] }; extracted?: { fields: { path: string }[] } | null }[], drifts = body.drifts as { itemKey: string }[];
  const problems: DesignProblem[] = [];
  const mark = (path: string, rule: string) => problems.push({ path, rule, message: '설계 보고의 항목 또는 참조를 확인하세요.' });
  const unique = (values: string[], path: string) => {
    const seen = new Set<string>();
    values.forEach((value, i) => { if (seen.has(value)) mark(`${path}.${String(i)}`, 'unique'); seen.add(value); });
  };
  unique(files.map(f => f.path), 'files'); unique(items.map(i => i.itemKey), 'items'); unique(drifts.map(d => d.itemKey), 'drifts');
  files.forEach((f, i) => {
    if (!f.path.startsWith('contracts/')) mark(`files.${String(i)}.path`, 'contractPath');
    if (f.status === 'error' && !f.error) mark(`files.${String(i)}.error`, 'required');
  });
  items.forEach((item, i) => {
    if (!files.some(f => f.path === item.path && f.status !== 'error')) mark(`items.${String(i)}.path`, 'reference');
    for (const key of ['contract', 'extracted'] as const) {
      const fields = item[key]?.fields;
      if (fields) unique(fields.map(f => f.path), `items.${String(i)}.${key}.fields`);
    }
  });
  const keys = new Set(items.map(i => i.itemKey));
  for (const [i, edge] of ((body.edges ?? []) as { from: string; to: string }[]).entries()) if (!keys.has(edge.from) || !keys.has(edge.to)) mark(`edges.${String(i)}`, 'reference');
  drifts.forEach((d, i) => { if (!keys.has(d.itemKey)) mark(`drifts.${String(i)}.itemKey`, 'reference'); });
  return problems;
}

export function assertDesignSnapshot(value: unknown): void {
  const errors = designSnapshotProblems(value);
  if (errors.length) throw new Error(`설계 보고 계약 오류: ${errors.map(e => `${e.path} ${e.rule}`).join(', ')}`);
}
