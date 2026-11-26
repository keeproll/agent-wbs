import type { ApiRequest } from '../api/client.ts';

export type DesignSnapshot = ApiRequest<'reportDesignSnapshot'>['body'];
export type DesignItem = DesignSnapshot['items'][number];
export type DesignShape = NonNullable<DesignItem['contract']>;
export type DesignDifference = Pick<DesignSnapshot['drifts'][number], 'compat' | 'where' | 'text'>;

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('객체 형식이 아닙니다.');
  return value as Record<string, unknown>;
}

export const pointer = (value: string): string => value.replaceAll('~', '~0').replaceAll('/', '~1');

export function validShape(value: unknown): value is DesignShape {
  try {
    const fields = record(value).fields;
    if (!Array.isArray(fields)) return false;
    const paths = new Set<string>();
    for (const field of fields) {
      const f = record(field);
      if (typeof f.path !== 'string' || !/^\/(?:[^~]|~[01])*$/.test(f.path) || paths.has(f.path) ||
        typeof f.type !== 'string' || !f.type.trim() || typeof f.required !== 'boolean') return false;
      paths.add(f.path);
    }
    return true;
  } catch { return false; }
}

/** 참고값만 계산한다. 서버가 원래 필드 목록으로 다시 판정한다. */
export function compareShapes(contract: unknown, extracted: unknown): DesignDifference | null {
  if (!validShape(contract) || !validShape(extracted)) return { compat: 'unchecked', where: '/', text: '대조 안 함: 계약 또는 실제 명세를 추출하지 못했습니다.' };
  const before = new Map(contract.fields.map(f => [f.path, f]));
  const after = new Map(extracted.fields.map(f => [f.path, f]));
  const changes: string[] = [];
  let breaking = false;
  for (const f of contract.fields) {
    const next = after.get(f.path);
    if (!next || next.type !== f.type || (!f.required && next.required)) breaking = true;
    if (!next || next.type !== f.type || next.required !== f.required) changes.push(f.path);
  }
  for (const f of extracted.fields) if (!before.has(f.path)) {
    changes.push(f.path);
    if (f.required) breaking = true;
  }
  return changes.length ? { compat: breaking ? 'breaking' : 'compatible', where: changes.join(', '), text: '계약 파일과 실제 명세의 필드가 다릅니다.' } : null;
}

/** 외부 참조를 읽거나 저장소 코드를 실행하지 않는다. */
export function dereference(value: unknown, root: unknown, seen = new Set<unknown>()): Record<string, unknown> {
  const obj = record(value);
  if (obj.$ref === undefined) return obj;
  if (seen.has(obj) || typeof obj.$ref !== 'string' || !obj.$ref.startsWith('#/')) throw new Error('지역 참조를 해석할 수 없습니다.');
  seen.add(obj);
  let target = root;
  for (const part of obj.$ref.slice(2).split('/')) {
    const name = part.replaceAll('~1', '/').replaceAll('~0', '~');
    const parent = record(target);
    if (!Object.hasOwn(parent, name)) throw new Error('참조 대상이 없습니다.');
    target = parent[name];
  }
  if (Object.keys(obj).some(key => !['$ref', 'summary', 'description'].includes(key))) throw new Error('참조와 함께 있는 추가 규칙은 대조 안 함입니다.');
  return dereference(target, root, seen);
}

export function schemaFields(schema: unknown, root: unknown, path: string, required: boolean, seen = new Set<unknown>()): DesignShape['fields'] {
  if (seen.size >= 64 || seen.has(schema)) throw new Error('순환하거나 너무 깊은 스키마입니다.');
  const visited = new Set(seen).add(schema);
  if (typeof schema === 'boolean') return [{ path, type: schema ? 'any' : 'never', required }];
  const obj = dereference(schema, root);
  // shortcut: 조합·동적 JSON Schema는 대조 안 함이다. 해당 형식 채택 뒤 전용 해석기를 연결한다.
  if (['allOf', 'oneOf', 'anyOf', 'not', 'if', '$dynamicRef', 'patternProperties', 'dependentSchemas', 'prefixItems', 'unevaluatedProperties'].some(k => k in obj)) {
    throw new Error('지원하지 않는 스키마 규칙입니다.');
  }
  const types: unknown[] = Array.isArray(obj.type) ? obj.type : [obj.type ?? (obj.properties ? 'object' : 'any')];
  if (!types.length || types.some(t => typeof t !== 'string' || !['any', 'null', 'object', 'array', 'string', 'number', 'integer', 'boolean'].includes(t))) throw new Error('필드 타입이 올바르지 않습니다.');
  const fields = [{ path, type: [...new Set(types)].sort().join('|'), required }];
  if (obj.required !== undefined && (!Array.isArray(obj.required) || obj.required.some(k => typeof k !== 'string'))) throw new Error('필수 필드 목록이 올바르지 않습니다.');
  const requiredKeys = new Set(obj.required as string[] | undefined);
  for (const [name, child] of Object.entries(obj.properties === undefined ? {} : record(obj.properties))) {
    fields.push(...schemaFields(child, root, `${path}/${pointer(name)}`, requiredKeys.has(name), visited));
    requiredKeys.delete(name);
  }
  if (requiredKeys.size) throw new Error('정의 없는 필수 필드는 대조 안 함입니다.');
  if (types.includes('array')) fields.push(...schemaFields(obj.items ?? true, root, `${path}/*`, false, visited));
  if (obj.additionalProperties !== undefined) fields.push(...schemaFields(obj.additionalProperties, root, `${path}/**`, false, visited));
  return fields;
}
