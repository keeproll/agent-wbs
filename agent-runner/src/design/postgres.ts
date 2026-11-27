import { deparseSync } from 'pgsql-parser';
import { loadModule, parsePlPgSQLSync, parseSync } from 'libpg-query';
import { parse, type QName, type Statement } from 'pgsql-ast-parser';
import { DESIGN_LIMITS, record } from './shape.ts';

await loadModule();
export interface UnparsedSql { type: 'raw constraint' | 'unsupported'; table?: QName; typeName?: QName; name?: string; sql: string }
const NEUTRAL = new Set(['CreateFunctionStmt', 'AlterFunctionStmt', 'CreateExtensionStmt', 'CommentStmt', 'CreateRoleStmt', 'AlterRoleStmt', 'InsertStmt', 'UpdateStmt', 'DeleteStmt', 'CreateSchemaStmt']);
const NEUTRAL_ALTER = new Set(['AT_EnableRowSecurity', 'AT_DisableRowSecurity', 'AT_ForceRowSecurity', 'AT_NoForceRowSecurity', 'AT_EnableTrig', 'AT_EnableAlwaysTrig', 'AT_DisableTrig', 'AT_EnableTrigAll', 'AT_DisableTrigAll', 'AT_EnableTrigUser', 'AT_DisableTrigUser', 'AT_ValidateConstraint', 'AT_SetStatistics', 'AT_SetStorage', 'AT_SetCompression']);
const text = (stmt: Record<string, unknown>) => deparseSync({ stmts: [{ stmt }] } as Parameters<typeof deparseSync>[0]);
// 구조를 바꾸지 않는 기본 함수만 신뢰한다. 같은 이름의 정의는 아래에서 전역 대조 안 함으로 막는다.
const SAFE_FUNCTIONS = new Set(['cardinality', 'array_length', 'array_agg', 'coalesce', 'nullif', 'greatest', 'least', 'format', 'quote_ident', 'quote_literal', 'lower', 'upper', 'length', 'concat', 'concat_ws', 'string_agg', 'count', 'max', 'min', 'sum', 'regexp_replace', 'split_part', 'to_regclass', 'unnest', 'md5', 'current_database']);

/** 대상은 몰라도 승인된 문장 종류는 필드 집합·타입·필수 여부를 바꾸지 않는다. PRIMARY KEY는 제외한다. */
function fieldsUnchanged(statement: Record<string, unknown>): boolean {
  if (['CreateTrigStmt', 'IndexStmt', 'GrantStmt', 'GrantRoleStmt', 'AlterOwnerStmt'].some(kind => statement[kind])) return true;
  if (statement.DropStmt) return record(statement.DropStmt).removeType === 'OBJECT_TRIGGER';
  if (statement.AlterFunctionStmt) {
    const actions = record(statement.AlterFunctionStmt).actions;
    return Array.isArray(actions) && actions.length > 0 && actions.every(value => {
      const action = record(record(value).DefElem);
      return action.defname === 'set' && Boolean(record(action.arg).VariableSetStmt);
    });
  }
  if (!statement.AlterTableStmt) return false;
  const alter = record(statement.AlterTableStmt);
  return Array.isArray(alter.cmds) && alter.cmds.length > 0 && alter.cmds.every(value => {
    const command = record(record(value).AlterTableCmd);
    return command.subtype === 'AT_ChangeOwner' || alter.objtype === 'OBJECT_TABLE' && command.subtype === 'AT_AddConstraint' && ['CONSTR_UNIQUE', 'CONSTR_FOREIGN'].includes(String(record(record(command.def).Constraint).contype));
  });
}

function harmlessTemplate(expression: string): boolean {
  try {
    const selected = parseSync(`SELECT ${expression}`).stmts;
    if (selected?.length !== 1) return false;
    const select = record(record(selected[0]?.stmt).SelectStmt);
    if (Object.keys(select).some(key => !['targetList', 'limitOption', 'op'].includes(key))) return false;
    if (!Array.isArray(select.targetList) || select.targetList.length !== 1) return false;
    const call = record(record(record(record(select.targetList[0]).ResTarget).val).FuncCall);
    const names = Array.isArray(call.funcname) ? call.funcname.map(n => record(record(n).String).sval) : [];
    if (!(names.length === 1 && names[0] === 'format' || names.length === 2 && names[0] === 'pg_catalog' && names[1] === 'format') || !Array.isArray(call.args)) return false;
    const template = record(record(record(call.args[0]).A_Const).sval).sval;
    if (typeof template !== 'string') return false;
    const sql = template.replace(/%([%ILs])|%/g, (_match, kind: string | undefined) => {
      if (!kind) throw new Error('지원하지 않는 format 자리표시자입니다.');
      return kind === '%' ? '%' : kind === 'L' ? "'__design_literal__'" : '__design_identifier__';
    });
    const statements = parseSync(sql).stmts;
    if (statements?.length !== 1) return false;
    return fieldsUnchanged(record(statements[0]?.stmt));
  } catch { return false; }
}

const CONTROL = new Set(['block', 'if', 'case', 'loop', 'while', 'fori', 'fors', 'foreach_a', 'exit', 'return', 'raise']);
function doStatements(raw: string, depth: number): UnparsedSql[] {
  const output: UnparsedSql[] = [];
  const unknown = (sql: string) => output.push({ type: 'unsupported', sql });
  const staticSql = (sql: string) => {
    const statements = parseSync(sql).stmts ?? [];
    if (statements.length && statements.every(part => fieldsUnchanged(record(part.stmt)))) return;
    for (const part of postgresStatements(sql, depth + 1)) {
      if (part.type === 'unsupported' || part.type === 'raw constraint') output.push({ ...part, type: 'unsupported' });
      else if (part.type === 'create enum' || part.type === 'create composite type' || part.type === 'alter enum') {
        output.push({ type: 'unsupported', typeName: part.name, sql });
        if (part.type === 'alter enum' && part.change.type === 'rename') output.push({ type: 'unsupported', typeName: { ...part.name, ...part.change.to }, sql });
      } else {
        const targets = part.type === 'create table' ? [part.name] : part.type === 'alter table' || part.type === 'create index' ? [part.table] : part.type === 'drop table' ? part.names : [];
        if (!targets.length) unknown(sql);
        for (const table of targets) output.push({ type: 'unsupported', table, sql });
        if (part.type === 'alter table') for (const change of part.changes) if (change.type === 'rename') output.push({ type: 'unsupported', table: { ...part.table, ...change.to }, sql });
      }
    }
  };
  let visited = 0;
  const walk = (value: unknown, level: number) => {
    if (++visited > 20_000 || level > DESIGN_LIMITS.depth) throw new Error('PL/pgSQL 해석 상한입니다.');
    if (Array.isArray(value)) { for (const child of value) walk(child, level + 1); return; }
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'PLpgSQL_expr') {
        const expression = record(child), query = expression.query;
        if (typeof query !== 'string' || ![undefined, 0, 2].includes(expression.parseMode as number | undefined)) throw new Error('표현식 형식을 해석하지 못했습니다.');
        const statements = parseSync(expression.parseMode === 2 ? `SELECT ${query}` : query).stmts;
        if (statements?.length !== 1) throw new Error('표현식 문장 수를 확인하지 못했습니다.');
        walk(statements, level + 1);
        continue;
      }
      if (key === 'FuncCall') {
        const names = record(child).funcname;
        const parts = Array.isArray(names) ? names.map(n => record(record(n).String).sval) : [];
        const name = parts.at(-1);
        if (typeof name !== 'string' || !SAFE_FUNCTIONS.has(name) || !(parts.length === 1 || parts.length === 2 && parts[0] === 'pg_catalog')) throw new Error('허용하지 않은 함수 호출입니다.');
      } else if (key === 'PLpgSQL_stmt_execsql' || key === 'PLpgSQL_stmt_dynexecute') {
        const statement = record(child), dynamic = key === 'PLpgSQL_stmt_dynexecute';
        const query = record(record(statement[dynamic ? 'query' : 'sqlstmt']).PLpgSQL_expr).query;
        if (typeof query !== 'string') throw new Error('PL/pgSQL 문장이 없습니다.');
        if (!dynamic) staticSql(query);
        else if (!harmlessTemplate(query)) unknown(query);
      } else if (key.startsWith('PLpgSQL_stmt_') && !CONTROL.has(key.slice('PLpgSQL_stmt_'.length))) unknown(key);
      walk(child, level + 1);
    }
  };
  try {
    const parsed = record(parsePlPgSQLSync(raw));
    if (!Array.isArray(parsed.plpgsql_funcs) || parsed.plpgsql_funcs.length !== 1) throw new Error('PL/pgSQL 블록이 아닙니다.');
    if (!record(record(parsed.plpgsql_funcs[0]).PLpgSQL_function).action) throw new Error('PL/pgSQL 실행 본문이 없습니다.');
    walk(parsed.plpgsql_funcs, 0);
    return output;
  } catch { return [{ type: 'unsupported', sql: raw }]; }
}

/** PostgreSQL 공식 구문 트리로 문장을 분류한다. 지원하지 않는 구조 변경은 대상 테이블을 대조 안 함으로 남긴다. */
export function postgresStatements(raw: string, depth = 0): (Statement | UnparsedSql)[] {
  if (depth > DESIGN_LIMITS.depth) return [{ type: 'unsupported', sql: raw }];
  const output: (Statement | UnparsedSql)[] = [];
  const convert = (stmt: Record<string, unknown>, table?: QName, typeName?: QName) => {
    const sql = text(stmt);
    try { for (const part of parse(sql)) output.push(part); }
    catch { output.push({ type: 'unsupported', ...(table && { table }), ...(typeName && { typeName }), sql }); }
  };
  for (const source of parseSync(raw).stmts ?? []) {
    const stmt = record(source.stmt), [kind] = Object.keys(stmt);
    if (!kind) continue;
    const node = record(stmt[kind]);
    if (kind === 'CreateFunctionStmt' && Array.isArray(node.funcname)) {
      const name = record(record(node.funcname.at(-1)).String).sval;
      if (typeof name === 'string' && SAFE_FUNCTIONS.has(name)) {
        output.push({ type: 'unsupported', sql: text(stmt) });
        continue;
      }
    }
    const relation = node.relation === undefined ? undefined : record(node.relation);
    const table = relation && typeof relation.relname === 'string' ? { name: relation.relname, ...(typeof relation.schemaname === 'string' && { schema: relation.schemaname }) } : undefined;
    const names = Array.isArray(node.typeName) ? node.typeName.map(part => record(record(part).String).sval) : [];
    const name = names.at(-1), schema = names.length === 2 ? names[0] : undefined;
    const typeName = names.length <= 2 && typeof name === 'string' ? { name, ...(typeof schema === 'string' && { schema }) } : undefined;
    if (kind === 'AlterTableStmt' && node.objtype === 'OBJECT_TYPE') {
      output.push({ type: 'unsupported', ...(table && { typeName: table }), sql: text(stmt) });
    } else if (kind === 'AlterEnumStmt' && (node.oldVal !== undefined || node.newValNeighbor !== undefined)) {
      output.push({ type: 'unsupported', ...(typeName && { typeName }), sql: text(stmt) });
    } else if (kind === 'AlterTableStmt' && Array.isArray(node.cmds)) {
      for (const source of node.cmds) {
        const command = record(record(source).AlterTableCmd);
        const single = { AlterTableStmt: { ...node, cmds: [source] } };
        if (NEUTRAL_ALTER.has(String(command.subtype)) || command.subtype === 'AT_ChangeOwner' && fieldsUnchanged(single)) continue;
        const constraint = command.def && record(command.def).Constraint;
        if (constraint && record(constraint).contype === 'CONSTR_CHECK') {
          const name = record(constraint).conname;
          output.push({ type: 'raw constraint', ...(table && { table }), ...(typeof name === 'string' && { name }), sql: text(single) });
        } else {
          if (constraint && record(constraint).contype === 'CONSTR_UNIQUE') delete record(constraint).nulls_not_distinct;
          if (command.subtype === 'AT_AlterColumnType' && command.def) {
            const column = record(record(command.def).ColumnDef);
            delete column.raw_default;
          }
          convert(single, table);
        }
      }
    } else if (kind === 'DropStmt' && !['OBJECT_TABLE', 'OBJECT_INDEX', 'OBJECT_TYPE'].includes(String(node.removeType))) {
      // 함수·트리거 삭제는 컬럼의 타입·필수성을 바꾸지 않는다.
      continue;
    } else if (kind === 'DoStmt') {
      output.push(...doStatements(text(stmt), depth));
    } else if (fieldsUnchanged(stmt) && kind !== 'IndexStmt' || NEUTRAL.has(kind) && kind !== 'CommentStmt') continue;
    else convert(stmt, table, typeName);
  }
  return output;
}

/** DB 조회 결과와 같은 타입 이름을 쓴다. serial은 저장되는 정수 타입으로 바꾼다. */
export function sqlType(type: string): string {
  if (type.includes('"')) return type.trim();
  const name = type.trim().toLowerCase().replace(/^(pg_catalog|public)\./, '').replace(/\s+\(/g, '(');
  const aliases: Record<string, string> = { int: 'integer', int4: 'integer', serial: 'integer', serial4: 'integer', int8: 'bigint', bigserial: 'bigint', serial8: 'bigint', int2: 'smallint', smallserial: 'smallint', serial2: 'smallint', varchar: 'character varying', bpchar: 'character', char: 'character', bool: 'boolean', float4: 'real', float8: 'double precision', decimal: 'numeric', timestamptz: 'timestamp with time zone', timestamp: 'timestamp without time zone', timetz: 'time with time zone', time: 'time without time zone' };
  return name.replace(/^[a-z][a-z0-9 ]*(?=\(|\[|$)/, base => aliases[base] ?? base);
}
