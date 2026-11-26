// 계약 보완(2026-11-26): 모델 순서·Claude 목록 system seed(owner 아이템 8), GitHub 권한 3상태 저장(조정자 결정).
import assert from 'node:assert/strict';
import pg from 'pg';
import { afterAll, beforeAll, expect, inject, test } from 'vitest';
import { DEFAULT_MODEL_SETTINGS } from '@awbs/shared';
import { createPool, runMigrations, seedSystem } from '../src/index.ts';

const pool = createPool(inject('testDatabaseUrl'), { max: 2, onError: () => undefined });
beforeAll(async () => {
  await runMigrations(pool);
  await seedSystem(pool);
});
afterAll(() => pool.end());

async function transaction(fn: (c: pg.PoolClient) => Promise<void>) {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await fn(c);
  } finally {
    await c.query('rollback');
    c.release();
  }
}
async function rejects(c: pg.PoolClient, sql: string, values: unknown[], constraint: string) {
  await c.query('savepoint invalid');
  await expect(c.query(sql, values)).rejects.toMatchObject({ code: '23514', constraint });
  await c.query('rollback to savepoint invalid');
}
const plain = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;

test('system seed: 모델 순서·Codex 계열 순서·Claude 목록이 shared 초기값과 같다', async () => {
  const { rows } = await pool.query<{ model_settings: unknown }>('select model_settings from app_settings');
  expect(rows).toHaveLength(1);
  expect(rows[0]?.model_settings).toEqual(plain(DEFAULT_MODEL_SETTINGS));
});

test('system seed: 순서와 Claude 목록의 모델은 Q-06 승인 매핑(agent_efforts)의 모델과 같다', async () => {
  const settings = (await pool.query<{ s: typeof DEFAULT_MODEL_SETTINGS }>('select model_settings s from app_settings')).rows[0]?.s;
  assert(settings);
  const mapped = async (agent: string) =>
    (await pool.query<{ m: string }>('select distinct model_id m from agent_efforts where agent=$1 order by 1', [agent])).rows.map((r) => r.m);
  expect([...settings.rankOrder.Codex].sort()).toEqual(await mapped('Codex'));
  expect([...settings.rankOrder.Claude].sort()).toEqual(await mapped('Claude'));
  expect([...settings.claudeModels].sort()).toEqual(await mapped('Claude'));
});

test('system seed는 반복해도 팀장이 바꾼 순서를 덮지 않고, 설정 초기화는 초기값으로 되돌린다', () =>
  transaction(async (c) => {
    await c.query(`update app_settings set model_settings=jsonb_set(model_settings,'{claudeModels}','["claude-opus-5-5"]')`);
    await c.query('select seed_system()');
    expect((await c.query('select model_settings->$1 v from app_settings', ['claudeModels'])).rows[0]?.v).toEqual(['claude-opus-5-5']);
    const epoch = (await c.query<{ epoch: number }>('select epoch from system_state where id=1')).rows[0]?.epoch;
    await c.query("insert into projects(name,repo_url,repo_owner,repo_name,base_commit,lead_instruction,phase) values('reset-models','','','',null,'','active')");
    await c.query("select reset_project($1,'reset-models',false,'lead')", [epoch]);
    expect((await c.query('select model_settings from app_settings')).rows[0]?.model_settings).toEqual(plain(DEFAULT_MODEL_SETTINGS));
  }));

test('model_settings는 세 항목을 모두 가진 객체다', () =>
  transaction(async (c) => {
    await rejects(c, `update app_settings set model_settings='{}'`, [], 'app_model_settings_shape');
    await rejects(c, `update app_settings set model_settings=model_settings-'claudeModels'`, [], 'app_model_settings_shape');
  }));

test('model_settings의 네 목록은 겹치지 않는 문자열 배열이고, 계열·Claude 목록은 비울 수 없다(리뷰 지적 3)', () =>
  transaction(async (c) => {
    const set = 'update app_settings set model_settings=$1';
    const base = plain(DEFAULT_MODEL_SETTINGS) as Record<string, unknown> & { rankOrder: Record<string, unknown> };
    const bad = [
      { rankOrder: { Claude: 42, Codex: false }, codexFamilyOrder: null, claudeModels: null },
      { ...base, rankOrder: { ...base.rankOrder, Claude: 42 } },
      { ...base, rankOrder: { ...base.rankOrder, Codex: ['gpt-6-sol', 7] } },
      { ...base, rankOrder: { ...base.rankOrder, Codex: ['gpt-6-sol', 'gpt-6-sol'] } },
      { ...base, rankOrder: { ...base.rankOrder, Claude: [''] } },
      { ...base, codexFamilyOrder: [] },
      { ...base, codexFamilyOrder: null },
      { ...base, claudeModels: [] },
      { ...base, claudeModels: [null] },
      { ...base, claudeModels: 'claude-opus-5-5' },
    ];
    for (const value of bad) await rejects(c, set, [JSON.stringify(value)], 'app_model_settings_shape');
    // 빈 rankOrder 목록은 계약상 허용된다.
    await c.query(set, [JSON.stringify({ ...base, rankOrder: { Claude: [], Codex: [] } })]);
  }));

test('github_settings.scopes는 권한별 verified·unverified·missing 또는 null(확인 안 함)이다', () =>
  transaction(async (c) => {
    await c.query("insert into github_settings(mode,status) values('gh','failed')");
    const update = 'update github_settings set scopes=$1, warning=$2';
    const scopes = { contents: 'unverified', pulls: 'unverified', statuses: 'unverified', metadata: 'verified' };
    await c.query(update, [scopes, '쓰기 권한 미확인']);
    await c.query(update, [{ ...scopes, pulls: 'missing' }, null]);
    await c.query(update, [null, null]);
    await rejects(c, update, [{ ...scopes, pulls: true }, null], 'github_scopes_shape');
    await rejects(c, update, [{ ...scopes, admin: 'verified' }, null], 'github_scopes_shape');
    const three: Partial<typeof scopes> = { ...scopes };
    delete three.metadata;
    await rejects(c, update, [three, null], 'github_scopes_shape');
    await rejects(c, update, [scopes, '  '], 'github_warning_text');
    // 리뷰 지적 2: 권한 하나가 JSON null이면 CHECK가 SQL null이 되어 통과하던 틈
    await rejects(c, update, [{ ...scopes, contents: null }, null], 'github_scopes_shape');
    await rejects(c, update, ['null', null], 'github_scopes_shape');
  }));
