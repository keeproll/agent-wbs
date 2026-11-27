import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, expect, expectTypeOf, test } from 'vitest';
import { generateClient, type OpenApiDocument } from '../../scripts/client-codegen.ts';
import { ApiError, createApiClient, type ApiClient, type ApiRequest, type ApiResponse, type OperationId } from '../../src/api/client.ts';
import { OPERATIONS } from '../../src/api/generated/client.ts';
import { Secret } from '../../src/security/secret.ts';

const contracts = new URL('../../../agent-wbs/contracts/', import.meta.url);
const read = (path: string | URL) => readFileSync(path, 'utf8');
const document = () => JSON.parse(read(new URL('openapi.json', contracts))) as OpenApiDocument;

interface Fixture {
  id: OperationId;
  params?: Record<string, string>;
  query?: Record<string, string>;
  body?: Record<string, unknown>;
  status: number;
  response?: unknown;
}
// WBS schema 테스트와 같은 fixture(contracts §8)
const fixtures = JSON.parse(read(new URL('fixtures/runner.json', contracts))) as Fixture[];

const TOKEN = 'runner-token-for-test-0123456789abcdef';
let server: Server;
let baseUrl: string;
let api: ApiClient;
let requests: { method: string; url: string; headers: IncomingMessage['headers']; body: Buffer }[] = [];
let respond: (res: ServerResponse) => void = (res) => res.writeHead(204).end();

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) });
      respond(res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  api = createApiClient({ baseUrl, token: new Secret(TOKEN) });
});
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});
beforeEach(() => {
  requests = [];
});

const reply = (status: number, body?: unknown, headers: Record<string, string> = {}) => {
  respond = (res) =>
    res
      .writeHead(status, { ...(body !== undefined && { 'content-type': 'application/json' }), ...headers })
      .end(body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body));
};
const beat = { epoch: 2, body: { runnerId: 'r', version: '0', epoch: 2 } };

test('생성물이 openapi.json과 같다', () => {
  expect(read(new URL('../../src/api/generated/client.ts', import.meta.url))).toBe(generateClient(document()));
});

test('fixture가 생성된 모든 API를 덮는다', () => {
  expect(fixtures.map((f) => f.id).sort()).toEqual(Object.keys(OPERATIONS).sort());
});

test.each(fixtures)('$id: 계약 경로·헤더·본문으로 보내고 응답을 돌려준다', async (fixture) => {
  reply(fixture.status, fixture.response);
  const { id, params, query, body } = fixture;
  const request = {
    ...(params && { params }),
    ...(query && { query }),
    ...(body && { body: id === 'uploadEvidence' ? { ...body, file: new Blob([String(body.file)]) } : body }),
    epoch: 2,
    idempotencyKey: `att:1:${id}:t`,
  };
  const call = api as unknown as (id: OperationId, request: unknown) => Promise<{ status: number; body: unknown }>;
  const result = await call(id, request);
  expect(result.status).toBe(fixture.status);
  expect(result.body).toEqual(fixture.response);

  const [sent] = requests;
  const path = document().paths;
  const [template, methods] = Object.entries(path).find(([, item]) => Object.values(item).some((o) => o.operationId === id)) ?? [];
  const expected = (template ?? '').replaceAll(/\{(\w+)\}/g, (_, name: string) => params?.[name] ?? '');
  expect(sent?.method.toLowerCase()).toBe(Object.entries(methods ?? {}).find(([, o]) => o.operationId === id)?.[0]);
  expect(sent?.url).toBe(query ? `${expected}?${new URLSearchParams(query).toString()}` : expected);
  expect(sent?.headers).toMatchObject({
    authorization: `Bearer ${TOKEN}`,
    'x-project-epoch': '2',
    'idempotency-key': `att:1:${id}:t`,
  });
  if (id === 'uploadEvidence') {
    const data = await new Response(new Uint8Array(sent?.body ?? []), {
      headers: { 'content-type': sent?.headers['content-type'] ?? '' },
    }).formData();
    expect(await (data.get('file') as File).text()).toBe('로그 내용');
    expect([data.get('kind'), data.get('sha256'), data.get('size'), data.get('fence')]).toEqual(['log', 'c'.repeat(64), '13', '3']);
  } else if (body) {
    expect(sent?.headers['content-type']).toBe('application/json');
    expect(JSON.parse(sent?.body.toString() ?? '')).toEqual(body);
  } else {
    expect(sent?.body).toHaveLength(0);
  }
});

const judgementJobs = JSON.parse(read(new URL('fixtures/judgement-jobs.json', contracts))) as { kind: string; response: unknown }[];
test.each(judgementJobs)('판단 job($kind)의 내용과 hash를 타입으로 읽는다', async ({ response }) => {
  reply(200, response);
  const result = await api('claimJob', { epoch: 2, idempotencyKey: 'k', body: { kinds: ['planning'], capacity: 1 } });
  if (result.status !== 200 || result.body.job.kind !== 'planning') throw new Error('planning job이 아니다');
  const { proposal, tasks } = result.body.job.payload;
  expect((proposal?.targets ?? tasks).length).toBeGreaterThan(0);
  for (const target of proposal?.targets ?? []) expect(target.after.title).not.toBe('');
  for (const task of proposal?.splitTasks ?? tasks) expect(task.content.title).not.toBe('');
});

test('멱등 키는 필요한 요청에서만 타입으로 강제된다', () => {
  expectTypeOf<ApiRequest<'ackMessage'>>().toHaveProperty('idempotencyKey').toEqualTypeOf<string>();
  expectTypeOf<ApiRequest<'updateCiRun'>>().toHaveProperty('idempotencyKey');
  expectTypeOf<ApiRequest<'heartbeat'>>().not.toHaveProperty('idempotencyKey');
  expectTypeOf<ApiRequest<'getCommands'>>().not.toHaveProperty('idempotencyKey');
  expectTypeOf<ApiResponse<'claimJob'>['status']>().toEqualTypeOf<200 | 204>();
  expectTypeOf<ApiRequest<OperationId>>().toHaveProperty('epoch').toEqualTypeOf<number>();
});

test('오류 본문의 코드와 Retry-After를 전달한다', async () => {
  const error = { code: 'EPOCH_MISMATCH', message: 'm', action: 'a', fix: 'f', errors: [], details: { currentEpoch: 3 }, requestId: 'q' };
  reply(409, { error }, { 'retry-after': '7' });
  const caught: unknown = await api('reportUsage', {
    epoch: 2,
    idempotencyKey: 'k',
    body: { agent: 'Codex', remainPct: 1 },
  }).catch((e: unknown) => e);
  expect(caught).toBeInstanceOf(ApiError);
  expect(caught).toMatchObject({ status: 409, error, retryAfter: '7' });
  expect(JSON.stringify(caught) + String((caught as Error).stack)).not.toContain(TOKEN);
});

test.each([
  ['형식이 다른 오류', 502, '<html>'],
  ['선언하지 않은 성공', 200, { ok: true }],
  ['null 오류', 500, { error: null }],
])('%s는 ApiError이고 error가 없다', async (_, status, body) => {
  reply(status, body);
  await expect(api('heartbeat', beat)).rejects.toMatchObject({ name: 'ApiError', status, error: undefined });
});

test('본문이 있어야 하는 200이 JSON이 아니면 성공으로 보지 않는다', async () => {
  reply(200, '<html>');
  await expect(api('getCommands', { epoch: 2 })).rejects.toMatchObject({ name: 'ApiError', status: 200 });
});

test('리다이렉트를 따라가지 않는다(토큰 유출 방지)', async () => {
  reply(307, undefined, { location: `${baseUrl}/elsewhere` });
  await expect(api('heartbeat', beat)).rejects.toMatchObject({ status: 307 });
  expect(requests).toHaveLength(1);
});

test('경로 값은 인코딩하고 다른 경로가 되는 값은 보내지 않는다', async () => {
  reply(204);
  await api('ackMessage', { params: { messageId: 'a/../b?c' }, epoch: 2, idempotencyKey: 'k' });
  expect(requests[0]?.url).toBe('/api/runner/messages/a%2F..%2Fb%3Fc/ack');
  for (const messageId of ['', '.', '..']) {
    await expect(api('ackMessage', { params: { messageId }, epoch: 2, idempotencyKey: 'k' })).rejects.toThrow('messageId');
  }
  expect(requests).toHaveLength(1);
});

test('ETag 조건부 조회: If-None-Match를 보내고 304를 성공으로 돌려준다', async () => {
  reply(304);
  const result = await api('getRunnerPolicy', { epoch: 2, ifNoneMatch: '"v1"' });
  expect(result).toMatchObject({ status: 304, body: undefined });
  expect(requests[0]?.headers['if-none-match']).toBe('"v1"');
});

test('명령 결과는 명령의 epoch를 헤더로 보낸다(현재 epoch로 덮지 않는다)', async () => {
  reply(204);
  await api('reportCommandResult', { params: { id: 'c' }, epoch: 2, idempotencyKey: 'k', body: { status: 'done', items: [], holds: [] } });
  expect(requests[0]?.headers['x-project-epoch']).toBe('2');
});

test('heartbeat는 멱등 키 없이 보내고 X-Current-Epoch를 읽을 수 있다', async () => {
  reply(204, undefined, { 'x-current-epoch': '3' });
  const result = await api('heartbeat', beat);
  expect(result.headers.get('x-current-epoch')).toBe('3');
  expect(requests[0]?.headers).not.toHaveProperty('idempotency-key');
});

const withSchema = (schema: unknown): OpenApiDocument => {
  const doc = document();
  const op = doc.paths['/api/runner/heartbeat']?.post;
  if (!op) throw new Error('heartbeat');
  op.requestBody = { content: { 'application/json': { schema: schema as object } } };
  return doc;
};

test('추가 필드를 허용한 명령 payload는 생성 타입에서도 잃지 않는다', () => {
  const generated = generateClient(withSchema({ type: 'object', properties: { holds: { type: 'array', items: { type: 'string' } } }, additionalProperties: true }));
  expect(generated).toContain('[key: string]: unknown;');
  expect(generated).toContain('holds?: (string)[];');
});

test.each([
  ['모르는 키워드', { type: 'object', oneOf: [] }],
  ['모르는 type', { type: ['string', 'null'] }],
  ['없는 참조', { $ref: '#/components/schemas/Nope' }],
  ['외부 참조', { $ref: 'http://example.invalid/x' }],
  ['items 없는 배열', { type: 'array' }],
])('생성기는 %s를 추정하지 않고 실패한다', (_, schema) => {
  expect(() => generateClient(withSchema(schema))).toThrow();
});

test('생성기는 팀장 API를 포함하지 않는다. 예외는 원본 경로의 기술 결정 제안(G§8.6)뿐이다', () => {
  const paths = Object.values(OPERATIONS).map((op) => op.path);
  expect(paths.filter((path) => !/^\/api\/(runner|planning)\//.test(path))).toEqual([
    '/api/projects/{projectId}/design/decisions',
  ]);
});
