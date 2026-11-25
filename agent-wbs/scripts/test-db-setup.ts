import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { TestProject } from 'vitest/node';
import { recreateTestDatabase } from '../packages/db/src/index.ts';

/** 대상 DB가 awbs_test_가 아니면 어떤 테스트도 시작하지 않는다. */
export default async function setup(project: TestProject): Promise<void> {
  const envFile = resolve(import.meta.dirname, '../.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  project.provide('testDatabaseUrl', await recreateTestDatabase(process.env.TEST_DATABASE_URL));
}
