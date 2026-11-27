import { expect, test } from 'vitest';
import { parseContracts } from '../../src/design/parse.ts';

const source = (body: string) => [{ path: 'contracts/db/postgres/001.sql', raw: `CREATE TABLE t(id integer, x text); CREATE TABLE safe(id integer); ${body} CREATE TABLE later(id integer);` }];
const checked = (body: string) => parseContracts(source(body)).items.filter(i => i.contract).map(i => i.itemKey);

test('DO의 정적 제어문과 문자열 안의 EXECUTE는 구조를 오염하지 않는다', () => {
  expect(checked("DO $$ BEGIN IF true THEN RAISE NOTICE 'EXECUTE DROP TABLE t'; ELSE NULL; END IF; END $$;")).toEqual(['postgres:t', 'postgres:safe', 'postgres:later']);
});

test.each([
  'ALTER TABLE t DROP COLUMN x;',
  'IF false THEN ALTER TABLE t DROP COLUMN x; END IF;',
  'FOR i IN 1..2 LOOP ALTER TABLE t ALTER COLUMN x SET NOT NULL; END LOOP;',
  'BEGIN ALTER TABLE t INHERIT safe; EXCEPTION WHEN others THEN ALTER TABLE t ADD COLUMN z integer; END;',
])('DO의 정적 SQL은 실행 여부를 추측하지 않고 대상만 대조하지 않는다: %s', sql => {
  const parsed = parseContracts(source(`DO $$ DECLARE i integer; BEGIN ${sql} END $$;`));
  expect(parsed.files[0]?.status).toBe('ok');
  expect(parsed.items.find(i => i.itemKey === 'postgres:t')?.contract).toBeUndefined();
  expect(parsed.items.filter(i => i.contract).map(i => i.itemKey)).toEqual(['postgres:safe', 'postgres:later']);
});

test('DO의 양쪽 분기와 타입 변경의 대상을 함께 보존한다', () => {
  const parsed = parseContracts([{ path: 'contracts/db/postgres/001.sql', raw: "CREATE TYPE s AS ENUM ('a'); CREATE TABLE t(k s); CREATE TABLE safe(id integer); CREATE TABLE u(id integer); DO $$ BEGIN IF true THEN ALTER TYPE s RENAME VALUE 'a' TO 'b'; ELSE ALTER TABLE u DROP COLUMN id; END IF; END $$; CREATE TABLE later(k s);" }]);
  expect(parsed.files[0]?.status).toBe('ok');
  expect(parsed.items.filter(i => i.contract).map(i => i.itemKey)).toEqual(['postgres:safe']);
});

test.each([
  "CREATE TRIGGER %I BEFORE UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION f(%L)",
  'CREATE INDEX %I ON %s(id)',
  'CREATE UNIQUE INDEX %I ON %s(id)',
  'ALTER TABLE %s ADD CONSTRAINT %I UNIQUE (id)',
  'ALTER TABLE %s ADD CONSTRAINT %I FOREIGN KEY (id) REFERENCES %s(id)',
  'GRANT UPDATE ON %I TO app',
  'REVOKE UPDATE ON public.%I FROM app',
  'GRANT app_owner TO %I',
  'REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC',
  'ALTER TABLE public.%I OWNER TO app_owner',
  'ALTER FUNCTION %s OWNER TO app_owner',
  'ALTER FUNCTION %s SET search_path=pg_catalog,pg_temp',
  'ALTER FUNCTION %s RESET ALL',
  'DROP TRIGGER guard_delete ON public.%I',
])('승인된 리터럴 format 템플릿만 필드 비교에 영향이 없다고 분류한다: %s', template => {
  expect(checked(`DO $$ DECLARE r record; BEGIN FOR r IN SELECT 1 LOOP EXECUTE pg_catalog.format('${template}', r.a, r.b, r.c); END LOOP; END $$;`)).toEqual(['postgres:t', 'postgres:safe', 'postgres:later']);
  const sql = template.replaceAll('%I', 'idx').replaceAll('%s', 't').replaceAll('%L', "'text'");
  expect(checked(`${sql};`)).toEqual(['postgres:t', 'postgres:safe', 'postgres:later']);
  expect(checked(`DO $$ BEGIN ${sql}; END $$;`)).toEqual(['postgres:t', 'postgres:safe', 'postgres:later']);
});

test.each([
  "format('ALTER TABLE %s ADD CONSTRAINT %I PRIMARY KEY(id)', target, name)",
  "format('ALTER TABLE %s ADD COLUMN z int', target)",
  "format('ALTER TABLE %s ALTER COLUMN id SET NOT NULL', target)",
  "format('ALTER TABLE %s DROP CONSTRAINT %I', target, name)",
  "format('ALTER TABLE %s ADD CONSTRAINT %I UNIQUE(id), ALTER COLUMN x SET NOT NULL', target, name)",
  "format('CREATE INDEX %I ON %s(id); DROP TABLE t', name, target)",
  "format('not valid SQL %s', target)",
  "format('CREATE INDEX %Q ON t(id)', name)",
  "format(template, target)",
  "'CREATE INDEX i ON t(id)'",
  "format('CREATE INDEX %I ON t(id)', name) || suffix",
  "custom.format('CREATE INDEX %I ON t(id)', name)",
])('미승인·불명확 동적 SQL은 기존·이후 전체를 대조하지 않는다: %s', expression => {
  const parsed = parseContracts(source(`DO $$ DECLARE target text; name text; template text; suffix text; BEGIN EXECUTE ${expression}; END $$;`));
  expect(parsed.files[0]?.status).toBe('ok');
  expect(parsed.items).toHaveLength(3);
  expect(parsed.items.every(i => i.contract === undefined)).toBe(true);
});

test.each([
  'DO $$ BEGIN invalid syntax here; END $$;',
  "DO LANGUAGE plpythonu $$ print('unknown') $$;",
  'DO $$ BEGIN PERFORM mutate_schema(); END $$;',
])('PL/pgSQL 해석 실패와 미지원 실행은 대조됨으로 바꾸지 않는다: %s', block => {
  const parsed = parseContracts(source(block));
  expect(parsed.files[0]?.status).toBe('ok');
  expect(parsed.items.every(i => i.contract === undefined)).toBe(true);
});
