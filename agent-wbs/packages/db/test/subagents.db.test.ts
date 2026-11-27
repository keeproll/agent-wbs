import { afterAll, beforeAll, expect, inject, test } from 'vitest';
import { createPool, recreateTestDatabase, runMigrations, seedDemo, seedSystem } from '../src/index.ts';
import { loadSubagentSet, seedSubagents, sha256Hex } from '../src/subagents.ts';

function must<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) throw new Error(`없음: ${what}`);
  return value;
}

const dbUrl = new URL(inject('testDatabaseUrl'));
dbUrl.pathname += '_subagents';
const url = dbUrl.href;
const pool = createPool(url, { max: 4, onError: () => undefined });
const set = await loadSubagentSet();

beforeAll(async () => {
  await recreateTestDatabase(url);
  await runMigrations(pool);
});
afterAll(async () => { await pool.end(); });

const rows = async () => (await pool.query<{ def_key: string; version: number; agent: string; tools: string[]; sandbox: string; text: string; hash: string; allowed: boolean; is_demo: boolean; ref: string | null }>(
  'select def_key,version,agent,tools,sandbox,text,hash,allowed,is_demo,ref from subagent_defs order by def_key,version')).rows;

test('system seed가 검토를 마친 하위 Agent v1을 파일 내용·hash 그대로 넣는다', async () => {
  await seedSystem(pool);
  const real = (await rows()).filter((r) => !r.is_demo);
  expect(real.map((r) => r.def_key)).toEqual(set.defs.map((d) => d.key).sort());
  for (const r of real) {
    const d = must(set.defs.find((x) => x.key === r.def_key), 'value');
    expect(r).toMatchObject({ version: d.version, agent: d.agent, tools: d.tools, sandbox: d.sandbox, text: d.text, hash: d.hash, allowed: d.allowed, ref: d.ref });
    // Runner가 받은 file로 다시 계산한 hash가 저장된 hash와 같아야 설치할 수 있다(contracts §4 subagents).
    expect(sha256Hex(r.text)).toBe(r.hash);
  }
});

test('다시 seed해도 늘지 않고 팀장이 바꾼 허용 값을 덮지 않는다', async () => {
  await pool.query("update subagent_defs set allowed=false where def_key='ui-builder'");
  await seedSystem(pool);
  const real = (await rows()).filter((r) => !r.is_demo);
  expect(real).toHaveLength(set.defs.length);
  expect(real.find((r) => r.def_key === 'ui-builder')?.allowed).toBe(false);
  await pool.query("update subagent_defs set allowed=true where def_key='ui-builder'");
});

test('같은 정의·버전인데 내용이 다르면 seed가 멈추고 아무것도 넣지 않는다(버전 불변)', async () => {
  const changed = structuredClone(set);
  // 새 정의 하나를 앞에 두고, 뒤의 정의가 충돌하게 만든다. 앞의 것도 들어가지 않아야 한다(한 트랜잭션).
  const base = must(changed.defs.find((d) => d.key === 'test-author'), 'value');
  const extra = { ...structuredClone(base), key: 'extra-author', file: 'codex/extra-author.v1.toml' };
  extra.text = base.text.replace('name = "test-author"', 'name = "extra-author"').replace('(test-author)', '(extra-author)');
  extra.hash = sha256Hex(extra.text);
  const def = must(changed.defs.find((d) => d.key === 'ui-builder'), 'value');
  const oldHash = def.hash;
  def.text = def.text.replace('맡은 일', '맡은  일');
  def.hash = sha256Hex(def.text);
  changed.defs = [extra, ...changed.defs.filter((d) => d.key !== 'ui-builder'), def];
  changed.review = `${changed.review.replaceAll(oldHash, def.hash)}\n| \`extra-author\` v1 \`${extra.hash}\` | Codex | 시험 |\n`;
  await expect(seedSubagents(pool, changed)).rejects.toThrow('ui-builder v1');
  expect((await rows()).some((r) => r.def_key === 'extra-author')).toBe(false);
  expect((await rows()).find((r) => r.def_key === 'ui-builder')?.hash).toBe(oldHash);
});

test('검사를 통과하지 못한 정의는 seed하지 않는다', async () => {
  const bad = structuredClone(set);
  must(bad.defs[0], 'value').text += '\nmodel: opus\n';
  await expect(seedSubagents(pool, bad)).rejects.toThrow('하위 Agent 정의 검사 실패');
});

test('demo 정의와 섞이지 않고, 설정까지 지우는 초기화 뒤에도 실제 정의는 남는다', async () => {
  await seedDemo(pool, url);
  const all = await rows();
  expect(all.filter((r) => r.is_demo)).toHaveLength(10);
  expect(all.filter((r) => !r.is_demo)).toHaveLength(set.defs.length);
  const demoKeys = new Set(all.filter((r) => r.is_demo).map((r) => r.def_key));
  expect(set.defs.some((d) => demoKeys.has(d.key))).toBe(false);
  const name = (await pool.query<{ name: string }>('select name from projects')).rows[0]?.name;
  await pool.query("select reset_project(1,$1,false,'test')", [name]);
  const after = await rows();
  expect(after.filter((r) => r.is_demo)).toHaveLength(0);
  expect(after.map((r) => r.def_key)).toEqual(set.defs.map((d) => d.key).sort());
});
