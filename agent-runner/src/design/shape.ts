import type { ApiRequest } from '../api/client.ts';

export type DesignSnapshot = ApiRequest<'reportDesignSnapshot'>['body'];
export type DesignItem = DesignSnapshot['items'][number];
export type DesignShape = NonNullable<DesignItem['contract']>;
export type DesignDifference = Pick<DesignSnapshot['drifts'][number], 'compat' | 'where' | 'text'>;
export const DESIGN_LIMITS = { fields: 5000, depth: 64, shapeBytes: 512 * 1024, fileBytes: 262144, reportBytes: 1048576, parseMs: 1000, extractMs: 1000, totalMs: 10_000 } as const;
export interface ShapeBudget { fields: number; bytes: number; deadline: number }
export const shapeBudget = (): ShapeBudget => ({ fields: 0, bytes: 0, deadline: performance.now() + DESIGN_LIMITS.parseMs });

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('객체 형식이 아닙니다.');
  return value as Record<string, unknown>;
}
export const pointer = (value: string): string => value.replaceAll('~', '~0').replaceAll('/', '~1');

export function validShape(value: unknown): value is DesignShape {
  try {
    const fields = record(value).fields;
    if (!Array.isArray(fields) || fields.length > DESIGN_LIMITS.fields) return false;
    const paths = new Set<string>();
    let bytes = 0;
    for (const field of fields) {
      const f = record(field);
      if (typeof f.path !== 'string' || f.path.length > 4096 || !/^\/(?:[^~]|~[01])*$/.test(f.path) || paths.has(f.path) || typeof f.type !== 'string' || f.type.length > 4096 || !f.type.trim() || typeof f.required !== 'boolean') return false;
      bytes += Buffer.byteLength(f.path) + Buffer.byteLength(f.type) + 48;
      if (bytes > DESIGN_LIMITS.shapeBytes) return false;
      paths.add(f.path);
    }
    return true;
  } catch { return false; }
}

/** Q-c: 요청은 받는 쪽, 응답·메시지는 소비하는 쪽의 호환성을 본다. 최종 판정은 서버다. */
export function compareShapes(contract: unknown, extracted: unknown, kind = 'postgres'): DesignDifference | null {
  if (!validShape(contract) || !validShape(extracted)) return { compat: 'unchecked', where: '/', text: '대조 안 함: 계약 또는 실제 명세를 추출하지 못했습니다.' };
  const before = new Map(contract.fields.map(f => [f.path, f]));
  const after = new Map(extracted.fields.map(f => [f.path, f]));
  const direction = (path: string) => kind === 'REST' ? path.startsWith('/responses/') ? 'response' : 'request' : ['Kafka', 'WebSocket', 'SSE'].includes(kind) ? 'response' : 'data';
  const changes: string[] = [];
  let breaking = false;
  for (const f of contract.fields) {
    const next = after.get(f.path), side = direction(f.path);
    if (!next && side !== 'request' || next && (next.type !== f.type || side === 'response' && f.required && !next.required || side !== 'response' && !f.required && next.required)) breaking = true;
    if (!next || next.type !== f.type || next.required !== f.required) changes.push(f.path);
  }
  for (const f of extracted.fields) if (!before.has(f.path)) {
    changes.push(f.path);
    if (f.required && direction(f.path) !== 'response') breaking = true;
  }
  return changes.length ? { compat: breaking ? 'breaking' : 'compatible', where: changes.join(', '), text: '계약 파일과 실제 명세의 필드가 다릅니다.' } : null;
}

const references = new WeakMap<object, WeakMap<object, Record<string, unknown>>>();
export function dereference(value: unknown, root: unknown, seen = new Set<unknown>()): Record<string, unknown> {
  const obj = record(value);
  if (obj.$ref === undefined) return obj;
  const doc = record(root);
  let cache = references.get(doc);
  if (!cache) { cache = new WeakMap(); references.set(doc, cache); }
  const known = cache.get(obj);
  if (known) return known;
  if (seen.size >= DESIGN_LIMITS.depth || seen.has(obj) || typeof obj.$ref !== 'string' || !obj.$ref.startsWith('#/')) throw new Error('지역 참조를 해석할 수 없습니다.');
  seen.add(obj);
  let target: unknown = doc;
  for (const part of obj.$ref.slice(2).split('/')) {
    if (/~(?![01])/.test(part)) throw new Error('참조 주소가 잘못되었습니다.');
    const name = part.replaceAll('~1', '/').replaceAll('~0', '~'), parent = record(target);
    if (!Object.hasOwn(parent, name)) throw new Error('참조 대상이 없습니다.');
    target = parent[name];
  }
  if (Object.keys(obj).some(key => !['$ref', 'summary', 'description'].includes(key))) throw new Error('참조의 추가 규칙은 대조 안 함입니다.');
  const resolved = dereference(target, doc, seen);
  cache.set(obj, resolved);
  return resolved;
}

const templates = new WeakMap<object, Map<unknown, DesignShape['fields'] | Error>>();
const KEYS = new Set(['type', 'properties', 'required', 'items', 'additionalProperties', 'enum', 'const', 'format', '$schema', '$defs', 'definitions', 'title', 'description', 'default', 'examples', 'example', 'deprecated']);

function canonical(value: unknown, depth = 0): string {
  if (depth > 32) throw new Error('타입 지문이 너무 깊습니다.');
  if (Array.isArray(value)) return `[${value.map(v => canonical(v, depth + 1)).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(record(value)).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v, depth + 1)}`).join(',')}}`;
  return JSON.stringify(value);
}

function compile(schema: unknown, root: unknown, cache: Map<unknown, DesignShape['fields'] | Error>, seen: Set<unknown>, deadline: number): DesignShape['fields'] {
  if (performance.now() > deadline || seen.size >= DESIGN_LIMITS.depth || seen.has(schema)) throw new Error('스키마 해석 시간·깊이 상한 또는 순환 참조입니다.');
  const resolved = typeof schema === 'boolean' ? schema : dereference(schema, root);
  const known = cache.get(resolved);
  if (known instanceof Error) throw known;
  if (known) return known;
  const visited = new Set(seen).add(schema).add(resolved);
  try {
    if (typeof resolved === 'boolean') return [{ path: '', type: resolved ? 'any' : 'never', required: false }];
    if (Object.keys(resolved).some(key => !KEYS.has(key))) throw new Error('알 수 없는 스키마 키워드입니다.');
    if (resolved.type === undefined) throw new Error('type 없는 스키마는 대조 안 함입니다.');
    if (resolved.type === 'any' || Array.isArray(resolved.type) && resolved.type.includes('any')) throw new Error('JSON Schema의 타입이 아닙니다.');
    const types: unknown[] = Array.isArray(resolved.type) ? resolved.type : [resolved.type];
    if (!types.length || types.some(t => typeof t !== 'string' || !['any', 'null', 'object', 'array', 'string', 'number', 'integer', 'boolean'].includes(t))) throw new Error('필드 타입이 올바르지 않습니다.');
    const fingerprint: Record<string, unknown> = {};
    if (resolved.enum !== undefined) {
      if (!Array.isArray(resolved.enum) || !resolved.enum.length) throw new Error('enum이 올바르지 않습니다.');
      fingerprint.enum = [...new Set(resolved.enum.map(v => canonical(v)))].sort();
    }
    if ('const' in resolved) fingerprint.const = resolved.const;
    if ('format' in resolved) {
      if (typeof resolved.format !== 'string') throw new Error('format이 올바르지 않습니다.');
      fingerprint.format = resolved.format;
    }
    const type = [...new Set(types)].sort().join('|') + (Object.keys(fingerprint).length ? `:${canonical(fingerprint)}` : '');
    const fields = [{ path: '', type, required: false }];
    let bytes = Buffer.byteLength(type) + 48;
    const append = (child: unknown, path: string, required: boolean) => {
      for (const f of compile(child, root, cache, visited, deadline)) {
        const next = { ...f, path: path + f.path, required: f.path ? f.required : required };
        bytes += Buffer.byteLength(next.path) + Buffer.byteLength(next.type) + 48;
        if (fields.length >= DESIGN_LIMITS.fields || bytes > DESIGN_LIMITS.shapeBytes || performance.now() > deadline) throw new Error('스키마 크기·시간 상한을 넘었습니다.');
        fields.push(next);
      }
    };
    if (resolved.required !== undefined && (!Array.isArray(resolved.required) || resolved.required.some(k => typeof k !== 'string'))) throw new Error('필수 목록이 올바르지 않습니다.');
    const required = new Set(resolved.required as string[] | undefined);
    for (const [name, child] of Object.entries(resolved.properties === undefined ? {} : record(resolved.properties))) {
      append(child, `/${pointer(name)}`, required.has(name)); required.delete(name);
    }
    if (required.size) throw new Error('정의 없는 필수 필드입니다.');
    if (types.includes('array')) append(resolved.items ?? true, '/*', false);
    if (resolved.additionalProperties !== undefined) append(resolved.additionalProperties, '/**', false);
    if (new Set(fields.map(f => f.path)).size !== fields.length) throw new Error('필드 주소가 충돌합니다.');
    cache.set(resolved, fields);
    return fields;
  } catch (error) {
    const failure = error instanceof Error ? error : new Error('스키마를 해석하지 못했습니다.');
    cache.set(resolved, failure); throw failure;
  }
}

/** 상대 필드 템플릿과 실패를 재사용한다. 같은 참조를 항목마다 지수적으로 펼치지 않는다. */
export function schemaFields(schema: unknown, root: unknown, path: string, required: boolean, budget = shapeBudget()): DesignShape['fields'] {
  const doc = record(root);
  let cache = templates.get(doc);
  if (!cache) { cache = new Map(); templates.set(doc, cache); }
  const fields = compile(schema, doc, cache, new Set(), budget.deadline);
  budget.fields += fields.length;
  budget.bytes += fields.reduce((n, f) => n + Buffer.byteLength(path + f.path) + Buffer.byteLength(f.type) + 48, 0);
  if (budget.fields > DESIGN_LIMITS.fields || budget.bytes > DESIGN_LIMITS.shapeBytes) throw new Error('항목의 필드·크기 상한을 넘었습니다.');
  return fields.map(f => ({ ...f, path: path + f.path, required: f.path ? f.required : required }));
}
