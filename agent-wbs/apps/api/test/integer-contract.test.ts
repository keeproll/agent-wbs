import Fastify, { type FastifySchemaValidationError } from 'fastify';
import { afterAll, expect, test } from 'vitest';
import { OPERATIONS } from '@awbs/shared/api';
import { validationErrors } from '../src/platform/errors.ts';
import { buildValidator } from '../src/platform/validation.ts';

interface Schema {
  type?: string;
  minimum?: number;
  maximum?: number;
  properties?: Record<string, Schema>;
  items?: Schema;
  anyOf?: Schema[];
  allOf?: Schema[];
  oneOf?: Schema[];
}
function integers(schema: Schema, path: string[] = []): { schema: Schema; path: string[] }[] {
  return [
    ...(schema.type === 'integer' ? [{ schema, path }] : []),
    ...Object.entries(schema.properties ?? {}).flatMap(([key, child]) => integers(child, [...path, key])),
    ...(schema.items ? integers(schema.items, [...path, '0']) : []),
    ...[...schema.anyOf ?? [], ...schema.allOf ?? [], ...schema.oneOf ?? []].flatMap(child => integers(child, path)),
  ];
}

// 실제 int4 열로 가는 입력이다. bigint·numeric·JSON 개수에는 이 상한을 일괄 적용하지 않는다.
const int4 = new Set([
  'putExecPolicy.autoRetryLimit', 'putExecPolicy.autoReworkLimit', 'putExecPolicy.notifyAt',
  'updateCiSettings.retry', 'putCiDefaults.retry', 'reportHost.samples', 'reportHost.cores',
  'reportConcurrency.limit', 'reportConcurrency.running.Claude', 'reportConcurrency.running.Codex',
  'reportConcurrency.heavyJobs', 'reportConcurrency.sessions.0.observed', 'reportConcurrency.sessions.0.reserved',
  'reportAttemptResult.verification.specRevision', 'reportAttemptStatus.subagents.0.version',
  'reportSubagentUsage.items.0.version', 'startJob.installedSubagents.0.version',
  'putConcurrency.caps.total', 'putConcurrency.caps.Claude', 'putConcurrency.caps.Codex', 'putConcurrency.caps.heavy',
  'putObsBudget.budget.dev', 'putObsBudget.budget.qa', 'reportConcurrency.adjust.from', 'reportConcurrency.adjust.to',
  'createProposal.ops.0.t.srcV', 'submitPlanningProposal.ops.0.t.srcV',
  'submitPlanningReviews.reviews.0.ops.0.t.srcV', 'submitPlanningReviews.reviews.0.codexOps.0.t.srcV',
  'submitPlanningReviews.reviews.0.claudeOps.0.t.srcV',
]);
const inputs = OPERATIONS.flatMap(op => (['body', 'query', 'params'] as const).flatMap(where =>
  integers((op[where] ?? {}) as Schema).map(field => ({ op, where, ...field, key: `${op.id}.${field.path.join('.')}` }))));
const unique = [...new Map(inputs.map(input => [`${input.where}:${input.key}`, input])).values()];

const app = Fastify({
  schemaController: { compilersFactory: { buildValidator } },
  // 필요한 다른 칸이 빠져도 검사 대상 칸의 maximum 오류를 함께 확인한다.
  ajv: { customOptions: { allErrors: true } },
});
let handled = 0;
for (const op of OPERATIONS) app.route({
  method: op.method, url: op.path,
  schema: { ...(op.body ? { body: op.body } : {}), ...(op.query ? { querystring: op.query } : {}), ...(op.params ? { params: op.params } : {}) },
  handler: () => { handled++; throw new Error('범위 밖 입력이 처리기에 도착했습니다.'); },
});
app.setErrorHandler((error, _request, reply) => {
  const failure = error as { validation?: FastifySchemaValidationError[] };
  return reply.code(failure.validation ? 400 : 500).send({ errors: validationErrors(failure.validation ?? []) });
});
afterAll(() => app.close());

test('전체 API의 정수 입력에는 상한이 있고 int4 열은 2147483647 이하다', () => {
  expect(unique.length).toBeGreaterThan(50);
  for (const key of int4) expect(unique.some(input => input.key === key), key).toBe(true);
  for (const input of inputs.filter(input => int4.has(input.key))) expect(input.schema.minimum, input.key).toBe(input.key === 'reportHost.cores' ? 1 : 0);
  const missing = inputs.filter(input => !Number.isSafeInteger(input.schema.maximum)
    || (input.schema.maximum ?? Infinity) > (int4.has(input.key) ? 2147483647 : Number.MAX_SAFE_INTEGER));
  expect(missing.map(input => input.key)).toEqual([]);
});

const nested = (path: string[], value: number): unknown => path.length === 0 ? value
  : path[0] === '0' ? [nested(path.slice(1), value)] : { [path[0] ?? '']: nested(path.slice(1), value) };

test('전체 API의 본문·쿼리·경로에서 범위 밖 정수는 해당 칸의 maximum 오류와 400이다', async () => {
  const failures: string[] = [];
  for (const input of unique) {
    const { op, where, path, key, schema } = input;
    const maximum = int4.has(key) ? 2147483647 : schema.maximum ?? Number.MAX_SAFE_INTEGER;
    const bad = maximum + 1;
    let url = op.path.replace(/:\w+/g, 'fixture');
    if (where === 'query') url += `?${path[0] ?? ''}=${String(bad)}`;
    if (where === 'params') url = op.path.replace(`:${path[0] ?? ''}`, String(bad)).replace(/:\w+/g, 'fixture');
    const response = await app.inject({ method: op.method, url, ...(where === 'body' ? { payload: nested(path, bad) as object } : {}) });
    const errors = response.json<{ errors: { path: string; rule: string }[] }>().errors;
    if (response.statusCode !== 400 || !errors.some(error => error.path === path.join('.') && error.rule === 'maximum')) {
      failures.push(`${key} → ${String(response.statusCode)} ${JSON.stringify(errors)}`);
    }
  }
  expect(failures).toEqual([]);
  expect(handled).toBe(0);
}, 20_000);
