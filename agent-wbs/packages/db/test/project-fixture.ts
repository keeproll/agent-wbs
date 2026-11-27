import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { textValues } from '../src/schema-values.ts';

/** Fill every project relation so reset omissions cannot hide behind empty tables. */
export async function fillProjectTables(
  c: pg.PoolClient,
  f: { p: string; task: string; wp: string; job: string },
) {
  const ids = new Map<string, string>([
    ['projects', f.p],
    ['tasks', f.task],
    ['wbs_nodes', f.wp],
    ['runner_jobs', f.job],
  ]);
  const secondTask = (
    await c.query<{ id: string }>(
      "insert into tasks(project_id,task_key,wbs_node_id,sort_order,title,work_type,primary_domain,related_domains,priority,assignee_agent,verifier_agent,status,verif_state) values($1,'TASK-2',$2,1,'second','Test','BE','{}',1,'Claude','Codex','ready','none') returning id",
      [f.p, f.wp],
    )
  ).rows[0]?.id;
  assert(secondTask);
  const sub = (
    await c.query<{ id: string }>(
      "insert into subagent_defs(def_key,version,agent,role,tools,sandbox,text,hash) values('fixture-v1',1,'Codex','qa','{}','read-only','reviewed','hash') returning id",
    )
  ).rows[0]?.id;
  assert(sub);
  ids.set('subagent_defs', sub);
  interface Column {
    table: string;
    name: string;
    type: string;
    required: boolean;
    has_default: boolean;
    enum_values: string[] | null;
  }
  const columns = (
    await c.query<Column>(`select t.relname as table,a.attname as name,ty.typname as type,a.attnotnull as required,
      ad.oid is not null as has_default,(select array_agg(e.enumlabel::text order by e.enumsortorder) from pg_enum e where e.enumtypid=ty.oid) as enum_values
    from pg_class t join pg_namespace n on n.oid=t.relnamespace join pg_attribute a on a.attrelid=t.oid and a.attnum>0 and not a.attisdropped
    join pg_type ty on ty.oid=a.atttypid left join pg_attrdef ad on ad.adrelid=t.oid and ad.adnum=a.attnum
    where n.nspname='public' and t.relkind='r' order by t.relname,a.attnum`)
  ).rows;
  const tables = [
    ...new Set(columns.filter((col) => col.name === 'project_id').map((col) => col.table)),
  ];
  interface Reference {
    table: string;
    column: string;
    parent: string;
  }
  const references = (
    await c.query<Reference>(`select t.relname as table,a.attname as column,p.relname as parent from pg_constraint fk
    join pg_class t on t.oid=fk.conrelid join pg_class p on p.oid=fk.confrelid
    cross join lateral unnest(fk.conkey) k(num) join pg_attribute a on a.attrelid=t.oid and a.attnum=k.num
    where fk.contype='f' and a.attname<>'project_id' and a.attname<>'id'`)
  ).rows;
  const pending = new Set(tables.filter((table) => !ids.has(table)));
  while (pending.size) {
    let progressed = false;
    for (const table of pending) {
      const cols = columns.filter((col) => col.table === table);
      const requiredRefs = references.filter(
        (ref) => ref.table === table && cols.some((col) => col.name === ref.column && col.required),
      );
      if (requiredRefs.some((ref) => !ids.has(ref.parent))) continue;
      const values: unknown[] = [];
      const names: string[] = [];
      for (const col of cols) {
        if (
          col.has_default ||
          (!col.required &&
            col.name !== 'project_id' &&
            !(table === 'messages' && ['to_agent', 'delivery'].includes(col.name)) &&
            !(table === 'evidence' && ['storage_path', 'sha256', 'size'].includes(col.name)))
        )
          continue;
        let value: unknown;
        const ref = requiredRefs.find((ref) => ref.column === col.name);
        if (col.name === 'project_id') value = f.p;
        else if (ref)
          value =
            table === 'task_dependencies' && col.name === 'succ' ? secondTask : ids.get(ref.parent);
        else if (col.enum_values) value = col.enum_values[0];
        else if (col.type === 'uuid') value = randomUUID();
        else if (col.type === 'bool') value = false;
        else if (['int2', 'int4', 'int8', 'numeric'].includes(col.type)) value = 1;
        else if (col.type === 'timestamptz') value = new Date();
        else if (col.type === 'date') value = new Date().toISOString().slice(0, 10);
        else if (col.type.startsWith('_')) value = [];
        else if (col.type === 'jsonb')
          value = JSON.stringify(
            col.name === 'judged_rules'
              ? { schemaVersion: 1, items: [] }
              : ['ac', 'ops', 'exceptions', 'files', 'md_list', 'changes'].includes(col.name)
                ? []
                : {},
          );
        else if (col.name === 'sha256') value = 'a'.repeat(64);
        else value = textValues[table]?.[col.name]?.[0] ?? 'fixture';
        if (table === 'planning_jobs' && col.name === 'kind') value = 'bootstrap';
        if (table === 'planning_jobs' && col.name === 'status') value = 'queued';
        if (table === 'change_proposals' && col.name === 'source') value = 'manual';
        if (table === 'replans' && col.name === 'status') value = 'pending';
        // job 없는 CI 실행은 야간 점검(3)뿐이다(M1 통합).
        if (table === 'ci_runs' && col.name === 'stage') value = 3;
        if (table === 'ci_runs' && col.name === 'artifacts') value = '[]';
        if (table === 'design_drifts' && col.name === 'compat') value = '호환';
        if (table === 'messages' && col.name === 'dir') value = 'out';
        if (table === 'runner_job_events' && col.name === 'kind') value = 'prepared';
        if (table === 'attempt_observations' && col.name === 'state') value = 'ok';
        if (table === 'execution_holds') {
          if (col.name === 'slot_state') value = 'reserved';
          if (col.name === 'lock_state') value = 'held';
        }
        names.push(col.name);
        values.push(value);
      }
      if (table === 'execution_holds') {
        names.push('host_id', 'boot_id', 'fence', 'task');
        values.push('host', 'boot', 1, f.task);
      }
      const placeholders = names.map((_, i) => `$${i + 1}`).join(',');
      const key = table === 'task_specs' ? 'task' : table === 'change_events' ? 'seq' : table === 'ci_merge_facts' ? 'merge_sha' : 'id';
      const row = (
        await c.query(
          `insert into ${c.escapeIdentifier(table)}(${names.map((name) => c.escapeIdentifier(name)).join(',')}) values(${placeholders}) returning ${c.escapeIdentifier(key)} as id`,
          values,
        )
      ).rows[0] as { id: string } | undefined;
      assert(row, `fixture ${table}`);
      ids.set(table, row.id);
      pending.delete(table);
      progressed = true;
    }
    assert(progressed, `fixture dependency cycle: ${[...pending].join(',')}`);
  }
  return tables;
}
