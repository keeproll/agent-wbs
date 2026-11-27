import { readFileSync } from 'node:fs';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { expect, test } from 'vitest';
import * as schema from '../src/schema.ts';

const snapshot = (number: string): ReturnType<typeof generateDrizzleJson> =>
  JSON.parse(readFileSync(new URL(`../migrations/meta/${number}_snapshot.json`, import.meta.url), 'utf8')) as ReturnType<typeof generateDrizzleJson>;

test('0021·0022 snapshot이 단계별 구조와 연결을 보존하고 다음 generate에서 기존 변경을 다시 만들지 않는다', async () => {
  const before = snapshot('0020');
  const project = snapshot('0021');
  const evidence = snapshot('0022');
  const observation = snapshot('0023');
  const settings = snapshot('0024');
  const versions = snapshot('0025');
  const ci = snapshot('0026');
  expect(project.prevId).toBe(before.id);
  expect(evidence.prevId).toBe(project.id);
  expect(observation.prevId).toBe(evidence.id);
  expect(settings.prevId).toBe(observation.id);
  expect(versions.prevId).toBe(settings.id);
  expect(project.tables['public.projects']?.columns).toHaveProperty('input_checked_at');
  expect(project.tables['public.change_proposals']?.columns).toHaveProperty('deleted_at');
  expect(project.tables['public.evidence']).toEqual(before.tables['public.evidence']);
  expect(evidence.tables['public.evidence']?.columns).toHaveProperty('reference_path');
  expect(evidence.tables['public.evidence']?.columns.sha256?.notNull).toBe(false);
  expect(await generateMigration(evidence, observation)).toEqual([]);
  expect(settings.tables['public.app_settings']?.columns).toHaveProperty('readiness_check_request');
  expect(settings.tables['public.github_settings']?.columns).toHaveProperty('checked_at');
  expect(versions.tables['public.app_settings']?.columns).toHaveProperty('split_version');
  expect(versions.tables['public.concurrency_settings']?.columns).toHaveProperty('budget_version');
  expect(ci.prevId).toBe(versions.id);
  expect(ci.tables['public.merge_queue']?.columns).toHaveProperty('head_sync');
  expect(ci.tables['public.ci_steps']?.columns).toHaveProperty('duration_ms');
  // M5·M7 통합: Planning 이벤트 수신 순번(0027). 마지막 snapshot이 지금 schema와 같아야 다음 generate가 빈 변경이다.
  const order = snapshot('0027');
  expect(order.prevId).toBe(ci.id);
  for (const table of ['change_proposal_events', 'planning_job_logs', 'planning_reviews']) expect(order.tables[`public.${table}`]?.columns).toHaveProperty('record_no');
  expect(await generateMigration(order, generateDrizzleJson(schema, order.id))).toEqual([]);
});
