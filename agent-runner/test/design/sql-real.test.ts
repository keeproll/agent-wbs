import { readdirSync, readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { parseContracts } from '../../src/design/parse.ts';
import { buildDesignSnapshot } from '../../src/design/snapshot.ts';
import { assertDesignSnapshot } from '../../src/design/validate.ts';

test('M4 실제 마이그레이션 26개는 미승인 동적 SQL의 영향을 추측해 대조하지 않는다', async () => {
  const root = new URL('../../../agent-wbs/packages/db/migrations/', import.meta.url);
  const paths = readdirSync(root).filter(n => /^00(?:0\d|1\d|2[0-5])_.*\.sql$/.test(n)).sort();
  expect(paths).toHaveLength(26);
  const files = paths.map(n => ({ path: `contracts/db/postgres/migrations/${n}`, raw: readFileSync(new URL(n, root), 'utf8') }));
  const prefix = parseContracts(files.slice(0, 6));
  expect(prefix.items).toHaveLength(100);
  expect(prefix.items.every(i => i.contract !== undefined)).toBe(true);
  const checked = await buildDesignSnapshot({ commit: 'a'.repeat(40), ref: 'main', jobKind: 'design_apply', jobId: 'sql-prefix', fence: 1, files: files.slice(0, 6) }, { sql: async ({ item }) => item.contract });
  expect(checked.drifts).toEqual([]);
  const parsed = parseContracts(files);
  expect(parsed.files.filter(f => f.status === 'error')).toEqual([]);
  expect(parsed.items).toHaveLength(100);
  expect(parsed.items.every(i => i.contract === undefined)).toBe(true);
  expect(parsed.items.find(i => i.itemKey === 'postgres:tasks')?.content).toMatchObject({ columns: expect.arrayContaining([expect.objectContaining({ name: 'task_key', type: 'text', nullable: false })]) });
  expect(parsed.items.find(i => i.itemKey === 'postgres:task_specs')?.content).toMatchObject({ columns: expect.not.arrayContaining([expect.objectContaining({ name: 'id' })]) });
  let extracted = 0;
  const snapshot = await buildDesignSnapshot({ commit: 'a'.repeat(40), ref: 'main', jobKind: 'design_apply', jobId: 'sql-fixture', fence: 1, files }, { sql: async ({ item }) => { extracted++; return item.contract; } });
  expect(extracted).toBe(0);
  expect(snapshot.drifts).toHaveLength(100);
  expect(snapshot.drifts.every(d => d.compat === 'unchecked')).toBe(true);
  expect(() => assertDesignSnapshot(snapshot)).not.toThrow();
});

test('M4 serial·identity는 필수이고 타입 별칭은 DB의 표준 타입과 일치한다', () => {
  const parsed = parseContracts([{ path: 'contracts/db/postgres/001.sql', raw: 'CREATE TYPE status AS ENUM (\'a\',\'b\'); CREATE TABLE t (id bigserial, n int GENERATED ALWAYS AS IDENTITY, a int4, b integer, c varchar(10), d timestamptz, e timestamp with time zone);' }]);
  expect(parsed.files[0]?.status).toBe('ok');
  expect(parsed.items[0]?.contract?.fields).toEqual([
    { path: '/id', type: 'bigint', required: true }, { path: '/n', type: 'integer', required: true },
    { path: '/a', type: 'integer', required: false }, { path: '/b', type: 'integer', required: false },
    { path: '/c', type: 'character varying(10)', required: false },
    { path: '/d', type: 'timestamp with time zone', required: false }, { path: '/e', type: 'timestamp with time zone', required: false },
  ]);
});

test('Q-a SQL enum 허용 값의 변화도 타입 지문에서 사라지지 않는다', () => {
  const shape = (values: string) => parseContracts([{ path: 'contracts/db/postgres/001.sql', raw: `CREATE TYPE status AS ENUM (${values}); CREATE TABLE t(s status);` }]).items[0]?.contract?.fields[0]?.type;
  expect(shape("'a','b'")).not.toBe(shape("'a'"));
});

test('모르는 구조 변경은 그 테이블만 unchecked이고 나머지 테이블은 보존한다', () => {
  const parsed = parseContracts([{ path: 'contracts/db/postgres/001.sql', raw: 'CREATE TABLE t(id integer); CREATE TABLE u(id integer); ALTER TABLE t INHERIT u;' }]);
  expect(parsed.items.find(i => i.itemKey === 'postgres:t')?.contract).toBeUndefined();
  expect(parsed.items.find(i => i.itemKey === 'postgres:u')?.contract?.fields).toEqual([{ path: '/id', type: 'integer', required: false }]);
});
