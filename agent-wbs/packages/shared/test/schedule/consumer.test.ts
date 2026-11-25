import { expect, test } from 'vitest';
import * as shared from '@awbs/shared';

test('P2-6 a package consumer can call the public schedule API', () => {
  expect(shared).toHaveProperty('schedule');
  expect(shared).toHaveProperty('ScheduleError');
  expect(shared.taskSlots(10, 0.5)).toBe(6);
  expect(shared.schedule({ now: '2026-11-03T03:00:00Z', tasks: [], deps: [], sessions: [], blackouts: [],
    assumeRate: 0.6, concurrency: { total: 4, current: 4, subRatio: 0, Claude: 2, Codex: 2 }, usage: {} }).project.n).toBe(0);
});
