import { readFileSync } from 'node:fs';
import { OPERATIONS } from '../../src/api/generated/client.ts';
import type { OperationId } from '../../src/api/client.ts';

/*
 * 계약 문서(agent-wbs/contracts/openapi.json)의 요청 본문 스키마로 Runner가 보낸 본문을 검사한다.
 * Runner는 WBS 소스를 가져오지 않으므로(Runner·WBS 소스 분리) 시험용 최소 JSON Schema 검사기를 둔다.
 * 계약 문서가 쓰는 키워드만 처리하고, 모르는 키워드가 나오면 시험을 실패시킨다(조용히 통과하지 않게).
 */
type Schema = Record<string, unknown>;
interface Document { paths: Record<string, Record<string, { requestBody?: { content: Record<string, { schema: Schema }> } }>>; components: { schemas: Record<string, Schema> } }

const document = JSON.parse(readFileSync(new URL('../../../agent-wbs/contracts/openapi.json', import.meta.url), 'utf8')) as Document;
const KNOWN = new Set(['$ref', 'anyOf', 'const', 'enum', 'format', 'maxItems', 'maxLength', 'maximum', 'minItems', 'minLength', 'minimum', 'exclusiveMinimum',
  'pattern', 'patternProperties', 'properties', 'required', 'type', 'uniqueItems', 'additionalProperties', 'items', 'title', 'description', 'minProperties', 'nullable', 'default']);

function resolve(schema: Schema): Schema {
  const ref = schema.$ref;
  if (typeof ref !== 'string') return schema;
  const name = ref.replace('#/components/schemas/', '');
  const target = document.components.schemas[name];
  if (!target) throw new Error(`스키마 ${ref}를 찾지 못했습니다.`);
  return resolve(target);
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

export function errorsOf(input: Schema, value: unknown, path = '$'): string[] {
  const schema = resolve(input);
  for (const key of Object.keys(schema)) if (!KNOWN.has(key)) throw new Error(`시험 검사기가 모르는 스키마 키워드: ${key} (${path})`);
  if (Array.isArray(schema.anyOf)) {
    const branches = (schema.anyOf as Schema[]).map((branch) => errorsOf(branch, value, path));
    return branches.some((e) => e.length === 0) ? [] : [`${path}: 어느 형태와도 맞지 않음 (${branches.map((e) => e[0]).join(' | ')})`];
  }
  const errors: string[] = [];
  if ('const' in schema && value !== schema.const) errors.push(`${path}: ${JSON.stringify(schema.const)}이어야 함`);
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) errors.push(`${path}: 허용값 아님 ${JSON.stringify(value)}`);
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type as string[] : [schema.type as string];
    const actual = typeOf(value);
    if (!types.includes(actual) && !(actual === 'integer' && types.includes('number'))) return [...errors, `${path}: ${types.join('|')} 아님(${actual})`];
  }
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) errors.push(`${path}: 너무 짧음`);
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) errors.push(`${path}: 너무 김`);
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(value)) errors.push(`${path}: 형식 ${schema.pattern} 아님 (${value})`);
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) errors.push(`${path}: 최솟값 미만`);
    if (typeof schema.maximum === 'number' && value > schema.maximum) errors.push(`${path}: 최댓값 초과`);
    if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) errors.push(`${path}: 초과 조건 위반`);
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) errors.push(`${path}: 항목 ${String(schema.minItems)}개 이상 필요`);
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) errors.push(`${path}: 항목 ${String(schema.maxItems)}개 이하`);
    if (schema.uniqueItems === true && new Set(value.map((v) => JSON.stringify(v))).size !== value.length) errors.push(`${path}: 중복 항목`);
    if (schema.items) value.forEach((item, i) => errors.push(...errorsOf(schema.items as Schema, item, `${path}[${String(i)}]`)));
  }
  if (typeOf(value) === 'object') {
    const object = value as Record<string, unknown>;
    const properties = (schema.properties ?? {}) as Record<string, Schema>;
    for (const name of (schema.required ?? []) as string[]) if (!(name in object)) errors.push(`${path}.${name}: 필수`);
    if (typeof schema.minProperties === 'number' && Object.keys(object).length < schema.minProperties) errors.push(`${path}: 속성 부족`);
    for (const [name, item] of Object.entries(object)) {
      if (item === undefined) continue;
      if (properties[name]) { errors.push(...errorsOf(properties[name], item, `${path}.${name}`)); continue; }
      const pattern = Object.entries((schema.patternProperties ?? {}) as Record<string, Schema>).find(([p]) => new RegExp(p, 'u').test(name));
      if (pattern) { errors.push(...errorsOf(pattern[1], item, `${path}.${name}`)); continue; }
      if (schema.additionalProperties === false) errors.push(`${path}.${name}: 계약에 없는 필드`);
      else if (typeof schema.additionalProperties === 'object') errors.push(...errorsOf(schema.additionalProperties as Schema, item, `${path}.${name}`));
    }
  }
  return errors;
}

/** operationId의 요청 본문 스키마 오류 목록. 본문이 없는 operation이면 빈 목록이다. */
export function bodyErrors(id: OperationId, body: unknown): string[] {
  const op = OPERATIONS[id] as { method: string; path: string };
  const schema = document.paths[op.path]?.[op.method.toLowerCase()]?.requestBody?.content['application/json']?.schema;
  if (!schema) throw new Error(`${id}의 요청 스키마가 계약에 없습니다.`);
  return errorsOf(schema, body);
}
