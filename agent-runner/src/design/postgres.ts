import { deparseSync, loadModule, parseSync } from 'pgsql-parser';
import { parse, type QName, type Statement } from 'pgsql-ast-parser';
import { record } from './shape.ts';

await loadModule();
export interface UnparsedSql { type: 'raw constraint' | 'unsupported'; table?: QName; typeName?: QName; name?: string; sql: string }
const NEUTRAL = new Set(['GrantStmt', 'GrantRoleStmt', 'CreateFunctionStmt', 'AlterFunctionStmt', 'CreateTrigStmt', 'AlterOwnerStmt', 'CreateExtensionStmt', 'CommentStmt', 'CreateRoleStmt', 'AlterRoleStmt', 'InsertStmt', 'UpdateStmt', 'DeleteStmt', 'CreateSchemaStmt']);
const NEUTRAL_ALTER = new Set(['AT_EnableRowSecurity', 'AT_DisableRowSecurity', 'AT_ForceRowSecurity', 'AT_NoForceRowSecurity', 'AT_EnableTrig', 'AT_EnableAlwaysTrig', 'AT_DisableTrig', 'AT_EnableTrigAll', 'AT_DisableTrigAll', 'AT_EnableTrigUser', 'AT_DisableTrigUser', 'AT_ChangeOwner', 'AT_ValidateConstraint', 'AT_SetStatistics', 'AT_SetStorage', 'AT_SetCompression']);
const text = (stmt: Record<string, unknown>) => deparseSync({ stmts: [{ stmt }] } as Parameters<typeof deparseSync>[0]);

/** PostgreSQL 공식 구문 트리로 문장을 분류한다. 지원하지 않는 구조 변경은 대상 테이블을 대조 안 함으로 남긴다. */
export function postgresStatements(raw: string): (Statement | UnparsedSql)[] {
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
        if (NEUTRAL_ALTER.has(String(command.subtype))) continue;
        const single = { AlterTableStmt: { ...node, cmds: [source] } };
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
      output.push({ type: 'unsupported', sql: text(stmt) });
    } else if (NEUTRAL.has(kind) && kind !== 'CommentStmt') continue;
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
