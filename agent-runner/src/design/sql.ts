import { astMapper, astVisitor, parse, toSql, type CreateColumnDef, type CreateIndexStatement, type Expr, type QName, type TableConstraint } from 'pgsql-ast-parser';
import type { ContractFile } from './parse.ts';
import { pointer, type DesignItem } from './shape.ts';

interface Column { definition: CreateColumnDef; desc: string }
interface Table {
  path: string;
  name: string;
  columns: Map<string, Column>;
  constraints: TableConstraint[];
  indexes: CreateIndexStatement[];
}

const tableName = (name: QName) => name.schema && name.schema !== 'public' ? `${name.schema}.${name.name}` : name.name;
const primary = (table: Table, column: CreateColumnDef) => column.constraints?.some(c => c.type === 'primary key') ||
  table.constraints.some(c => c.type === 'primary key' && c.columns.some(k => k.name === column.name.name));
const required = (table: Table, column: CreateColumnDef) => Boolean(primary(table, column) || column.constraints?.some(c => c.type === 'not null'));

function addColumn(table: Table, column: CreateColumnDef, ifNotExists = false): void {
  if (table.columns.has(column.name.name)) {
    if (ifNotExists) return;
    throw new Error('SQL 컬럼이 중복입니다.');
  }
  table.columns.set(column.name.name, { definition: structuredClone(column), desc: '' });
}

function addConstraint(table: Table, constraint: TableConstraint): void {
  if (constraint.type === 'primary key' && constraint.columns.some(c => !table.columns.has(c.name))) throw new Error('SQL 기본키의 컬럼이 없습니다.');
  table.constraints.push(structuredClone(constraint));
}

function constraintText(c: TableConstraint): string {
  if (c.type === 'check') return `CHECK (${toSql.expr(c.expr)})`;
  if (c.type === 'foreign key') return `FOREIGN KEY (${c.localColumns.map(k => k.name).join(', ')}) REFERENCES ${tableName(c.foreignTable)} (${c.foreignColumns.map(k => k.name).join(', ')})`;
  return `${c.type.toUpperCase()} (${c.columns.map(k => k.name).join(', ')})`;
}

function foreignReferences(table: Table) {
  return [...table.constraints.filter(c => c.type === 'foreign key'),
    ...[...table.columns.values()].flatMap(c => c.definition.constraints?.filter(c => c.type === 'reference') ?? [])];
}

function usesColumn(expr: Expr, name: string): boolean {
  let found = false;
  astVisitor(() => ({ ref: r => { if (r.name === name) found = true; } })).expr(expr);
  return found;
}

function renameColumnReferences(tables: Map<string, Table>, table: Table, before: string, after: string): void {
  const mapper = astMapper(() => ({ ref: r => ({ ...r, name: r.name === before ? after : r.name }) }));
  for (const index of table.indexes) for (const expression of index.expressions) expression.expression = mapper.expr(expression.expression) ?? expression.expression;
  for (const index of table.indexes) if (index.where) index.where = mapper.expr(index.where) ?? index.where;
  for (const constraint of table.constraints) {
    if (constraint.type === 'check') constraint.expr = mapper.expr(constraint.expr) ?? constraint.expr;
    else for (const key of constraint.type === 'foreign key' ? constraint.localColumns : constraint.columns) if (key.name === before) key.name = after;
  }
  for (const column of table.columns.values()) for (const constraint of column.definition.constraints ?? []) {
    if (constraint.type === 'check') constraint.expr = mapper.expr(constraint.expr) ?? constraint.expr;
  }
  for (const owner of tables.values()) for (const reference of foreignReferences(owner)) {
    if (tableName(reference.foreignTable) === table.name) for (const key of reference.foreignColumns) if (key.name === before) key.name = after;
  }
}

/** SQL을 실행하지 않고 구문 트리만 읽는다. 지원하지 않는 변경은 전체 SQL 스키마를 읽기 실패로 보고한다. */
export function sqlItems(files: readonly ContractFile[]): DesignItem[] {
  const tables = new Map<string, Table>();
  for (const file of [...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
    if (file.error !== undefined || file.raw === undefined) throw new Error('SQL 파일을 읽지 못했습니다.');
    for (const statement of parse(file.raw)) {
      if (statement.type === 'create table') {
        const name = tableName(statement.name);
        if (tables.has(name)) {
          if (statement.ifNotExists) continue;
          throw new Error('SQL 테이블이 중복입니다.');
        }
        if (statement.inherits?.length) throw new Error('상속 테이블은 대조 안 함입니다.');
        const table: Table = { path: file.path, name, columns: new Map(), constraints: [], indexes: [] };
        for (const column of statement.columns) {
          if (column.kind !== 'column') throw new Error('LIKE 테이블은 대조 안 함입니다.');
          addColumn(table, column);
        }
        for (const constraint of statement.constraints ?? []) addConstraint(table, constraint);
        tables.set(name, table);
      } else if (statement.type === 'alter table') {
        const name = tableName(statement.table);
        const table = tables.get(name);
        if (!table) {
          if (statement.ifExists) continue;
          throw new Error('변경할 SQL 테이블이 없습니다.');
        }
        table.path = file.path;
        for (const change of statement.changes) {
          if (change.type === 'add column') addColumn(table, change.column, change.ifNotExists);
          else if (change.type === 'drop column') {
            if (change.behaviour === 'cascade') throw new Error('CASCADE 삭제는 지원하지 않습니다.');
            const target = change.column.name;
            const index = table.indexes.some(i => i.expressions.some(e => usesColumn(e.expression, target)) || i.where && usesColumn(i.where, target));
            const constraint = table.constraints.some(c => c.type === 'check' ? usesColumn(c.expr, target) : (c.type === 'foreign key' ? c.localColumns : c.columns).some(k => k.name === target));
            const check = [...table.columns.values()].some(c => c.definition.constraints?.some(c => c.type === 'check' && usesColumn(c.expr, target)));
            const foreign = [...tables.values()].some(t => foreignReferences(t).some(r => tableName(r.foreignTable) === table.name && r.foreignColumns.some(c => c.name === target)));
            // shortcut: 의존 항목의 자동 삭제는 해석하지 않는다. SQL 의존성 삭제 지원 전에는 읽기 실패로 남긴다.
            if (index || constraint || check || foreign) throw new Error('의존 항목이 있는 SQL 컬럼 삭제는 지원하지 않습니다.');
            if (!table.columns.delete(change.column.name) && !change.ifExists) throw new Error('삭제할 SQL 컬럼이 없습니다.');
          } else if (change.type === 'alter column') {
            const column = table.columns.get(change.column.name)?.definition;
            if (!column) throw new Error('변경할 SQL 컬럼이 없습니다.');
            if (change.alter.type === 'set type') column.dataType = change.alter.dataType;
            else if (change.alter.type === 'set not null') column.constraints = [...(column.constraints ?? []), { type: 'not null' }];
            else if (change.alter.type === 'drop not null') {
              if (primary(table, column)) throw new Error('기본키 컬럼은 NULL을 허용할 수 없습니다.');
              column.constraints = (column.constraints ?? []).filter(c => c.type !== 'not null');
            } else if (change.alter.type === 'set default') column.constraints = [...(column.constraints ?? []).filter(c => c.type !== 'default'), { type: 'default', default: change.alter.default }];
            else if (change.alter.type === 'drop default') column.constraints = (column.constraints ?? []).filter(c => c.type !== 'default');
            else throw new Error('지원하지 않는 SQL 컬럼 변경입니다.');
          } else if (change.type === 'rename column') {
            const column = table.columns.get(change.column.name);
            if (!column || table.columns.has(change.to.name)) throw new Error('SQL 컬럼 이름을 바꿀 수 없습니다.');
            column.definition.name = change.to;
            table.columns.delete(change.column.name); table.columns.set(change.to.name, column);
            renameColumnReferences(tables, table, change.column.name, change.to.name);
          } else if (change.type === 'rename') {
            const renamed = tableName({ ...statement.table, name: change.to.name });
            if (tables.has(renamed)) throw new Error('SQL 테이블 이름이 중복입니다.');
            for (const owner of tables.values()) for (const reference of foreignReferences(owner)) if (tableName(reference.foreignTable) === table.name) reference.foreignTable.name = change.to.name;
            tables.delete(table.name); table.name = renamed; tables.set(renamed, table);
          } else if (change.type === 'add constraint') addConstraint(table, change.constraint);
          else throw new Error('지원하지 않는 SQL 테이블 변경입니다.');
        }
      } else if (statement.type === 'create index') {
        const table = tables.get(tableName(statement.table));
        if (!table) throw new Error('인덱스의 SQL 테이블이 없습니다.');
        table.indexes.push(statement); table.path = file.path;
      } else if (statement.type === 'drop table') {
        if (statement.cascade === 'cascade') throw new Error('CASCADE 삭제는 지원하지 않습니다.');
        for (const name of statement.names) if (!tables.delete(tableName(name)) && !statement.ifExists) throw new Error('삭제할 SQL 테이블이 없습니다.');
      } else if (statement.type === 'drop index') {
        for (const name of statement.names) for (const table of tables.values()) table.indexes = table.indexes.filter(i => i.indexName?.name !== name.name);
      } else if (statement.type === 'comment' && statement.on.type === 'column') {
        const target = statement.on.column;
        const column = tables.get(tableName({ name: target.table, ...(target.schema && { schema: target.schema }) }))?.columns.get(target.column);
        if (!column) throw new Error('설명을 넣을 SQL 컬럼이 없습니다.');
        column.desc = statement.comment;
      } else if (!['begin', 'start transaction', 'commit', 'insert', 'update', 'delete', 'comment', 'create schema'].includes(statement.type)) {
        // shortcut: 함수·동적 SQL은 안전하게 읽기 실패로 남긴다. 실제 SQL 추출기 연결 때 지원 범위를 늘린다.
        throw new Error(`지원하지 않는 SQL 구문입니다: ${statement.type}`);
      }
    }
  }
  return [...tables.values()].map(table => ({
    itemKey: `postgres:${table.name}`, name: table.name, kind: 'postgres', path: table.path,
    content: { type: 'postgres', columns: [...table.columns.entries()].map(([name, { definition: c, desc }]) => {
      const reference = c.constraints?.find(c => c.type === 'reference');
      const foreign = table.constraints.find(c => c.type === 'foreign key' && c.localColumns.some(k => k.name === name));
      const fk = reference ? `${tableName(reference.foreignTable)}.${reference.foreignColumns.map(k => k.name).join(',')}`
        : foreign?.type === 'foreign key' ? `${tableName(foreign.foreignTable)}.${foreign.foreignColumns[foreign.localColumns.findIndex(k => k.name === name)]?.name ?? ''}` : null;
      const unique = Boolean(c.constraints?.some(c => c.type === 'primary key' || c.type === 'unique') || table.constraints.some(c => (c.type === 'primary key' || c.type === 'unique') && c.columns.length === 1 && c.columns[0]?.name === name));
      const fallback = c.constraints?.find(c => c.type === 'default');
      return { name, type: toSql.dataType(c.dataType).trim(), nullable: !required(table, c), pk: Boolean(primary(table, c)), unique, fk, default: fallback?.type === 'default' ? toSql.expr(fallback.default) : null, desc };
    }), constraints: table.constraints.map(constraintText), usedBy: [],
    indexes: table.indexes.map(i => ({ name: i.indexName?.name ?? '', columns: i.expressions.map(e => toSql.expr(e.expression)).join(', '), kind: i.unique ? 'UNIQUE' : (i.using?.name ?? 'BTREE').toUpperCase() })),
    },
    contract: { fields: [...table.columns.entries()].map(([name, { definition: c }]) => ({ path: `/${pointer(name)}`, type: toSql.dataType(c.dataType).trim(), required: required(table, c) })) },
  }));
}
