import { expect, test } from 'vitest';
import { parseContracts } from '../../src/design/parse.ts';

const source = (body: string) => ({ path: 'contracts/db/postgres/001.sql', raw: `CREATE TABLE t(id integer); ${body} CREATE TABLE later(id integer);` });

test.each([
  'BEGIN IF mutate_schema() THEN NULL; END IF; END',
  'BEGIN IF true THEN NULL; ELSIF mutate_schema() THEN NULL; END IF; END',
  'BEGIN WHILE NOT mutate_schema() LOOP EXIT; END LOOP; END',
  'BEGIN LOOP EXIT WHEN mutate_schema(); END LOOP; END',
  'BEGIN CASE WHEN mutate_schema() THEN NULL; ELSE NULL; END CASE; END',
  'DECLARE r record; BEGIN FOR r IN SELECT mutate_schema() LOOP NULL; END LOOP; END',
  'BEGIN FOR i IN 1..(mutate_schema())::int LOOP NULL; END LOOP; END',
  'DECLARE i text; BEGIN FOREACH i IN ARRAY ARRAY[mutate_schema()] LOOP NULL; END LOOP; END',
  "BEGIN RAISE NOTICE '%', mutate_schema(); END",
  'DECLARE v boolean := mutate_schema(); BEGIN NULL; END',
  "BEGIN EXECUTE format('CREATE INDEX %I ON t(id)', mutate_schema()); END",
  "BEGIN EXECUTE format('CREATE INDEX %I ON t(id)', lower(mutate_schema())); END",
  "BEGIN EXECUTE format('CREATE INDEX %I ON t(id)', 'i') USING mutate_schema(); END",
  "BEGIN INSERT INTO log SELECT mutate_schema(); END",
])('모든 PL/pgSQL 표현식의 미지원 함수 호출은 전역 대조 안 함이다: %s', body => {
  const parsed = parseContracts([source(`DO $$ ${body} $$;`)]);
  expect(parsed.files[0]?.status).toBe('ok');
  expect(parsed.items).toHaveLength(2);
  expect(parsed.items.every(i => i.contract === undefined)).toBe(true);
});

test.each([
  "cardinality(ARRAY[1]) = 1",
  "pg_catalog.cardinality(ARRAY[1]) = 1",
  "array_length(ARRAY[1],1) = 1",
  "coalesce(nullif(1,2),greatest(1,least(2,3))) = 1",
  "length(concat_ws(',',lower('X'),upper('x'),concat('a','b'))) > 0",
  "split_part(regexp_replace('a.b','b','c'),'.',1) = 'a'",
  "to_regclass('t') IS NOT NULL",
  "(SELECT count(*) + max(x) + min(x) + sum(x) FROM unnest(ARRAY[1]) x) > 0",
  "(SELECT cardinality(array_agg(x)) FROM unnest(ARRAY[1]) x) > 0",
  "(SELECT length(string_agg(quote_ident(x),',')) FROM unnest(ARRAY['a']) x) > 0",
  "length(quote_literal('a')) > 0",
])('고정 허용 목록의 기본 함수는 대조를 막지 않는다: %s', condition => {
  const parsed = parseContracts([source(`DO $$ BEGIN IF ${condition} THEN NULL; END IF; END $$;`)]);
  expect(parsed.files[0]?.status).toBe('ok');
  expect(parsed.items.every(i => i.contract !== undefined)).toBe(true);
});

test.each(['public.lower', 'custom.cardinality', 'other.pg_catalog.lower'])('기본 함수와 같은 이름이어도 허용한 이름 한정이 아니면 대조하지 않는다: %s', name => {
  const parsed = parseContracts([source(`DO $$ BEGIN IF ${name}('x') IS NOT NULL THEN NULL; END IF; END $$;`)]);
  expect(parsed.items.every(i => i.contract === undefined)).toBe(true);
});

test.each(['lower', 'public.lower', 'pg_catalog.lower', 'custom.lower'])('마이그레이션이 기본 함수와 같은 이름을 정의하면 전역 대조 안 함이다: %s', name => {
  const definition = `CREATE FUNCTION ${name}(text) RETURNS text LANGUAGE sql AS $f$ SELECT $1 $f$;`;
  const parsed = parseContracts([source(`${definition} DO $$ BEGIN IF lower('x') IS NOT NULL THEN NULL; END IF; END $$;`)]);
  expect(parsed.files[0]?.status).toBe('ok');
  expect(parsed.items.every(i => i.contract === undefined)).toBe(true);
  expect(parseContracts([source("DO $$ BEGIN IF lower('x') IS NOT NULL THEN NULL; END IF; END $$;")]).items.every(i => i.contract !== undefined)).toBe(true);
});

test('뒤 파일과 DO 내부의 그림자 함수 정의도 앞서 읽은 테이블을 대조하지 않는다', () => {
  for (const raw of [
    "CREATE FUNCTION lower(text) RETURNS text LANGUAGE sql AS $f$ SELECT $1 $f$;",
    "DO $$ BEGIN CREATE FUNCTION lower(text) RETURNS text LANGUAGE sql AS $f$ SELECT $1 $f$; END $$;",
  ]) {
    const parsed = parseContracts([source("DO $$ BEGIN IF lower('x') IS NOT NULL THEN NULL; END IF; END $$;"), { path: 'contracts/db/postgres/002.sql', raw }]);
    expect(parsed.files.every(f => f.status === 'ok')).toBe(true);
    expect(parsed.items.every(i => i.contract === undefined)).toBe(true);
  }
});
