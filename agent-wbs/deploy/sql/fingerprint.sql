-- 표마다 「행 수」와 「내용 지문」을 낸다(M8-06 백업·복원 대조). 출력: 표 이름<TAB>행 수<TAB>지문
-- 지문 = 각 행을 글자로 바꾼 값의 md5를 정렬해 이어 붙인 뒤 다시 md5. 행 순서와 관계없이 내용이 같으면 같은 값이다.
-- 왜: 행 수만 보면 내용이 바뀐 것을 놓친다. 지문까지 같으면 복원한 내용이 백업 순간과 같다.
\set ON_ERROR_STOP on
\pset format unaligned
\pset tuples_only on
\pset fieldsep '\t'
\pset footer off
SELECT format(
  'SELECT %L, count(*), coalesce(md5(string_agg(md5(x::text), %L ORDER BY md5(x::text))), %L) FROM %I.%I x',
  n.nspname || '.' || c.relname, '', '-', n.nspname, c.relname)
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p') AND n.nspname IN ('public', 'drizzle')
ORDER BY n.nspname, c.relname
\gexec
