import type { TSchema } from 'typebox';
import { Epoch, ErrorResponse, Id, TaskKey } from './common.ts';
import { ERROR_STATUS, type ErrorCode } from './errors.ts';
import { pathParams, usesEpoch, type Operation } from './operation.ts';

type Json = Record<string, unknown>;

interface Parameter {
  name: string;
  in: 'path' | 'query' | 'header';
  required: boolean;
  schema: unknown;
}

const object = (schema: TSchema | undefined) =>
  (schema ?? {}) as { properties?: Record<string, TSchema>; required?: readonly string[] };

const header = (name: string, required: boolean, schema: unknown): Parameter => ({ name, in: 'header', required, schema });
const text = { type: 'string', minLength: 1 };
const HEADERS = {
  ProjectEpoch: header('X-Project-Epoch', true, Epoch),
  IdempotencyKey: header('Idempotency-Key', true, text),
  OptionalIdempotencyKey: header('Idempotency-Key', false, text),
  CsrfToken: header('X-CSRF-Token', true, text),
  IfNoneMatch: header('If-None-Match', false, { type: 'string' }),
};

/** TypeBox 정의에서 OpenAPI 3.1 문서를 만든다. 같은 입력이면 결과가 항상 같다. */
export function buildOpenApi(operations: readonly Operation[]): Json {
  const schemas: Record<string, unknown> = {};

  /** title이 있는 스키마는 component로 뺀다. 같은 title에 다른 정의가 있으면 실패한다. */
  const emit = (value: unknown, root = false): unknown => {
    if (Array.isArray(value)) return value.map((item) => emit(item));
    if (typeof value !== 'object' || value === null) return value;
    const { title } = value as { title?: unknown };
    if (!root && typeof title === 'string') {
      const body = emit(value, true);
      if (title in schemas && JSON.stringify(schemas[title]) !== JSON.stringify(body)) {
        throw new Error(`스키마 이름 중복: ${title}`);
      }
      schemas[title] = body;
      return { $ref: `#/components/schemas/${title}` };
    }
    return Object.fromEntries(
      // title이라는 이름의 속성(문자열이 아닌 스키마)은 그대로 둔다.
      Object.entries(value).map(([key, item]) => [key, emit(item)]),
    );
  };

  const fields = (schema: TSchema | undefined, where: 'path' | 'query'): Parameter[] => {
    const { properties = {}, required = [] } = object(schema);
    return Object.entries(properties).map(([name, item]) => ({
      name,
      in: where,
      required: where === 'path' || required.includes(name),
      schema: emit(item),
    }));
  };

  const paths: Record<string, Record<string, unknown>> = {};
  for (const op of operations) {
    const declared = object(op.params).properties ?? {};
    const parameters: Parameter[] = [
      ...pathParams(op.path).map((name) => ({
        name,
        in: 'path' as const,
        required: true,
        schema: emit(declared[name] ?? (name === 'taskKey' ? TaskKey : Id)),
      })),
      ...fields(op.query, 'query'),
    ];
    const headers: (keyof typeof HEADERS)[] = [];
    if (usesEpoch(op)) headers.push('ProjectEpoch');
    if (op.idempotency === 'required') headers.push('IdempotencyKey');
    if (op.idempotency === 'optional') headers.push('OptionalIdempotencyKey');
    if (op.principal === 'lead' && op.method !== 'GET') headers.push('CsrfToken');
    if (op.ifNoneMatch) headers.push('IfNoneMatch');
    const allParameters = [...parameters, ...headers.map((name) => ({ $ref: `#/components/parameters/${name}` }))];

    const responses: Record<string, unknown> = {};
    for (const [status, schema] of Object.entries(op.responses)) {
      const names = [
        ...(op.responseHeaders ?? []),
        ...(op.idempotency === 'none' ? [] : ['Idempotency-Replayed']),
      ];
      const content = op.binary && status === '200'
        ? { [op.binary]: { schema: { contentMediaType: op.binary } } }
        : schema && { 'application/json': { schema: emit(schema) } };
      responses[status] = {
        description: op.summary,
        ...(names.length > 0 && {
          headers: Object.fromEntries(
            names.map((name) => [
              name,
              { schema: name === 'X-Current-Epoch' ? emit(Epoch) : { type: 'string' } },
            ]),
          ),
        }),
        ...(content && { content }),
      };
    }
    const errorCodes: Record<string, ErrorCode[]> = {};
    for (const code of op.errors) (errorCodes[ERROR_STATUS[code]] ??= []).push(code);
    for (const [status, codes] of Object.entries(errorCodes)) {
      responses[status] = {
        $ref: `#/components/responses/${status === '429' ? 'RateLimited' : 'Error'}`,
        description: codes.join(', '),
      };
    }

    const path = op.path.replaceAll(/:(\w+)/g, '{$1}');
    const item = (paths[path] ??= {});
    const method = op.method.toLowerCase();
    if (method in item) throw new Error(`라우트 중복: ${op.method} ${op.path}`);
    item[method] = {
      operationId: op.id,
      summary: op.summary,
      tags: [op.path.startsWith('/api/planning/') ? 'planning' : op.principal],
      security: op.principal === 'none' ? [] : [op.principal === 'lead' ? { leadSession: [] } : { runnerToken: [] }],
      ...(op.version && { 'x-version-rule': op.version }),
      ...(allParameters.length > 0 && { parameters: allParameters }),
      ...(op.body && {
        requestBody: {
          required: true,
          content: {
            [op.multipart ? 'multipart/form-data' : 'application/json']: { schema: emit(op.body) },
          },
        },
      }),
      responses,
      'x-error-codes': errorCodes,
    };
  }

  const error = { content: { 'application/json': { schema: emit(ErrorResponse) } } };
  return {
    openapi: '3.1.0',
    info: { title: 'Agent WBS API', version: '0.0.0' },
    paths,
    components: {
      securitySchemes: {
        leadSession: { type: 'apiKey', in: 'cookie', name: 'awbs_session' },
        runnerToken: { type: 'http', scheme: 'bearer' },
      },
      responses: {
        Error: { description: '오류', ...error },
        RateLimited: { description: '요청 제한', headers: { 'Retry-After': { schema: { type: 'string' } } }, ...error },
      },
      parameters: HEADERS,
      schemas: Object.fromEntries(Object.entries(schemas).sort(([a], [b]) => a.localeCompare(b, 'en'))),
    },
  };
}

export const renderOpenApi = (operations: readonly Operation[]): string =>
  `${JSON.stringify(buildOpenApi(operations), null, 2)}\n`;
