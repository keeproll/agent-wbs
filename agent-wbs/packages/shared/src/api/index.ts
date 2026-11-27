import { planningOperations } from './routes/planning.ts';
import { projectOperations } from './routes/project.ts';
import { runnerOperations } from './routes/runner.ts';
import { settingsOperations } from './routes/settings.ts';
import { systemOperations } from './routes/system.ts';
import { wbsOperations } from './routes/wbs.ts';
import type { Operation } from './operation.ts';

/** 전체 API. 여기 없는 라우트는 계약에 없는 것이다. */
export const OPERATIONS: readonly Operation[] = [
  ...systemOperations,
  ...wbsOperations,
  ...projectOperations,
  ...settingsOperations,
  ...runnerOperations,
  ...planningOperations,
];

export * from './adapters.ts';
export * from './errors.ts';
export * from './input-rules.ts';
export * from './operation.ts';
export * from './openapi.ts';
export * from './jobs.ts';
export * from './design.ts';
export { DATE_PATTERN, ErrorResponse, isDateOnly, isTimestamp, TIMESTAMP_PATTERN } from './common.ts';
export { planningOperations, projectOperations, runnerOperations, settingsOperations, systemOperations, wbsOperations };
