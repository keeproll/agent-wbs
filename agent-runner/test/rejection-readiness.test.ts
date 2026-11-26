import { expect, test } from 'vitest';
import { withRejectionWarnings } from '../src/app.ts';
import type { ReadinessReport } from '../src/readiness/checks.ts';

test('거부 기록을 별도 준비 경고로 보내고 기존 실패는 유지하며 복구 보고도 보낸다', () => {
  const body: ReadinessReport = { at: '2026-11-27T00:00:00Z', items: [{ key: 'git', status: 'fail', detail: 'git 없음' }] };
  const warning = withRejectionWarnings(body, ['보고 거부 1건']);
  expect(warning.items).toEqual(expect.arrayContaining([body.items[0], { key: 'reports', status: 'warn', detail: '보고 거부 1건', fix: expect.any(String) }]));
  expect(body.items).toHaveLength(1);
  expect(withRejectionWarnings(warning, []).items.filter(i => String(i.key) === 'reports')).toEqual([{ key: 'reports', status: 'ok', detail: '보고 거부 기록 없음', fix: '' }]);
});
