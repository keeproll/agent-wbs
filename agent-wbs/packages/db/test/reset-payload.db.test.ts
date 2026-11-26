// 초기화 정리 명령 payload의 생산자(reset_project)와 Runner 소비자를 같은 고정 예시로 묶는다(M4 통합 교차 리뷰 P1-1).
// 실제 reset_project가 만든 payload에서 매번 바뀌는 값(ID·시각)만 자리표시자로 바꾸면 공용 fixture와 같아야 한다.
// Runner 시험(agent-runner/test/cleanup/reset-payload.test.ts)이 같은 fixture를 읽어 정리 결과를 확인한다.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, expect, inject, test } from 'vitest';
import { createPool, runMigrations, seedSystem } from '../src/index.ts';

const pool = createPool(inject('testDatabaseUrl'), { max: 2, onError: () => undefined });
beforeAll(async () => {
  await runMigrations(pool);
  await seedSystem(pool);
});
afterAll(() => pool.end());

const fixture = JSON.parse(readFileSync(join(import.meta.dirname, '../../../contracts/fixtures/reset-cleanup-payloads.json'), 'utf8')) as Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** 행마다 달라지는 값만 자리표시자로 바꾼다. 필드 이름·구조·나머지 값은 그대로 둔다. */
function normalize(value: unknown, key = ''): unknown {
  if (Array.isArray(value)) return value.map((v) => normalize(v));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v, k)]));
  if (typeof value === 'string' && UUID.test(value)) return `<uuid:${key}>`;
  if (typeof value === 'string' && ['created_at', 'updated_at'].includes(key)) return '<timestamp>';
  return value;
}

async function produce(base: string | null): Promise<unknown> {
  const c: pg.PoolClient = await pool.connect();
  try {
    await c.query('begin');
    const project = (await c.query<{ id: string }>(
      "insert into projects(name,repo_url,repo_owner,repo_name,base_commit,lead_instruction,phase) values('fixture','https://github.com/o/r','o','r',$1,'','active') returning id", [base])).rows[0]?.id;
    const newJob = async (key: string, payload: string) => (await c.query<{ id: string }>(
      "insert into runner_jobs(project_id,kind,payload,state,epoch,dedup_key) values($1,'attempt',$2,'queued',1,$3) returning id", [project, payload, key])).rows[0]?.id;
    const job = await newJob('fixture-1', '{"branch":"agent/T1-h1","pr":7}');
    const job2 = await newJob('fixture-2', '{"branch":"agent/T2-h1"}');
    // 보유 두 개: 프로세스 그룹이 기록된 실행 중 보유(잠금 포함), 프로세스를 만들기 전 예약만 된 보유.
    const hold = "insert into execution_holds(project_id,job,epoch,agent,slots,heavy,host_id,boot_id,fence,slot_state,lock_state,conflict_group) values($1,$2,1,'Codex',1,false,'host-a','boot-a',1,'reserved',$3,$4) returning id";
    const active = (await c.query<{ id: string }>(hold, [project, job, 'held', 'g1'])).rows[0]?.id;
    await c.query(hold, [project, job2, 'none', null]);
    await c.query("update execution_holds set slot_state='active', pgid=4242 where id=$1", [active]);
    const epoch = (await c.query<{ epoch: number }>('select epoch from system_state where id=1')).rows[0]?.epoch;
    await c.query("select reset_project($1,'fixture',true,'lead')", [epoch]);
    const command = (await c.query<{ kind: string; payload: unknown }>('select kind,payload from runner_commands order by created_at desc limit 1')).rows[0];
    const payload = normalize(command?.payload) as { holds: { slot_state: string }[] };
    // jsonb_agg는 순서를 보장하지 않으므로 비교 전에 보유 순서만 고정한다.
    payload.holds.sort((a, b) => a.slot_state.localeCompare(b.slot_state));
    return { kind: command?.kind, payload };
  } finally {
    await c.query('rollback');
    c.release();
  }
}

test('reset_project: 기준 커밋 없는 프로젝트의 payload가 공용 fixture와 같다', async () => {
  expect(await produce(null)).toEqual(fixture.noBase);
});

test('reset_project: 기준 커밋 있는 프로젝트의 payload가 공용 fixture와 같다', async () => {
  expect(await produce('a'.repeat(40))).toEqual(fixture.withBase);
});
