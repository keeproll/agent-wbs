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
  const order = snapshot('0027');
  // M6 통합 재번호(새 main 위): 메일 큐(M6-03) → 0031, 설계 원장(M6-05) → 0034. 사슬은 0025 → 0026 → 0027 → 0031 → 0034.
  const mail = snapshot('0031');
  const design = snapshot('0034');
  // M6 통합 fix2: 저장 순번(0037, notify_outbox·reports·design_drifts)
  const order2 = snapshot('0037');
  const claims = snapshot('0038');
  const recovery = snapshot('0039');
  // M8 전 연결 fix1: 해제 증거 cgroup_empty(0040, 조정자 결정 3)
  const cgroup = snapshot('0040');
  // Q-13 결정 A: 외부 수신자(0041, mail_recipients·mail_outbox의 external)
  const external = snapshot('0041');
  // UAT-TASK-10: 실제 사용한 하위 Agent(0048, attempt_subagent_usage)
  const usage = snapshot('0048');
  expect(project.prevId).toBe(before.id);
  expect(evidence.prevId).toBe(project.id);
  expect(observation.prevId).toBe(evidence.id);
  expect(settings.prevId).toBe(observation.id);
  expect(versions.prevId).toBe(settings.id);
  expect(ci.prevId).toBe(versions.id);
  expect(order.prevId).toBe(ci.id);
  expect(mail.prevId).toBe(order.id);
  expect(design.prevId).toBe(mail.id);
  expect(order2.prevId).toBe(design.id);
  expect(claims.prevId).toBe(order2.id);
  expect(recovery.prevId).toBe(claims.id);
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
  expect(ci.tables['public.merge_queue']?.columns).toHaveProperty('head_sync');
  expect(ci.tables['public.ci_steps']?.columns).toHaveProperty('duration_ms');
  // M5·M7 통합: Planning 이벤트 수신 순번(0027). 「다음 generate가 빈 변경」은 마지막 snapshot(0034)으로 아래에서 확인한다.
  for (const table of ['change_proposal_events', 'planning_job_logs', 'planning_reviews']) expect(order.tables[`public.${table}`]?.columns).toHaveProperty('record_no');
  // M6: 0027 위에 메일 큐(0031)를 더하면 메일 열만 바뀌고, 설계 원장(0034)은 설계 두 줄만 더한다.
  expect(await generateMigration(order, mail)).not.toEqual([]);
  expect(mail.tables['public.ci_runs']).toEqual(order.tables['public.ci_runs']);
  expect(await generateMigration(mail, design)).toEqual([
    'ALTER TABLE "design_versions" ALTER COLUMN "snapshot" DROP NOT NULL;',
    'ALTER TABLE "design_snapshots" ADD COLUMN "content" jsonb DEFAULT \'{}\'::jsonb NOT NULL;',
  ]);
  expect(await generateMigration(design, order2)).toHaveLength(6);
  for (const table of ['notify_outbox', 'reports', 'design_drifts']) expect(order2.tables[`public.${table}`]?.columns).toHaveProperty('record_no');
  expect(claims.tables['public.ci_merge_facts']?.columns).toHaveProperty('commit_parents');
  expect(cgroup.prevId).toBe(recovery.id);
  // 0040은 열거형 값 하나만 더한다. 트리거·정리 함수는 손으로 쓴 SQL이다.
  expect(await generateMigration(recovery, cgroup)).toEqual(['ALTER TYPE "public"."release_proof" ADD VALUE \'cgroup_empty\';']);
  expect(external.prevId).toBe(cgroup.id);
  // 0041은 외부 수신자 열 두 개와 검사 두 개만 더한다. 「다음 generate가 빈 변경」은 마지막 snapshot(0041)으로 확인한다.
  expect(await generateMigration(cgroup, external)).toHaveLength(4);
  for (const table of ['mail_recipients', 'mail_outbox']) expect(external.tables[`public.${table}`]?.columns).toHaveProperty('external');
  expect(usage.prevId).toBe(external.id);
  // 0048은 표 하나와 FK 셋만 더한다(Drizzle 기준). 범위 FK·색인·권한·트리거는 손으로 쓴 SQL이다. 「다음 generate가 빈 변경」은 마지막 snapshot(0048)으로 확인한다.
  const added = await generateMigration(external, usage);
  expect(added).toHaveLength(4);
  expect(added[0]).toContain('CREATE TABLE "attempt_subagent_usage"');
  expect(await generateMigration(usage, generateDrizzleJson(schema, usage.id))).toEqual([]);
  expect(mail.tables['public.mail_outbox']?.columns).toHaveProperty('retried');
  expect(mail.tables['public.mail_settings']?.columns).toHaveProperty('settings_version');
  expect(design.tables['public.mail_outbox']).toEqual(mail.tables['public.mail_outbox']);
});
