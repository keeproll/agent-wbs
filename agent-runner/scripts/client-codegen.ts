// openapi.json의 Runner·Planning API로 타입과 호출 표를 만든다. 모르는 형식은 추정하지 않고 실패한다.
interface Schema {
  $ref?: string;
  type?: string;
  enum?: unknown[];
  const?: unknown;
  anyOf?: Schema[];
  allOf?: Schema[];
  items?: Schema;
  properties?: Record<string, Schema>;
  required?: string[];
  patternProperties?: Record<string, Schema>;
  contentMediaType?: string;
  additionalProperties?: boolean;
}
interface Parameter {
  $ref?: string;
  name: string;
  in: string;
  required: boolean;
  schema: Schema;
}
interface Content {
  content?: Record<string, { schema: Schema }>;
}
interface ApiOperation {
  operationId: string;
  summary: string;
  tags: string[];
  parameters?: Parameter[];
  requestBody?: Content;
  responses: Record<string, Content & { $ref?: string }>;
}
export interface OpenApiDocument {
  paths: Record<string, Record<string, ApiOperation>>;
  components: { schemas: Record<string, Schema>; parameters: Record<string, Parameter> };
}

const KNOWN = new Set([
  '$ref', 'type', 'enum', 'const', 'anyOf', 'allOf', 'items', 'properties', 'required', 'patternProperties', 'contentMediaType', 'description',
  // 타입에 영향이 없는 검증 규칙
  'title', 'description', 'pattern', 'minLength', 'maxLength', 'minimum', 'maximum', 'exclusiveMinimum', 'minItems', 'uniqueItems',
  'maxItems', 'minProperties', 'additionalProperties',
]);

export function generateClient(doc: OpenApiDocument): string {
  const used = new Set<string>();
  const queue: string[] = [];

  const ref = (pointer: string, section: 'schemas' | 'parameters'): string => {
    const name = new RegExp(`^#/components/${section}/(\\w+)$`).exec(pointer)?.[1];
    if (!name || !(name in doc.components[section])) throw new Error(`알 수 없는 참조: ${pointer}`);
    return name;
  };

  const type = (schema: Schema, indent: string): string => {
    const unknown = Object.keys(schema).find((key) => !KNOWN.has(key));
    if (unknown) throw new Error(`지원하지 않는 스키마 키워드: ${unknown}`);
    if (schema.$ref) {
      const name = ref(schema.$ref, 'schemas');
      if (!used.has(name)) {
        used.add(name);
        queue.push(name);
      }
      return name;
    }
    if (schema.enum) return schema.enum.map((value) => JSON.stringify(value)).join(' | ');
    if ('const' in schema) return JSON.stringify(schema.const);
    if (schema.anyOf) return schema.anyOf.map((item) => type(item, indent)).join(' | ');
    if (schema.allOf) return schema.allOf.map((item) => type(item, indent)).join(' & ');
    if (schema.contentMediaType) return 'Blob';
    switch (schema.type) {
      case 'string':
      case 'boolean':
      case 'null':
        return schema.type;
      case 'integer':
      case 'number':
        return 'number';
      case 'array':
        if (!schema.items) throw new Error('items가 없는 배열');
        return `(${type(schema.items, indent)})[]`;
      case 'object': {
        if (schema.patternProperties) {
          const [value, ...rest] = Object.values(schema.patternProperties);
          if (!value || rest.length > 0) throw new Error('지원하지 않는 patternProperties');
          return `Record<string, ${type(value, indent)}>`;
        }
        const object = fields(
          Object.entries(schema.properties ?? {}).map(([name, item]) => ({
            name,
            required: schema.required?.includes(name) ?? false,
            schema: item,
          })),
          indent,
        );
        return schema.additionalProperties === true
          ? object.replace(/\n(\s*)}$/, `\n${indent}  [key: string]: unknown;\n$1}`)
          : object;
      }
      case undefined:
        if (Object.keys(schema).length === 0) return 'unknown';
        throw new Error(`type이 없는 스키마: ${JSON.stringify(schema)}`);
      default:
        throw new Error(`지원하지 않는 type: ${schema.type}`);
    }
  };

  const fields = (items: { name: string; required: boolean; schema: Schema }[], indent: string): string => {
    if (items.length === 0) return 'Record<string, unknown>';
    const inner = `${indent}  `;
    const lines = items.map(({ name, required, schema }) =>
      `${inner}${/^\w+$/.test(name) ? name : JSON.stringify(name)}${required ? '' : '?'}: ${type(schema, inner)};\n`);
    return `{\n${lines.join('')}${indent}}`;
  };

  const single = (content: Content['content'], where: string): [string, Schema] => {
    const entries = Object.entries(content ?? {});
    const [entry] = entries;
    if (!entry || entries.length > 1) throw new Error(`본문 형식이 하나가 아니다: ${where}`);
    return [entry[0], entry[1].schema];
  };

  const meta: string[] = [];
  const types: string[] = [];
  let designSchema: Schema | undefined;
  const planningSchemas: Record<string, Schema> = {};
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (!op.tags.some((tag) => tag === 'runner' || tag === 'planning')) continue;
      const id = op.operationId;
      const parameters = (op.parameters ?? []).map((p) =>
        p.$ref ? (doc.components.parameters[ref(p.$ref, 'parameters')] as Parameter) : p);
      const group = (where: string) => parameters.filter((p) => p.in === where);
      const headers = group('header');
      const known = ['X-Project-Epoch', 'Idempotency-Key', 'If-None-Match'];
      const other = parameters.find((p) => !['path', 'query', 'header'].includes(p.in) || (p.in === 'header' && !known.includes(p.name)));
      if (other) throw new Error(`지원하지 않는 매개변수: ${id} ${other.name}`);
      if (!headers.some((h) => h.name === 'X-Project-Epoch' && h.required)) throw new Error(`epoch 헤더가 없다: ${id}`);

      const success: string[] = [];
      const statuses: string[] = [];
      for (const [status, response] of Object.entries(op.responses)) {
        if (response.$ref) continue;
        if (!/^[23]\d\d$/.test(status)) throw new Error(`지원하지 않는 응답: ${id} ${status}`);
        const body = response.content ? type(single(response.content, id)[1], '      ') : 'undefined';
        statuses.push(`${status}: ${String(Boolean(response.content))}`);
        success.push(`      ${status}: ${body};\n`);
      }
      const request: string[] = [];
      for (const [key, list] of [['params', group('path')], ['query', group('query')]] as const) {
        if (list.length > 0) {
          const optional = list.every((p) => !p.required) ? '?' : '';
          request.push(`      ${key}${optional}: ${fields(list, '      ')};\n`);
        }
      }
      let content = 'none';
      if (op.requestBody) {
        const [mime, schema] = single(op.requestBody.content, id);
        if (id === 'reportDesignSnapshot') designSchema = schema;
        if (['submitDraft', 'submitTechProposals', 'submitPlanningAnalysis', 'submitPlanningReviews', 'submitPlanningProposal', 'submitTaskPlan', 'submitEstimates'].includes(id)) planningSchemas[id] = schema;
        if (mime !== 'application/json' && mime !== 'multipart/form-data') throw new Error(`지원하지 않는 본문: ${mime}`);
        content = mime === 'application/json' ? 'json' : 'multipart';
        request.push(`      body: ${type(schema, '      ')};\n`);
      }
      request.push('      epoch: number;\n');
      const idempotent = headers.some((h) => h.name === 'Idempotency-Key');
      if (idempotent) request.push('      idempotencyKey: string;\n');
      if (headers.some((h) => h.name === 'If-None-Match')) request.push('      ifNoneMatch?: string;\n');

      meta.push(
        `  ${id}: { method: '${method.toUpperCase()}', path: '${path}', content: '${content}', statuses: { ${statuses.join(', ')} } },\n`,
      );
      types.push(
        `  /** ${op.summary} */\n  ${id}: {\n    request: {\n${request.join('')}    };\n    responses: {\n${success.join('')}    };\n  };\n`,
      );
    }
  }
  if (meta.length === 0) throw new Error('Runner API가 없다.');

  type({ $ref: '#/components/schemas/ErrorResponse' }, '');
  const components: string[] = [];
  for (let name = queue.shift(); name; name = queue.shift()) {
    components.push(`export type ${name} = ${type(doc.components.schemas[name] as Schema, '')};\n`);
  }
  const validationSchemas: Record<string, Schema> = {}, planningValidation: Record<string, Schema> = {};
  const collect = (value: unknown, schemas: Record<string, Schema>): void => {
    if (Array.isArray(value)) { value.forEach(item => collect(item, schemas)); return; }
    if (!value || typeof value !== 'object') return;
    const node = value as Schema;
    if (node.$ref) {
      const name = ref(node.$ref, 'schemas');
      if (!schemas[name]) { schemas[name] = doc.components.schemas[name] as Schema; collect(schemas[name], schemas); }
    }
    Object.values(value).forEach(item => collect(item, schemas));
  };
  if (designSchema) collect(designSchema, validationSchemas);
  Object.values(planningSchemas).forEach(schema => collect(schema, planningValidation));

  return [
    '// 생성 파일. 직접 고치지 말고 `pnpm client:generate`를 실행한다.\n/* eslint-disable */\n',
    components.sort().join('\n'),
    `export interface Operations {\n${types.join('')}}\n`,
    `export const OPERATIONS = {\n${meta.join('')}} as const satisfies Record<keyof Operations, unknown>;\n`,
    ...(designSchema ? [`export const DESIGN_SNAPSHOT_SCHEMA = ${JSON.stringify({ ...designSchema, components: { schemas: validationSchemas } }, null, 2)} as const;\n`] : []),
    ...(Object.keys(planningSchemas).length ? [`export const PLANNING_REPORT_SCHEMAS = ${JSON.stringify({ ...planningSchemas, components: { schemas: planningValidation } }, null, 2)} as const;\n`] : []),
  ].join('\n');
}
