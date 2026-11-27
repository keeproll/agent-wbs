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
  // M6 통합 재번호: 메일 큐(M6-03, 옛 0049) → 0039, 설계 원장(M6-05, 옛 0053) → 0042. 사슬은 0025 → 0039 → 0042.
  const mail = snapshot('0039');
  const design = snapshot('0042');
  expect(project.prevId).toBe(before.id);
  expect(evidence.prevId).toBe(project.id);
  expect(observation.prevId).toBe(evidence.id);
  expect(settings.prevId).toBe(observation.id);
  expect(versions.prevId).toBe(settings.id);
  expect(mail.prevId).toBe(versions.id);
  expect(design.prevId).toBe(mail.id);
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
  expect(await generateMigration(mail, design)).toEqual([
    'ALTER TABLE "design_versions" ALTER COLUMN "snapshot" DROP NOT NULL;',
    'ALTER TABLE "design_snapshots" ADD COLUMN "content" jsonb DEFAULT \'{}\'::jsonb NOT NULL;',
  ]);
  expect(await generateMigration(design, generateDrizzleJson(schema, design.id))).toEqual([]);
  expect(mail.tables['public.mail_outbox']?.columns).toHaveProperty('retried');
  expect(mail.tables['public.mail_settings']?.columns).toHaveProperty('settings_version');
  expect(design.tables['public.mail_outbox']).toEqual(mail.tables['public.mail_outbox']);
});
