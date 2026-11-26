import { expect, test } from 'vitest';
import type { ApiClient } from '../../src/api/client.ts';
import { ResourceReporter } from '../../src/resources/reporter.ts';
import { HeavySemaphore } from '../../src/resources/heavy.ts';

test('CLI 업데이트의 일부 항목 보고가 기존 공통 준비 실패를 지우지 않는다', async () => {
  const api = (async () => ({ status: 204, body: undefined, headers: new Headers() })) as unknown as ApiClient;
  const reporter = new ResourceReporter({ api, epoch: () => 1, heavy: new HeavySemaphore(1) });
  const at = '2026-11-26T00:00:00.000Z';
  await reporter.reportReadiness({ at, items: [{ key: 'git', status: 'fail', detail: 'git 실행 불가' }] });
  await reporter.reportReadiness({ at, items: [
    { key: 'codex', status: 'ok', detail: '새 버전 적용' },
    { key: 'claude', status: 'ok', detail: '새 버전 적용' },
    { key: 'obs', status: 'warn', detail: '미검증·보수 계산' },
  ] });
  expect(reporter.blocked).toEqual(['Claude', 'Codex']);
  await reporter.reportReadiness({ at, items: [{ key: 'git', status: 'ok', detail: '복구됨' }] });
  expect(reporter.blocked).toEqual([]);
});
