import type { PoolClient } from '@awbs/db';

const versions = {
  split: ['app_settings', 'split_version'], blackouts: ['app_settings', 'blackouts_version'],
  workflow: ['app_settings', 'workflow_version'], models: ['app_settings', 'models_version'],
  subagents: ['app_settings', 'subagents_version'], 'exec-policy': ['exec_policy', 'settings_version'],
  schedule: ['schedule_policy', 'settings_version'], concurrency: ['concurrency_settings', 'concurrency_version'],
  'obs-budget': ['concurrency_settings', 'budget_version'], github: ['github_settings', 'settings_version'],
} as const;
export type SettingGroup = keyof typeof versions;

/** 해당 설정의 값이 바뀐 트랜잭션에서만 호출한다. 기존 행 잠금으로 동시 저장을 직렬화한다. */
export async function touchSetting(client: Pick<PoolClient, 'query'>, group: SettingGroup): Promise<void> {
  const [table, column] = versions[group];
  await client.query(`update ${table} set ${column}=greatest(clock_timestamp(),${column}+interval '1 microsecond') where singleton`);
}
