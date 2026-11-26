import { expect, test } from 'vitest';
import { parseContracts } from '../../src/design/parse.ts';

const api = (paths: unknown) => JSON.stringify({ openapi: '3.1.0', info: { title: '시험', version: '1' }, paths });
const file = (path: string, raw: string) => ({ path, raw });

test('OpenAPI YAML의 endpoint 키·지역 참조·경로 공통 파라미터와 덮어쓰기를 보존한다', () => {
  const raw = `openapi: 3.1.0
info: {title: 시험, version: '1'}
components:
  schemas:
    Id: {type: string}
paths:
  /users/{id}:
    parameters:
      - {in: path, name: id, required: true, schema: {$ref: '#/components/schemas/Id'}}
      - {in: query, name: limit, schema: {type: integer}}
    get:
      summary: 사용자 조회
      x-task-key: TASK-0005
      parameters:
        - {in: query, name: limit, schema: {type: string}}
      responses:
        '200':
          description: 성공
          content:
            application/json:
              schema: {type: object, properties: {id: {$ref: '#/components/schemas/Id'}}}
`;
  const parsed = parseContracts([file('contracts/api/openapi.yaml', raw)]);
  expect(parsed.files).toEqual([{ path: 'contracts/api/openapi.yaml', raw, kind: 'REST', format: 'OpenAPI 3.1', status: 'ok' }]);
  expect(parsed.items).toHaveLength(1);
  expect(parsed.items[0]).toMatchObject({ itemKey: 'GET /users/{id}', name: '사용자 조회', taskKey: 'TASK-0005', kind: 'REST' });
  expect(parsed.items[0]?.contract?.fields).toEqual([
    { path: '/parameters/path/id', type: 'string', required: true },
    { path: '/parameters/query/limit', type: 'string', required: false },
    { path: '/responses/200', type: 'response', required: false },
    { path: '/responses/200/content/application~1json', type: 'object', required: false },
    { path: '/responses/200/content/application~1json/id', type: 'string', required: false },
  ]);
});

test('JSON의 요청 본문과 특수 문자가 있는 필드도 해석한다', () => {
  const raw = api({ '/users': { post: { requestBody: { required: true, content: { 'application/json': {
    schema: { type: 'object', required: ['a/b'], properties: { 'a/b': { type: 'integer' } } },
  } } }, responses: { 204: { description: '완료' } } } } });
  expect(parseContracts([file('contracts/api/openapi.json', raw)]).items[0]?.contract?.fields).toContainEqual({
    path: '/requestBody/content/application~1json/a~1b', type: 'integer', required: true,
  });
});

test('읽기 실패는 원문과 오류를 남기고 다른 파일의 성공 결과를 버리지 않는다', () => {
  const good = file('contracts/api/good.json', api({ '/ok': { get: { responses: {} } } }));
  for (const raw of ['openapi: [', 'openapi: 3.1.0\npaths: {}\npaths: {}', api({ '/bad': { get: null } })]) {
    const parsed = parseContracts([file('contracts/api/openapi.yaml', raw), good]);
    expect(parsed.files[0]).toMatchObject({ status: 'error', raw, error: expect.any(String) });
    expect(parsed.items.map(i => i.itemKey)).toEqual(['GET /ok']);
  }
});

test('미지원 버전·스키마·외부 참조는 성공 대조로 위장하지 않는다', () => {
  const unsupported = api({ '/users': { get: { responses: { 200: { content: { 'application/json': { schema: { $ref: 'other.yaml#/User' } } } } } } } });
  const parsed = parseContracts([file('contracts/api/openapi.json', unsupported)]);
  expect(parsed.items[0]?.contract).toBeUndefined();
  expect(parsed.files[0]?.raw).toBe(unsupported);
  expect(parseContracts([file('contracts/api/openapi.json', '{"openapi":"3.0.0","paths":{}}')]).files[0]?.status).toBe('error');
});

test('AsyncAPI 3.0 채널은 주소를 키로 쓰고 WebSocket 메시지를 해석한다', () => {
  const raw = JSON.stringify({ asyncapi: '3.0.0', servers: { ws: { host: 'example.invalid', protocol: 'wss' } },
    channels: { changed: { address: 'users/changed', messages: { event: { $ref: '#/components/messages/Changed' } } } },
    components: { messages: { Changed: { payload: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } } } },
    operations: { receive: { action: 'receive', channel: { $ref: '#/channels/changed' } } },
  });
  const parsed = parseContracts([file('contracts/events/asyncapi.json', raw)]);
  expect(parsed.items[0]).toMatchObject({ itemKey: 'users/changed', kind: 'WebSocket' });
  expect(parsed.items[0]?.contract?.fields).toContainEqual({ path: '/messages/event/payload/id', type: 'string', required: true });
});

test('Avro·Neo4j·QuestDB·미지원 파일은 원문을 남기고 대조용 계약을 만들지 않는다', () => {
  const kafka = JSON.stringify({ asyncapi: '3.0.0', servers: { k: { host: 'example.invalid', protocol: 'kafka' } },
    channels: { created: { address: 'users.created', messages: { event: { payload: { schemaFormat: 'application/vnd.apache.avro;version=1.9.0', schema: { type: 'record' } } } } } } });
  const parsed = parseContracts([
    file('contracts/events/asyncapi.json', kafka), file('contracts/db/neo4j/model.cypher', 'CREATE CONSTRAINT example'),
    file('contracts/db/questdb/tables.sql', 'CREATE TABLE measurements (at TIMESTAMP) TIMESTAMP(at);'),
  ], 'agent/task-1');
  expect(parsed.files.every(f => f.status === 'draft' && f.raw)).toBe(true);
  expect(parsed.items.map(i => i.itemKey)).toEqual(['users.created', 'file:contracts/db/neo4j/model.cypher', 'file:contracts/db/questdb/tables.sql']);
  expect(parsed.items.every(i => i.contract === undefined)).toBe(true);
});

test('Q-14 A: Kafka JSON Schema는 지역 참조를 해석하고 Avro·Protobuf는 대조 안 함이다', () => {
  const raw = JSON.stringify({ asyncapi: '3.0.0', servers: { k: { host: 'example.invalid', protocol: 'kafka' } },
    channels: { created: { address: 'users.created', messages: { event: { payload: {
      schemaFormat: 'application/schema+json;version=draft-07', schema: { type: 'object', properties: { id: { type: 'string' } } },
    } } } } } });
  const parsed = parseContracts([file('contracts/events/asyncapi.json', raw)]);
  expect(parsed.items[0]).toMatchObject({ itemKey: 'users.created', kind: 'Kafka' });
  expect(parsed.items[0]?.contract?.fields).toContainEqual({ path: '/messages/event/payload/id', type: 'string', required: false });
  const proto = raw.replace('application/schema+json;version=draft-07', 'application/vnd.google.protobuf;version=3');
  expect(parseContracts([file('contracts/events/asyncapi.json', proto)]).items[0]?.contract).toBeUndefined();
});

test('중복 항목·읽기 실패·저장소 밖 경로를 조용히 덮어쓰지 않는다', () => {
  const raw = api({ '/users': { get: { responses: {} } } });
  expect(() => parseContracts([file('contracts/a.json', raw), file('contracts/b.json', raw)])).toThrow();
  for (const path of ['src/openapi.json', '../contracts/a.json', 'contracts/../a', 'contracts//a', 'contracts\\a', '/contracts/a']) {
    expect(() => parseContracts([file(path, raw)])).toThrow();
  }
  expect(parseContracts([{ path: 'contracts/api/openapi.yaml', error: '읽지 못함' }]).files[0]).toMatchObject({ status: 'error', error: expect.any(String) });
});

test('SQL 마이그레이션을 이름순으로 누적하고 CREATE·ALTER·DROP과 제약·인덱스를 보존한다', () => {
  const parsed = parseContracts([
    file('contracts/db/postgres/migrations/002.sql', 'ALTER TABLE public.users ADD COLUMN email text NOT NULL; ALTER TABLE users ALTER COLUMN name TYPE varchar(40); ALTER TABLE users DROP COLUMN old; CREATE UNIQUE INDEX users_email ON users(email); DROP TABLE removed;'),
    file('contracts/db/postgres/migrations/001.sql', 'CREATE TABLE public.users (id uuid, name text, old integer, PRIMARY KEY(id)); CREATE TABLE removed (id integer);'),
  ]);
  expect(parsed.items.map(i => i.itemKey)).toEqual(['postgres:users']);
  expect(parsed.items[0]?.contract?.fields).toEqual([
    { path: '/id', type: 'uuid', required: true }, { path: '/name', type: 'varchar (40)', required: false },
    { path: '/email', type: 'text', required: true },
  ]);
  expect(parsed.items[0]?.content).toHaveProperty('indexes');
  expect(parsed.files.every(f => f.status === 'ok')).toBe(true);
});

test('M6-05 화면용 REST content에는 요청·응답·오류를 계약 형태로 넣는다', () => {
  const parsed = parseContracts([file('contracts/api/openapi.json', api({ '/users': { get: {
    security: [{ bearer: [] }], responses: { 403: { description: '권한 부족' } },
  } } }))]);
  expect(parsed.items[0]?.content).toEqual({ type: 'REST', auth: '[{"bearer":[]}]', request: '{"parameters":[]}', response: '{"403":{"description":"권한 부족"}}',
    validation: [], errors: [{ code: '403', http: '403', cond: '권한 부족' }], tables: [] });
});

test('M6-05 화면용 message content와 원문 전용 빈 content를 구별한다', () => {
  const parsed = parseContracts([
    file('contracts/events/asyncapi.json', JSON.stringify({ asyncapi: '3.0.0', servers: { ws: { protocol: 'ws' } },
      channels: { updates: { address: 'updates', messages: { changed: { payload: { type: 'string' } } } } },
      operations: { send: { action: 'send', channel: { $ref: '#/channels/updates' } } },
    })), file('contracts/db/neo4j/model.cypher', '원문'),
  ]);
  expect(parsed.items[0]?.content).toEqual({ type: 'message', auth: '', messages: [{ name: 'changed', direction: 'send', schema: '{"type":"string"}' }], rules: [], topic: null });
  expect(parsed.items[1]?.content).toEqual({});
});

test('M6-05 화면용 postgres content에 기본키·외래키·기본값·인덱스를 보존한다', () => {
  const parsed = parseContracts([file('contracts/db/postgres/migrations/001.sql',
    'CREATE TABLE users (id uuid PRIMARY KEY, age integer DEFAULT 18, owner uuid REFERENCES users(id)); CREATE UNIQUE INDEX users_age ON users(age);')]);
  expect(parsed.items[0]?.kind).toBe('postgres');
  expect(parsed.items[0]?.content).toMatchObject({ type: 'postgres', columns: [
    { name: 'id', type: 'uuid', nullable: false, pk: true, unique: true, fk: null, default: null, desc: '' },
    { name: 'age', type: 'integer', nullable: true, pk: false, unique: false, fk: null, default: '(18)', desc: '' },
    { name: 'owner', type: 'uuid', nullable: true, pk: false, unique: false, fk: 'users.id', default: null, desc: '' },
  ], constraints: [], indexes: [{ name: 'users_age', columns: 'age', kind: 'UNIQUE' }], usedBy: [] });
});

test('SQL 문법 오류·미지원 변경은 부분 스키마를 성공으로 보고하지 않는다', () => {
  for (const raw of ['CREATE TABLE broken (', 'CREATE TABLE users (id int); DO $$ BEGIN NULL; END $$;']) {
    const parsed = parseContracts([file('contracts/db/postgres/migrations/001.sql', raw)]);
    expect(parsed.files[0]).toMatchObject({ status: 'error', raw });
    expect(parsed.items).toEqual([]);
  }
});

test('SQL 파일 하나라도 못 읽으면 누적 스키마를 성공으로 대조하지 않는다', () => {
  const parsed = parseContracts([
    file('contracts/db/postgres/migrations/001.sql', 'CREATE TABLE users (id uuid);'),
    { path: 'contracts/db/postgres/migrations/002.sql', error: '읽기 실패' },
  ]);
  expect(parsed.items).toEqual([]);
  expect(parsed.files.every(f => f.status === 'error')).toBe(true);
});

test('SQL 이름 변경·NULL 허용 변경·기본값·설명·인덱스 삭제가 최종 상태에 반영된다', () => {
  const parsed = parseContracts([file('contracts/db/postgres/migrations/001.sql', `
    CREATE TABLE users (id uuid PRIMARY KEY, age int, old text);
    CREATE INDEX ages ON users(age);
    ALTER TABLE users RENAME COLUMN age TO years;
    ALTER TABLE users ALTER COLUMN years SET NOT NULL;
    ALTER TABLE users ALTER COLUMN old SET NOT NULL;
    ALTER TABLE users ALTER COLUMN old DROP NOT NULL;
    ALTER TABLE users ALTER COLUMN years SET DEFAULT 21;
    ALTER TABLE users RENAME TO people;
    COMMENT ON COLUMN people.years IS '나이';
    DROP INDEX ages;
  `)]);
  expect(parsed.items[0]?.itemKey).toBe('postgres:people');
  expect(parsed.items[0]?.contract?.fields).toContainEqual({ path: '/years', type: 'int', required: true });
  expect(parsed.items[0]?.contract?.fields).toContainEqual({ path: '/old', type: 'text', required: false });
  expect(parsed.items[0]?.content).toMatchObject({ columns: expect.arrayContaining([{ name: 'years', type: 'int', nullable: false, pk: false, unique: false, fk: null, default: '(21)', desc: '나이' }]), indexes: [] });
});

test('SQL의 rollback과 search_path 변경을 무시해 잘못된 스키마를 만들지 않는다', () => {
  for (const raw of ['BEGIN; CREATE TABLE users(id int); ROLLBACK;', 'SET search_path TO other; CREATE TABLE users(id int);']) {
    const parsed = parseContracts([file('contracts/db/postgres/migrations/001.sql', raw)]);
    expect(parsed.files[0]?.status).toBe('error');
    expect(parsed.items).toEqual([]);
  }
});
